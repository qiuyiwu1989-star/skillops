import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  canonicalDigest,
  normalizeRelease,
  normalizeSkillId,
  releaseId,
  sourceId,
  toPublicRegistryValue,
} from '../lib/registry-identity.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;

function release(overrides = {}) {
  const source = sourceId('skillhub', 'https://skillhub.cn/skills/humanizer');
  return {
    schemaVersion: 1,
    skillId: 'Qiuyiwu/Humanizer',
    version: '1.2.0',
    package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('a')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: ['eval_fixture', 'sms_fixture'],
    reviewRefs: ['review_fixture'],
    sourceRefs: [source],
    publishedAt: '2026-08-13T01:02:03Z',
    ...overrides,
  };
}

test('skillId normalizes to lowercase namespace/name and never accepts candidate identity', () => {
  assert.equal(normalizeSkillId(' Qiuyiwu/Humanizer '), 'qiuyiwu/humanizer');
  for (const invalid of ['humanizer', 'too/many/parts', 'cand_123/humanizer', '/humanizer', 'qiuyiwu/空白']) {
    assert.throws(() => normalizeSkillId(invalid), /skillId|candidate/i, invalid);
  }
});

test('releaseId follows the exact v1 NUL-delimited SHA-256 identity contract', () => {
  const expected = `rel_${crypto.createHash('sha256')
    .update(['skillops.release.v1', 'qiuyiwu/humanizer', '1.2.0', D('a')].join('\0'), 'utf8')
    .digest('hex')}`;
  assert.equal(releaseId('qiuyiwu/humanizer', '1.2.0', D('a')), expected);
  assert.equal(releaseId({ skillId: 'Qiuyiwu/Humanizer', version: '1.2.0', packageDigest: D('a') }), expected);
  assert.notEqual(releaseId('qiuyiwu/humanizer', '1.2.1', D('a')), expected);
  assert.notEqual(releaseId('qiuyiwu/humanizer', '1.2.0', D('b')), expected);
});

test('sourceId is deterministic for type and canonical coordinate without becoming product identity', () => {
  const first = sourceId({ type: 'SkillHub', coordinate: 'https://skillhub.cn/skills/humanizer' });
  const second = sourceId('skillhub', 'https://skillhub.cn/skills/humanizer');
  assert.equal(first, second);
  assert.match(first, /^src_[a-f0-9]{64}$/);
  assert.throws(() => sourceId('skillhub', 'cand_abc'), /candidate/i);
});

test('normalizeRelease validates immutable identity, package, refs and published initial state', () => {
  const normalized = normalizeRelease(release());
  assert.equal(normalized.skillId, 'qiuyiwu/humanizer');
  assert.equal(normalized.releaseId, releaseId('qiuyiwu/humanizer', '1.2.0', D('a')));
  assert.equal(normalized.status, 'published');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.package));
  assert.throws(() => normalizeRelease(release({ releaseId: `rel_${'0'.repeat(64)}` })), /releaseId/i);
  assert.throws(() => normalizeRelease(release({ status: 'withdrawn' })), /published/i);
  assert.throws(() => normalizeRelease(release({ version: '01.2.0' })), /SemVer/i);
  assert.throws(() => normalizeRelease(release({ package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('c')}` } })), /storageRef/i);
  assert.throws(() => normalizeRelease(release({ assessmentRefs: [] })), /assessmentRefs/i);
  assert.throws(() => normalizeRelease(release({ sourceRefs: [releaseId('qiuyiwu/humanizer', '1.2.0', D('a'))] })), /sourceRefs/i);
  assert.throws(() => normalizeRelease(release({ reviewRefs: ['cand_internal'] })), /candidate/i);
  assert.throws(() => normalizeRelease(release({ candidateId: 'cand_internal' })), /unknown fields/i);
});

test('public Registry projection removes candidate, storage, local path and reviewer identity fields recursively', () => {
  const publicValue = toPublicRegistryValue({
    releaseId: releaseId('qiuyiwu/humanizer', '1.2.0', D('a')),
    candidateId: 'cand_secret',
    package: { packageDigest: D('a'), storageRef: `cas:${D('a')}` },
    localPath: '/Users/private/skill',
    evidence: { reviewerIdentity: { principalId: 'person:alice', email: 'a@example.com' }, reviewRole: 'human-review' },
    refs: ['review_fixture', 'cand_hidden', '/absolute/private'],
  });
  assert.equal(JSON.stringify(publicValue).includes('cand_'), false);
  assert.equal(JSON.stringify(publicValue).includes('/Users/'), false);
  assert.equal(JSON.stringify(publicValue).includes('storageRef'), false);
  assert.equal(JSON.stringify(publicValue).includes('principalId'), false);
  assert.deepEqual(publicValue.refs, ['review_fixture']);
  assert.equal(publicValue.evidence.reviewRole, 'human-review');
});

test('canonicalDigest is independent of object key insertion order', () => {
  assert.equal(canonicalDigest({ b: 2, a: { d: 4, c: 3 } }), canonicalDigest({ a: { c: 3, d: 4 }, b: 2 }));
});
