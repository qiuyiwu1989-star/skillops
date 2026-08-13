import { canonicalDigest } from './registry-identity.mjs';
import { validateRoutingAssessment } from './routing-assessment.mjs';
import { validateSkillRecord } from './skill-record.mjs';
import { summarizeSkillOperations } from './skill-operations.mjs';

export const SKILL_OPERATIONS_PROJECTION_SCHEMA_VERSION = 1;
export const SKILL_OPERATIONS_PROJECTION_MAX_EVENTS = 10_000;

const PRIVATE_KEY = /^(?:events?|rawEvents?|eventId|operationId|occurredAt|taskIntent\.summaryZh|summaryZh|candidate|candidateId|cand|path|localPath|absolutePath|storageRef|principal|principalId|prompt|output|token|secret|password|credential|apiKey)$/i;
const PRIVATE_VALUE = /(?:^cand_|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/i;
const STATUS = new Set(['healthy', 'degrading', 'high_usage_low_utility', 'zero_usage', 'insufficient_data']);
const PLAN_STATUS = new Set(['ready', 'blocked', 'no_match']);

export class SkillOperationsProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillOperationsProjectionError';
    this.code = code;
  }
}

function fail(code, message) { throw new SkillOperationsProjectionError(code, message); }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} 必须是对象`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} 含未知字段：${unknown.join(', ')}`);
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} 必须是非空字符串`);
  const result = value.normalize('NFC').trim();
  if (result.includes('\0') || [...result].length > maximum) fail('INVALID_TEXT', `${label} 超出限制`);
  return result;
}

function nullableText(value, label, maximum = 1_000) {
  return value == null ? null : text(value, label, maximum);
}

function finite(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_METRIC', `${label} 必须是范围内的有限数字`);
  }
  return value;
}

function integer(value, label) {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result)) fail('INVALID_METRIC', `${label} 必须是安全整数`);
  return result;
}

function stringList(value, label, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) fail('INVALID_LIST', `${label} 必须是受限数组`);
  return Object.freeze(value.map((item, index) => text(item, `${label}[${index}]`, 500)));
}

function assertPublic(value, label = 'projection') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublic(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) fail('PRIVATE_FIELD_FORBIDDEN', `${label}.${key} 不允许进入公共投影`);
      assertPublic(nested, `${label}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && PRIVATE_VALUE.test(value)) fail('PRIVATE_VALUE_FORBIDDEN', `${label} 含非公开值`);
}

function projectRecord(record) {
  return Object.freeze({
    skillId: record.skillId,
    releaseId: record.releaseId,
    version: record.version,
    packageDigest: record.packageDigest,
    recordDigest: record.recordDigest,
    titleZh: record.metadata.titleZh,
    descriptionZh: record.metadata.descriptionZh,
    originalTitle: record.metadata.originalTitle,
    originalLanguage: record.metadata.originalLanguage,
    localizationStatus: record.metadata.localizationStatus,
    intentTags: Object.freeze([...record.routing.intentTags]),
    routingSummary: record.routing.summary,
    interface: Object.freeze({
      inputs: Object.freeze(record.interface.inputs.map(item => ({ name: item.name, description: item.description, required: item.required }))),
      outputs: Object.freeze(record.interface.outputs.map(item => ({ name: item.name, description: item.description }))),
    }),
    permissions: Object.freeze({
      required: Object.freeze([...record.permissions.required]),
      optional: Object.freeze([...record.permissions.optional]),
      prohibited: Object.freeze([...record.permissions.prohibited]),
    }),
    compatibility: Object.freeze({ contract: record.compatibility.contract, targets: Object.freeze([...record.compatibility.targets]) }),
  });
}

function projectRouting(record, assessment) {
  return Object.freeze({
    assessmentDigest: assessment.assessmentDigest,
    basedOnRoutingDigest: assessment.basedOnRoutingDigest,
    rubricVersion: assessment.rubricVersion,
    total: assessment.total,
    maxTotal: assessment.dimensions.reduce((sum, item) => sum + item.maxScore, 0),
    grade: assessment.grade,
    limitations: Object.freeze([...assessment.limitations]),
    dimensions: Object.freeze(assessment.dimensions.map(item => ({
      key: item.key, label: item.label, score: item.score, maxScore: item.maxScore, reasons: Object.freeze([...item.reasons]),
    }))),
    whenToUse: Object.freeze([...record.routing.whenToUse]),
    whenNotToUse: Object.freeze([...record.routing.whenNotToUse]),
    examples: Object.freeze(record.routing.examples.map(item => ({ task: item.task, expectedUse: item.expectedUse, reason: item.reason }))),
    confusions: Object.freeze(record.routing.confusions.map(item => ({ skillId: item.skillId, reason: item.reason, distinction: item.distinction }))),
  });
}

