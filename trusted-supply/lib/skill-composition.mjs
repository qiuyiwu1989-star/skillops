import crypto from 'node:crypto';

import { isSkillRecordCurrent, validateSkillRecord } from './skill-record.mjs';

export const SKILL_COMPOSITION_SCHEMA_VERSION = 1;

const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const PERMISSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const PUBLIC_KEY_FORBIDDEN = /(?:cand|candidate|path|storage(?:ref)?|principal|reviewer|prompt|output|token|secret|password|credential|api[_-]?key|content)/i;
const PUBLIC_VALUE_FORBIDDEN = /(?:^cand_|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*\S{8,})/i;
const EVIDENCE_FIELDS = ['sms', 'eval', 'review', 'packageAudit'];

export class SkillCompositionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillCompositionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillCompositionError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${field} 必须是对象`);
  return value;
}

function exactKeys(value, allowed, field) {
  object(value, field);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${field} 含未知字段：${unknown.join(', ')}`);
}

function text(value, field, { maximum = 512, pattern } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${field} 必须是非空字符串`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${field} 格式无效`);
  }
  return normalized;
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

function stringList(value, field, { pattern, maximum = 100, itemMaximum = 128, optional = false } = {}) {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail('INVALID_LIST', `${field} 必须是受限数组`);
  const result = value.map((item, index) => text(item, `${field}[${index}]`, { maximum: itemMaximum, pattern }));
  if (new Set(result).size !== result.length) fail('DUPLICATE_VALUE', `${field} 不得重复`);
  return result.sort((a, b) => a.localeCompare(b, 'en'));
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_NOW', 'now 必须是有效时间');
  return date.getTime();
}

function semverParts(value, field) {
  const version = text(value, field, { maximum: 128 });
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) fail('INVALID_VERSION', `${field} 必须是 SemVer`);
  return { version, parts: match.slice(1, 4).map(Number) };
}

function expectedReleaseId(skillId, version, packageDigest) {
  return `rel_${crypto.createHash('sha256').update(`skillops.release.v1\0${skillId}\0${version}\0${packageDigest}`, 'utf8').digest('hex')}`;
}

