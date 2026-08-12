import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  UpdatePolicyError,
  createUpdateAssessment,
} from '../dist-src/skillops/scripts/lib/update-policy.mjs';

const sha = char => `sha256:${char.repeat(64)}`;
const NOW = '2026-08-13T00:00:00.000Z';

function releaseId(skillId, version, packageDigest) {
  return `rel_${crypto.createHash('sha256')
    .update(`skillops.release.v1\0${skillId}\0${version}\0${packageDigest}`, 'utf8')
    .digest('hex')}`;
}

function release(char, version, overrides = {}) {
  const value = {
    schemaVersion: 1,
    skillId: 'qiuyiwu/humanizer',
    version,
    status: 'published',
    package: {
      packageDigest: sha(char),
      manifestDigest: sha(char === '1' ? 'a' : 'b'),
      licenseDigest: sha('c'),
      securityDigest: sha('d'),
    },
    compatibility: { contract: 'skillops/v1', targets: ['codex', 'claude'] },
    dependencies: [{ skillId: 'qiuyiwu/base', range: '^1.0.0' }],
    assessmentPolicy: {
      smsSuiteId: 'sms-suite-v2',
      evalSuiteId: 'eval-suite-v3',
      runnerId: 'local-runner-v1',
      reviewPolicyVersion: 'review-policy-v2',
    },
    ...overrides,
  };
  value.releaseId = overrides.releaseId ?? releaseId(value.skillId, value.version, value.package.packageDigest);
  return value;
}