function publicReason(value, label) {
  object(value, label);
  return Object.freeze({
    code: text(value.code, `${label}.code`, 128),
    skillId: value.skillId == null ? null : text(value.skillId, `${label}.skillId`, 127),
    messageZh: text(value.messageZh, `${label}.messageZh`, 500),
    blocking: value.blocking === true,
  });
}

function projectComposition(plan, currentSkillId) {
  object(plan, 'compositionPlan');
  exactKeys(plan, new Set([
    'schemaVersion', 'status', 'taskIntent', 'environment', 'steps', 'reasons', 'unselected', 'blockers', 'graph', 'planDigest',
  ]), 'compositionPlan');
  const { planDigest, ...planBody } = plan;
  if (canonicalDigest(planBody) !== planDigest) fail('PLAN_DIGEST_MISMATCH', 'compositionPlan.planDigest 与计划内容不一致');
  if (!PLAN_STATUS.has(plan.status)) fail('INVALID_PLAN', 'compositionPlan.status 不受支持');
  if (!plan.taskIntent || !Array.isArray(plan.taskIntent.intentTags) || !Array.isArray(plan.taskIntent.requirements)) {
    fail('INVALID_PLAN', 'compositionPlan 缺少结构化任务意图');
  }
  const steps = Array.isArray(plan.steps) ? plan.steps.map((item, index) => {
    object(item, `compositionPlan.steps[${index}]`);
    return Object.freeze({
      position: integer(item.position, `compositionPlan.steps[${index}].position`),
      skillId: text(item.skillId, `compositionPlan.steps[${index}].skillId`, 127),
      releaseId: text(item.releaseId, `compositionPlan.steps[${index}].releaseId`, 80),
      titleZh: text(item.titleZh, `compositionPlan.steps[${index}].titleZh`, 160),
      reasonZh: text(item.reasonZh, `compositionPlan.steps[${index}].reasonZh`, 500),
    });
  }) : fail('INVALID_PLAN', 'compositionPlan.steps 必须是数组');
  const relatedSkills = steps.filter(item => item.skillId !== currentSkillId).map(item => ({
    skillId: item.skillId, releaseId: item.releaseId, titleZh: item.titleZh, relation: 'composition_step', reasonZh: item.reasonZh,
  }));
  const blockers = (Array.isArray(plan.blockers) ? plan.blockers : []).map((item, index) => publicReason(item, `compositionPlan.blockers[${index}]`));
  const reasons = (Array.isArray(plan.reasons) ? plan.reasons : []).map((item, index) => publicReason(item, `compositionPlan.reasons[${index}]`));
  return Object.freeze({
    status: plan.status,
    planDigest: text(planDigest, 'compositionPlan.planDigest', 71),
    taskIntent: Object.freeze({
      intentTags: stringList(plan.taskIntent.intentTags, 'compositionPlan.taskIntent.intentTags', 30),
      requirements: stringList(plan.taskIntent.requirements, 'compositionPlan.taskIntent.requirements', 30),
    }),
    steps: Object.freeze(steps),
    relatedSkills: Object.freeze(relatedSkills),
    reasons: Object.freeze(reasons),
    blockers: Object.freeze(blockers),
  });
}

function funnelStage(value, label, first = false) {
  object(value, label);
  const observed = integer(value.observed, `${label}.observed`);
  if (first) return Object.freeze({ observed, numerator: observed, denominator: observed, rate: observed ? 1 : null });
  const numerator = integer(value.numerator, `${label}.numerator`);
  const denominator = integer(value.denominator, `${label}.denominator`);
  const rate = finite(value.rate, `${label}.rate`, { maximum: 1, nullable: true });
  return Object.freeze({ observed, numerator, denominator, rate });
}

