import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import {
  SkillRecordValidationError,
  createSkillRecord,
  isSkillRecordCurrent,
  validateSkillRecord,
} from '../lib/skill-record.mjs';

const D = value => `sha256:${value.repeat(64)}`;
const skillId = 'zaowuyun/research-synthesis';
const packageDigest = D('a');
const source = { type: 'github', coordinate: 'github:owner/repo@abc:skills/research' };
const sourceRef = sourceId(source);
const evidence = {
  smsDigest: D('c'), evalDigest: D('d'), reviewEvidenceDigest: D('e'), reviewPolicyDigest: D('f'),
};

function release(overrides = {}) {
  return normalizeRelease({
    skillId,
    version: '2.1.0',
    releaseId: releaseId({ skillId, version: '2.1.0', packageDigest }),
    package: { packageDigest, manifestDigest: D('b'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code', 'codex'] },
    assessmentRefs: [evidence.smsDigest, evidence.evalDigest],
    reviewRefs: [evidence.reviewEvidenceDigest, evidence.reviewPolicyDigest],
    sourceRefs: [sourceRef],
    publishedAt: '2026-08-13T00:00:00Z',
    ...overrides,
  });
}

function input(overrides = {}) {
  return {
    release: release(),
    source: { sourceId: sourceRef, ...source },
    metadata: {
      titleZh: '研究综述', descriptionZh: '把多来源材料整理为结构化中文研究综述。',
      originalTitle: 'Research synthesis', originalDescription: 'Synthesizes multiple sources into a structured research brief.',
      originalLanguage: 'en', localizationStatus: 'auto_translated', translationSource: 'fixture-translator.v1',
    },
    routing: {
      summary: '当需要综合多个可靠来源并形成结构化研究结论时使用。',
      intentTags: ['研究', '综合'],
      whenToUse: ['需要比较多个来源的共同结论', '需要形成带证据的研究简报'],
      whenNotToUse: ['只需要查找一个确定事实', '需要执行第三方代码'],
      examples: [
        { task: '比较五篇技能管理论文', expectedUse: true, reason: '需要多来源综合' },
        { task: '今天几点了', expectedUse: false, reason: '不需要研究综述' },
      ],
      confusions: [{ skillId: 'zaowuyun/web-search', reason: '都可能读取资料', distinction: '本技能负责综合，搜索技能只负责发现资料' }],
    },
    interface: {
      inputs: [{ name: 'sources', description: '待分析的公开来源摘要', required: true }],
      outputs: [{ name: 'brief', description: '结构化研究简报' }],
    },
    dependencies: {
      required: [], optional: [],
      conflicts: [{ skillId: 'zaowuyun/web-search', releaseId: null, reason: '只做搜索时不应调用研究综述' }],
    },
    permissions: { required: ['read:public-summary'], optional: ['network:public'], prohibited: ['secret:read'] },
    compatibility: { contract: 'skill-package.v1', targets: ['codex', 'claude-code'] },
    evidence,
    ...overrides,
  };
}

test('creates a canonical frozen Skill Record bound to Release and evidence', () => {
  const record = createSkillRecord(input());
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.releaseId, input().release.releaseId);
  assert.deepEqual(record.routing.intentTags, ['研究', '综合']);
  assert.match(record.routingDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.recordDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateSkillRecord(structuredClone(record), { release: release() }).recordDigest, record.recordDigest);
  assert.equal(isSkillRecordCurrent(record, { release: release() }), true);
  assert.equal(Object.isFrozen(record), true);
});

test('source-language Chinese may preserve the same original metadata', () => {
  const metadata = {
    titleZh: '研究综述', descriptionZh: '把多来源材料整理为结构化中文研究综述。',
    originalTitle: '研究综述', originalDescription: '把多来源材料整理为结构化中文研究综述。',
    originalLanguage: 'zh-CN', localizationStatus: 'source', translationSource: null,
  };
  assert.equal(createSkillRecord(input({ metadata })).metadata.originalDescription, metadata.descriptionZh);
});

test('strict schemas reject unknown and missing routing fields', () => {
  const extra = input();
  extra.routing.marketingScore = 99;
  assert.throws(() => createSkillRecord(extra), error => error instanceof SkillRecordValidationError && error.code === 'UNKNOWN_FIELD');
  const missing = input();
  delete missing.routing.whenNotToUse;
  assert.throws(() => createSkillRecord(missing), error => error.code === 'MISSING_FIELD');
  const noTags = input();
  noTags.routing.intentTags = [];
  assert.throws(() => createSkillRecord(noTags), error => error.code === 'INVALID_ARRAY');
});

test('recursive privacy gate rejects content, local paths, candidate IDs, and secrets', () => {
  for (const mutate of [
    value => { value.metadata.content = 'hidden body'; },
    value => { value.routing.whenToUse = ['/Users/private/skill.md']; },
    value => { value.routing.summary = '不要泄露 cand_private_123 的内部信息'; },
    value => { value.routing.summary = '不要读取 /Users/private/skill.md 里的正文'; },
    value => { value.routing.summary = 'Bearer abcdefghijklmnopqrstuvwxyz'; },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => createSkillRecord(value), SkillRecordValidationError);
  }
});

test('source coordinate rejects query, fragment, userinfo, and unreferenced sources', () => {
  for (const coordinate of [
    'https://example.com/skill?token=secret', 'https://example.com/skill#private', 'https://user:pass@example.com/skill',
  ]) {
    const value = input();
    value.source.coordinate = coordinate;
    assert.throws(() => createSkillRecord(value), error => error.code === 'PRIVATE_SOURCE_COORDINATE');
  }
  const value = input();
  value.source.sourceId = sourceId({ type: 'github', coordinate: 'github:other/repo' });
  assert.throws(() => createSkillRecord(value), error => error.code === 'SOURCE_NOT_CURRENT');
});

test('Release, package, compatibility, and evidence binding fail closed', () => {
  const cases = [
    value => { value.compatibility.targets = ['codex']; },
    value => { value.evidence.evalDigest = D('1'); },
  ];
  for (const mutate of cases) {
    const value = input();
    mutate(value);
    assert.throws(() => createSkillRecord(value), SkillRecordValidationError);
  }
  const record = createSkillRecord(input());
  const otherPackage = D('8');
  const changedRelease = normalizeRelease({
    ...release(),
    releaseId: releaseId({ skillId, version: '2.1.0', packageDigest: otherPackage }),
    package: { packageDigest: otherPackage, manifestDigest: D('7'), storageRef: `cas:${otherPackage}` },
  });
  assert.equal(isSkillRecordCurrent(record, { release: changedRelease }), false);
});

test('routing and record digests are deterministic and invalidate stale records', () => {
  const first = createSkillRecord(input());
  const reordered = input();
  reordered.routing.intentTags.reverse();
  reordered.permissions.required.reverse();
  assert.equal(createSkillRecord(reordered).recordDigest, first.recordDigest);

  const changedRouting = input();
  changedRouting.routing.whenToUse = [...changedRouting.routing.whenToUse, '需要归纳不同论文的分歧'];
  const next = createSkillRecord(changedRouting);
  assert.notEqual(next.routingDigest, first.routingDigest);
  assert.notEqual(next.recordDigest, first.recordDigest);
  assert.equal(isSkillRecordCurrent({ ...first, routing: next.routing }), false);

  const changedMetadata = input();
  changedMetadata.metadata.descriptionZh = '这是一个发生变化但依然公开且不敏感的中文说明文本。';
  const metadataNext = createSkillRecord(changedMetadata);
  assert.equal(metadataNext.routingDigest, first.routingDigest);
  assert.notEqual(metadataNext.recordDigest, first.recordDigest);
});

test('recordDigest covers exactly the normalized record and is stable', () => {
  const record = createSkillRecord(input());
  const { recordDigest, ...withoutRecordDigest } = record;
  assert.equal(recordDigest, canonicalDigest(withoutRecordDigest));
});
