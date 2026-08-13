import { normalizeAccessDecision } from '../commerce/access-decision.mjs';
import { canonicalDigest } from '../registry-identity.mjs';
import { validateDemandCatalogProjection } from './demand-catalog.mjs';
import { normalizeEnterpriseLibraryProjection } from './enterprise-library.mjs';

export const SKILL_STEWARD_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const RELEASE_ID = /^(?:rel|apprel)_[a-f0-9]{64}$/;
const ENTITLEMENT_ID = /^ent_[a-f0-9]{64}$/;
const ORG_ID = /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const PROJECT_ID = /^project_[a-z0-9](?:[a-z0-9._-]{0,90}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const PRIVATE_KEY = /(?:candidate|content|body|prompt|inputText|output|transcript|token|secret|password|credential|apiKey|privateKey|localPath|absolutePath|storageRef|identityReceipt|principal|reviewer|shell|command|url)/i;
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|https?:\/\//i;
const ACQUISITION = new Set(['entitled', 'free_available', 'purchase_required', 'unavailable']);
const DEFAULT_RIGHTS = Object.freeze(['invoke']);

export class SkillStewardError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SkillStewardError';
    this.code = code;
  }
}

function fail(code, message, cause) { throw new SkillStewardError(code, message, cause); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} 必须是对象`);
  return value;
}
function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} 含未知字段：${unknown.join(', ')}`);
}
function text(value, label, maximum = 512, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} 必须是非空字符串`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) fail('INVALID_TEXT', `${label} 格式无效`);
  if (PRIVATE_VALUE.test(normalized)) fail('PRIVATE_VALUE_FORBIDDEN', `${label} 含不允许的内容`);
  return normalized;
}
function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} 必须是有效时间`);
  return new Date(Date.parse(normalized)).toISOString();
}
function list(value, label, { maximum = 50, pattern = TOKEN, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && !value.length)) fail('INVALID_ARRAY', `${label} 必须是受限数组`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 256, pattern));
  if (new Set(result).size !== result.length) fail('DUPLICATE_VALUE', `${label} 不得重复`);
  return result.sort((a, b) => a.localeCompare(b, 'en'));
}
function trustedNow(now) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', '必须提供受信时钟');
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch (cause) { fail('TRUSTED_CLOCK_FAILED', '受信时钟调用失败', cause); }
  return timestamp(value instanceof Date ? value.toISOString() : value, 'trustedNow');
}
function assertPublic(value, label = 'output', seen = new Set()) {
  if (typeof value === 'string') {
    if (PRIVATE_VALUE.test(value)) fail('PRIVATE_VALUE_FORBIDDEN', `${label} 含不允许的内容`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('NOT_JSON', `${label} 不得包含循环`);
  seen.add(value);
  if (!Array.isArray(value)) for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) fail('PRIVATE_FIELD_FORBIDDEN', `${label}.${key} 不允许出现`);
    assertPublic(nested, `${label}.${key}`, seen);
  }
  else value.forEach((nested, index) => assertPublic(nested, `${label}[${index}]`, seen));
  seen.delete(value);
}
function normalizeInput(input) {
  exactKeys(input, new Set(['task', 'context']), 'input');
  const task = object(input.task, 'task');
  exactKeys(task, new Set(['summaryZh', 'intentTags']), 'task');
  const context = object(input.context, 'context');
  exactKeys(context, new Set(['organizationId', 'projectId', 'environment', 'allowedPermissions', 'requiredRights']), 'context');
  const summaryZh = text(task.summaryZh, 'task.summaryZh', 240);
  if (/\b(?:prompt|system message|assistant output)\b/i.test(summaryZh)) fail('RAW_PROMPT_FORBIDDEN', '只能提交受限任务摘要');
  return {
    task: { summaryZh, intentTags: list(task.intentTags, 'task.intentTags', { maximum: 30, pattern: TAG, allowEmpty: false }) },
    context: {
      organizationId: text(context.organizationId, 'context.organizationId', 99, ORG_ID),
      projectId: context.projectId == null ? null : text(context.projectId, 'context.projectId', 99, PROJECT_ID),
      environment: text(context.environment, 'context.environment', 128, TOKEN),
      allowedPermissions: list(context.allowedPermissions, 'context.allowedPermissions', { maximum: 100 }),
      requiredRights: list(context.requiredRights ?? DEFAULT_RIGHTS, 'context.requiredRights', { maximum: 20, allowEmpty: false }),
    },
  };
}

