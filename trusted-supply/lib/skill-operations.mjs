import crypto from 'node:crypto';

export const SKILL_OPERATIONS_SCHEMA_VERSION = 1;

const EVENT_TYPES = new Set(['impression', 'selected', 'invoked', 'succeeded', 'failed', 'reused', 'handoff']);
const TERMINAL_TYPES = new Set(['succeeded', 'failed', 'handoff']);
const FAILURE_CATEGORIES = new Set([
  'task_error', 'dependency_error', 'permission_denied', 'timeout',
  'invalid_input', 'policy_blocked', 'environment_error', 'unknown',
]);
const EVENT_KEYS = new Set([
  'schemaVersion', 'operationId', 'eventType', 'organizationId', 'projectId',
  'skillId', 'releaseId', 'packageDigest', 'occurredAt', 'window',
  'environmentDigest', 'policyDigest', 'costMicros', 'latencyMs',
  'failureCategory', 'eventId', 'sequence',
]);
const QUERY_KEYS = new Set([
  'organizationId', 'projectId', 'skillId', 'releaseId', 'packageDigest',
  'windowStart', 'windowEnd',
]);
const POLICY_KEYS = new Set([
  'minimumInvocations', 'minimumTrendInvocations', 'lowUtilitySuccessRate',
  'degradationDelta', 'highUsageThreshold',
]);
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const OPERATION_ID = /^op_[a-z0-9][a-z0-9_-]{0,95}$/;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EVENT_ID = /^opsevt_[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE_KEY = /(?:body|content|candidate|principal|reviewer|subject|identity|email|phone|name|prompt|output|input|token|secret|password|credential|api[_-]?key|path|storage|url|metadata|session|trace|request|response)/i;
const PATH_VALUE = /^(?:\/|~\/|[A-Za-z]:[\\/]|file:\/\/)/;
const MAX_COST_MICROS = 1_000_000_000;
const MAX_LATENCY_MS = 86_400_000;

export class SkillOperationsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillOperationsError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillOperationsError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    const privateFields = unknown.filter(key => PRIVATE_KEY.test(key));
    fail(privateFields.length ? 'PRIVATE_FIELD_FORBIDDEN' : 'UNKNOWN_FIELD', `${label} contains forbidden fields: ${unknown.join(', ')}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

export function skillOperationsDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function text(value, label, pattern, maximum = 128) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || PATH_VALUE.test(normalized) || !pattern.test(normalized)) {
    fail('INVALID_TEXT', `${label} is invalid`);
  }
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function trustedTimestamp(input, now) {
  const source = typeof now === 'function' ? now() : (now ?? new Date());
  const trusted = source instanceof Date ? source : new Date(source);
  if (!Number.isFinite(trusted.getTime())) fail('INVALID_TIMESTAMP', 'now must be a valid timestamp');
  const result = trusted.toISOString();
  if (input !== undefined && timestamp(input, 'occurredAt') !== result) fail('EVENT_TIME_UNTRUSTED', 'occurredAt must equal trusted now');
  return result;
}

function date(value, label) {
  if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    fail('INVALID_WINDOW', `${label} must be a UTC calendar date`);
  }
  return value;
}

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('INVALID_METRIC', `${label} is outside its allowed range`);
  return value;
}

function optionalDigest(value, label) {
  if (value === undefined || value === null) return null;
  return text(value, label, DIGEST, 71);
}

function normalizeEvent(input, { now, replay = false } = {}) {
  exactKeys(input, EVENT_KEYS, 'skill operation event');
  if (replay) {
    const missing = [...EVENT_KEYS].filter(key => !Object.hasOwn(input, key));
    if (missing.length) fail('FIXED_SCHEMA_REQUIRED', `persisted event is missing fields: ${missing.join(', ')}`);
  }
  const schemaVersion = input.schemaVersion ?? SKILL_OPERATIONS_SCHEMA_VERSION;
  if (schemaVersion !== SKILL_OPERATIONS_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported skill operation event schema');
  const eventType = input.eventType;
  if (!EVENT_TYPES.has(eventType)) fail('INVALID_EVENT_TYPE', 'eventType is not supported');
  const occurredAt = replay ? timestamp(input.occurredAt, 'occurredAt') : trustedTimestamp(input.occurredAt, now);
  const derivedWindow = occurredAt.slice(0, 10);
  if (input.window !== undefined && date(input.window, 'window') !== derivedWindow) fail('WINDOW_MISMATCH', 'window must match occurredAt UTC date');

  const allowsMetrics = eventType === 'invoked' || TERMINAL_TYPES.has(eventType);
  if (!allowsMetrics && (input.costMicros != null || input.latencyMs != null)) {
    fail('METRIC_NOT_ALLOWED', 'costMicros and latencyMs are allowed only on invoked or terminal events');
  }
  if (eventType !== 'failed' && input.failureCategory != null) {
    fail('FAILURE_CATEGORY_NOT_ALLOWED', 'failureCategory is allowed only on failed events');
  }
  if (eventType === 'failed' && !FAILURE_CATEGORIES.has(input.failureCategory)) {
    fail('INVALID_FAILURE_CATEGORY', 'failed event requires an allowed failureCategory');
  }

  const body = {
    schemaVersion,
    operationId: text(input.operationId, 'operationId', OPERATION_ID, 99),
    eventType,
    organizationId: text(input.organizationId, 'organizationId', ID),
    projectId: text(input.projectId, 'projectId', ID),
    skillId: text(input.skillId, 'skillId', SKILL_ID),
    releaseId: text(input.releaseId, 'releaseId', RELEASE_ID, 68),
    packageDigest: text(input.packageDigest, 'packageDigest', DIGEST, 71),
    occurredAt,
    window: derivedWindow,
    environmentDigest: optionalDigest(input.environmentDigest, 'environmentDigest'),
    policyDigest: optionalDigest(input.policyDigest, 'policyDigest'),
    costMicros: allowsMetrics && input.costMicros != null ? boundedInteger(input.costMicros, 'costMicros', MAX_COST_MICROS) : null,
    latencyMs: allowsMetrics && input.latencyMs != null ? boundedInteger(input.latencyMs, 'latencyMs', MAX_LATENCY_MS) : null,
    failureCategory: eventType === 'failed' ? input.failureCategory : null,
  };
  const eventId = `opsevt_${skillOperationsDigest(body).slice(7)}`;
  if (input.eventId !== undefined && input.eventId !== eventId) fail('EVENT_ID_MISMATCH', 'eventId does not match canonical event');
  if (replay) {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('SEQUENCE_INVALID', 'sequence must be a positive safe integer');
    return Object.freeze({ ...body, eventId, sequence: input.sequence });
  }
  if (input.sequence !== undefined) fail('SEQUENCE_FORBIDDEN', 'callers cannot assign sequence');
  return Object.freeze({ ...body, eventId });
}

export function createSkillOperationEvent(input, options = {}) {
  return normalizeEvent(input, options);
}

function assertOperationConsistency(state, event) {
  const identity = [event.organizationId, event.projectId, event.skillId, event.releaseId, event.packageDigest];
  const previousIdentity = state.identities.get(event.operationId);
  if (previousIdentity && previousIdentity.some((value, index) => value !== identity[index])) {
    fail('OPERATION_IDENTITY_DRIFT', 'one operation cannot change organization, project, skill, release, or package identity');
  }
  state.identities.set(event.operationId, identity);
  const terminal = state.terminals.get(event.operationId);
  if (TERMINAL_TYPES.has(event.eventType) && terminal && terminal !== event.eventType) {
    fail('TERMINAL_OUTCOME_CONFLICT', 'one operation cannot have multiple terminal outcomes');
  }
  if (TERMINAL_TYPES.has(event.eventType)) state.terminals.set(event.operationId, event.eventType);
  const key = `${event.operationId}\0${event.eventType}`;
  const previous = state.byStage.get(key);
  if (previous && previous.eventId !== event.eventId) fail('OPERATION_EVENT_CONFLICT', 'one operation stage cannot be rewritten');
  state.byStage.set(key, event);
}

export function replaySkillOperationEvents(events) {
  if (!Array.isArray(events)) fail('INVALID_EVENT_LOG', 'events must be an array');
  const state = { identities: new Map(), terminals: new Map(), byStage: new Map() };
  const ids = new Set();
  const normalized = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = normalizeEvent(events[index], { replay: true });
    if (event.sequence !== index + 1) fail('SEQUENCE_GAP', 'event sequence must be contiguous');
    if (!EVENT_ID.test(event.eventId) || ids.has(event.eventId)) fail('EVENT_LOG_INVALID', 'eventId must be unique and valid');
    ids.add(event.eventId);
    assertOperationConsistency(state, event);
    normalized.push(event);
  }
  return Object.freeze({
    schemaVersion: SKILL_OPERATIONS_SCHEMA_VERSION,
    throughSequence: normalized.length,
    events: structuredClone(normalized),
  });
}

export function appendSkillOperationEvent(events, input, options = {}) {
  const projection = replaySkillOperationEvents(events);
  const candidate = createSkillOperationEvent(input, options);
  const sameStage = projection.events.find(event => event.operationId === candidate.operationId && event.eventType === candidate.eventType);
  if (sameStage) {
    const operationPayload = event => {
      const { occurredAt, window, eventId, sequence, ...stable } = event;
      return stable;
    };
    if (skillOperationsDigest(operationPayload(sameStage)) !== skillOperationsDigest(operationPayload(candidate))) {
      fail('OPERATION_EVENT_CONFLICT', 'one operation stage cannot be rewritten');
    }
    return { action: 'replayed', event: structuredClone(sameStage), events: structuredClone(projection.events), projection };
  }
  const nextEvent = Object.freeze({ ...candidate, sequence: projection.throughSequence + 1 });
  const nextEvents = [...projection.events, nextEvent];
  const nextProjection = replaySkillOperationEvents(nextEvents);
  return { action: 'appended', event: structuredClone(nextEvent), events: structuredClone(nextEvents), projection: nextProjection };
}

function percentile(sorted, percentage) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(percentage * sorted.length) - 1)];
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function operationSets(events) {
  const result = Object.fromEntries([...EVENT_TYPES].map(type => [type, new Set()]));
  for (const event of events) result[event.eventType].add(event.operationId);
  return result;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function conversion(from, to) {
  const numerator = intersectionSize(from, to);
  return Object.freeze({
    numerator,
    denominator: from.size,
    rate: ratio(numerator, from.size),
    observedWithoutPredecessor: [...to].filter(value => !from.has(value)).length,
  });
}

function aggregate(events) {
  const sets = operationSets(events);
  const outcomes = new Set([...sets.succeeded, ...sets.failed, ...sets.handoff]);
  const metricEvents = new Map();
  for (const event of events) {
    if (event.eventType !== 'invoked' && !TERMINAL_TYPES.has(event.eventType)) continue;
    const previous = metricEvents.get(event.operationId) ?? { costMicros: null, latencyMs: null };
    metricEvents.set(event.operationId, {
      costMicros: event.costMicros ?? previous.costMicros,
      latencyMs: event.latencyMs ?? previous.latencyMs,
    });
  }
  const costs = [...metricEvents.values()].filter(event => event.costMicros !== null).map(event => event.costMicros);
  const latencies = [...metricEvents.values()].filter(event => event.latencyMs !== null).map(event => event.latencyMs).sort((a, b) => a - b);
  const failures = {};
  for (const event of events) {
    if (event.failureCategory) failures[event.failureCategory] = (failures[event.failureCategory] ?? 0) + 1;
  }
  const matchedOutcomes = intersectionSize(sets.invoked, outcomes);
  return {
    observedEvents: events.length,
    observedOperations: new Set(events.map(event => event.operationId)).size,
    funnel: {
      impression: { observed: sets.impression.size },
      selected: { observed: sets.selected.size, ...conversion(sets.impression, sets.selected) },
      invoked: { observed: sets.invoked.size, ...conversion(sets.selected, sets.invoked) },
      succeeded: { observed: sets.succeeded.size, ...conversion(sets.invoked, sets.succeeded) },
      reused: { observed: sets.reused.size, ...conversion(sets.succeeded, sets.reused) },
    },
    outcomes: {
      observed: outcomes.size,
      denominator: sets.invoked.size,
      matchedToInvocation: matchedOutcomes,
      coverageRate: ratio(matchedOutcomes, sets.invoked.size),
      successes: sets.succeeded.size,
      failures: sets.failed.size,
      handoffs: sets.handoff.size,
      successRate: ratio(intersectionSize(sets.invoked, sets.succeeded), sets.invoked.size),
      handoffRate: ratio(intersectionSize(sets.invoked, sets.handoff), sets.invoked.size),
      observedWithoutInvocation: [...outcomes].filter(value => !sets.invoked.has(value)).length,
    },
    cost: {
      samples: costs.length,
      totalMicros: costs.reduce((sum, value) => sum + value, 0),
      averageMicros: costs.length ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null,
    },
    latency: {
      samples: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
    },
    failureCategories: Object.fromEntries(Object.entries(failures).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function normalizeQuery(query) {
  exactKeys(query, QUERY_KEYS, 'operations query');
  const result = {
    organizationId: text(query.organizationId, 'organizationId', ID),
    projectId: text(query.projectId, 'projectId', ID),
    skillId: text(query.skillId, 'skillId', SKILL_ID),
    releaseId: query.releaseId === undefined ? null : text(query.releaseId, 'releaseId', RELEASE_ID, 68),
    packageDigest: query.packageDigest === undefined ? null : text(query.packageDigest, 'packageDigest', DIGEST, 71),
    windowStart: date(query.windowStart, 'windowStart'),
    windowEnd: date(query.windowEnd, 'windowEnd'),
  };
  if (result.windowStart > result.windowEnd) fail('INVALID_WINDOW', 'windowStart must not be after windowEnd');
  return result;
}

function positiveInteger(value, fallback, label, maximum = 100_000) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) fail('INVALID_POLICY', `${label} must be a positive safe integer`);
  return result;
}

function probability(value, fallback, label) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0 || result > 1) fail('INVALID_POLICY', `${label} must be between 0 and 1`);
  return result;
}

function normalizePolicy(policy) {
  exactKeys(policy, POLICY_KEYS, 'operations policy');
  return {
    minimumInvocations: positiveInteger(policy.minimumInvocations, 10, 'minimumInvocations'),
    minimumTrendInvocations: positiveInteger(policy.minimumTrendInvocations, 5, 'minimumTrendInvocations'),
    highUsageThreshold: positiveInteger(policy.highUsageThreshold, 20, 'highUsageThreshold'),
    lowUtilitySuccessRate: probability(policy.lowUtilitySuccessRate, 0.5, 'lowUtilitySuccessRate'),
    degradationDelta: probability(policy.degradationDelta, 0.2, 'degradationDelta'),
  };
}

function contextBucket(events) {
  const relevant = events.filter(event => event.eventType === 'invoked' || TERMINAL_TYPES.has(event.eventType));
  const environments = new Set(relevant.map(event => event.environmentDigest));
  const policies = new Set(relevant.map(event => event.policyDigest));
  return {
    comparable: environments.size === 1 && policies.size === 1 && !environments.has(null) && !policies.has(null),
    environmentDigest: environments.size === 1 ? [...environments][0] : null,
    policyDigest: policies.size === 1 ? [...policies][0] : null,
    environmentVariants: environments.size,
    policyVariants: policies.size,
  };
}

function dayDifference(left, right) {
  return (Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86_400_000;
}

function trendFor(events, policy) {
  const windows = [...new Set(events.map(event => event.window))].sort();
  const rows = windows.map(window => {
    const windowEvents = events.filter(event => event.window === window);
    return { window, ...aggregate(windowEvents), context: contextBucket(windowEvents) };
  });
  if (rows.length < 2) return { comparable: false, reasonCode: 'TWO_ADJACENT_WINDOWS_REQUIRED', windows: rows };
  const previous = rows.at(-2);
  const current = rows.at(-1);
  if (dayDifference(previous.window, current.window) !== 1) {
    return { comparable: false, reasonCode: 'ADJACENT_WINDOWS_REQUIRED', windows: rows };
  }
  if (!previous.context.comparable || !current.context.comparable
      || previous.context.environmentDigest !== current.context.environmentDigest
      || previous.context.policyDigest !== current.context.policyDigest) {
    return { comparable: false, reasonCode: 'CONTEXT_CHANGED', windows: rows };
  }
  if (previous.funnel.invoked.observed < policy.minimumTrendInvocations || current.funnel.invoked.observed < policy.minimumTrendInvocations) {
    return { comparable: false, reasonCode: 'TREND_SAMPLE_MINIMUM_NOT_MET', windows: rows };
  }
  if ((previous.outcomes.coverageRate ?? 0) < 0.8 || (current.outcomes.coverageRate ?? 0) < 0.8) {
    return { comparable: false, reasonCode: 'TREND_OUTCOME_COVERAGE_INSUFFICIENT', windows: rows };
  }
  const delta = current.outcomes.successRate - previous.outcomes.successRate;
  return {
    comparable: true,
    reasonCode: delta <= -policy.degradationDelta ? 'SUCCESS_RATE_DEGRADED' : 'TREND_WITHIN_THRESHOLD',
    successRateDelta: delta,
    previousWindow: previous.window,
    currentWindow: current.window,
    environmentDigest: current.context.environmentDigest,
    policyDigest: current.context.policyDigest,
    windows: rows,
  };
}

function versionTrends(events) {
  const keys = [...new Set(events.map(event => `${event.releaseId}\0${event.packageDigest}`))].sort();
  return keys.map(key => {
    const [releaseId, packageDigest] = key.split('\0');
    const selected = events.filter(event => event.releaseId === releaseId && event.packageDigest === packageDigest);
    const result = aggregate(selected);
    return {
      releaseId,
      packageDigest,
      firstWindow: selected.map(event => event.window).sort()[0],
      lastWindow: selected.map(event => event.window).sort().at(-1),
      invoked: result.funnel.invoked.observed,
      successes: result.outcomes.successes,
      failures: result.outcomes.failures,
      handoffs: result.outcomes.handoffs,
      successRate: result.outcomes.successRate,
      totalCostMicros: result.cost.totalMicros,
      p50LatencyMs: result.latency.p50Ms,
      p95LatencyMs: result.latency.p95Ms,
    };
  });
}

export function summarizeSkillOperations(events, query, policyInput = {}) {
  const projection = replaySkillOperationEvents(events);
  const normalizedQuery = normalizeQuery(query);
  const policy = normalizePolicy(policyInput);
  const selected = projection.events.filter(event => (
    event.organizationId === normalizedQuery.organizationId
      && event.projectId === normalizedQuery.projectId
      && event.skillId === normalizedQuery.skillId
      && (!normalizedQuery.releaseId || event.releaseId === normalizedQuery.releaseId)
      && (!normalizedQuery.packageDigest || event.packageDigest === normalizedQuery.packageDigest)
      && event.window >= normalizedQuery.windowStart
      && event.window <= normalizedQuery.windowEnd
  ));
  const metrics = aggregate(selected);
  const trend = trendFor(selected, policy);
  let status;
  let reasonCode;
  if (metrics.funnel.invoked.observed === 0 && metrics.outcomes.observed > 0) {
    status = 'insufficient_data';
    reasonCode = 'INVOCATION_EVENTS_MISSING';
  } else if (metrics.funnel.invoked.observed === 0) {
    status = 'zero_usage';
    reasonCode = 'NO_INVOCATIONS_OBSERVED';
  } else if (metrics.funnel.invoked.observed < policy.minimumInvocations) {
    status = 'insufficient_data';
    reasonCode = 'MINIMUM_INVOCATIONS_NOT_MET';
  } else if ((metrics.outcomes.coverageRate ?? 0) < 0.8) {
    status = 'insufficient_data';
    reasonCode = 'OUTCOME_COVERAGE_INSUFFICIENT';
  } else if (trend.comparable && trend.reasonCode === 'SUCCESS_RATE_DEGRADED') {
    status = 'degrading';
    reasonCode = trend.reasonCode;
  } else if (metrics.funnel.invoked.observed >= policy.highUsageThreshold
      && metrics.outcomes.successRate !== null
      && metrics.outcomes.successRate < policy.lowUtilitySuccessRate) {
    status = 'high_usage_low_utility';
    reasonCode = 'SUCCESS_RATE_BELOW_UTILITY_THRESHOLD';
  } else if (!trend.comparable && trend.reasonCode === 'CONTEXT_CHANGED') {
    status = 'insufficient_data';
    reasonCode = 'TREND_CONTEXT_CONFOUNDED';
  } else {
    status = 'healthy';
    reasonCode = 'OPERATIONS_WITHIN_THRESHOLDS';
  }
  return Object.freeze({
    schemaVersion: SKILL_OPERATIONS_SCHEMA_VERSION,
    query: normalizedQuery,
    policy,
    status,
    reasonCode,
    conclusionStrength: ['healthy', 'degrading', 'high_usage_low_utility'].includes(status) ? 'strong' : 'observational',
    governanceAction: 'none',
    autoRetirementAllowed: false,
    metrics,
    trend,
    versionTrends: versionTrends(selected),
  });
}