function assertPublic(value, field = 'publicOutput') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublic(item, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (PUBLIC_KEY_FORBIDDEN.test(key)) fail('PRIVATE_DATA_FORBIDDEN', `${field}.${key} 不允许进入公共计划`);
      assertPublic(nested, `${field}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && PUBLIC_VALUE_FORBIDDEN.test(value)) fail('PRIVATE_DATA_FORBIDDEN', `${field} 含非公开值`);
}

function normalizeTask(input) {
  exactKeys(input, new Set(['summaryZh', 'intentTags', 'requirements']), 'taskIntent');
  const summaryZh = text(input.summaryZh, 'taskIntent.summaryZh', { maximum: 240 });
  if (/\b(?:prompt|system message|assistant output)\b/i.test(summaryZh)) fail('RAW_PROMPT_FORBIDDEN', 'taskIntent 只能是任务摘要，不能是原始 prompt');
  return {
    summaryZh,
    intentTags: stringList(input.intentTags, 'taskIntent.intentTags', { pattern: TAG, maximum: 30 }),
    requirements: stringList(input.requirements, 'taskIntent.requirements', { pattern: TAG, maximum: 30, optional: true }),
  };
}

function normalizeEnvironment(input) {
  exactKeys(input, new Set(['contract', 'target']), 'environment');
  return {
    contract: text(input.contract, 'environment.contract', { maximum: 128 }),
    target: text(input.target, 'environment.target', { maximum: 64, pattern: TAG }),
  };
}

function normalizePermissions(input) {
  exactKeys(input, new Set(['allow']), 'permissions');
  return { allow: stringList(input.allow, 'permissions.allow', { pattern: PERMISSION_TOKEN, maximum: 100, itemMaximum: 256 }) };
}

function normalizePolicy(input = {}) {
  exactKeys(input, new Set(['requiredEvidence']), 'policy');
  const requiredEvidence = input.requiredEvidence === undefined
    ? [...EVIDENCE_FIELDS]
    : stringList(input.requiredEvidence, 'policy.requiredEvidence', { pattern: TAG, maximum: EVIDENCE_FIELDS.length });
  if (requiredEvidence.length !== EVIDENCE_FIELDS.length || EVIDENCE_FIELDS.some(kind => !requiredEvidence.includes(kind))) {
    fail('HARD_GATE_WEAKENING_FORBIDDEN', 'requiredEvidence 必须包含 sms、eval、review、packageAudit 全部硬门');
  }
  return { requiredEvidence: [...EVIDENCE_FIELDS] };
}

function normalizeDependency(row, field) {
  exactKeys(row, new Set(['skillId', 'releaseId', 'reason']), field);
  return {
    skillId: text(row.skillId, `${field}.skillId`, { maximum: 127, pattern: SKILL_ID }),
    releaseId: row.releaseId === null ? null : text(row.releaseId, `${field}.releaseId`, { maximum: 80, pattern: RELEASE_ID }),
    reason: text(row.reason, `${field}.reason`, { maximum: 240 }),
  };
}

function normalizeRecord(input, index, release) {
  const field = `records[${index}]`;
  object(input, field);
  if (!release) fail('RELEASE_REQUIRED', `${field} 缺少明确的 canonical Release`);
  if (!isSkillRecordCurrent(input, { release })) fail('SKILL_RECORD_NOT_CURRENT', `${field} 未通过 Record/Release 当前绑定校验`);
  let strict;
  try { strict = validateSkillRecord(input, { release }); } catch (error) { fail('SKILL_RECORD_INVALID', `${field} 无效：${error.message}`); }
  const skillId = text(strict.skillId, `${field}.skillId`, { maximum: 127, pattern: SKILL_ID });
  const releaseId = text(strict.releaseId, `${field}.releaseId`, { maximum: 80, pattern: RELEASE_ID });
  const { version, parts } = semverParts(strict.version, `${field}.version`);
  const packageDigest = text(strict.packageDigest, `${field}.packageDigest`, { maximum: 71, pattern: DIGEST });
  if (releaseId !== expectedReleaseId(skillId, version, packageDigest)) fail('RELEASE_ID_MISMATCH', `${field} Release 身份无法重算`);
  const routing = object(strict.routing, `${field}.routing`);
  const metadata = object(strict.metadata, `${field}.metadata`);
  const dependencies = object(strict.dependencies, `${field}.dependencies`);
  const permissions = object(strict.permissions, `${field}.permissions`);
  const compatibility = object(strict.compatibility, `${field}.compatibility`);
  const evidence = object(strict.evidence, `${field}.evidence`);
  const tags = stringList(routing.intentTags, `${field}.routing.intentTags`, { pattern: TAG, maximum: 30 });
  return {
    skillId, releaseId, version, versionParts: parts, packageDigest,
    recordDigest: text(strict.recordDigest, `${field}.recordDigest`, { maximum: 71, pattern: DIGEST }),
    routingDigest: text(strict.routingDigest, `${field}.routingDigest`, { maximum: 71, pattern: DIGEST }),
    titleZh: text(metadata.titleZh, `${field}.metadata.titleZh`, { maximum: 160 }),
    routingSummary: text(routing.summary, `${field}.routing.summary`, { maximum: 500 }),
    whenToUse: stringList(routing.whenToUse, `${field}.routing.whenToUse`, { maximum: 50 }),
    whenNotToUse: stringList(routing.whenNotToUse, `${field}.routing.whenNotToUse`, { maximum: 50 }),
    positiveExamples: routing.examples.filter(example => example.expectedUse).map(example => example.task),
    negativeExamples: routing.examples.filter(example => !example.expectedUse).map(example => example.task),
    tags,
    dependencies: Object.fromEntries(['required', 'optional', 'conflicts'].map(kind => {
      if (!Array.isArray(dependencies[kind])) fail('INVALID_RECORD', `${field}.dependencies.${kind} 必须是数组`);
      return [kind, dependencies[kind].map((row, rowIndex) => normalizeDependency(row, `${field}.dependencies.${kind}[${rowIndex}]`))];
    })),
    permissions: {
      required: stringList(permissions.required, `${field}.permissions.required`, { pattern: PERMISSION_TOKEN, maximum: 100, itemMaximum: 256 }),
      optional: stringList(permissions.optional, `${field}.permissions.optional`, { pattern: PERMISSION_TOKEN, maximum: 100, itemMaximum: 256 }),
      prohibited: stringList(permissions.prohibited, `${field}.permissions.prohibited`, { pattern: PERMISSION_TOKEN, maximum: 100, itemMaximum: 256 }),
    },
    compatibility: {
      contract: text(compatibility.contract, `${field}.compatibility.contract`, { maximum: 128 }),
      targets: stringList(compatibility.targets, `${field}.compatibility.targets`, { pattern: TAG, maximum: 50 }),
    },
    evidence: {
      sms: text(evidence.smsDigest, `${field}.evidence.smsDigest`, { maximum: 71, pattern: DIGEST }),
      eval: text(evidence.evalDigest, `${field}.evidence.evalDigest`, { maximum: 71, pattern: DIGEST }),
      review: text(evidence.reviewEvidenceDigest, `${field}.evidence.reviewEvidenceDigest`, { maximum: 71, pattern: DIGEST }),
      reviewPolicy: text(evidence.reviewPolicyDigest, `${field}.evidence.reviewPolicyDigest`, { maximum: 71, pattern: DIGEST }),
    },
  };
}

function normalizeEvidenceSnapshots(value, records, now, requiredEvidence) {
  if (!Array.isArray(value)) fail('EVIDENCE_SNAPSHOTS_REQUIRED', '必须提供受信的 evidenceSnapshots');
  const result = new Map();
  for (const [index, row] of value.entries()) {
    const field = `evidenceSnapshots[${index}]`;
    exactKeys(row, new Set(['skillId', 'releaseId', 'packageDigest', 'recordDigest', 'validUntil']), field);
    const normalized = {
      skillId: text(row.skillId, `${field}.skillId`, { pattern: SKILL_ID, maximum: 127 }),
      releaseId: text(row.releaseId, `${field}.releaseId`, { pattern: RELEASE_ID, maximum: 80 }),
      packageDigest: text(row.packageDigest, `${field}.packageDigest`, { pattern: DIGEST, maximum: 71 }),
      recordDigest: text(row.recordDigest, `${field}.recordDigest`, { pattern: DIGEST, maximum: 71 }),
      validUntil: object(row.validUntil, `${field}.validUntil`),
    };
    if (result.has(normalized.skillId)) fail('DUPLICATE_EVIDENCE_SNAPSHOT', `重复证据快照：${normalized.skillId}`);
    const record = records.find(item => item.skillId === normalized.skillId);
    if (!record || record.releaseId !== normalized.releaseId || record.packageDigest !== normalized.packageDigest || record.recordDigest !== normalized.recordDigest) {
      fail('EVIDENCE_BINDING_MISMATCH', `${field} 未绑定当前 Record/Release/Package`);
    }
    for (const kind of requiredEvidence) {
      const at = text(normalized.validUntil[kind], `${field}.validUntil.${kind}`, { maximum: 128 });
      const milliseconds = Date.parse(at);
      if (!Number.isFinite(milliseconds) || milliseconds <= now) fail('EVIDENCE_EXPIRED', `${normalized.skillId} 的 ${kind} 证据缺失或已过期`);
    }
    result.set(normalized.skillId, normalized);
  }
  return result;
}

function normalizeRelations(value = []) {
  if (!Array.isArray(value)) fail('INVALID_RELATIONS', 'relations 必须是数组');
  return value.map((row, index) => {
    const field = `relations[${index}]`;
    exactKeys(row, new Set(['type', 'from', 'to', 'reason']), field);
    if (!['before', 'after'].includes(row.type)) fail('INVALID_RELATION', `${field}.type 只允许 before/after`);
    const endpoint = (value, name) => {
      exactKeys(value, new Set(['skillId', 'releaseId']), `${field}.${name}`);
      return {
        skillId: text(value.skillId, `${field}.${name}.skillId`, { pattern: SKILL_ID, maximum: 127 }),
        releaseId: value.releaseId === undefined || value.releaseId === null ? null : text(value.releaseId, `${field}.${name}.releaseId`, { pattern: RELEASE_ID, maximum: 80 }),
      };
    };
    return { type: row.type, from: endpoint(row.from, 'from'), to: endpoint(row.to, 'to'), reason: text(row.reason, `${field}.reason`, { maximum: 240 }) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}

function taskText(task) {
  return `${task.summaryZh} ${task.intentTags.join(' ')} ${task.requirements.join(' ')}`.toLocaleLowerCase('zh-CN');
}

function matchRecord(record, task) {
  const haystack = taskText(task);
  const positives = [...record.whenToUse, ...record.positiveExamples, ...record.tags];
  const negatives = [...record.whenNotToUse, ...record.negativeExamples];
  const matched = positives.filter(term => haystack.includes(term.toLocaleLowerCase('zh-CN')));
  const excluded = negatives.filter(term => haystack.includes(term.toLocaleLowerCase('zh-CN')));
  return { score: matched.length * 10 + record.tags.filter(tag => task.intentTags.includes(tag)).length * 20, matched, excluded };
}

function publicReason(code, skillId, messageZh, blocking = false, details) {
  const result = { code, skillId, messageZh, blocking };
  if (details) result.details = canonical(details);
  return result;
}

function selectRecords(records, task, requestedSkillIds) {
  const requested = new Set(requestedSkillIds);
  const selected = new Set();
  const matches = new Map(records.map(record => [record.skillId, matchRecord(record, task)]));
  for (const record of records) {
    const match = matches.get(record.skillId);
    if (requested.has(record.skillId) || (match.score > 0 && !match.excluded.length)) selected.add(record.skillId);
  }
  return { selected, matches };
}

function dependencyClosure(selected, bySkill, blockers, reasons) {
  const queue = [...selected].sort((a, b) => a.localeCompare(b, 'en'));
  while (queue.length) {
    const skillId = queue.shift();
    const record = bySkill.get(skillId);
    if (!record) continue;
    for (const dependency of record.dependencies.required) {
      const target = bySkill.get(dependency.skillId);
      if (!target) {
        blockers.push(publicReason('REQUIRED_SKILL_MISSING', skillId, `缺少必需技能 ${dependency.skillId}`, true, { dependencySkillId: dependency.skillId }));
        continue;
      }
      if (dependency.releaseId && dependency.releaseId !== target.releaseId) {
        blockers.push(publicReason('REQUIRED_RELEASE_MISMATCH', skillId, `必需技能 ${dependency.skillId} 的 Release 不匹配`, true, { dependencySkillId: dependency.skillId, requiredReleaseId: dependency.releaseId, availableReleaseId: target.releaseId }));
        continue;
      }
      if (!selected.has(target.skillId)) {
        selected.add(target.skillId);
        queue.push(target.skillId);
        queue.sort((a, b) => a.localeCompare(b, 'en'));
        reasons.push(publicReason('REQUIRED_DEPENDENCY_SELECTED', target.skillId, `由 ${skillId} 的必需依赖选入`, false));
      }
    }
  }
}

function assessGates(selected, bySkill, environment, permissions, blockers, reasons) {
  for (const skillId of [...selected].sort((a, b) => a.localeCompare(b, 'en'))) {
    const record = bySkill.get(skillId);
    if (record.compatibility.contract !== environment.contract || !record.compatibility.targets.includes(environment.target)) {
      blockers.push(publicReason('COMPATIBILITY_BLOCKED', skillId, '技能与目标契约或环境不兼容', true, { requiredContract: environment.contract, requiredTarget: environment.target }));
    }
    const prohibited = record.permissions.required.filter(permission => record.permissions.prohibited.includes(permission));
    const denied = record.permissions.required.filter(permission => !permissions.allow.includes(permission));
    if (prohibited.length) blockers.push(publicReason('PROHIBITED_PERMISSION', skillId, '技能声明了被自身禁止的必需权限', true, { permissions: prohibited }));
    if (denied.length) blockers.push(publicReason('PERMISSION_NOT_ALLOWED', skillId, '任务环境未允许技能所需权限', true, { permissions: denied }));
    if (!prohibited.length && !denied.length) reasons.push(publicReason('GATES_PASSED', skillId, 'Release、证据、权限与兼容门禁通过'));
  }
}

function buildGraph(selected, bySkill, relations, blockers) {
  const edges = [];
  const add = (from, to, type, reason) => {
    if (from === to) blockers.push(publicReason('DEPENDENCY_CYCLE', from, '技能不能依赖或排序到自身', true));
    edges.push({ from, to, type, reason });
  };
  for (const skillId of [...selected].sort((a, b) => a.localeCompare(b, 'en'))) {
    const record = bySkill.get(skillId);
    for (const dependency of record.dependencies.required) if (selected.has(dependency.skillId)) add(dependency.skillId, skillId, 'required', dependency.reason);
    for (const dependency of record.dependencies.optional) if (selected.has(dependency.skillId)) {
      if (dependency.releaseId && dependency.releaseId !== bySkill.get(dependency.skillId).releaseId) {
        blockers.push(publicReason('OPTIONAL_RELEASE_MISMATCH', skillId, `已选可选技能 ${dependency.skillId} 的 Release 不匹配`, true));
      } else add(dependency.skillId, skillId, 'optional', dependency.reason);
    }
    for (const conflict of record.dependencies.conflicts) if (selected.has(conflict.skillId)) {
      blockers.push(publicReason('SKILL_CONFLICT', skillId, `与已选技能 ${conflict.skillId} 冲突`, true, { conflictingSkillId: conflict.skillId }));
    }
  }
  for (const relation of relations) {
    const from = bySkill.get(relation.from.skillId);
    const to = bySkill.get(relation.to.skillId);
    if (!from || !to || !selected.has(from.skillId) || !selected.has(to.skillId)) continue;
    if (relation.from.releaseId && relation.from.releaseId !== from.releaseId) blockers.push(publicReason('RELATION_RELEASE_MISMATCH', from.skillId, 'before/after 来源 Release 不匹配', true));
    if (relation.to.releaseId && relation.to.releaseId !== to.releaseId) blockers.push(publicReason('RELATION_RELEASE_MISMATCH', to.skillId, 'before/after 目标 Release 不匹配', true));
    if (relation.type === 'before') add(from.skillId, to.skillId, 'before', relation.reason);
    else add(to.skillId, from.skillId, 'after', relation.reason);
  }
  const deduped = [...new Map(edges.map(edge => [`${edge.from}\0${edge.to}\0${edge.type}`, edge])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return deduped;
}

function topologicalOrder(selected, edges, blockers) {
  const nodes = [...selected].sort((a, b) => a.localeCompare(b, 'en'));
  const indegree = new Map(nodes.map(node => [node, 0]));
  const outgoing = new Map(nodes.map(node => [node, []]));
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  for (const values of outgoing.values()) values.sort((a, b) => a.localeCompare(b, 'en'));
  const ready = nodes.filter(node => indegree.get(node) === 0);
  const result = [];
  while (ready.length) {
    const node = ready.shift();
    result.push(node);
    for (const target of outgoing.get(node)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort((a, b) => a.localeCompare(b, 'en'));
      }
    }
  }
  if (result.length !== nodes.length) blockers.push(publicReason('DEPENDENCY_CYCLE', null, '组合图存在循环依赖或循环顺序', true, { skillIds: nodes.filter(node => !result.includes(node)) }));
  return result;
}

/**
 * 生成确定性的技能组合计划。它只读取 Skill Record 的公开结构化摘要，
 * 不读取包正文、不执行技能，也不产生安装或发布动作。
 */
export function createSkillCompositionPlan(input, { now } = {}) {
  exactKeys(input, new Set(['taskIntent', 'records', 'releases', 'requestedSkillIds', 'environment', 'permissions', 'policy', 'evidenceSnapshots', 'relations']), 'input');
  const task = normalizeTask(object(input.taskIntent, 'taskIntent'));
  if (!Array.isArray(input.records) || !input.records.length) fail('RECORDS_REQUIRED', 'records 必须是非空数组');
  if (!Array.isArray(input.releases) || !input.releases.length) fail('RELEASES_REQUIRED', 'releases 必须是非空数组');
  const releaseById = new Map();
  for (const [index, release] of input.releases.entries()) {
    object(release, `releases[${index}]`);
    const releaseId = text(release.releaseId, `releases[${index}].releaseId`, { maximum: 80, pattern: RELEASE_ID });
    if (releaseById.has(releaseId)) fail('DUPLICATE_RELEASE', `重复 Release：${releaseId}`);
    releaseById.set(releaseId, release);
  }
  const records = input.records.map((record, index) => normalizeRecord(record, index, releaseById.get(record?.releaseId)));
  const bySkill = new Map();
  for (const record of records) {
    if (bySkill.has(record.skillId)) fail('MULTIPLE_RELEASES_FOR_SKILL', `每个技能只能提供一个明确 Release：${record.skillId}`);
    bySkill.set(record.skillId, record);
  }
  const requestedSkillIds = stringList(input.requestedSkillIds ?? [], 'requestedSkillIds', { pattern: SKILL_ID, maximum: 100 });
  const environment = normalizeEnvironment(object(input.environment, 'environment'));
  const permissions = normalizePermissions(object(input.permissions, 'permissions'));
  const policy = normalizePolicy(input.policy ?? {});
  const at = normalizeNow(now);
  const evidenceSnapshots = normalizeEvidenceSnapshots(input.evidenceSnapshots, records, at, policy.requiredEvidence);
  if (evidenceSnapshots.size !== records.length) fail('EVIDENCE_SNAPSHOT_MISSING', '每个候选 Record 都必须有当前证据快照');
  const relations = normalizeRelations(input.relations ?? []);
  const blockers = [];
  const reasons = [];
  const { selected, matches } = selectRecords(records, task, requestedSkillIds);
  for (const skillId of requestedSkillIds) if (!bySkill.has(skillId)) blockers.push(publicReason('REQUESTED_SKILL_MISSING', skillId, '明确请求的技能没有可用 Release', true));
  dependencyClosure(selected, bySkill, blockers, reasons);
  for (const skillId of [...selected].sort((a, b) => a.localeCompare(b, 'en'))) {
    const excluded = matches.get(skillId)?.excluded ?? [];
    if (excluded.length) blockers.push(publicReason('NEGATIVE_INTENT_BLOCKED', skillId, `命中明确不适用场景：${excluded.join('、')}`, true));
  }
  assessGates(selected, bySkill, environment, permissions, blockers, reasons);
  const edges = buildGraph(selected, bySkill, relations, blockers);
  const order = topologicalOrder(selected, edges, blockers);
  const uniqueBlockers = [...new Map(blockers.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  const steps = uniqueBlockers.length ? [] : order.map((skillId, index) => {
    const record = bySkill.get(skillId);
    const match = matches.get(skillId);
    return {
      position: index + 1, skillId, releaseId: record.releaseId, version: record.version,
      packageDigest: record.packageDigest, titleZh: record.titleZh,
      reasonZh: requestedSkillIds.includes(skillId) ? '由请求明确选中' : match?.matched.length ? `匹配任务意图：${match.matched.join('、')}` : '由必需依赖选入',
    };
  });
  const unselected = records.filter(record => !selected.has(record.skillId)).map(record => {
    const match = matches.get(record.skillId);
    return {
      skillId: record.skillId, releaseId: record.releaseId, titleZh: record.titleZh,
      code: match.excluded.length ? 'NEGATIVE_INTENT_MATCHED' : 'NO_INTENT_MATCH',
      reasonZh: match.excluded.length ? `命中不适用场景：${match.excluded.join('、')}` : '未匹配任务意图，也不是必需依赖',
    };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId, 'en'));
  const graph = {
    nodes: [...selected].sort((a, b) => a.localeCompare(b, 'en')).map(skillId => ({ skillId, releaseId: bySkill.get(skillId).releaseId })),
    edges,
  };
  const body = {
    schemaVersion: SKILL_COMPOSITION_SCHEMA_VERSION,
    status: uniqueBlockers.length ? 'blocked' : (steps.length ? 'ready' : 'no_match'),
    taskIntent: task,
    environment,
    steps,
    reasons: reasons.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')),
    unselected,
    blockers: uniqueBlockers,
    graph,
  };
  assertPublic(body);
  const plan = { ...body, planDigest: digest(body) };
  assertPublic(plan);
  return Object.freeze(plan);
}
