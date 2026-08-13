import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { createRoutingAssessment } from '../lib/routing-assessment.mjs';
import {
  SKILL_OPERATIONS_PROJECTION_MAX_EVENTS,
  SkillOperationsProjectionError,
  createSkillOperationsCatalogProjection,
  createSkillOperationsProjection,
} from '../lib/skill-operations-projection.mjs';
import { createSkillRecord } from '../lib/skill-record.mjs';
import { appendSkillOperationEvent, summarizeSkillOperations } from '../lib/skill-operations.mjs';

const D = character => `sha256:${character.repeat(64)}`;

function fixture(skillId = 'zaowuyun/writer', character = 'a') {
  const source = { type: 'registry', coordinate: `registry:${skillId}` };
  const sourceRef = sourceId(source);
  const evidence = { smsDigest: D('1'), evalDigest: D('2'), reviewEvidenceDigest: D('3'), reviewPolicyDigest: D('4') };
  const packageDigest = D(character);
  const version = '1.0.0';
  const release = normalizeRelease({
    skillId, version, releaseId: releaseId({ skillId, version, packageDigest }), status: 'published',
    package: { packageDigest, manifestDigest: D('0'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code', 'codex'] },
    assessmentRefs: [evidence.smsDigest, evidence.evalDigest], reviewRefs: [evidence.reviewEvidenceDigest, evidence.reviewPolicyDigest],
    sourceRefs: [sourceRef], publishedAt: '2026-08-13T00:00:00.000Z',
  });
  const record = createSkillRecord({
    release, source: { sourceId: sourceRef, ...source },
    metadata: {
      titleZh: '中文写作', descriptionZh: '将公开材料整理为结构清晰、语气自然并可继续复核的中文文章。',
      originalTitle: 'Chinese writer', originalDescription: 'Turn public materials into a structured Chinese article.',
      originalLanguage: 'en', localizationStatus: 'human_reviewed', translationSource: 'internal',
    },
    routing: {
      summary: '需要根据现有材料撰写或改写中文文章时使用。', intentTags: ['中文写作', '内容创作'],
      whenToUse: ['需要根据材料撰写中文文章'], whenNotToUse: ['只需要搜索资料'],
      examples: [
        { task: '把访谈整理成文章', expectedUse: true, reason: '属于中文内容创作' },
        { task: '搜索今天的新闻', expectedUse: false, reason: '只需搜索资料' },
      ],
      confusions: [{ skillId: 'zaowuyun/search', reason: '写作前可能需要资料', distinction: '写作技能产出文章，搜索技能只发现资料' }],
    },
    interface: {
      inputs: [{ name: 'materials', description: '公开且已清理的写作材料', required: true }],
      outputs: [{ name: 'article', description: '结构化中文文章' }],
    },
    dependencies: { required: [], optional: [], conflicts: [{ skillId: 'zaowuyun/search', releaseId: null, reason: '只搜索时不要调用写作技能' }] },
    permissions: { required: ['read:public-summary'], optional: [], prohibited: ['shell:execute'] },
    compatibility: release.compatibility, evidence,
  });
  const routingAssessment = createRoutingAssessment(record, { release });
  const compositionBody = {
    schemaVersion: 1, status: 'ready',
    taskIntent: { summaryZh: '这段任务摘要绝不能进入公共投影', intentTags: ['中文写作'], requirements: ['公开材料'] },
    environment: { contract: 'skill-package.v1', target: 'codex' },
    steps: [
      { position: 1, skillId, releaseId: release.releaseId, version, packageDigest, titleZh: '中文写作', reasonZh: '匹配任务意图：中文写作' },
      { position: 2, skillId: 'zaowuyun/review', releaseId: `rel_${'f'.repeat(64)}`, version: '1.0.0', packageDigest: D('f'), titleZh: '文章复核', reasonZh: '由必需依赖选入' },
    ],
    reasons: [{ code: 'GATES_PASSED', skillId, messageZh: '证据、权限与兼容门禁通过', blocking: false }],
    unselected: [], blockers: [], graph: { nodes: [], edges: [] },
  };
  const compositionPlan = { ...compositionBody, planDigest: canonicalDigest(compositionBody) };
  const operationsQuery = { organizationId: 'org_demo', projectId: 'project_demo', skillId, releaseId: release.releaseId, packageDigest, windowStart: '2026-08-13', windowEnd: '2026-08-13' };
  const operationsPolicy = { minimumInvocations: 6, highUsageThreshold: 6, lowUtilitySuccessRate: 0.6 };
  let operationsEvents = [];
  const append = (operationId, eventType, extras = {}) => {
    operationsEvents = appendSkillOperationEvent(operationsEvents, {
      schemaVersion: 1, operationId, eventType, organizationId: 'org_demo', projectId: 'project_demo',
      skillId, releaseId: release.releaseId, packageDigest, occurredAt: '2026-08-13T10:00:00.000Z',
      window: '2026-08-13', environmentDigest: D('6'), policyDigest: D('7'), ...extras,
    }, { now: '2026-08-13T10:00:00.000Z' }).events;
  };
  for (let index = 0; index < 6; index += 1) {
    const operationId = `op_demo_${index}`;
    append(operationId, 'impression');
    append(operationId, 'selected');
    append(operationId, 'invoked');
    if (index < 3) append(operationId, 'succeeded', { costMicros: 2_000, latencyMs: 420 + index });
    else if (index < 5) append(operationId, 'failed', { costMicros: 2_000, latencyMs: 1_240, failureCategory: 'timeout' });
    else append(operationId, 'handoff', { costMicros: 2_000, latencyMs: 900 });
  }
  append('op_demo_0', 'reused');
  const operationsSummary = summarizeSkillOperations(operationsEvents, operationsQuery, operationsPolicy);
  return { record, release, routingAssessment, compositionPlan, operationsEvents, operationsQuery, operationsPolicy, operationsSummary };
}

test('creates a deterministic public projection from current A/B/C outputs', () => {
  const input = fixture();
  const first = createSkillOperationsProjection(input);
  const second = createSkillOperationsProjection(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.projectionDigest, second.projectionDigest);
  assert.equal(first.skill.titleZh, '中文写作');
  assert.deepEqual(first.skill.intentTags, ['中文写作', '内容创作']);
  assert.equal(first.routing.limitations.includes('static_routing_quality_only'), true);
  assert.equal(first.composition.relatedSkills[0].titleZh, '文章复核');
  assert.deepEqual(first.composition.taskIntent, { intentTags: ['中文写作'], requirements: ['公开材料'] });
  assert.equal(first.operations.funnel.invoked.numerator, 6);
  assert.equal(first.operations.funnel.invoked.denominator, 6);
  assert.equal(first.operations.latency.samples, 6);
  assert.equal(first.operations.suggestedAction, 'review_for_coach');
  assert.equal(first.operations.governanceAction, 'none');
});

test('never exposes raw task summary, events, identities, paths, prompts, outputs, tokens or secrets', () => {
  const projection = createSkillOperationsProjection(fixture());
  const json = JSON.stringify(projection);
  for (const value of ['这段任务摘要绝不能进入公共投影', 'summaryZh', '"events"', 'operationId', 'cand_', 'storageRef', 'principal', 'prompt', '"output"', 'token', 'secret', '/Users/']) {
    assert.equal(json.includes(value), false, value);
  }
});

test('strictly rejects private extensions and current binding mismatches', () => {
  const input = fixture();
  assert.throws(() => createSkillOperationsProjection({ ...input, candidateId: 'cand_private' }), error => error.code === 'UNKNOWN_FIELD');
  const leakyBody = { ...input.compositionPlan, reasons: [{ code: 'LEAK', skillId: input.record.skillId, messageZh: '/Users/private', blocking: false }] };
  delete leakyBody.planDigest;
  assert.throws(() => createSkillOperationsProjection({
    ...input, compositionPlan: { ...leakyBody, planDigest: canonicalDigest(leakyBody) },
  }), error => error instanceof SkillOperationsProjectionError && error.code === 'PRIVATE_VALUE_FORBIDDEN');
  assert.throws(() => createSkillOperationsProjection({
    ...input, operationsSummary: { ...input.operationsSummary, status: 'healthy' },
  }), error => error.code === 'OPERATIONS_SUMMARY_MISMATCH');
  for (const operationsQuery of [
    { ...input.operationsQuery, releaseId: undefined },
    { ...input.operationsQuery, releaseId: `rel_${'e'.repeat(64)}` },
    { ...input.operationsQuery, packageDigest: undefined },
    { ...input.operationsQuery, packageDigest: D('e') },
  ]) {
    assert.throws(() => createSkillOperationsProjection({ ...input, operationsQuery }), error => error.code === 'OPERATIONS_QUERY_BINDING_MISMATCH');
  }
  assert.throws(() => createSkillOperationsProjection({
    ...input, compositionPlan: { ...input.compositionPlan, status: 'blocked' },
  }), error => error.code === 'PLAN_DIGEST_MISMATCH');
});

test('rejects oversized event input before aggregation', () => {
  const input = fixture();
  let inspected = false;
  const oversized = new Proxy(Array(SKILL_OPERATIONS_PROJECTION_MAX_EVENTS + 1), {
    get(target, property, receiver) {
      if (property !== 'length' && property !== Symbol.toStringTag) inspected = true;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => createSkillOperationsProjection({ ...input, operationsEvents: oversized }), error => error.code === 'OPERATIONS_EVENT_LIMIT_EXCEEDED');
  assert.equal(inspected, false, 'oversized events must be rejected before replay or aggregation');
});

test('catalog sort and digest are stable and duplicate Skills fail closed', () => {
  const first = fixture('zaowuyun/writer', 'a');
  const second = fixture('zaowuyun/reviewer', 'b');
  const left = createSkillOperationsCatalogProjection([first, second]);
  const right = createSkillOperationsCatalogProjection([second, first]);
  assert.deepEqual(left, right);
  assert.deepEqual(left.items.map(item => item.skill.skillId), ['zaowuyun/reviewer', 'zaowuyun/writer']);
  assert.throws(() => createSkillOperationsCatalogProjection([first, first]), error => error.code === 'DUPLICATE_SKILL');
});

test('zero-use evidence never suggests automatic governance', () => {
  const input = fixture();
  input.operationsEvents = [];
  delete input.operationsSummary;
  const projection = createSkillOperationsProjection(input);
  assert.equal(projection.operations.status, 'zero_usage');
  assert.equal(projection.operations.suggestedAction, 'none');
  assert.equal(projection.operations.governanceAction, 'none');
});