function normalizeCatalog(input, validator) {
  if (typeof validator !== 'function') fail('CATALOG_VALIDATOR_REQUIRED', '必须提供受信需求目录校验能力');
  let value;
  try { value = validateDemandCatalogProjection(input); } catch (cause) { fail('CATALOG_NOT_TRUSTED', '需求目录未通过正式校验', cause); }
  let trusted;
  try { trusted = validator(value); } catch (cause) { fail('CATALOG_NOT_TRUSTED', '需求目录未通过受信校验', cause); }
  if (!trusted || trusted.projectionDigest !== value.projectionDigest || canonicalDigest(trusted) !== canonicalDigest(value)) fail('CATALOG_TRUST_MISMATCH', '受信目录与输入不一致');
  object(value, 'catalogProjection');
  if (!DIGEST.test(value.projectionDigest ?? '') || !Array.isArray(value.items) || value.items.length > 10_000) fail('CATALOG_NOT_TRUSTED', '需求目录结构不可信');
  return value;
}

function normalizeLibrary(input, validator) {
  if (typeof validator !== 'function') fail('LIBRARY_VALIDATOR_REQUIRED', '必须提供受信企业授权库校验能力');
  let value;
  try { value = normalizeEnterpriseLibraryProjection(input); } catch (cause) { fail('LIBRARY_NOT_TRUSTED', '企业授权库未通过正式校验', cause); }
  let trusted;
  try { trusted = validator(value); } catch (cause) { fail('LIBRARY_NOT_TRUSTED', '企业授权库未通过受信校验', cause); }
  if (!trusted || trusted.projectionDigest !== value.projectionDigest || canonicalDigest(trusted) !== canonicalDigest(value)) fail('LIBRARY_TRUST_MISMATCH', '受信授权库与输入不一致');
  object(value, 'libraryProjection');
  const entries = value.items ?? value.entitlements;
  if (!DIGEST.test(value.projectionDigest ?? '') || !Array.isArray(entries) || entries.length > 10_000) fail('LIBRARY_NOT_TRUSTED', '企业授权库结构不可信');
  return { value, entries };
}

function taskMatch(item, task) {
  const signalSource = item.taskSignals ?? {};
  const signals = [
    ...(Array.isArray(signalSource) ? signalSource : []),
    ...(Array.isArray(signalSource.intentTags) ? signalSource.intentTags : []),
    ...(Array.isArray(signalSource.whenToUse) ? signalSource.whenToUse : []),
  ];
  const tags = new Set(task.intentTags.map(tag => tag.toLocaleLowerCase('zh-CN')));
  const normalizedSignals = signals.filter(value => typeof value === 'string').map(value => value.normalize('NFC').trim()).filter(Boolean);
  const tagMatches = normalizedSignals.filter(signal => tags.has(signal.toLocaleLowerCase('zh-CN')));
  const summary = task.summaryZh.toLocaleLowerCase('zh-CN');
  const textMatches = normalizedSignals.filter(signal => summary.includes(signal.toLocaleLowerCase('zh-CN')));
  if (typeof signalSource.routingSummary === 'string' && task.intentTags.some(tag => signalSource.routingSummary.includes(tag))) {
    textMatches.push(...task.intentTags.filter(tag => signalSource.routingSummary.includes(tag)));
  }
  const score = tagMatches.length * 100 + textMatches.length * 10;
  return { score, reasons: [...new Set([...tagMatches, ...textMatches])].sort((a, b) => a.localeCompare(b, 'zh-CN')) };
}

function requiredPermissions(item) {
  const routing = item.routing ?? {};
  const values = item.requiredPermissions ?? routing.requiredPermissions ?? [];
  return Array.isArray(values) ? values.filter(value => typeof value === 'string').sort((a, b) => a.localeCompare(b, 'en')) : [];
}

function findLibraryEntry(entries, item) {
  return entries.find(entry => entry?.entitlementId === item?.acquisition?.entitlementId
    && entry.productId === item.productId && (entry.releaseId === item.releaseId || entry.releaseIds?.includes(item.releaseId) || entry.releaseScope?.releaseIds?.includes(item.releaseId))) ?? null;
}

