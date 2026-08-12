/* coach-proposal.mjs — SkillOps Coach 隔离提案的纯数据契约。
 *
 * 本模块不调用模型、不读取或写入技能文件、不执行脚本。它只登记摘要化证据、
 * 摘要化变更意图，以及主人接受后必须重新进入可信供给链的请求。
 */
import crypto from 'node:crypto';

export const COACH_PROPOSAL_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const SENSITIVE_KEY = /(?:content|prompt|output|token|secret|password|credential|api[_-]?key|command|script|sourcecode|body|text)/i;
const SCRIPT_PATH = /(?:^|\/)(?:scripts?|bin)(?:\/|$)|\.(?:c?js|mjs|sh|bash|zsh|fish|py|rb|pl|ps1|bat|cmd)$/i;
const DIMENSIONS = new Set([
  'clarity', 'invocability', 'executability', 'stability', 'quality',
  'reusability', 'composability', 'evaluability', 'safety', 'business',
]);
const EVIDENCE_KINDS = new Set([
  'sms_assessment', 'eval_failure', 'usage_error', 'performance_summary', 'package_audit',
]);
const OPERATIONS = new Set(['add', 'replace', 'remove']);

const CREATE_KEYS = new Set([
  'skillId', 'baseReleaseId', 'basePackageDigest', 'evidence', 'weakDimensions',
  'changes', 'generator', 'createdAt',
]);
const PROPOSAL_KEYS = new Set([
  'schemaVersion', 'kind', 'proposalId', 'skillId', 'base', 'evidence', 'evidenceDigest',
  'weakDimensions', 'changes', 'patchDigest', 'generator', 'createdAt', 'proposalDigest',
]);
const BASE_KEYS = new Set(['releaseId', 'packageDigest']);
const EVIDENCE_KEYS = new Set(['kind', 'digest']);
const DIMENSION_KEYS = new Set(['key', 'score']);
const CHANGE_KEYS = new Set(['operation', 'path', 'beforeSha256', 'afterSha256']);
const GENERATOR_KEYS = new Set(['kind', 'name', 'version']);
const ACCEPTANCE_KEYS = new Set(['acceptedBy', 'acceptedAt', 'sourceRevision', 'expectedProposalDigest']);

export class CoachProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoachProposalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoachProposalError(code, message);
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

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象`);
  return value;
}

function assertNoSensitiveKeys(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail('PRIVATE_FIELD_FORBIDDEN', `不允许私密或正文参数：${[...path, key].join('.')}`);
    assertNoSensitiveKeys(nested, [...path, key]);
  }
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('PRIVATE_FIELD_FORBIDDEN', `${label} 不允许字段：${unknown.join(', ')}`);
}

function text(value, label, pattern, maximum = 256) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REFERENCE', `${label} 必须是非空字符串`);
  const normalized = value.trim().normalize('NFC');
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_REFERENCE', `${label} 格式无效`);
  }
  return normalized;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_DIGEST', `${label} 必须是 SHA-256 摘要`);
  return value;
}

function timestamp(value, label) {
  const normalized = text(value, label, null, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} 必须是有效时间`);
  return new Date(normalized).toISOString();
}

function skillId(value) {
  const normalized = text(value, 'skillId', SKILL_ID);
  if (normalized.includes('/cand_')) fail('CANDIDATE_ID_FORBIDDEN', 'skillId 不能使用 Candidate 身份');
  return normalized;
}

function normalizeBase(value) {
  exactKeys(value, BASE_KEYS, 'base');
  return {
    releaseId: text(value.releaseId, 'base.releaseId', RELEASE_ID),
    packageDigest: sha256(value.packageDigest, 'base.packageDigest'),
  };
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail('INVALID_EVIDENCE', 'evidence 必须是非空数组');
  const normalized = value.map((row, index) => {
    exactKeys(row, EVIDENCE_KEYS, `evidence[${index}]`);
    if (!EVIDENCE_KINDS.has(row.kind)) fail('INVALID_EVIDENCE', `evidence[${index}].kind 不受支持`);
    return { kind: row.kind, digest: sha256(row.digest, `evidence[${index}].digest`) };
  }).sort((a, b) => compareText(`${a.kind}\0${a.digest}`, `${b.kind}\0${b.digest}`));
  const identities = normalized.map(row => `${row.kind}\0${row.digest}`);
  if (new Set(identities).size !== identities.length) fail('DUPLICATE_EVIDENCE', 'evidence 不得重复');
  return normalized;
}

