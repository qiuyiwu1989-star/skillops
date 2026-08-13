import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SkillOperationsError,
  appendSkillOperationEvent,
  createSkillOperationEvent,
  replaySkillOperationEvents,
  summarizeSkillOperations,
} from '../lib/skill-operations.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;
const R = letter => `rel_${letter.repeat(64)}`;
const DAY_1 = '2026-08-12T10:00:00.000Z';
const DAY_2 = '2026-08-13T10:00:00.000Z';

function event(operationId, eventType, at = DAY_2, extras = {}) {
  return {
    schemaVersion: 1,
    operationId,
    eventType,
    organizationId: 'org_yongle',
    projectId: 'project_camp',
    skillId: 'qiuyiwu/humanizer',
    releaseId: R('a'),
    packageDigest: D('b'),
    occurredAt: at,
    window: at.slice(0, 10),
    environmentDigest: D('c'),
    policyDigest: D('d'),
    ...extras,
  };
}

function append(events, input) {
  return appendSkillOperationEvent(events, input, { now: input.occurredAt }).events;
}

function operation(events, number, outcome = 'succeeded', at = DAY_2, extras = {}) {
  const operationId = `op_run_${number}`;
  for (const eventType of ['impression', 'selected', 'invoked']) events = append(events, event(operationId, eventType, at));
  return append(events, event(operationId, outcome, at, extras));
}

function query(extras = {}) {
  return {
    organizationId: 'org_yongle',
    projectId: 'project_camp',
    skillId: 'qiuyiwu/humanizer',
    windowStart: '2026-08-12',
    windowEnd: '2026-08-13',
    ...extras,
  };
}

test('创建 fixed-schema 事件并以可信时间、稳定 identity 和内容摘要绑定', () => {
  const input = event('op_run_1', 'failed', DAY_2, {
    costMicros: 12_500,
    latencyMs: 1_250,
    failureCategory: 'dependency_error',
  });
  const first = createSkillOperationEvent(input, { now: DAY_2 });
  const second = createSkillOperationEvent(input, { now: new Date(DAY_2) });
  assert.deepEqual(second, first);
  assert.match(first.eventId, /^opsevt_[a-f0-9]{64}$/);
  assert.equal(first.window, '2026-08-13');
  assert.equal(first.costMicros, 12_500);
  assert.equal(first.failureCategory, 'dependency_error');
  assert.throws(
    () => createSkillOperationEvent({ ...input, occurredAt: DAY_1 }, { now: DAY_2 }),
    error => error instanceof SkillOperationsError && error.code === 'EVENT_TIME_UNTRUSTED',
  );
});

test('隐私正文、身份原文、prompt/output/token/secret/path 与任意未知高基数字段失败关闭', () => {
  const forbidden = ['body', 'userIdentity', 'prompt', 'output', 'tokenCount', 'secret', 'localPath', 'sessionId', 'arbitraryTag'];
  for (const key of forbidden) {
    assert.throws(
      () => createSkillOperationEvent({ ...event('op_private', 'impression'), [key]: '/private/value' }, { now: DAY_2 }),
      error => ['PRIVATE_FIELD_FORBIDDEN', 'UNKNOWN_FIELD'].includes(error.code),
      key,
    );
  }
});

test('指标字段受事件类型、硬上限与 failureCategory 枚举约束', () => {
  assert.throws(
    () => createSkillOperationEvent({ ...event('op_metric_1', 'selected'), latencyMs: 10 }, { now: DAY_2 }),
    error => error.code === 'METRIC_NOT_ALLOWED',
  );
  assert.throws(
    () => createSkillOperationEvent({ ...event('op_metric_2', 'invoked'), costMicros: 1_000_000_001 }, { now: DAY_2 }),
    error => error.code === 'INVALID_METRIC',
  );
  assert.throws(
    () => createSkillOperationEvent({ ...event('op_metric_3', 'failed'), latencyMs: 86_400_001, failureCategory: 'timeout' }, { now: DAY_2 }),
    error => error.code === 'INVALID_METRIC',
  );
  assert.throws(
    () => createSkillOperationEvent({ ...event('op_metric_4', 'failed'), failureCategory: 'customer_12345' }, { now: DAY_2 }),
    error => error.code === 'INVALID_FAILURE_CATEGORY',
  );
  assert.throws(
    () => createSkillOperationEvent({ ...event('op_metric_5', 'succeeded'), failureCategory: 'timeout' }, { now: DAY_2 }),
    error => error.code === 'FAILURE_CATEGORY_NOT_ALLOWED',
  );
});