const HEALTH_LABELS = Object.freeze({
  healthy: ['运行健康', '当前样本达到阈值，运营指标处于策略范围内。'],
  degrading: ['表现退化', '相邻可比窗口的成功率出现显著下降。'],
  high_usage_low_utility: ['高使用低效用', '调用量较高，但成功率低于效用阈值。'],
  zero_usage: ['零使用', '当前观察窗口内没有技能调用。'],
  insufficient_data: ['证据不足', '当前样本量或结果覆盖不足，不能作强判断。'],
});

function projectOperations(summary, record) {
  object(summary, 'operationsSummary');
  if (!STATUS.has(summary.status)) fail('INVALID_OPERATIONS', 'operationsSummary.status 不受支持');
  object(summary.query, 'operationsSummary.query');
  if (summary.query.skillId !== record.skillId || (summary.query.releaseId && summary.query.releaseId !== record.releaseId)
    || (summary.query.packageDigest && summary.query.packageDigest !== record.packageDigest)) {
    fail('OPERATIONS_BINDING_MISMATCH', '运营摘要未绑定当前 Skill/Release/Package');
  }
  const metrics = object(summary.metrics, 'operationsSummary.metrics');
  const outcomes = object(metrics.outcomes, 'operationsSummary.metrics.outcomes');
  const cost = object(metrics.cost, 'operationsSummary.metrics.cost');
  const latency = object(metrics.latency, 'operationsSummary.metrics.latency');
  const [healthLabelZh, healthReasonZh] = HEALTH_LABELS[summary.status];
  const needsCoach = ['degrading', 'high_usage_low_utility'].includes(summary.status);
  return Object.freeze({
    status: summary.status,
    reasonCode: text(summary.reasonCode, 'operationsSummary.reasonCode', 128),
    healthLabelZh,
    healthReasonZh,
    conclusionStrength: text(summary.conclusionStrength, 'operationsSummary.conclusionStrength', 32),
    window: Object.freeze({ start: text(summary.query.windowStart, 'operationsSummary.query.windowStart', 10), end: text(summary.query.windowEnd, 'operationsSummary.query.windowEnd', 10) }),
    sample: Object.freeze({ observedOperations: integer(metrics.observedOperations, 'operationsSummary.metrics.observedOperations'), observedEvents: integer(metrics.observedEvents, 'operationsSummary.metrics.observedEvents') }),
    funnel: Object.freeze({
      impression: funnelStage(metrics.funnel.impression, 'operationsSummary.metrics.funnel.impression', true),
      selected: funnelStage(metrics.funnel.selected, 'operationsSummary.metrics.funnel.selected'),
      invoked: funnelStage(metrics.funnel.invoked, 'operationsSummary.metrics.funnel.invoked'),
      succeeded: funnelStage(metrics.funnel.succeeded, 'operationsSummary.metrics.funnel.succeeded'),
      reused: funnelStage(metrics.funnel.reused, 'operationsSummary.metrics.funnel.reused'),
    }),
    outcomes: Object.freeze({
      samples: integer(outcomes.observed, 'operationsSummary.metrics.outcomes.observed'),
      denominator: integer(outcomes.denominator, 'operationsSummary.metrics.outcomes.denominator'),
      successes: integer(outcomes.successes, 'operationsSummary.metrics.outcomes.successes'),
      failures: integer(outcomes.failures, 'operationsSummary.metrics.outcomes.failures'),
      handoffs: integer(outcomes.handoffs, 'operationsSummary.metrics.outcomes.handoffs'),
      successRate: finite(outcomes.successRate, 'operationsSummary.metrics.outcomes.successRate', { maximum: 1, nullable: true }),
      handoffRate: finite(outcomes.handoffRate, 'operationsSummary.metrics.outcomes.handoffRate', { maximum: 1, nullable: true }),
    }),
    cost: Object.freeze({
      samples: integer(cost.samples, 'operationsSummary.metrics.cost.samples'),
      totalMicros: integer(cost.totalMicros, 'operationsSummary.metrics.cost.totalMicros'),
      averageMicros: finite(cost.averageMicros, 'operationsSummary.metrics.cost.averageMicros', { nullable: true }),
    }),
    latency: Object.freeze({
      samples: integer(latency.samples, 'operationsSummary.metrics.latency.samples'),
      p50Ms: finite(latency.p50Ms, 'operationsSummary.metrics.latency.p50Ms', { nullable: true }),
      p95Ms: finite(latency.p95Ms, 'operationsSummary.metrics.latency.p95Ms', { nullable: true }),
    }),
    failureCategories: Object.freeze(Object.fromEntries(Object.entries(object(metrics.failureCategories, 'operationsSummary.metrics.failureCategories')).map(([key, value]) => [text(key, 'failureCategory', 64), integer(value, `failureCategories.${key}`)]))),
    trend: Object.freeze({
      comparable: summary.trend?.comparable === true,
      reasonCode: nullableText(summary.trend?.reasonCode, 'operationsSummary.trend.reasonCode', 128),
      successRateDelta: finite(summary.trend?.successRateDelta ?? null, 'operationsSummary.trend.successRateDelta', { minimum: -1, maximum: 1, nullable: true }),
    }),
    suggestedAction: needsCoach ? 'review_for_coach' : 'none',
    coachReasonZh: needsCoach ? healthReasonZh : null,
    governanceAction: 'none',
  });
}

