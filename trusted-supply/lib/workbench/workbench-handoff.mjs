import { canonicalDigest } from '../registry-identity.mjs';

export const WORKBENCH_HANDOFF_SCHEMA_VERSION = 1;
export const WORKBENCH_HANDOFF_KIND = 'skillops.workbench-handoff.v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SKILL_REF = /^previewskill_[a-f0-9]{64}$/;
const HANDOFF_ID = /^wbh_[a-f0-9]{64}$/;
const ORG_ID = /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|(?:file:\/\/|(?:^|[\s：:])\/(?:[^\s/]+\/)*[^\s/]+)|(?:^|[\s：:])[A-Za-z]:\\|\\\\[^\s\\]+\\|https?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/i;

export class WorkbenchHandoffError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkbenchHandoffError';
    this.code = code;
  }
}

function fail(code, message, cause) { throw new WorkbenchHandoffError(code, message, cause); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} 必须是对象`);
  return value;
}
function exact(value, keys, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !keys.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} 含未知字段：${unknown.join(', ')}`);
}
function text(value, label, maximum, pattern) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} 必须是非空字符串`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) fail('INVALID_TEXT', `${label} 格式无效`);
  if (PRIVATE_VALUE.test(normalized)) fail('PRIVATE_VALUE_FORBIDDEN', `${label} 含不允许的内容`);
  return normalized;
}
function list(value, label, maximum = 20) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) fail('INVALID_ARRAY', `${label} 必须是非空受限数组`);
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 64, TAG));
  if (new Set(result).size !== result.length) fail('DUPLICATE_VALUE', `${label} 不得重复`);
  return result.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} 必须是有效时间`);
  return new Date(Date.parse(normalized)).toISOString();
}
function canonicalBody(input, issuedAt, expiresAt) {
  exact(input, new Set(['task', 'skill', 'context']), 'handoffInput');
  exact(input.task, new Set(['summaryZh', 'intentTags']), 'handoffInput.task');
  exact(input.skill, new Set(['skillRef', 'titleZh', 'originalName', 'category', 'versionFingerprint', 'distribution', 'smsTotal', 'smsTier', 'evalStatus', 'installStatus']), 'handoffInput.skill');
  exact(input.context, new Set(['organizationId', 'projectId', 'environment']), 'handoffInput.context');
  const smsTotal = input.skill.smsTotal == null ? null : Number(input.skill.smsTotal);
  if (smsTotal !== null && (!Number.isInteger(smsTotal) || smsTotal < 0 || smsTotal > 100)) fail('INVALID_SMS_TOTAL', 'SMS 分数无效');
  return {
    schemaVersion: WORKBENCH_HANDOFF_SCHEMA_VERSION,
    kind: WORKBENCH_HANDOFF_KIND,
    status: 'ready_for_workbench',
    task: {
      summaryZh: text(input.task.summaryZh, 'handoffInput.task.summaryZh', 240),
      intentTags: list(input.task.intentTags, 'handoffInput.task.intentTags'),
    },
    skill: {
      skillRef: text(input.skill.skillRef, 'handoffInput.skill.skillRef', 77, SKILL_REF),
      titleZh: text(input.skill.titleZh, 'handoffInput.skill.titleZh', 160),
      originalName: text(input.skill.originalName, 'handoffInput.skill.originalName', 160),
      category: text(input.skill.category, 'handoffInput.skill.category', 64, TAG),
      versionFingerprint: text(input.skill.versionFingerprint, 'handoffInput.skill.versionFingerprint', 71, DIGEST),
      distribution: text(input.skill.distribution, 'handoffInput.skill.distribution', 64, TOKEN),
      smsTotal,
      smsTier: text(input.skill.smsTier, 'handoffInput.skill.smsTier', 16, TOKEN),
      evalStatus: text(input.skill.evalStatus, 'handoffInput.skill.evalStatus', 64, TOKEN),
      installStatus: text(input.skill.installStatus, 'handoffInput.skill.installStatus', 64, TOKEN),
    },
    context: {
      organizationId: text(input.context.organizationId, 'handoffInput.context.organizationId', 99, ORG_ID),
      projectId: input.context.projectId == null ? null : text(input.context.projectId, 'handoffInput.context.projectId', 128, TOKEN),
      environment: text(input.context.environment, 'handoffInput.context.environment', 64, TOKEN),
    },
    adapter: {
      current: 'skillops.steward.local.v1',
      future: 'code.zaowuyun.workbench.v1',
    },
    experience: {
      mode: 'guided_preview',
      executionStatus: 'not_started',
      nonExecutable: true,
      boundaryZh: '工作单只固定任务、技能版本与可信边界；本服务不调用模型，不执行第三方脚本。',
    },
    issuedAt,
    expiresAt,
  };
}

export function createWorkbenchHandoff(input, { now, ttlMs = 30 * 60 * 1000 } = {}) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', '必须提供受信时钟');
  let clockValue;
  try { clockValue = typeof now === 'function' ? now() : now; } catch (cause) { fail('TRUSTED_CLOCK_FAILED', '受信时钟调用失败', cause); }
  const issuedAt = timestamp(clockValue instanceof Date ? clockValue.toISOString() : clockValue, 'now');
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) fail('INVALID_TTL', '工作单有效期无效');
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  const body = canonicalBody(input, issuedAt, expiresAt);
  const handoffDigest = canonicalDigest(body);
  return Object.freeze({ ...body, handoffId: `wbh_${handoffDigest.slice(7)}`, handoffDigest });
}

export function validateWorkbenchHandoff(value, { at } = {}) {
  exact(value, new Set(['schemaVersion', 'kind', 'status', 'task', 'skill', 'context', 'adapter', 'experience', 'issuedAt', 'expiresAt', 'handoffId', 'handoffDigest']), 'handoff');
  const body = canonicalBody({ task: value.task, skill: value.skill, context: value.context }, timestamp(value.issuedAt, 'handoff.issuedAt'), timestamp(value.expiresAt, 'handoff.expiresAt'));
  if (value.schemaVersion !== 1 || value.kind !== WORKBENCH_HANDOFF_KIND || value.status !== 'ready_for_workbench') fail('INVALID_HANDOFF', '工作单类型或状态无效');
  exact(value.adapter, new Set(['current', 'future']), 'handoff.adapter');
  exact(value.experience, new Set(['mode', 'executionStatus', 'nonExecutable', 'boundaryZh']), 'handoff.experience');
  if (value.adapter.current !== body.adapter.current || value.adapter.future !== body.adapter.future
    || value.experience.mode !== body.experience.mode || value.experience.executionStatus !== body.experience.executionStatus
    || value.experience.nonExecutable !== true || value.experience.boundaryZh !== body.experience.boundaryZh) fail('INVALID_HANDOFF', '工作单执行边界无效');
  const digest = canonicalDigest(body);
  if (!DIGEST.test(value.handoffDigest ?? '') || value.handoffDigest !== digest || value.handoffId !== `wbh_${digest.slice(7)}` || !HANDOFF_ID.test(value.handoffId ?? '')) fail('HANDOFF_DIGEST_MISMATCH', '工作单摘要不匹配');
  if (Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) fail('INVALID_HANDOFF_WINDOW', '工作单有效期无效');
  if (at !== undefined && Date.parse(timestamp(at instanceof Date ? at.toISOString() : at, 'at')) >= Date.parse(body.expiresAt)) fail('HANDOFF_EXPIRED', '工作单已过期');
  return Object.freeze({ ...body, handoffId: value.handoffId, handoffDigest: value.handoffDigest });
}