test('operation 链拒绝稳定身份漂移、重复阶段改写和 succeeded/failed 双结局', () => {
  let events = append([], event('op_chain_1', 'invoked'));
  const retried = appendSkillOperationEvent(events, event('op_chain_1', 'invoked', '2026-08-13T11:00:00.000Z'), {
    now: '2026-08-13T11:00:00.000Z',
  });
  assert.equal(retried.action, 'replayed');
  assert.deepEqual(retried.events, events);
  assert.throws(
    () => append(events, event('op_chain_1', 'succeeded', DAY_2, { releaseId: R('e') })),
    error => error.code === 'OPERATION_IDENTITY_DRIFT',
  );
  events = append(events, event('op_chain_1', 'succeeded'));
  assert.throws(
    () => append(events, event('op_chain_1', 'failed', DAY_2, { failureCategory: 'unknown' })),
    error => error.code === 'TERMINAL_OUTCOME_CONFLICT',
  );
  assert.throws(
    () => append(events, event('op_chain_1', 'invoked', DAY_2, { latencyMs: 10 })),
    error => error.code === 'OPERATION_EVENT_CONFLICT',
  );
});

test('不完整事件链显式报告观察数、有效分母和缺失前序，所有比率不超过 100%', () => {
  let events = [];
  events = append(events, event('op_only_selected', 'selected'));
  events = append(events, event('op_only_invoked', 'invoked'));
  events = append(events, event('op_only_outcome', 'succeeded', DAY_2, { latencyMs: 100 }));
  events = append(events, event('op_complete', 'impression'));
  events = append(events, event('op_complete', 'selected'));
  events = append(events, event('op_complete', 'invoked'));
  events = append(events, event('op_complete', 'succeeded', DAY_2, { costMicros: 30, latencyMs: 200 }));
  const summary = summarizeSkillOperations(events, query(), { minimumInvocations: 10 });
  assert.deepEqual(summary.metrics.funnel.selected, {
    observed: 2, numerator: 1, denominator: 1, rate: 1, observedWithoutPredecessor: 1,
  });
  assert.deepEqual(summary.metrics.funnel.invoked, {
    observed: 2, numerator: 1, denominator: 2, rate: 0.5, observedWithoutPredecessor: 1,
  });
  assert.equal(summary.metrics.outcomes.successRate, 0.5);
  assert.equal(summary.metrics.outcomes.observedWithoutInvocation, 1);
  assert.equal(summary.status, 'insufficient_data');
  assert.equal(summary.governanceAction, 'none');
  assert.equal(summary.autoRetirementAllowed, false);
});

test('聚合由事件重算成本、p50/p95、人工接管率、失败分类和版本趋势', () => {
  let events = [];
  events = operation(events, 1, 'succeeded', DAY_2, { costMicros: 100, latencyMs: 100 });
  events = operation(events, 2, 'failed', DAY_2, { costMicros: 200, latencyMs: 200, failureCategory: 'timeout' });
  events = operation(events, 3, 'handoff', DAY_2, { costMicros: 300, latencyMs: 500 });
  events = operation(events, 4, 'succeeded', DAY_2, { costMicros: 400, latencyMs: 1_000 });
  events = append(events, event('op_run_1', 'reused'));
  const summary = summarizeSkillOperations(events, query(), { minimumInvocations: 4 });
  assert.equal(summary.metrics.cost.totalMicros, 1_000);
  assert.equal(summary.metrics.cost.averageMicros, 250);
  assert.equal(summary.metrics.latency.samples, 4);
  assert.equal(summary.metrics.latency.p50Ms, 200);
  assert.equal(summary.metrics.latency.p95Ms, 1_000);
  assert.equal(summary.metrics.outcomes.handoffRate, 0.25);
  assert.deepEqual(summary.metrics.failureCategories, { timeout: 1 });
  assert.equal(summary.metrics.funnel.reused.rate, 0.5);
  assert.equal(summary.versionTrends.length, 1);
  assert.equal(summary.versionTrends[0].invoked, 4);
  assert.equal(summary.status, 'healthy');
});

test('invoked 上报的成本时延在 outcome 未重复上报时仍保留且每个 operation 只计一次', () => {
  let events = [];
  events = append(events, event('op_metric_fallback', 'invoked', DAY_2, { costMicros: 321, latencyMs: 654 }));
  events = append(events, event('op_metric_fallback', 'succeeded'));
  const summary = summarizeSkillOperations(events, query(), { minimumInvocations: 1 });
  assert.deepEqual(summary.metrics.cost, { samples: 1, totalMicros: 321, averageMicros: 321 });
  assert.deepEqual(summary.metrics.latency, { samples: 1, p50Ms: 654, p95Ms: 654 });
});