function accessFor(item, libraryEntry, context, at, resolver) {
  if (typeof resolver !== 'function') fail('ACCESS_DECISION_RESOLVER_REQUIRED', '必须提供受信 AccessDecision 解析器');
  const requiredRights = context.requiredRights;
  let raw;
  try {
    raw = resolver({
      entitlementIds: [libraryEntry.entitlementId], organizationId: context.organizationId,
      productId: item.productId, releaseId: item.releaseId, requiredRights,
      projectId: context.projectId, environment: context.environment, checkedAt: at,
    });
  } catch (cause) { fail('ACCESS_DECISION_RESOLVER_FAILED', '受信 AccessDecision 解析失败', cause); }
  let decision;
  try {
    decision = normalizeAccessDecision(raw, {
      organizationId: context.organizationId, productId: item.productId, releaseId: item.releaseId,
      requiredRights, checkedAt: at,
    });
  } catch (cause) { fail('ACCESS_DECISION_NOT_TRUSTED', 'AccessDecision 绑定无效', cause); }
  if (decision.decision === 'allow' && decision.entitlementId !== libraryEntry.entitlementId) fail('ENTITLEMENT_BINDING_MISMATCH', 'AccessDecision 未绑定授权库中的 Entitlement');
  return decision;
}

function recommendation(item, match, context, library, at, resolver) {
  const productId = text(item.productId, 'catalogItem.productId', 69, PRODUCT_ID);
  const releaseId = text(item.releaseId, 'catalogItem.releaseId', 72, RELEASE_ID);
  const titleZh = text(item.titleZh, 'catalogItem.titleZh', 160);
  const acquisition = object(item.acquisition, 'catalogItem.acquisition');
  if (!ACQUISITION.has(acquisition.state)) fail('CATALOG_NOT_TRUSTED', '目录获取状态不受支持');
  const missingPermissions = requiredPermissions(item).filter(permission => !context.allowedPermissions.includes(permission));
  let status = 'blocked';
  let code = acquisition.code ?? 'UNAVAILABLE';
  let entitlement = null;
  let accessDecision = null;
  const dependencyBindings = [];
  if (missingPermissions.length) code = 'PERMISSION_NOT_ALLOWED';
  else if (acquisition.state === 'entitled') {
    entitlement = findLibraryEntry(library.entries, item);
    if (!entitlement || !ENTITLEMENT_ID.test(entitlement.entitlementId ?? '')) code = 'ENTITLEMENT_NOT_IN_LIBRARY';
    else {
      accessDecision = accessFor({ ...item, productId, releaseId }, entitlement, context, at, resolver);
      if (accessDecision.decision === 'allow') { status = 'ready'; code = 'ACCESS_ALLOWED'; }
      else code = accessDecision.code;
    }
  } else if (acquisition.state === 'free_available' || acquisition.state === 'purchase_required') {
    status = 'acquisition_required';
    code = acquisition.state === 'free_available' ? 'FREE_CONFIRMATION_REQUIRED' : 'PURCHASE_CONFIRMATION_REQUIRED';
  }
  if (status === 'ready' && item.abilityType === 'application') {
    for (const dependency of (item.dependencies ?? []).filter(value => value.requirement === 'required')) {
      const dependencyItem = { acquisition: dependency.acquisition, productId: dependency.productId, releaseId: dependency.releaseId };
      const dependencyEntitlement = findLibraryEntry(library.entries, dependencyItem);
      if (!dependencyEntitlement) { status = 'blocked'; code = 'REQUIRED_DEPENDENCY_ENTITLEMENT_MISSING'; break; }
      const dependencyContext = { ...context, requiredRights: dependency.requiredRights };
      const dependencyDecision = accessFor(dependencyItem, dependencyEntitlement, dependencyContext, at, resolver);
      if (dependencyDecision.decision !== 'allow') { status = 'blocked'; code = `REQUIRED_DEPENDENCY_${dependencyDecision.code}`; break; }
      dependencyBindings.push({ productId: dependency.productId, releaseId: dependency.releaseId, entitlementId: dependencyEntitlement.entitlementId, rights: [...dependency.requiredRights] });
    }
  }
  const reasonZh = status === 'ready' ? `已授权并通过调用前检查，匹配：${match.reasons.join('、')}`
    : status === 'acquisition_required' ? `${acquisition.reasonZh ?? '尚未获得授权'}；必须由人确认，技能管家不会自动获取或采购`
      : missingPermissions.length ? `所需权限未获允许：${missingPermissions.join('、')}` : (acquisition.reasonZh ?? `当前不可用：${code}`);
  return {
    productId, releaseId, abilityType: item.abilityType, titleZh, status, code, reasonZh,
    matchReasons: match.reasons, acquisitionState: acquisition.state,
    entitlementId: status === 'ready' ? entitlement.entitlementId : null,
    grantedRights: status === 'ready' ? [...context.requiredRights] : [],
    missingPermissions,
    dependencies: Array.isArray(item.dependencies) ? structuredClone(item.dependencies) : [],
    dependencyBindings: status === 'ready' ? dependencyBindings : [],
  };
}

