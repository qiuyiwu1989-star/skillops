import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { createRoutingAssessment } from '../lib/routing-assessment.mjs';
import { SkillCompositionError, createSkillCompositionPlan } from '../lib/skill-composition.mjs';
import {
  SkillOperationsProjectionError,
  createSkillOperationsCatalogProjection,
  createSkillOperationsProjection,
} from '../lib/skill-operations-projection.mjs';
import { SkillOperationsStore } from '../lib/skill-operations-store.mjs';
import { createSkillRecord } from '../lib/skill-record.mjs';

const D = character => `sha256:${character.repeat(64)}`;
const NOW = '2026-08-13T12:00:00.000Z';
const FUTURE = '2026-08-14T00:00:00.000Z';
const DAY_1 = '2026-08-12T10:00:00.000Z';
const DAY_2 = '2026-08-13T10:00:00.000Z';
const ORGANIZATION_ID = 'org_zaowuyun';
const PROJECT_ID = 'project_market_upgrade';
const ENVIRONMENT_DIGEST = D('8');
const POLICY_DIGEST = D('9');
const OPERATIONS_POLICY = Object.freeze({
  minimumInvocations: 3,
  minimumTrendInvocations: 3,
  highUsageThreshold: 6,
  lowUtilitySuccessRate: 0.5,
  degradationDelta: 0.3,
});

