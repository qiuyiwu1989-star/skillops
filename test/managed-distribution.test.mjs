import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagedDistributionError,
  assertManagedDistributionPrivacy,
  claimManagedOperation,
  createManagedDistributionPlan,
  createManagedLockV2,
  projectManagedDistributionStatus,
} from '../dist-src/skillops/scripts/lib/managed-distribution.mjs';
import { canonicalDigest } from '../trusted-supply/lib/registry-identity.mjs';

const sha = char => `sha256:${char.repeat(64)}`;
const rel = char => `rel_${char.repeat(64)}`;
const NOW = '2026-08-13T00:00:00.000Z';

function input(overrides = {}) {
  return {
    operationId: 'op_fixture_001',
    action: 'install',
    skillId: 'qiuyiwu/humanizer',
    releaseId: rel('a'),
    version: '1.2.0',
    packageDigest: sha('b'),
    registrySourceId: 'regsrc_local_fixture',
    releaseStatus: 'published',
    manifest: [
      { path: 'SKILL.md', digest: sha('c'), size: 120 },
      { path: 'references/guide.md', digest: sha('d'), size: 80 },
    ],
    trustSnapshot: {
      policyVersion: 'skillops-trust-v1',
      reviewValidUntil: '2026-09-13T00:00:00.000Z',
      evalValidUntil: '2026-09-01T00:00:00.000Z',
      feedCursor: '42',
      reviewDigest: sha('e'),
      evalDigest: sha('f'),
    },
    targetState: { exists: false, managed: false },
    ...overrides,
  };
}

test('install plan binds immutable Registry identities and is deterministic', () => {
  const first = createManagedDistributionPlan(input(), { now: NOW });
  const reordered = createManagedDistributionPlan(input({
    manifest: [...input().manifest].reverse(),
  }), { now: NOW });
  assert.equal(first.status, 'ready');
  assert.equal(first.action, 'install.plan');
  assert.equal(first.planDigest, reordered.planDigest);
  assert.match(first.planDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.lockDraft.releaseId, rel('a'));
  assert.equal(first.lockDraft.packageDigest, sha('b'));
  assert.equal(first.lockDraft.registrySourceId, 'regsrc_local_fixture');
  assert.deepEqual(first.requiredConfirmations[0], {
    kind: 'plan_digest', value: first.planDigest, messageZh: '安装或更新确认必须绑定本计划摘要',
  });
});

test('Registry package manifest sha256 shape is accepted and an asserted manifest digest is checked', () => {
  const standardManifest = [
    { path: 'SKILL.md', sha256: 'c'.repeat(64), size: 120, executable: false, mediaType: 'text/markdown' },
  ];
  const plan = createManagedDistributionPlan(input({
    manifest: standardManifest,
    manifestDigest: canonicalDigest(standardManifest),
  }), { now: NOW });
  assert.equal(plan.status, 'ready');
  assert.throws(
    () => createManagedDistributionPlan(input({ manifest: standardManifest, manifestDigest: sha('0') }), { now: NOW }),
    error => error.code === 'MANIFEST_DIGEST_MISMATCH',
  );
});

test('candidate identity, latest alias and malformed Registry identity fail closed', () => {
  for (const [override, code] of [
    [{ skillId: 'qiuyiwu/cand_bad' }, 'CANDIDATE_ID_FORBIDDEN'],
    [{ releaseId: 'latest' }, 'MUTABLE_RELEASE_FORBIDDEN'],
    [{ version: 'latest' }, 'MUTABLE_RELEASE_FORBIDDEN'],
    [{ registrySourceId: 'src_supply' }, 'INVALID_IDENTITY'],
  ]) {
    assert.throws(
      () => createManagedDistributionPlan(input(override), { now: NOW }),
      error => error instanceof ManagedDistributionError && error.code === code,
    );
  }
});

test('withdrawn, revoked and expired review return blocked plans with structured reasons', () => {
  const fixtures = [
    [{ releaseStatus: 'withdrawn' }, 'withdrawn', 'RELEASE_WITHDRAWN'],
    [{ releaseStatus: 'revoked' }, 'revoked', 'RELEASE_REVOKED'],
    [{ trustSnapshot: { ...input().trustSnapshot, reviewValidUntil: '2026-08-12T00:00:00.000Z' } }, 'review_stale', 'REVIEW_EXPIRED'],
  ];
  for (const [override, primaryStatus, code] of fixtures) {
    const plan = createManagedDistributionPlan(input(override), { now: NOW });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.distributionStatus, primaryStatus);
    assert.ok(plan.reasons.some(row => row.code === code && row.blocking));
    assert.equal(plan.lockDraft, null);
  }
});