function workOrder(recommendations, context, catalogDigest, libraryDigest, at) {
  const ready = recommendations.filter(item => item.status === 'ready');
  if (!ready.length) return null;
  const body = {
    schemaVersion: SKILL_STEWARD_SCHEMA_VERSION,
    adapter: 'code.zaowuyun.future.v1', nonExecutable: true,
    organizationId: context.organizationId, projectId: context.projectId, environment: context.environment,
    catalogProjectionDigest: catalogDigest, libraryProjectionDigest: libraryDigest, createdAt: at,
    steps: ready.flatMap(item => [
      { productId: item.productId, releaseId: item.releaseId, entitlementId: item.entitlementId, rights: [...item.grantedRights], environment: context.environment, dependencyOf: null },
      ...item.dependencyBindings.map(dependency => ({ ...dependency, environment: context.environment, dependencyOf: item.productId })),
    ]).map((item, index) => ({ position: index + 1, ...item })),
  };
  return Object.freeze({ ...body, workOrderDigest: canonicalDigest(body) });
}

/**
 * 技能管家只产出可重算的推荐与未来工作台适配草案，不获取、不采购、不执行。
 */
export function createSkillStewardPlan(input, options = {}) {
  exactKeys(options, new Set(['catalogProjection', 'libraryProjection', 'catalogValidator', 'libraryValidator', 'accessDecisionResolver', 'now']), 'options');
  const normalized = normalizeInput(input);
  const at = trustedNow(options.now);
  const catalog = normalizeCatalog(options.catalogProjection, options.catalogValidator);
  const library = normalizeLibrary(options.libraryProjection, options.libraryValidator);
  if (catalog.organizationId !== normalized.context.organizationId || library.value.organizationId !== normalized.context.organizationId) {
    fail('ORGANIZATION_SCOPE_MISMATCH', '目录、授权库与任务组织范围不一致');
  }
  const matched = catalog.items.map(item => ({ item, match: taskMatch(item, normalized.task) }))
    .sort((a, b) => b.match.score - a.match.score || String(a.item.productId).localeCompare(String(b.item.productId), 'en'));
  const selected = matched.filter(value => value.match.score > 0).slice(0, 20);
  const recommendations = selected.map(value => recommendation(value.item, value.match, normalized.context, library, at, options.accessDecisionResolver));
  const notSelected = matched.filter(value => value.match.score === 0).map(value => ({
    productId: value.item.productId, releaseId: value.item.releaseId, titleZh: value.item.titleZh,
    code: 'NO_INTENT_MATCH', reasonZh: '未匹配任务意图，也不是必需依赖',
  }));
  // 候选之间是可替代关系：一个未选候选被阻断，不能盖过另一个已通过全部门禁的候选。
  // required dependency 的缺口已由需求目录折叠进该候选自身的 unavailable 状态。
  const status = recommendations.some(item => item.status === 'ready') ? 'ready'
    : recommendations.some(item => item.status === 'acquisition_required') ? 'acquisition_required' : 'blocked';
  const nextActions = status === 'ready' ? ['核对离线 WorkOrder 草案后，由企业工作台显式接入']
    : status === 'acquisition_required' ? ['由企业人员确认免费获取或发起采购，不会自动下单']
      : ['检查召回、授权、依赖、权限与兼容性阻断原因'];
  const body = {
    schemaVersion: SKILL_STEWARD_SCHEMA_VERSION, status,
    taskSummaryDigest: canonicalDigest({ summaryZh: normalized.task.summaryZh }),
    intentTags: normalized.task.intentTags,
    organizationId: normalized.context.organizationId,
    projectId: normalized.context.projectId,
    environment: normalized.context.environment,
    catalogProjectionDigest: catalog.projectionDigest,
    libraryProjectionDigest: library.value.projectionDigest,
    recommendations, notSelected, nextActions,
    workOrderDraft: status === 'ready' ? workOrder(recommendations, normalized.context, catalog.projectionDigest, library.value.projectionDigest, at) : null,
    generatedAt: at,
  };
  assertPublic(body);
  const plan = { ...body, planDigest: canonicalDigest(body) };
  assertPublic(plan);
  return Object.freeze(plan);
}