function releaseFixture(skillId, character) {
  const packageDigest = D(character);
  const source = { type: 'registry', coordinate: `registry:${skillId}` };
  const sourceRef = sourceId(source);
  const evidence = {
    smsDigest: D('1'), evalDigest: D('2'), reviewEvidenceDigest: D('3'), reviewPolicyDigest: D('4'),
  };
  const version = '1.0.0';
  const release = normalizeRelease({
    schemaVersion: 1,
    skillId,
    version,
    releaseId: releaseId({ skillId, version, packageDigest }),
    status: 'published',
    package: { packageDigest, manifestDigest: D('0'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code', 'codex'] },
    assessmentRefs: [evidence.smsDigest, evidence.evalDigest],
    reviewRefs: [evidence.reviewEvidenceDigest, evidence.reviewPolicyDigest],
    sourceRefs: [sourceRef],
    publishedAt: '2026-08-01T00:00:00.000Z',
  });
  return { skillId, packageDigest, source, sourceRef, evidence, release };
}

function recordFor(fixture, {
  titleZh,
  summary,
  intentTag,
  whenToUse,
  whenNotToUse,
  required = [],
  conflicts = [],
  permissions = ['read:public-summary'],
} = {}) {
  return createSkillRecord({
    release: fixture.release,
    source: { sourceId: fixture.sourceRef, ...fixture.source },
    metadata: {
      titleZh,
      descriptionZh: `${titleZh}用于造物云公开内容工作流，并保留可复核的结构化结果。`,
      originalTitle: titleZh,
      originalDescription: `${titleZh}用于造物云公开内容工作流，并保留可复核的结构化结果。`,
      originalLanguage: 'zh-CN',
      localizationStatus: 'source',
      translationSource: null,
    },
    routing: {
      summary,
      intentTags: [intentTag],
      whenToUse: [whenToUse],
      whenNotToUse: [whenNotToUse],
      examples: [
        { task: whenToUse, expectedUse: true, reason: `属于${intentTag}任务` },
        { task: whenNotToUse, expectedUse: false, reason: `不属于${intentTag}任务` },
      ],
      confusions: [],
    },
    interface: {
      inputs: [{ name: 'public_materials', description: '已清理的公开材料摘要', required: true }],
      outputs: [{ name: 'public_result', description: '可供下一环节消费的公开结构化结果' }],
    },
    dependencies: { required, optional: [], conflicts },
    permissions: { required: permissions, optional: [], prohibited: ['secret:read'] },
    compatibility: fixture.release.compatibility,
    evidence: fixture.evidence,
  });
}

function dependency(record, reason) {
  return { skillId: record.skillId, releaseId: record.releaseId, reason };
}

function buildCatalog() {
  const researchFixture = releaseFixture('zaowuyun/research-brief', 'a');
  const research = recordFor(researchFixture, {
    titleZh: '资料研究', summary: '需要研究公开资料并形成证据简报时使用。', intentTag: '资料研究',
    whenToUse: '研究公开资料', whenNotToUse: '只需要撰写已有材料',
  });
  const writingFixture = releaseFixture('zaowuyun/chinese-writer', 'b');
  const writing = recordFor(writingFixture, {
    titleZh: '中文撰写', summary: '需要基于研究简报撰写中文文章时使用。', intentTag: '中文撰写',
    whenToUse: '撰写中文文章', whenNotToUse: '只需要搜索资料',
    required: [dependency(research, '写作前需要可信研究简报')], permissions: ['read:public-summary', 'write:article'],
  });
  const reviewFixture = releaseFixture('zaowuyun/content-review', 'c');
  const review = recordFor(reviewFixture, {
    titleZh: '内容复核', summary: '需要对中文文章进行质量复核时使用。', intentTag: '质量复核',
    whenToUse: '复核中文文章', whenNotToUse: '只需要研究公开资料',
    required: [dependency(writing, '复核对象必须是已生成文章')],
  });
  const fixtures = [researchFixture, writingFixture, reviewFixture];
  const records = [research, writing, review];
  const releases = fixtures.map(item => item.release);
  const routingAssessments = records.map((record, index) => createRoutingAssessment(record, { release: releases[index] }));
  return { fixtures, records, releases, routingAssessments, research, writing, review };
}

function snapshot(record, overrides = {}) {
  return {
    skillId: record.skillId,
    releaseId: record.releaseId,
    packageDigest: record.packageDigest,
    recordDigest: record.recordDigest,
    validUntil: {
      sms: FUTURE,
      eval: overrides.eval ?? FUTURE,
      review: FUTURE,
      packageAudit: FUTURE,
    },
  };
}

function compositionInput(catalog, overrides = {}) {
  return {
    taskIntent: {
      summaryZh: '研究公开资料、撰写中文文章并复核中文文章',
      intentTags: ['中文撰写', '质量复核', '资料研究'],
      requirements: ['公开材料'],
    },
    records: catalog.records,
    releases: catalog.releases,
    requestedSkillIds: [],
    environment: { contract: 'skill-package.v1', target: 'codex' },
    permissions: { allow: ['read:public-summary', 'write:article'] },
    policy: undefined,
    evidenceSnapshots: catalog.records.map(record => snapshot(record)),
    relations: [],
    ...overrides,
  };
}

function operationEvent(record, operationId, eventType, occurredAt, extras = {}) {
  return {
    schemaVersion: 1,
    operationId,
    eventType,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    skillId: record.skillId,
    releaseId: record.releaseId,
    packageDigest: record.packageDigest,
    occurredAt,
    window: occurredAt.slice(0, 10),
    environmentDigest: ENVIRONMENT_DIGEST,
    policyDigest: POLICY_DIGEST,
    ...extras,
  };
}

function append(store, input) {
  return store.append(input, { expectedRevision: store.read().revision, now: input.occurredAt });
}

function appendOperation(store, record, operationId, occurredAt, outcome, extras = {}) {
  for (const type of ['impression', 'selected', 'invoked']) append(store, operationEvent(record, operationId, type, occurredAt));
  append(store, operationEvent(record, operationId, outcome, occurredAt, extras));
}

function operationsQuery(record) {
  return {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    skillId: record.skillId,
    releaseId: record.releaseId,
    packageDigest: record.packageDigest,
    windowStart: '2026-08-12',
    windowEnd: '2026-08-13',
  };
}

function createOperationsStore(t, catalog) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v41-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'ledger', 'operations.json');
  const store = new SkillOperationsStore(filePath);

  for (let index = 0; index < 3; index += 1) {
    appendOperation(store, catalog.research, `op_research_old_${index}`, DAY_1, 'succeeded', { costMicros: 100, latencyMs: 100 });
    appendOperation(store, catalog.research, `op_research_new_${index}`, DAY_2, 'succeeded', { costMicros: 120, latencyMs: 120 });
    appendOperation(store, catalog.writing, `op_writing_old_${index}`, DAY_1, 'succeeded', { costMicros: 200, latencyMs: 200 });
    appendOperation(
      store,
      catalog.writing,
      `op_writing_new_${index}`,
      DAY_2,
      index === 0 ? 'succeeded' : 'failed',
      index === 0 ? { costMicros: 220, latencyMs: 220 } : { costMicros: 240, latencyMs: 240, failureCategory: 'task_error' },
    );
  }
  appendOperation(store, catalog.review, 'op_review_sparse_0', DAY_2, 'succeeded', { costMicros: 80, latencyMs: 80 });
  return { filePath, store };
}

function compositionError(code) {
  return error => error instanceof SkillCompositionError && error.code === code;
}