function normalizeWeakDimensions(value) {
  if (!Array.isArray(value) || !value.length || value.length > DIMENSIONS.size) {
    fail('INVALID_WEAK_DIMENSIONS', 'weakDimensions 必须是非空 SMS 维度数组');
  }
  const normalized = value.map((row, index) => {
    exactKeys(row, DIMENSION_KEYS, `weakDimensions[${index}]`);
    if (!DIMENSIONS.has(row.key)) fail('INVALID_WEAK_DIMENSIONS', `weakDimensions[${index}].key 无效`);
    if (!Number.isInteger(row.score) || row.score < 0 || row.score > 10) {
      fail('INVALID_WEAK_DIMENSIONS', `weakDimensions[${index}].score 必须是 0 到 10 的整数`);
    }
    return { key: row.key, score: row.score };
  }).sort((a, b) => compareText(a.key, b.key));
  if (new Set(normalized.map(row => row.key)).size !== normalized.length) fail('DUPLICATE_DIMENSION', 'weakDimensions 不得重复');
  return normalized;
}

function normalizeChangePath(value, label) {
  const normalized = text(value, label, null, 512).replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('UNSAFE_CHANGE_PATH', `${label} 必须是安全相对路径`);
  }
  if (SCRIPT_PATH.test(normalized)) fail('SCRIPT_CHANGE_FORBIDDEN', `${label} 不允许脚本变更`);
  return normalized;
}

function normalizeChanges(value) {
  if (!Array.isArray(value) || !value.length || value.length > 200) fail('INVALID_CHANGE', 'changes 必须是非空数组');
  const normalized = value.map((row, index) => {
    exactKeys(row, CHANGE_KEYS, `changes[${index}]`);
    const operation = row.operation;
    if (!OPERATIONS.has(operation)) fail('INVALID_CHANGE', `changes[${index}].operation 无效`);
    const path = normalizeChangePath(row.path, `changes[${index}].path`);
    const hasBefore = row.beforeSha256 !== undefined && row.beforeSha256 !== null;
    const hasAfter = row.afterSha256 !== undefined && row.afterSha256 !== null;
    if ((operation === 'add' && (hasBefore || !hasAfter))
      || (operation === 'remove' && (!hasBefore || hasAfter))
      || (operation === 'replace' && (!hasBefore || !hasAfter))) {
      fail('INVALID_CHANGE', `${operation} 的 beforeSha256/afterSha256 组合无效`);
    }
    const result = { operation, path };
    if (hasBefore) result.beforeSha256 = sha256(row.beforeSha256, `changes[${index}].beforeSha256`);
    if (hasAfter) result.afterSha256 = sha256(row.afterSha256, `changes[${index}].afterSha256`);
    if (operation === 'replace' && result.beforeSha256 === result.afterSha256) fail('NOOP_CHANGE', 'replace 不能使用相同的前后摘要');
    return result;
  }).sort((a, b) => compareText(a.path, b.path) || compareText(a.operation, b.operation));
  if (new Set(normalized.map(row => row.path)).size !== normalized.length) fail('DUPLICATE_CHANGE_PATH', '同一路径只能出现一个变更');
  return normalized;
}

function normalizeGenerator(value) {
  exactKeys(value, GENERATOR_KEYS, 'generator');
  const kind = text(value.kind, 'generator.kind', /^[a-z][a-z0-9_-]{0,31}$/);
  return {
    kind,
    name: text(value.name, 'generator.name', REFERENCE),
    version: text(value.version, 'generator.version', VERSION, 64),
  };
}

function proposalBody(value) {
  return {
    schemaVersion: COACH_PROPOSAL_SCHEMA_VERSION,
    kind: 'coach.proposal',
    skillId: value.skillId,
    base: value.base,
    evidence: value.evidence,
    evidenceDigest: value.evidenceDigest,
    weakDimensions: value.weakDimensions,
    changes: value.changes,
    patchDigest: value.patchDigest,
    generator: value.generator,
    createdAt: value.createdAt,
  };
}