function proof(kind, target, overrides = {}) {
  return {
    status: kind === 'review' ? 'certified' : 'passed',
    releaseId: target.releaseId,
    packageDigest: target.package.packageDigest,
    digest: sha(kind.charCodeAt(0).toString(16).slice(-1)),
    validUntil: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

function evidence(target, overrides = {}) {
  return {
    packageAudit: proof('packageAudit', target),
    license: proof('license', target),
    security: proof('security', target),
    sms: proof('sms', target, { suiteId: 'sms-suite-v2' }),
    eval: proof('eval', target, { suiteId: 'eval-suite-v3', runnerId: 'local-runner-v1' }),
    review: proof('review', target, { policyVersion: 'review-policy-v2' }),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const oldRelease = release('1', '1.2.3');
  const newRelease = release('2', '1.2.4');
  return {
    oldRelease,
    newRelease,
    currentLock: {
      schemaVersion: 2,
      installationId: 'inst_fixture_001',
      skillId: oldRelease.skillId,
      releaseId: oldRelease.releaseId,
      packageDigest: oldRelease.package.packageDigest,
      deployedFingerprint: sha('9'),
    },
    targetState: {
      exists: true,
      managed: true,
      deployedFingerprint: sha('9'),
      currentFingerprint: sha('9'),
    },
    localPolicy: {
      requiredEvidence: ['packageAudit', 'license', 'security', 'sms', 'eval', 'review'],
      smsSuiteId: 'sms-suite-v2',
      evalSuiteId: 'eval-suite-v3',
      runnerId: 'local-runner-v1',
      reviewPolicyVersion: 'review-policy-v2',
    },
    evidence: evidence(newRelease),
    ...overrides,
  };
}

test('patch update is deterministic but cannot bypass fresh evidence gates', () => {
  const first = createUpdateAssessment(fixture(), { now: NOW });
  const second = createUpdateAssessment(fixture(), { now: NOW });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'ready');
  assert.equal(first.riskLevel, 'medium');
  assert.ok(first.changes.some(row => row.kind === 'version' && row.level === 'patch'));
  assert.ok(first.changes.some(row => row.kind === 'package'));
  assert.equal(first.requiredReassessments.length, 0);
  assert.equal(first.migration.preserveCurrentLockOnFailure, true);
});

test('Eval from the old package is never inherited by a new package', () => {
  const input = fixture();
  input.evidence.eval = proof('eval', input.oldRelease, {
    suiteId: 'eval-suite-v3', runnerId: 'local-runner-v1',
  });
  const result = createUpdateAssessment(input, { now: NOW });
  assert.equal(result.status, 'reassessment_required');
  assert.ok(result.requiredReassessments.some(row => row.kind === 'eval' && row.code === 'EVIDENCE_PACKAGE_MISMATCH'));
  assert.equal(result.migration.preserveCurrentLockOnFailure, true);
});

test('suite, runner and review policy differences require explicit reassessment', () => {
  const input = fixture();
  input.evidence.sms.suiteId = 'sms-suite-v1';
  input.evidence.eval.runnerId = 'remote-runner-v1';
  input.evidence.review.policyVersion = 'review-policy-v1';
  const result = createUpdateAssessment(input, { now: NOW });
  assert.equal(result.status, 'reassessment_required');
  assert.deepEqual(
    result.requiredReassessments.map(row => row.code).sort(),
    ['EVAL_RUNNER_MISMATCH', 'REVIEW_POLICY_MISMATCH', 'SMS_SUITE_MISMATCH'],
  );
});

test('expired or failed evidence, withdrawn/revoked releases and target drift block update', () => {
  const cases = [
    [fixture({ evidence: evidence(release('2', '1.2.4'), { eval: proof('eval', release('2', '1.2.4'), { validUntil: '2026-08-12T00:00:00.000Z' }) }) }), 'EVIDENCE_EXPIRED'],
    [fixture({ evidence: evidence(release('2', '1.2.4'), { security: proof('security', release('2', '1.2.4'), { status: 'failed' }) }) }), 'EVIDENCE_FAILED'],
    [fixture({ newRelease: release('2', '1.2.4', { status: 'withdrawn' }) }), 'RELEASE_WITHDRAWN'],
    [fixture({ newRelease: release('2', '1.2.4', { status: 'revoked' }) }), 'RELEASE_REVOKED'],
    [fixture({ targetState: { exists: true, managed: true, deployedFingerprint: sha('9'), currentFingerprint: sha('8') } }), 'TARGET_DRIFT'],
  ];
  for (const [input, code] of cases) {
    const result = createUpdateAssessment(input, { now: NOW });
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.some(row => row.code === code && row.blocking));
    assert.equal(result.migration.preserveCurrentLockOnFailure, true);
  }
});

test('major, compatibility, dependency, license and security changes are classified as high risk', () => {
  const input = fixture();
  input.newRelease = release('2', '2.0.0', {
    package: {
      packageDigest: sha('2'), manifestDigest: sha('b'),
      licenseDigest: sha('e'), securityDigest: sha('f'),
    },
    compatibility: { contract: 'skillops/v2', targets: ['codex'] },
    dependencies: [{ skillId: 'qiuyiwu/base', range: '^2.0.0' }],
  });
  input.evidence = evidence(input.newRelease);
  const result = createUpdateAssessment(input, { now: NOW });
  assert.equal(result.status, 'ready');
  assert.equal(result.riskLevel, 'high');
  assert.ok(result.requiredConfirmations.some(row => row.kind === 'major_version'));
  assert.ok(result.requiredConfirmations.some(row => row.kind === 'compatibility_change'));
  assert.equal(result.migration.required, true);
  for (const kind of ['license', 'security', 'compatibility', 'dependencies']) {
    assert.ok(result.changes.some(row => row.kind === kind));
  }
});

test('identical immutable release is no_change after trust and drift checks', () => {
  const input = fixture();
  input.newRelease = input.oldRelease;
  input.evidence = evidence(input.newRelease);
  const result = createUpdateAssessment(input, { now: NOW });
  assert.equal(result.status, 'no_change');
  assert.equal(result.riskLevel, 'none');
  assert.deepEqual(result.changes, []);
});

test('mutable or candidate identities fail closed', () => {
  for (const mutate of [
    input => { input.newRelease.releaseId = 'latest'; },
    input => { input.newRelease.releaseId = 'cand_fixture'; },
    input => { input.newRelease.version = 'latest'; },
    input => { input.newRelease.skillId = 'qiuyiwu/cand_fixture'; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => createUpdateAssessment(input, { now: NOW }),
      error => error instanceof UpdatePolicyError,
    );
  }
});

test('a releaseId with valid shape but wrong canonical identity is rejected', () => {
  const input = fixture();
  input.newRelease.releaseId = `rel_${'f'.repeat(64)}`;
  assert.throws(
    () => createUpdateAssessment(input, { now: NOW }),
    error => error instanceof UpdatePolicyError && error.code === 'RELEASE_ID_MISMATCH',
  );
});

test('output never contains current lock paths, prompt/output/token or private evidence bodies', () => {
  const input = fixture();
  input.currentLock.targetPath = '/Users/private/skills/humanizer';
  input.evidence.eval.prompt = 'private prompt';
  input.evidence.eval.output = 'private output';
  input.evidence.eval.token = 'private token';
  input.evidence.eval.caseResults = [{ input: 'secret', output: 'secret' }];
  const serialized = JSON.stringify(createUpdateAssessment(input, { now: NOW }));
  for (const secret of ['/Users/private', 'private prompt', 'private output', 'private token', 'caseResults']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replaceAll('/', '\\/')));
  }
});