test('三条 canonical Release 形成真实 Record、Routing、Composition、运营趋势与公共目录闭环', t => {
  const catalog = buildCatalog();
  const plan = createSkillCompositionPlan(compositionInput(catalog), { now: NOW });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.steps.map(item => item.skillId), [catalog.research.skillId, catalog.writing.skillId, catalog.review.skillId]);
  assert.equal(plan.graph.edges.filter(item => item.type === 'required').length, 2);

  const { filePath, store } = createOperationsStore(t, catalog);
  const reopened = new SkillOperationsStore(filePath);
  assert.deepEqual(reopened.read(), store.read(), 'append-only ledger must survive restart without changing evidence');
  const summaries = catalog.records.map(record => reopened.summarize(operationsQuery(record), OPERATIONS_POLICY));
  assert.deepEqual(summaries.map(item => item.status), ['healthy', 'degrading', 'insufficient_data']);
  assert.ok(Math.abs(summaries[1].trend.successRateDelta - (-2 / 3)) < Number.EPSILON);
  assert.equal(summaries[2].conclusionStrength, 'observational', 'low sample must never become a strong judgment');
  for (const summary of summaries) {
    assert.equal(summary.governanceAction, 'none');
    assert.equal(summary.autoRetirementAllowed, false);
  }

  const events = reopened.read().events;
  const projectionInputs = catalog.records.map((record, index) => ({
    record,
    release: catalog.releases[index],
    routingAssessment: catalog.routingAssessments[index],
    compositionPlan: plan,
    operationsEvents: events,
    operationsQuery: operationsQuery(record),
    operationsPolicy: OPERATIONS_POLICY,
    operationsSummary: summaries[index],
  }));
  const publicCatalog = createSkillOperationsCatalogProjection(projectionInputs);
  assert.equal(publicCatalog.count, 3);
  assert.deepEqual(publicCatalog.items.map(item => item.skill.skillId), [
    catalog.writing.skillId, catalog.review.skillId, catalog.research.skillId,
  ]);
  assert.deepEqual(publicCatalog.items.map(item => item.operations.status), ['degrading', 'insufficient_data', 'healthy']);
  assert.equal(publicCatalog.items.find(item => item.skill.skillId === catalog.writing.skillId).operations.suggestedAction, 'review_for_coach');
  assert.equal(publicCatalog.items.find(item => item.skill.skillId === catalog.review.skillId).operations.suggestedAction, 'none');
  assert.equal(publicCatalog.items.every(item => item.operations.governanceAction === 'none'), true);

  const json = JSON.stringify(publicCatalog);
  for (const forbidden of ['"events"', 'operationId', 'op_research_', 'op_writing_', 'op_review_', 'cand_', 'storageRef', '/Users/', 'Bearer ', 'sk-private']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.equal(json.includes('研究公开资料、撰写中文文章并复核中文文章'), false, 'raw task summary must be removed');
});

test('伪 Record/Release、过期证据与循环、冲突、权限问题全部失败关闭', () => {
  const catalog = buildCatalog();
  const forgedRecord = { ...catalog.writing, skillId: 'attacker/forged-writer' };
  assert.throws(
    () => createSkillCompositionPlan(compositionInput(catalog, { records: [catalog.research, forgedRecord, catalog.review] }), { now: NOW }),
    compositionError('SKILL_RECORD_NOT_CURRENT'),
  );
  const forgedRelease = {
    ...catalog.releases[0],
    package: { ...catalog.releases[0].package, packageDigest: D('f'), storageRef: `cas:${D('f')}` },
  };
  assert.throws(
    () => createSkillCompositionPlan(compositionInput(catalog, { releases: [forgedRelease, ...catalog.releases.slice(1)] }), { now: NOW }),
    error => ['SKILL_RECORD_NOT_CURRENT', 'RELEASE_REQUIRED'].includes(error.code),
  );
  const expired = catalog.records.map(record => snapshot(record));
  expired[1] = snapshot(catalog.writing, { eval: NOW });
  assert.throws(
    () => createSkillCompositionPlan(compositionInput(catalog, { evidenceSnapshots: expired }), { now: NOW }),
    compositionError('EVIDENCE_EXPIRED'),
  );

  const cycle = createSkillCompositionPlan(compositionInput(catalog, {
    relations: [{
      type: 'before',
      from: { skillId: catalog.review.skillId, releaseId: catalog.review.releaseId },
      to: { skillId: catalog.research.skillId, releaseId: catalog.research.releaseId },
      reason: '构造反向顺序以验证循环门禁',
    }],
  }), { now: NOW });
  assert.equal(cycle.status, 'blocked');
  assert.equal(cycle.steps.length, 0);
  assert.equal(cycle.blockers.some(item => item.code === 'DEPENDENCY_CYCLE'), true);

  const conflictResearch = recordFor(catalog.fixtures[0], {
    titleZh: '资料研究', summary: '需要研究公开资料并形成证据简报时使用。', intentTag: '资料研究',
    whenToUse: '研究公开资料', whenNotToUse: '只需要撰写已有材料',
    conflicts: [dependency(catalog.review, '研究与复核冲突样本不能同时运行')],
  });
  const conflictReview = recordFor(catalog.fixtures[2], {
    titleZh: '内容复核', summary: '需要对中文文章进行质量复核时使用。', intentTag: '质量复核',
    whenToUse: '复核中文文章', whenNotToUse: '只需要研究公开资料',
    required: [dependency(catalog.writing, '复核对象必须是已生成文章')],
  });
  const conflictCatalog = { ...catalog, records: [conflictResearch, catalog.writing, conflictReview] };
  const conflict = createSkillCompositionPlan(compositionInput(conflictCatalog), { now: NOW });
  assert.equal(conflict.status, 'blocked');
  assert.equal(conflict.steps.length, 0);
  assert.equal(conflict.blockers.some(item => item.code === 'SKILL_CONFLICT'), true);

  const denied = createSkillCompositionPlan(compositionInput(catalog, {
    permissions: { allow: ['read:public-summary'] },
  }), { now: NOW });
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.steps.length, 0);
  assert.equal(denied.blockers.some(item => item.code === 'PERMISSION_NOT_ALLOWED' && item.skillId === catalog.writing.skillId), true);
});