/**
 * 将 V4.1 A/B/C 的内部产物裁剪为固定、确定性且隐私安全的只读公共投影。
 * 展示时间不进入投影；调用方若需要页面构建时间，应在投影外单独维护。
 */
export function createSkillOperationsProjection(input) {
  exactKeys(input, new Set([
    'record', 'release', 'routingAssessment', 'compositionPlan', 'operationsEvents', 'operationsQuery', 'operationsPolicy', 'operationsSummary',
  ]), 'input');
  const record = validateSkillRecord(input.record, { release: input.release });
  const assessment = validateRoutingAssessment(input.routingAssessment, { record, release: input.release });
  if (!Array.isArray(input.operationsEvents)) fail('OPERATIONS_EVENTS_REQUIRED', '必须提供受限运营事件并在投影边界重新聚合');
  if (input.operationsEvents.length > SKILL_OPERATIONS_PROJECTION_MAX_EVENTS) {
    fail('OPERATIONS_EVENT_LIMIT_EXCEEDED', `公共投影最多接收 ${SKILL_OPERATIONS_PROJECTION_MAX_EVENTS} 条运营事件`);
  }
  const operationsQuery = object(input.operationsQuery, 'operationsQuery');
  if (operationsQuery.releaseId !== record.releaseId || operationsQuery.packageDigest !== record.packageDigest) {
    fail('OPERATIONS_QUERY_BINDING_MISMATCH', '运营查询必须精确绑定当前 Skill Record 的 Release 与 Package');
  }
  const operationsSummary = summarizeSkillOperations(input.operationsEvents, operationsQuery, input.operationsPolicy ?? {});
  if (input.operationsSummary !== undefined && canonicalDigest(input.operationsSummary) !== canonicalDigest(operationsSummary)) {
    fail('OPERATIONS_SUMMARY_MISMATCH', '传入运营摘要与事件重算结果不一致');
  }
  const core = {
    schemaVersion: SKILL_OPERATIONS_PROJECTION_SCHEMA_VERSION,
    skill: projectRecord(record),
    routing: projectRouting(record, assessment),
    composition: projectComposition(input.compositionPlan, record.skillId),
    operations: projectOperations(operationsSummary, record),
  };
  assertPublic(core);
  const projection = Object.freeze({ ...core, projectionDigest: canonicalDigest(core) });
  assertPublic(projection);
  return projection;
}

export function createSkillOperationsCatalogProjection(items) {
  if (!Array.isArray(items)) fail('INVALID_LIST', 'items 必须是数组');
  const projections = items.map(createSkillOperationsProjection).sort((left, right) => left.skill.skillId.localeCompare(right.skill.skillId, 'en'));
  const skillIds = projections.map(item => item.skill.skillId);
  if (new Set(skillIds).size !== skillIds.length) fail('DUPLICATE_SKILL', '公共目录每个技能只能包含一个 Release');
  const core = { schemaVersion: SKILL_OPERATIONS_PROJECTION_SCHEMA_VERSION, count: projections.length, items: projections };
  assertPublic(core);
  return Object.freeze({ ...core, projectionDigest: canonicalDigest(core) });
}
