/* managed-distribution.mjs — Registry Release 安装/更新的纯计划层（零依赖）
 *
 * 这一层刻意不读写文件、不访问网络、不执行技能脚本，也不删除任何内容。
 * 它只验证不可变 Release 身份、投影结构化状态、生成确定性计划与 Lock v2 草稿。
 */
import crypto from 'node:crypto';

export const MANAGED_LOCK_SCHEMA_VERSION = 2;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SOURCE_ID = /^regsrc_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const OPERATION_ID = /^op_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const INSTALLATION_ID = /^inst_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const RELEASE_STATES = new Set(['published', 'superseded', 'withdrawn', 'revoked']);
const ACTIONS = new Set(['install', 'update']);

const SENSITIVE_KEY = /(?:token|secret|password|credential|api[_-]?key|prompt|output|content|baseurl|sourceurl|downloadurl)/i;

export class ManagedDistributionError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'ManagedDistributionError';
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code, message, options) {
  throw new ManagedDistributionError(code, message, options);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function text(value, field, { pattern, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${field} 必须是非空字符串`);
  const normalized = value.trim().normalize('NFC');
  if (pattern && !pattern.test(normalized)) fail('INVALID_IDENTITY', `${field} 格式无效`);
  return normalized;
}

function validDate(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const normalized = text(value, field);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TRUST_SNAPSHOT', `${field} 必须是 ISO 日期时间`);
  return new Date(normalized).toISOString();
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_NOW', 'now 必须是有效日期时间');
  return date;
}

function normalizeManifest(input) {
  if (!Array.isArray(input)) fail('INVALID_MANIFEST', 'manifest 必须是文件数组');
  const seen = new Set();
  const rows = input.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_MANIFEST', `manifest[${index}] 必须是对象`);
    const path = text(row.path, `manifest[${index}].path`);
    if (path.startsWith('/') || path.startsWith('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('INVALID_MANIFEST_PATH', `manifest 路径不安全：${path}`);
    }
    if (seen.has(path)) fail('INVALID_MANIFEST', `manifest 路径重复：${path}`);
    seen.add(path);
    const rawFileDigest = text(row.digest ?? row.sha256, `manifest[${index}].digest`);
    const sha256 = DIGEST.test(rawFileDigest)
      ? rawFileDigest.slice('sha256:'.length)
      : (HEX_SHA256.test(rawFileDigest) ? rawFileDigest : null);
    if (!sha256) fail('INVALID_MANIFEST', `manifest[${index}].digest 必须是 SHA-256 摘要`);
    const size = row.size ?? row.bytes;
    if (!Number.isSafeInteger(size) || size < 0) fail('INVALID_MANIFEST', `manifest[${index}].size 必须是非负整数`);
    const mediaType = row.mediaType === undefined ? 'application/octet-stream' : text(row.mediaType, `manifest[${index}].mediaType`);
    const executable = row.executable ?? false;
    if (typeof executable !== 'boolean') fail('INVALID_MANIFEST', `manifest[${index}].executable 必须是布尔值`);
    return { path, size, sha256, mediaType, executable };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return rows;
}

function normalizeTrustSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_TRUST_SNAPSHOT', '缺少 trustSnapshot');
  const snapshot = {
    policyVersion: text(input.policyVersion, 'trustSnapshot.policyVersion'),
    reviewValidUntil: validDate(input.reviewValidUntil, 'trustSnapshot.reviewValidUntil'),
    feedCursor: text(input.feedCursor, 'trustSnapshot.feedCursor'),
  };
  for (const field of ['evalValidUntil', 'packageAuditValidUntil', 'licenseValidUntil']) {
    const value = validDate(input[field], `trustSnapshot.${field}`, { optional: true });
    if (value) snapshot[field] = value;
  }
  for (const field of ['reviewDigest', 'evalDigest', 'packageAuditDigest', 'licenseDigest']) {
    if (input[field] !== undefined) snapshot[field] = text(input[field], `trustSnapshot.${field}`, { pattern: DIGEST });
  }
  return snapshot;
}

function reason(status, code, messageZh, blocking = false, details = undefined) {
  const result = { status, code, blocking, messageZh };
  if (details && Object.keys(details).length) result.details = canonical(details);
  return result;
}

function normalizeTargetState(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_TARGET_STATE', 'targetState 必须是对象');
  const status = input.status ?? null;
  if (status && !['clean', 'missing', 'target_drift', 'unknown'].includes(status)) fail('INVALID_TARGET_STATE', 'targetState.status 不受支持');
  const exists = status ? status !== 'missing' : Boolean(input.exists);
  const managed = status === 'unknown' ? false : Boolean(input.managed);
  const expected = input.deployedFingerprint ? text(input.deployedFingerprint, 'targetState.deployedFingerprint', { pattern: DIGEST }) : null;
  const actual = input.currentFingerprint ? text(input.currentFingerprint, 'targetState.currentFingerprint', { pattern: DIGEST }) : null;
  const drift = status === 'target_drift' || Boolean(input.drift) || (exists && managed && expected && actual && expected !== actual);
  return { exists, managed, drift, deployedFingerprint: expected, currentFingerprint: actual };
}

function normalizeCurrentLock(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_CURRENT_LOCK', 'currentLock 必须是对象');
  return {
    schemaVersion: input.schemaVersion ?? null,
    installationId: input.installationId ? text(input.installationId, 'currentLock.installationId', { pattern: INSTALLATION_ID }) : null,
    skillId: input.skillId ? text(input.skillId, 'currentLock.skillId', { pattern: SKILL_ID }) : null,
    releaseId: input.releaseId ? text(input.releaseId, 'currentLock.releaseId', { pattern: RELEASE_ID }) : null,
    packageDigest: input.packageDigest ? text(input.packageDigest, 'currentLock.packageDigest', { pattern: DIGEST }) : null,
    registrySourceId: input.registrySourceId ? text(input.registrySourceId, 'currentLock.registrySourceId', { pattern: SOURCE_ID }) : null,
    deployedFingerprint: input.deployedFingerprint ? text(input.deployedFingerprint, 'currentLock.deployedFingerprint', { pattern: DIGEST }) : null,
  };
}

function choosePrimaryStatus(reasons) {
  const precedence = ['revoked', 'withdrawn', 'target_drift', 'review_stale', 'missing', 'blocked', 'update_available', 'clean'];
  return precedence.find(status => reasons.some(row => row.status === status)) ?? 'blocked';
}

/**
 * 投影 Registry/Lock/目标三方状态。结果只含结构化 reason，不拼接状态字符串。
 */
export function projectManagedDistributionStatus(input, { now } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '状态输入必须是对象');
  const at = normalizeNow(now);
  const releaseStatus = input.releaseStatus ?? 'published';
  if (!RELEASE_STATES.has(releaseStatus)) fail('INVALID_RELEASE_STATUS', 'releaseStatus 不受支持');
  const target = normalizeTargetState(input.targetState);
  const current = normalizeCurrentLock(input.currentLock);
  const trust = normalizeTrustSnapshot(input.trustSnapshot);
  const reasons = [];

  if (releaseStatus === 'revoked') reasons.push(reason('revoked', 'RELEASE_REVOKED', '目标版本已被安全吊销', true));
  else if (releaseStatus === 'withdrawn') reasons.push(reason('withdrawn', 'RELEASE_WITHDRAWN', '目标版本已撤回，停止新安装与更新', true));

  const expiries = [
    ['reviewValidUntil', 'REVIEW_EXPIRED', '独立人类终审已过期'],
    ['evalValidUntil', 'EVAL_EXPIRED', '运行实绩证据已过期'],
    ['packageAuditValidUntil', 'PACKAGE_AUDIT_EXPIRED', '技能包审计证据已过期'],
    ['licenseValidUntil', 'LICENSE_EVIDENCE_EXPIRED', '许可证据已过期'],
  ];
  for (const [field, code, message] of expiries) {
    if (trust[field] && Date.parse(trust[field]) <= at.getTime()) reasons.push(reason('review_stale', code, message, true, { validUntil: trust[field] }));
  }

  if (target.exists && !target.managed) reasons.push(reason('blocked', 'UNKNOWN_TARGET', '目标目录不属于当前 SkillOps 台账，拒绝覆盖', true));
  if (target.drift) reasons.push(reason('target_drift', 'TARGET_DRIFT', '已管理目标存在本地修改，拒绝覆盖', true));
  if (current && !target.exists) reasons.push(reason('missing', 'TARGET_MISSING', '台账中的安装目标不存在', true));

  if (current && input.releaseId && current.releaseId !== input.releaseId) {
    reasons.push(reason('update_available', 'RELEASE_UPDATE_AVAILABLE', 'Registry 中存在不同的明确版本', false, {
      fromReleaseId: current.releaseId,
      toReleaseId: input.releaseId,
    }));
  }
  if (!reasons.length) reasons.push(reason('clean', 'STATE_CLEAN', current ? '当前安装、信任证据与目标一致' : '目标可用于新安装', false));
  return { primaryStatus: choosePrimaryStatus(reasons), reasons };
}

function blockedCode(reasons) {
  const first = reasons.find(row => row.blocking);
  return first?.code ?? null;
}

/** 生成安全的 Release 安装/更新计划；不会安装或修改任何文件。 */
export function createManagedDistributionPlan(input, { now } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '计划输入必须是对象');
  const action = text(input.action, 'action');
  if (!ACTIONS.has(action)) fail('INVALID_ACTION', 'action 只允许 install 或 update');
  const operationId = text(input.operationId, 'operationId', { pattern: OPERATION_ID });
  const skillId = text(input.skillId, 'skillId', { pattern: SKILL_ID });
  if (skillId.startsWith('cand_') || skillId.includes('/cand_')) fail('CANDIDATE_ID_FORBIDDEN', '不能从 Candidate 身份安装');
  if (input.releaseId === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', '不能以 latest 作为安装身份');
  const releaseId = text(input.releaseId, 'releaseId', { pattern: RELEASE_ID });
  const version = text(input.version, 'version');
  if (version === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', '不能以 latest 作为版本');
  const packageDigest = text(input.packageDigest, 'packageDigest', { pattern: DIGEST });
  const registrySourceId = text(input.registrySourceId, 'registrySourceId', { pattern: SOURCE_ID });
  const manifest = normalizeManifest(input.manifest);
  const manifestDigest = digest(manifest);
  if (input.manifestDigest !== undefined && text(input.manifestDigest, 'manifestDigest', { pattern: DIGEST }) !== manifestDigest) {
    fail('MANIFEST_DIGEST_MISMATCH', 'manifestDigest 与规范化清单不一致');
  }
  const trustSnapshot = normalizeTrustSnapshot(input.trustSnapshot);
  const targetState = normalizeTargetState(input.targetState);
  const currentLock = normalizeCurrentLock(input.currentLock);
  const releaseStatus = input.releaseStatus ?? 'published';

  if (action === 'update' && !currentLock) fail('CURRENT_LOCK_REQUIRED', 'update 必须绑定当前 Lock v2');
  if (currentLock?.skillId && currentLock.skillId !== skillId) fail('LOCK_IDENTITY_MISMATCH', '当前 lock 的 skillId 与计划不一致');
  if (currentLock && targetState.deployedFingerprint && currentLock.deployedFingerprint && targetState.deployedFingerprint !== currentLock.deployedFingerprint) {
    fail('LOCK_FINGERPRINT_MISMATCH', '目标状态与当前 lock 指纹不一致');
  }

  const projection = projectManagedDistributionStatus({
    releaseId, releaseStatus, trustSnapshot, targetState, currentLock,
  }, { now });
  const changes = currentLock ? [{
    kind: 'release',
    from: { releaseId: currentLock.releaseId, packageDigest: currentLock.packageDigest },
    to: { releaseId, packageDigest },
  }] : [{ kind: 'release', from: null, to: { releaseId, packageDigest } }];
  const blocking = projection.reasons.some(row => row.blocking);
  const planBody = {
    schemaVersion: 1,
    action: `${action}.plan`,
    subject: { skillId, releaseId, version, packageDigest, registrySourceId },
    manifest: { digest: manifestDigest, fileCount: manifest.length, totalBytes: manifest.reduce((sum, row) => sum + row.size, 0) },
    trustSnapshot,
    changes,
    reasons: projection.reasons,
  };
  const planDigest = digest(planBody);
  const lockDraft = blocking ? null : {
    schemaVersion: MANAGED_LOCK_SCHEMA_VERSION,
    skillId, releaseId, version, packageDigest, registrySourceId,
    manifestDigest,
    trustSnapshot,
    state: projection.primaryStatus === 'update_available' ? 'update_available' : 'clean',
  };
  return {
    schemaVersion: 1,
    operationId,
    action: `${action}.plan`,
    status: blocking ? 'blocked' : (currentLock?.releaseId === releaseId && currentLock?.packageDigest === packageDigest ? 'unchanged' : 'ready'),
    distributionStatus: projection.primaryStatus,
    subject: planBody.subject,
    planDigest,
    changes,
    warnings: projection.reasons.filter(row => !row.blocking && row.status !== 'clean'),
    requiredConfirmations: blocking ? [] : [{ kind: 'plan_digest', value: planDigest, messageZh: '安装或更新确认必须绑定本计划摘要' }],
    evidenceRefs: Object.entries(trustSnapshot).filter(([key]) => key.endsWith('Digest')).map(([, value]) => value).sort(),
    reasons: projection.reasons,
    lockDraft,
    error: blocking ? { code: blockedCode(projection.reasons), messageZh: '当前计划未通过安全预检', retryable: false } : null,
  };
}

/**
 * 以不可变数组记录幂等操作。相同 operationId + planDigest 重放，换摘要则冲突。
 */
export function claimManagedOperation(records, plan) {
  if (!Array.isArray(records)) fail('INVALID_OPERATION_LOG', 'records 必须是数组');
  if (!plan || typeof plan !== 'object') fail('INVALID_PLAN', '缺少计划');
  const operationId = text(plan.operationId, 'plan.operationId', { pattern: OPERATION_ID });
  const planDigest = text(plan.planDigest, 'plan.planDigest', { pattern: DIGEST });
  const existing = records.find(row => row?.operationId === operationId);
  if (existing) {
    if (existing.planDigest !== planDigest) fail('OPERATION_CONFLICT', '相同 operationId 不能绑定不同 planDigest');
    return { action: 'replayed', record: canonical(existing), records: records.map(canonical) };
  }
  const record = { operationId, planDigest, action: plan.action, status: plan.status, subject: canonical(plan.subject) };
  return { action: 'recorded', record, records: [...records.map(canonical), record] };
}

/**
 * 将 ready/unchanged 计划封装为本机 Lock v2 记录。targetPath 仅存在于该本地记录。
 */
export function createManagedLockV2(plan, input) {
  if (!plan?.lockDraft || !['ready', 'unchanged'].includes(plan.status)) fail('PLAN_NOT_INSTALLABLE', '只有通过预检的计划才能形成 Lock v2');
  if (!input || typeof input !== 'object') fail('INVALID_LOCK_INPUT', '缺少 Lock v2 安装结果');
  const installationId = text(input.installationId, 'installationId', { pattern: INSTALLATION_ID });
  const targetPath = text(input.targetPath, 'targetPath');
  const deployedFingerprint = text(input.deployedFingerprint, 'deployedFingerprint', { pattern: DIGEST });
  const sourceFingerprint = input.sourceFingerprint
    ? text(input.sourceFingerprint, 'sourceFingerprint', { pattern: DIGEST })
    : plan.subject.packageDigest;
  const installedAt = validDate(input.installedAt, 'installedAt');
  return canonical({
    ...plan.lockDraft,
    installationId,
    targetPath,
    sourceFingerprint,
    deployedFingerprint,
    installedAt,
    planDigest: plan.planDigest,
  });
}

/** 用于测试/导出前的隐私检查；返回 true，发现敏感信息则失败关闭。 */
export function assertManagedDistributionPrivacy(value) {
  const visit = (node, keyPath = []) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, [...keyPath, String(index)]));
    if (!node || typeof node !== 'object') {
      if (typeof node === 'string' && /https?:\/\/[^\s]+(?:\?|#|\/private\/)/i.test(node)) {
        fail('PRIVATE_SOURCE_URL', `发现不应导出的绝对来源 URL：${keyPath.join('.')}`);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (SENSITIVE_KEY.test(key)) fail('SENSITIVE_FIELD', `发现敏感字段：${[...keyPath, key].join('.')}`);
      visit(child, [...keyPath, key]);
    }
  };
  visit(value);
  return true;
}
