import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PERFORMANCE_LEDGER_SCHEMA_VERSION = 1;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVENT_KEYS = new Set([
  'schemaVersion', 'installationId', 'skillId', 'releaseId', 'outcome', 'durationMs',
  'errorCode', 'occurredAt', 'environmentDigest', 'evalPolicyDigest', 'eventId',
]);
const PERSISTED_EVENT_KEYS = new Set([
  'schemaVersion', 'installationId', 'skillId', 'releaseId', 'outcome', 'durationBucket',
  'errorCode', 'timeBucket', 'environmentDigest', 'evalPolicyDigest', 'eventId',
]);
const DURATION_BUCKETS = new Set(['lt_1s', '1_to_5s', '5_to_30s', 'gte_30s']);

export class PerformanceLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PerformanceLedgerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PerformanceLedgerError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP', `${label} 必须是有效时间`);
  return new Date(value).toISOString();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象`);
  const unknown = Object.keys(value).filter(key => !keys.has(key));
  if (unknown.length) fail('PRIVATE_FIELD_FORBIDDEN', `${label} 不允许字段：${unknown.join(', ')}`);
}

function match(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_IDENTITY', `${label} 格式无效`);
  return value;
}

function optionalDigest(value, label) {
  if (value === undefined || value === null) return null;
  return match(value, DIGEST, label);
}

function durationBucket(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 24 * 60 * 60 * 1_000) {
    fail('INVALID_DURATION', 'durationMs 必须是 0 到 24 小时的整数');
  }
  if (milliseconds < 1_000) return 'lt_1s';
  if (milliseconds < 5_000) return '1_to_5s';
  if (milliseconds < 30_000) return '5_to_30s';
  return 'gte_30s';
}

export function createPerformanceEvent(input) {
  exactKeys(input, EVENT_KEYS, 'performance event');
  if (input.schemaVersion !== undefined && input.schemaVersion !== PERFORMANCE_LEDGER_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', 'performance event schemaVersion 不受支持');
  }
  const outcome = input.outcome;
  if (!['success', 'failure'].includes(outcome)) fail('INVALID_OUTCOME', 'outcome 只允许 success 或 failure');
  if (outcome === 'success' && input.errorCode !== undefined && input.errorCode !== null) {
    fail('INVALID_ERROR_CODE', '成功事件不能携带 errorCode');
  }
  const occurredAt = timestamp(input.occurredAt, 'occurredAt');
  const body = {
    schemaVersion: PERFORMANCE_LEDGER_SCHEMA_VERSION,
    installationId: match(input.installationId, INSTALLATION_ID, 'installationId'),
    skillId: match(input.skillId, SKILL_ID, 'skillId'),
    releaseId: match(input.releaseId, RELEASE_ID, 'releaseId'),
    outcome,
    durationBucket: durationBucket(input.durationMs),
    errorCode: outcome === 'failure' ? match(input.errorCode, CODE, 'errorCode') : null,
    timeBucket: occurredAt.slice(0, 10),
    environmentDigest: optionalDigest(input.environmentDigest, 'environmentDigest'),
    evalPolicyDigest: optionalDigest(input.evalPolicyDigest, 'evalPolicyDigest'),
  };
  const eventId = `perf_${digest(body).slice('sha256:'.length)}`;
  if (input.eventId !== undefined && input.eventId !== eventId) fail('EVENT_ID_MISMATCH', 'eventId 与规范事件不一致');
  return Object.freeze({ ...body, eventId });
}

function validateLedger(input) {
  if (!input || input.schemaVersion !== PERFORMANCE_LEDGER_SCHEMA_VERSION || !Array.isArray(input.events)) {
    fail('LEDGER_INVALID', '绩效账本格式无效');
  }
  const ids = new Set();
  const events = input.events.map(event => {
    exactKeys(event, PERSISTED_EVENT_KEYS, 'persisted performance event');
    const normalized = Object.freeze({
      schemaVersion: event.schemaVersion,
      installationId: match(event.installationId, INSTALLATION_ID, 'installationId'),
      skillId: match(event.skillId, SKILL_ID, 'skillId'),
      releaseId: match(event.releaseId, RELEASE_ID, 'releaseId'),
      outcome: event.outcome,
      durationBucket: event.durationBucket,
      errorCode: event.errorCode,
      timeBucket: event.timeBucket,
      environmentDigest: optionalDigest(event.environmentDigest, 'environmentDigest'),
      evalPolicyDigest: optionalDigest(event.evalPolicyDigest, 'evalPolicyDigest'),
      eventId: event.eventId,
    });
    if (normalized.schemaVersion !== PERFORMANCE_LEDGER_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', '绩效事件 schemaVersion 不受支持');
    if (!['success', 'failure'].includes(normalized.outcome)) fail('INVALID_OUTCOME', '持久化 outcome 无效');
    if (!DURATION_BUCKETS.has(normalized.durationBucket)) fail('INVALID_DURATION', '持久化耗时桶无效');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.timeBucket) || !Number.isFinite(Date.parse(`${normalized.timeBucket}T00:00:00Z`))) {
      fail('INVALID_TIMESTAMP', '持久化时间桶无效');
    }
    if (normalized.outcome === 'failure') match(normalized.errorCode, CODE, 'errorCode');
    else if (normalized.errorCode !== null) fail('INVALID_ERROR_CODE', '成功事件不能携带 errorCode');
    if (!/^perf_[a-f0-9]{64}$/.test(normalized.eventId)) fail('LEDGER_INVALID', '绩效事件 ID 无效');
    const { eventId, ...body } = normalized;
    if (`perf_${digest(body).slice('sha256:'.length)}` !== eventId) fail('LEDGER_TAMPERED', '绩效事件摘要不一致');
    if (ids.has(eventId)) fail('LEDGER_INVALID', '绩效事件重复');
    ids.add(eventId);
    return normalized;
  });
  return { schemaVersion: PERFORMANCE_LEDGER_SCHEMA_VERSION, events };
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export class PerformanceLedger {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) fail('LEDGER_PATH_REQUIRED', '缺少绩效账本路径');
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: PERFORMANCE_LEDGER_SCHEMA_VERSION, events: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { fail('LEDGER_INVALID', '绩效账本不是有效 JSON'); }
    return structuredClone(validateLedger(parsed));
  }

  append(input) {
    const event = createPerformanceEvent(input);
    const ledger = this.read();
    const previous = ledger.events.find(item => item.eventId === event.eventId);
    if (previous) return { action: 'unchanged', event: structuredClone(previous) };
    const next = { schemaVersion: PERFORMANCE_LEDGER_SCHEMA_VERSION, events: [...ledger.events, event] };
    atomicWrite(this.filePath, next);
    return { action: 'recorded', event: structuredClone(event) };
  }

  summarize(input = {}) {
    return summarizePerformance(this.read().events, input);
  }
}

export function summarizePerformance(events, {
  skillId,
  releaseId,
  now = new Date(),
  windowDays = 30,
  minimumSamples = 10,
  degradedFailureRate = 0.25,
} = {}) {
  match(skillId, SKILL_ID, 'skillId');
  if (releaseId !== undefined) match(releaseId, RELEASE_ID, 'releaseId');
  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(evaluatedAt.getTime())) fail('INVALID_TIMESTAMP', 'now 必须是有效时间');
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) fail('INVALID_WINDOW', 'windowDays 必须是 1 到 365');
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 10_000) fail('INVALID_SAMPLE_THRESHOLD', 'minimumSamples 无效');
  if (typeof degradedFailureRate !== 'number' || degradedFailureRate <= 0 || degradedFailureRate > 1) fail('INVALID_FAILURE_THRESHOLD', 'degradedFailureRate 无效');
  const cutoff = new Date(evaluatedAt.getTime() - windowDays * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const selected = events.filter(event => event.skillId === skillId
    && (!releaseId || event.releaseId === releaseId)
    && event.timeBucket >= cutoff
    && event.timeBucket <= evaluatedAt.toISOString().slice(0, 10));
  const failures = selected.filter(event => event.outcome === 'failure').length;
  const failureRate = selected.length ? failures / selected.length : null;
  const environments = new Set(selected.map(event => event.environmentDigest).filter(Boolean));
  const policies = new Set(selected.map(event => event.evalPolicyDigest).filter(Boolean));
  let status = 'stable';
  let reasonCode = 'PERFORMANCE_WITHIN_THRESHOLD';
  if (selected.length < minimumSamples) {
    status = 'evidence_insufficient';
    reasonCode = 'MINIMUM_SAMPLE_NOT_MET';
  } else if (environments.size > 1 || policies.size > 1) {
    status = 'confounded';
    reasonCode = 'CONTEXT_CHANGED';
  } else if (failureRate >= degradedFailureRate) {
    status = 'degraded';
    reasonCode = 'FAILURE_RATE_THRESHOLD_EXCEEDED';
  }
  const durationBuckets = { lt_1s: 0, '1_to_5s': 0, '5_to_30s': 0, gte_30s: 0 };
  const errorCodes = {};
  for (const event of selected) {
    durationBuckets[event.durationBucket] += 1;
    if (event.errorCode) errorCodes[event.errorCode] = (errorCodes[event.errorCode] ?? 0) + 1;
  }
  return Object.freeze({
    schemaVersion: PERFORMANCE_LEDGER_SCHEMA_VERSION,
    skillId,
    releaseId: releaseId ?? null,
    status,
    reasonCode,
    samples: selected.length,
    successes: selected.length - failures,
    failures,
    failureRate,
    minimumSamples,
    windowDays,
    evaluatedAt: evaluatedAt.toISOString(),
    durationBuckets,
    errorCodes,
    context: { environmentVariants: environments.size, evalPolicyVariants: policies.size },
  });
}