test('零使用、低样本和高使用低效用分别判断，均绝不自动退役', () => {
  let impressions = append([], event('op_seen', 'impression'));
  assert.equal(summarizeSkillOperations(impressions, query()).status, 'zero_usage');

  let sparse = operation([], 1, 'failed', DAY_2, { failureCategory: 'task_error' });
  assert.equal(summarizeSkillOperations(sparse, query(), { minimumInvocations: 2 }).status, 'insufficient_data');

  let busy = [];
  for (let index = 0; index < 10; index += 1) {
    busy = operation(busy, index, index < 3 ? 'succeeded' : 'failed', DAY_2,
      index < 3 ? {} : { failureCategory: 'task_error' });
  }
  const lowUtility = summarizeSkillOperations(busy, query(), {
    minimumInvocations: 5,
    highUsageThreshold: 10,
    lowUtilitySuccessRate: 0.5,
  });
  assert.equal(lowUtility.status, 'high_usage_low_utility');
  assert.equal(lowUtility.autoRetirementAllowed, false);
});

test('退化只比较相邻窗口且 environment/policy 相同，变化或不相邻时不强判', () => {
  let events = [];
  for (let index = 0; index < 5; index += 1) events = operation(events, `old_${index}`, 'succeeded', DAY_1);
  for (let index = 0; index < 5; index += 1) {
    events = operation(events, `new_${index}`, index === 0 ? 'succeeded' : 'failed', DAY_2,
      index === 0 ? {} : { failureCategory: 'task_error' });
  }
  const degraded = summarizeSkillOperations(events, query(), {
    minimumInvocations: 5,
    minimumTrendInvocations: 5,
    degradationDelta: 0.3,
  });
  assert.equal(degraded.status, 'degrading');
  assert.equal(degraded.trend.successRateDelta, -0.8);

  const changed = events.map(item => item.window === '2026-08-13' && ['invoked', 'succeeded', 'failed'].includes(item.eventType)
    ? { ...item, environmentDigest: D('e') }
    : item);
  const normalizedChanged = changed.map(item => {
    const { eventId, sequence, ...body } = item;
    const recreated = createSkillOperationEvent(body, { now: body.occurredAt });
    return { ...recreated, sequence };
  });
  const confounded = summarizeSkillOperations(normalizedChanged, query(), {
    minimumInvocations: 5, minimumTrendInvocations: 5, degradationDelta: 0.3,
  });
  assert.equal(confounded.status, 'insufficient_data');
  assert.equal(confounded.reasonCode, 'TREND_CONTEXT_CONFOUNDED');

  const gap = events.map(item => item.window === '2026-08-12'
    ? { ...item, occurredAt: '2026-08-11T10:00:00.000Z', window: '2026-08-11' }
    : item).map(item => {
      const { eventId, sequence, ...body } = item;
      const recreated = createSkillOperationEvent(body, { now: body.occurredAt });
      return { ...recreated, sequence };
    });
  const nonAdjacent = summarizeSkillOperations(gap, { ...query(), windowStart: '2026-08-11' }, {
    minimumInvocations: 5, minimumTrendInvocations: 5, degradationDelta: 0.3,
  });
  assert.notEqual(nonAdjacent.status, 'degrading');
  assert.equal(nonAdjacent.trend.reasonCode, 'ADJACENT_WINDOWS_REQUIRED');
});

test('重放拒绝 gap、伪造摘要与日志重复', () => {
  const events = append([], event('op_replay', 'impression'));
  assert.equal(replaySkillOperationEvents(events).throughSequence, 1);
  const { policyDigest, ...missingFixedField } = events[0];
  assert.throws(() => replaySkillOperationEvents([missingFixedField]), error => error.code === 'FIXED_SCHEMA_REQUIRED');
  assert.throws(() => replaySkillOperationEvents([{ ...events[0], sequence: 2 }]), error => error.code === 'SEQUENCE_GAP');
  assert.throws(() => replaySkillOperationEvents([{ ...events[0], eventId: `opsevt_${'0'.repeat(64)}` }]), error => error.code === 'EVENT_ID_MISMATCH');
  assert.throws(() => replaySkillOperationEvents([...events, { ...events[0], sequence: 2 }]), error => ['EVENT_LOG_INVALID', 'OPERATION_EVENT_CONFLICT'].includes(error.code));
});