export function createCoachProposal(input) {
  assertNoSensitiveKeys(input);
  exactKeys(input, CREATE_KEYS, 'coach proposal input');
  const normalizedSkillId = skillId(input.skillId);
  const evidence = normalizeEvidence(input.evidence);
  const changes = normalizeChanges(input.changes);
  const value = {
    schemaVersion: COACH_PROPOSAL_SCHEMA_VERSION,
    kind: 'coach.proposal',
    skillId: normalizedSkillId,
    base: normalizeBase({ releaseId: input.baseReleaseId, packageDigest: input.basePackageDigest }),
    evidence,
    evidenceDigest: digest(evidence),
    weakDimensions: normalizeWeakDimensions(input.weakDimensions),
    changes,
    patchDigest: digest(changes),
    generator: normalizeGenerator(input.generator),
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
  const proposalDigest = digest(proposalBody(value));
  return deepFreeze(canonical({
    ...value,
    proposalId: `coachprop_${proposalDigest.slice('sha256:'.length)}`,
    proposalDigest,
  }));
}

export function validateCoachProposal(input) {
  assertNoSensitiveKeys(input);
  exactKeys(input, PROPOSAL_KEYS, 'coach proposal');
  if (input.schemaVersion !== COACH_PROPOSAL_SCHEMA_VERSION || input.kind !== 'coach.proposal') {
    fail('UNSUPPORTED_SCHEMA', 'coach proposal schema 或 kind 不受支持');
  }
  const value = {
    schemaVersion: COACH_PROPOSAL_SCHEMA_VERSION,
    kind: 'coach.proposal',
    skillId: skillId(input.skillId),
    base: normalizeBase(input.base),
    evidence: normalizeEvidence(input.evidence),
    evidenceDigest: sha256(input.evidenceDigest, 'evidenceDigest'),
    weakDimensions: normalizeWeakDimensions(input.weakDimensions),
    changes: normalizeChanges(input.changes),
    patchDigest: sha256(input.patchDigest, 'patchDigest'),
    generator: normalizeGenerator(input.generator),
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
  const calculatedEvidenceDigest = digest(value.evidence);
  if (value.evidenceDigest !== calculatedEvidenceDigest) fail('EVIDENCE_DIGEST_MISMATCH', 'evidenceDigest 与规范证据不一致');
  const calculatedPatchDigest = digest(value.changes);
  if (value.patchDigest !== calculatedPatchDigest) fail('PATCH_DIGEST_MISMATCH', 'patchDigest 与规范变更不一致');
  const calculatedProposalDigest = digest(proposalBody(value));
  if (input.proposalDigest !== calculatedProposalDigest) fail('PROPOSAL_DIGEST_MISMATCH', 'proposalDigest 与规范提案不一致');
  const proposalId = `coachprop_${calculatedProposalDigest.slice('sha256:'.length)}`;
  if (input.proposalId !== proposalId) fail('PROPOSAL_ID_MISMATCH', 'proposalId 与 proposalDigest 不一致');
  return deepFreeze(canonical({ ...value, proposalId, proposalDigest: calculatedProposalDigest }));
}

export function acceptCoachProposal(proposalInput, acceptanceInput) {
  const proposal = validateCoachProposal(proposalInput);
  assertNoSensitiveKeys(acceptanceInput);
  exactKeys(acceptanceInput, ACCEPTANCE_KEYS, 'coach proposal acceptance');
  const expectedProposalDigest = sha256(acceptanceInput.expectedProposalDigest, 'expectedProposalDigest');
  if (expectedProposalDigest !== proposal.proposalDigest) {
    fail('PROPOSAL_CONFIRMATION_MISMATCH', '确认摘要与当前 proposalDigest 不一致');
  }
  const acceptedBy = text(acceptanceInput.acceptedBy, 'acceptedBy', REFERENCE);
  const acceptedAt = timestamp(acceptanceInput.acceptedAt, 'acceptedAt');
  const sourceRevision = text(acceptanceInput.sourceRevision, 'sourceRevision', REFERENCE);
  const acceptedByDigest = digest({ kind: 'coach.acceptor.v1', principalId: acceptedBy });
  const requiredPipeline = ['package', 'audit', 'sms', 'eval', 'review', 'registry']
    .map(stage => ({ stage, status: 'required' }));
  const body = {
    schemaVersion: COACH_PROPOSAL_SCHEMA_VERSION,
    action: 'source_revision.requested',
    status: 'pending',
    skillId: proposal.skillId,
    base: proposal.base,
    sourceRevision,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acceptedByDigest,
    acceptedAt,
    requiredPipeline,
    mutatesSource: false,
    executesSkill: false,
  };
  const requestDigest = digest(body);
  return deepFreeze(canonical({
    ...body,
    requestId: `srreq_${requestDigest.slice('sha256:'.length)}`,
    requestDigest,
  }));
}