test('unknown targets and target drift block an update without losing update reason', () => {
  const currentLock = {
    schemaVersion: 2,
    installationId: 'inst_fixture_001',
    skillId: 'qiuyiwu/humanizer',
    releaseId: rel('1'),
    packageDigest: sha('1'),
    registrySourceId: 'regsrc_local_fixture',
    deployedFingerprint: sha('2'),
  };
  const drift = createManagedDistributionPlan(input({
    action: 'update', currentLock,
    targetState: { exists: true, managed: true, deployedFingerprint: sha('2'), currentFingerprint: sha('3') },
  }), { now: NOW });
  assert.equal(drift.status, 'blocked');
  assert.equal(drift.distributionStatus, 'target_drift');
  assert.deepEqual(drift.reasons.map(row => row.status).sort(), ['target_drift', 'update_available']);

  const unknown = createManagedDistributionPlan(input({ targetState: { exists: true, managed: false } }), { now: NOW });
  assert.equal(unknown.error.code, 'UNKNOWN_TARGET');
  assert.equal(unknown.distributionStatus, 'blocked');
});

test('missing managed target is distinct from target drift and review staleness', () => {
  const projected = projectManagedDistributionStatus({
    releaseId: rel('a'),
    releaseStatus: 'published',
    trustSnapshot: input().trustSnapshot,
    currentLock: {
      installationId: 'inst_fixture_001', skillId: 'qiuyiwu/humanizer', releaseId: rel('a'),
      packageDigest: sha('b'), registrySourceId: 'regsrc_local_fixture', deployedFingerprint: sha('9'),
    },
    targetState: { status: 'missing' },
  }, { now: NOW });
  assert.equal(projected.primaryStatus, 'missing');
  assert.deepEqual(projected.reasons.map(row => row.code), ['TARGET_MISSING']);
});

test('operationId is replay-safe and conflicts when the plan changes', () => {
  const first = createManagedDistributionPlan(input(), { now: NOW });
  const recorded = claimManagedOperation([], first);
  assert.equal(recorded.action, 'recorded');
  assert.equal(claimManagedOperation(recorded.records, first).action, 'replayed');

  const changed = createManagedDistributionPlan(input({ packageDigest: sha('9') }), { now: NOW });
  assert.throws(
    () => claimManagedOperation(recorded.records, changed),
    error => error instanceof ManagedDistributionError && error.code === 'OPERATION_CONFLICT',
  );
});

test('Lock v2 retains legacy fingerprints and binds release trust without installing files', () => {
  const plan = createManagedDistributionPlan(input(), { now: NOW });
  const lock = createManagedLockV2(plan, {
    installationId: 'inst_fixture_001',
    targetPath: '/local-only/skills/humanizer',
    sourceFingerprint: sha('8'),
    deployedFingerprint: sha('9'),
    installedAt: NOW,
  });
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.skillId, 'qiuyiwu/humanizer');
  assert.equal(lock.releaseId, rel('a'));
  assert.equal(lock.sourceFingerprint, sha('8'));
  assert.equal(lock.deployedFingerprint, sha('9'));
  assert.equal(lock.planDigest, plan.planDigest);
  assert.equal(lock.targetPath, '/local-only/skills/humanizer');
});

test('plan/lock export contains no tokens, prompts, outputs or absolute private source URLs', () => {
  const plan = createManagedDistributionPlan(input({
    token: 'token-must-never-appear',
    prompt: 'private prompt',
    output: 'private output',
    sourceUrl: 'https://private.example/packages/humanizer?token=secret',
    trustSnapshot: { ...input().trustSnapshot, token: 'secret' },
  }), { now: NOW });
  const serialized = JSON.stringify(plan);
  for (const secret of ['token-must-never-appear', 'private prompt', 'private output', 'private.example', 'secret']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(assertManagedDistributionPrivacy(plan), true);
  assert.throws(
    () => assertManagedDistributionPrivacy({ sourceUrl: 'https://private.example/v1' }),
    error => error.code === 'SENSITIVE_FIELD',
  );
});