test('运营身份漂移、敏感字段、伪 summary 与伪 plan 均不能污染台账或公共投影', t => {
  const catalog = buildCatalog();
  const plan = createSkillCompositionPlan(compositionInput(catalog), { now: NOW });
  const { store } = createOperationsStore(t, catalog);
  const before = store.read();

  assert.throws(
    () => append(store, operationEvent(catalog.review, 'op_research_old_0', 'reused', DAY_2)),
    error => error.code === 'OPERATION_IDENTITY_DRIFT',
  );
  assert.deepEqual(store.read(), before, 'identity drift must be a zero-write failure');

  assert.throws(
    () => append(store, { ...operationEvent(catalog.research, 'op_sensitive', 'impression', DAY_2), prompt: 'Bearer sk-private-credential' }),
    error => error.code === 'PRIVATE_FIELD_FORBIDDEN',
  );
  assert.deepEqual(store.read(), before, 'sensitive events must be a zero-write failure');

  const query = operationsQuery(catalog.writing);
  const summary = store.summarize(query, OPERATIONS_POLICY);
  const projectionInput = {
    record: catalog.writing,
    release: catalog.releases[1],
    routingAssessment: catalog.routingAssessments[1],
    compositionPlan: plan,
    operationsEvents: store.read().events,
    operationsQuery: query,
    operationsPolicy: OPERATIONS_POLICY,
    operationsSummary: summary,
  };
  const forgedSummary = structuredClone(summary);
  forgedSummary.status = 'healthy';
  forgedSummary.metrics.observedOperations = 999;
  assert.throws(
    () => createSkillOperationsProjection({ ...projectionInput, operationsSummary: forgedSummary }),
    error => error instanceof SkillOperationsProjectionError && error.code === 'OPERATIONS_SUMMARY_MISMATCH',
  );
  const forgedPlan = structuredClone(plan);
  forgedPlan.steps[0].reasonZh = '调用者伪造的推荐理由';
  assert.throws(
    () => createSkillOperationsProjection({ ...projectionInput, compositionPlan: forgedPlan }),
    error => error instanceof SkillOperationsProjectionError && error.code === 'PLAN_DIGEST_MISMATCH',
  );
  const unboundQuery = { ...query };
  delete unboundQuery.releaseId;
  delete unboundQuery.packageDigest;
  assert.throws(
    () => createSkillOperationsProjection({ ...projectionInput, operationsQuery: unboundQuery, operationsSummary: undefined }),
    error => error instanceof SkillOperationsProjectionError && error.code === 'OPERATIONS_QUERY_BINDING_MISMATCH',
  );
  assert.throws(
    () => createSkillOperationsProjection({ ...projectionInput, operationsEvents: Array(10_001).fill(store.read().events[0]), operationsSummary: undefined }),
    error => error instanceof SkillOperationsProjectionError && error.code === 'OPERATIONS_EVENT_LIMIT_EXCEEDED',
  );

  const projection = createSkillOperationsProjection(projectionInput);
  assert.equal(projection.operations.status, 'degrading');
  assert.equal(projection.operations.governanceAction, 'none');
  assert.equal(projection.operations.suggestedAction, 'review_for_coach');
});
