import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { createRoutingAssessment, isRoutingAssessmentCurrent, validateRoutingAssessment } from '../lib/routing-assessment.mjs';
import { createSkillRecord } from '../lib/skill-record.mjs';

const D = value => `sha256:${value.repeat(64)}`;
const evidence = { smsDigest: D('c'), evalDigest: D('d'), reviewEvidenceDigest: D('e'), reviewPolicyDigest: D('f') };
const source = { type: 'registry', coordinate: 'registry:zaowuyun/writing' };
const sourceRef = sourceId(source);

function release() {
  const skillId = 'zaowuyun/writing';
  const packageDigest = D('a');
  return normalizeRelease({
    skillId, version: '1.0.0', releaseId: releaseId({ skillId, version: '1.0.0', packageDigest }),
    package: { packageDigest, manifestDigest: D('b'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code', 'codex'] },
    assessmentRefs: [evidence.smsDigest, evidence.evalDigest], reviewRefs: [evidence.reviewEvidenceDigest, evidence.reviewPolicyDigest],
    sourceRefs: [sourceRef], publishedAt: '2026-08-13T00:00:00Z',
  });
}

function recordInput(routing = {}) {
  return {
    release: release(), source: { sourceId: sourceRef, ...source },
    metadata: {
      titleZh: '中文写作', descriptionZh: '根据明确任务和材料形成结构清楚的中文文章或业务文本。',
      originalTitle: '中文写作', originalDescription: '根据明确任务和材料形成结构清楚的中文文章或业务文本。',
      originalLanguage: 'zh-CN', localizationStatus: 'source', translationSource: null,
    },
    routing: {
      summary: '需要根据给定材料撰写、改写或整理中文文章时使用。', intentTags: ['中文写作', '内容创作'],
      whenToUse: ['需要根据材料撰写中文文章', '需要改写已有中文文本'],
      whenNotToUse: ['只需要搜索资料', '需要运行部署脚本'],
      examples: [
        { task: '把访谈整理成文章', expectedUse: true, reason: '属于中文内容创作' },
        { task: '搜索今天的新闻', expectedUse: false, reason: '只需搜索而非写作' },
      ],
      confusions: [{ skillId: 'zaowuyun/web-search', reason: '写作前可能需要资料', distinction: '本技能产出文章，搜索技能只发现资料' }],
      ...routing,
    },
    interface: {
      inputs: [{ name: 'materials', description: '公开且已经清理的写作材料', required: true }],
      outputs: [{ name: 'article', description: '结构化中文文章' }],
    },
    dependencies: { required: [], optional: [], conflicts: [{ skillId: 'zaowuyun/web-search', releaseId: null, reason: '仅搜索时不应调用写作技能' }] },
    permissions: { required: ['read:public-summary'], optional: [], prohibited: ['shell:execute'] },
    compatibility: { contract: 'skill-package.v1', targets: ['codex', 'claude-code'] }, evidence,
  };
}

test('deterministically recomputes five static routing dimensions', () => {
  const record = createSkillRecord(recordInput());
  const assessment = createRoutingAssessment(record, { release: release() });
  assert.deepEqual(assessment.dimensions.map(item => item.key), [
    'metadataCompleteness', 'positiveNegativeExamples', 'intentDistinctiveness', 'conflictDisclosure', 'portability',
  ]);
  assert.equal(assessment.total, 100);
  assert.equal(assessment.grade, 'excellent');
  assert.deepEqual(assessment.limitations, ['not_runtime_eval', 'static_routing_quality_only']);
  assert.equal(validateRoutingAssessment(structuredClone(assessment), { record, release: release() }).assessmentDigest, assessment.assessmentDigest);
});

test('missing positive and negative examples lower deterministic quality', () => {
  const record = createSkillRecord(recordInput({
    whenToUse: [], whenNotToUse: [], examples: [],
  }));
  const assessment = createRoutingAssessment(record);
  assert.equal(assessment.dimensions.find(item => item.key === 'positiveNegativeExamples').score, 0);
  assert.ok(assessment.findings.includes('missing_positive_example'));
  assert.ok(assessment.findings.includes('missing_negative_example'));
});

test('ambiguous intent boundaries and missing confusion comparison are reported', () => {
  const record = createSkillRecord(recordInput({
    whenToUse: ['需要根据材料撰写中文文章'], whenNotToUse: ['需要根据材料撰写中文文章'], confusions: [],
  }));
  const assessment = createRoutingAssessment(record);
  assert.ok(assessment.findings.includes('positive_negative_boundary_duplicate'));
  assert.ok(assessment.findings.includes('no_confusion_comparison'));
  assert.ok(assessment.dimensions.find(item => item.key === 'intentDistinctiveness').score < 20);
});

test('a confusion without a declared conflict is visible and penalized', () => {
  const value = recordInput();
  value.dependencies.conflicts = [];
  const assessment = createRoutingAssessment(createSkillRecord(value));
  assert.ok(assessment.findings.includes('confusion_conflict_not_declared'));
  assert.equal(assessment.dimensions.find(item => item.key === 'conflictDisclosure').score, 12);
});

test('portability score reflects interfaces, target breadth, and pinned dependencies', () => {
  const value = recordInput();
  value.interface.inputs = [];
  value.interface.outputs = [];
  value.dependencies.required = [{ skillId: 'zaowuyun/parser', releaseId: releaseId({ skillId: 'zaowuyun/parser', version: '1.0.0', packageDigest: D('9') }), reason: '固定解析器' }];
  value.release = normalizeRelease({ ...release(), compatibility: { contract: 'skill-package.v1', targets: ['codex'] } });
  value.compatibility.targets = ['codex'];
  const assessment = createRoutingAssessment(createSkillRecord(value));
  const portability = assessment.dimensions.find(item => item.key === 'portability');
  assert.equal(portability.score, 6);
  assert.deepEqual(portability.reasons, ['inputs_not_described', 'outputs_not_described', 'release_pinned_dependency', 'single_compatibility_target']);
});

test('caller cannot forge totals, dimensions, findings, or runtime success claims', () => {
  const record = createSkillRecord(recordInput());
  const assessment = createRoutingAssessment(record);
  for (const forged of [
    { ...assessment, total: 12 },
    { ...assessment, grade: 'weak' },
    { ...assessment, successRate: 1 },
    { ...assessment, findings: ['forged_runtime_claim'] },
  ]) assert.throws(() => validateRoutingAssessment(forged, { record }));
});

test('record or routing digest changes make old assessment non-current', () => {
  const first = createSkillRecord(recordInput());
  const assessment = createRoutingAssessment(first);
  const changedRoute = createSkillRecord(recordInput({ whenToUse: [...recordInput().routing.whenToUse, '需要写作研究报告'] }));
  assert.equal(isRoutingAssessmentCurrent(assessment, { record: changedRoute }), false);

  const changedMetadata = recordInput();
  changedMetadata.metadata.titleZh = '中文业务写作';
  const second = createSkillRecord(changedMetadata);
  assert.equal(second.routingDigest, first.routingDigest);
  assert.notEqual(second.recordDigest, first.recordDigest);
  assert.equal(isRoutingAssessmentCurrent(assessment, { record: second }), false);
});

test('canonical Release mismatch makes assessment non-current', () => {
  const record = createSkillRecord(recordInput());
  const assessment = createRoutingAssessment(record);
  const otherPackage = D('8');
  const changed = normalizeRelease({
    ...release(), releaseId: releaseId({ skillId: 'zaowuyun/writing', version: '1.0.0', packageDigest: otherPackage }),
    package: { packageDigest: otherPackage, manifestDigest: D('7'), storageRef: `cas:${otherPackage}` },
  });
  assert.equal(isRoutingAssessmentCurrent(assessment, { record, release: changed }), false);
});
