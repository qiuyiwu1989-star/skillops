import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReviewAttestation,
  createReviewEvidenceSnapshot,
  createReviewLifecycleEvent,
  createReviewPolicy,
  evaluateReviewCertification,
  reviewEvidenceChanges,
} from '../lib/review-policy.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;

function policy(overrides = {}) {
  return createReviewPolicy({
    policyId: 'skillops.market.final-review',
    policyVersion: '1.0.0',
    minimumIndependentHumanApprovals: 2,
    approvalValidityDays: 30,
    trustedIdentityProviders: ['fixture-idp'],
    ...overrides,
  });
}

function snapshot(currentPolicy = policy(), overrides = {}) {
  return createReviewEvidenceSnapshot({
    contentFingerprint: D('a'), packageDigest: D('b'), licenseDigest: D('c'),
    smsDigest: D('d'), evalDigest: D('e'), ...overrides,
  }, { policy: currentPolicy });
}

function reviewer(principalId, kind = 'human', overrides = {}) {
  return {
    kind,
    principalId,
    subject: `subject:${principalId}`,
    provider: kind === 'human' ? 'fixture-idp' : 'skillops-agent',
    displayName: principalId,
    verification: {
      status: kind === 'human' ? 'verified' : 'service',
      verifiedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-12-31T00:00:00Z',
      reference: `fixture://${principalId}`,
    },
    ...overrides,
  };
}

function approve(principalId, currentPolicy, currentSnapshot, at) {
  return createReviewAttestation({
    decision: 'approve', reviewer: reviewer(principalId), reason: `${principalId} 已独立复核全部证据。`, at,
  }, { policy: currentPolicy, snapshot: currentSnapshot });
}

test('policy and evidence snapshots have stable digests and reject caller forgery', () => {
  const one = policy();
  const two = policy({ trustedIdentityProviders: ['fixture-idp'] });
  assert.equal(one.policyDigest, two.policyDigest);
  const evidence = snapshot(one);
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => createReviewPolicy({ ...one, approvalValidityDays: 31 }), /policyDigest/i);
  assert.throws(() => createReviewEvidenceSnapshot({ ...evidence, evalDigest: D('f') }, { policy: one }), /evidenceDigest/i);
});

test('current evidence requires package, license, SMS and Eval under the default final-review policy', () => {
  const currentPolicy = policy();
  for (const field of ['packageDigest', 'licenseDigest', 'smsDigest', 'evalDigest']) {
    const input = { contentFingerprint: D('a'), packageDigest: D('b'), licenseDigest: D('c'), smsDigest: D('d'), evalDigest: D('e') };
    delete input[field];
    assert.throws(() => createReviewEvidenceSnapshot(input, { policy: currentPolicy }), new RegExp(field.replace('Digest', ''), 'i'));
  }
});

test('four-eyes certification requires two different verified human principals on the same evidence', () => {
  const currentPolicy = policy();
  const currentSnapshot = snapshot(currentPolicy);
  const first = approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T00:00:00Z');
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [first], now: '2026-08-12T00:00:00Z',
  }).status, 'pending');
  const duplicate = approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T01:00:00Z');
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [first, duplicate], now: '2026-08-12T00:00:00Z',
  }).status, 'pending');
  const second = approve('person:bob', currentPolicy, currentSnapshot, '2026-08-10T02:00:00Z');
  const result = evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [first, duplicate, second], now: '2026-08-12T00:00:00Z',
  });
  assert.equal(result.status, 'certified');
  assert.equal(result.approvals.length, 2);
  assert.equal(result.validUntil, '2026-09-09T01:00:00.000Z');
});

test('forged or mutated persisted attestations and lifecycle controls do not count', () => {
  const currentPolicy = policy();
  const currentSnapshot = snapshot(currentPolicy);
  const first = approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T00:00:00Z');
  const second = approve('person:bob', currentPolicy, currentSnapshot, '2026-08-10T01:00:00Z');
  const forged = structuredClone(second);
  forged.reviewer.principalId = 'person:mallory';
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [first, forged], now: '2026-08-12T00:00:00Z',
  }).status, 'pending');

  const recall = createReviewLifecycleEvent({
    action: 'recall', actor: reviewer('person:operator'), reason: '安全事件召回。', at: '2026-08-11T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  const forgedRecall = structuredClone(recall);
  forgedRecall.reason = '篡改理由但沿用旧事件 ID。';
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [first, second], lifecycleEvents: [forgedRecall], now: '2026-08-12T00:00:00Z',
  }).status, 'certified');
});

test('agent-assisted recommendations never count as independent human approval', () => {
  const currentPolicy = policy();
  const currentSnapshot = snapshot(currentPolicy);
  const advisory = createReviewAttestation({
    type: 'agent_assisted', recommendation: 'approve', reviewer: reviewer('agent:reviewer', 'agent'),
    reason: '自动检查未发现额外风险。', at: '2026-08-10T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  assert.equal(advisory.decision, 'advisory');
  const result = evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot,
    attestations: [advisory, approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T01:00:00Z')],
    now: '2026-08-12T00:00:00Z',
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.approvals.length, 1);
  assert.throws(() => createReviewAttestation({
    type: 'agent_assisted', decision: 'approve', recommendation: 'approve', reviewer: reviewer('agent:reviewer', 'agent'),
    reason: '试图越权批准。', at: '2026-08-10T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot }), /agent.*cannot|不能|approve/i);
});

test('unverified, expired, untrusted, submitter and conflicted identities fail closed or do not count', () => {
  const currentPolicy = policy();
  const currentSnapshot = snapshot(currentPolicy);
  assert.throws(() => approve('person:bad', currentPolicy, currentSnapshot, '2027-01-01T00:00:00Z'), /identity.*current/i);
  assert.throws(() => createReviewAttestation({
    decision: 'approve', reviewer: reviewer('person:bad', 'human', { provider: 'unknown-idp' }),
    reason: '不可信身份源。', at: '2026-08-10T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot }), /provider.*trusted/i);
  const submitter = approve('person:submitter', currentPolicy, currentSnapshot, '2026-08-10T00:00:00Z');
  const conflicted = approve('person:vendor', currentPolicy, currentSnapshot, '2026-08-10T01:00:00Z');
  const independent = approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T02:00:00Z');
  const result = evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [submitter, conflicted, independent],
    submitterPrincipalId: 'person:submitter', conflictedPrincipalIds: ['person:vendor'], now: '2026-08-12T00:00:00Z',
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.approvals.length, 1);
  assert.ok(result.reasons.includes('conflicted_reviewer_excluded'));
});

test('content, package, license, SMS, Eval and policy changes stale an earlier certification with explicit reasons', () => {
  const originalPolicy = policy();
  const originalSnapshot = snapshot(originalPolicy);
  const approvals = [
    approve('person:alice', originalPolicy, originalSnapshot, '2026-08-10T00:00:00Z'),
    approve('person:bob', originalPolicy, originalSnapshot, '2026-08-10T01:00:00Z'),
  ];
  const changedPolicy = policy({ policyVersion: '1.1.0' });
  const changed = snapshot(changedPolicy, {
    contentFingerprint: D('f'), packageDigest: D('1'), licenseDigest: D('2'), smsDigest: D('3'), evalDigest: D('4'),
  });
  assert.deepEqual(reviewEvidenceChanges(originalSnapshot, changed), [
    'content_changed', 'package_changed', 'license_changed', 'sms_changed', 'eval_changed', 'policy_changed',
  ]);
  const result = evaluateReviewCertification({
    policy: changedPolicy, snapshot: changed, attestations: approvals, now: '2026-08-12T00:00:00Z',
  });
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.reasons, [
    'content_changed', 'package_changed', 'license_changed', 'sms_changed', 'eval_changed', 'policy_changed',
  ]);
});

test('approval expiry requires a fresh two-human recertification while preserving history', () => {
  const currentPolicy = policy({ approvalValidityDays: 2 });
  const currentSnapshot = snapshot(currentPolicy);
  const old = [
    approve('person:alice', currentPolicy, currentSnapshot, '2026-08-01T00:00:00Z'),
    approve('person:bob', currentPolicy, currentSnapshot, '2026-08-01T01:00:00Z'),
  ];
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: old, now: '2026-08-04T00:00:00Z',
  }).status, 'expired');
  const renewed = [
    approve('person:alice', currentPolicy, currentSnapshot, '2026-08-04T01:00:00Z'),
    approve('person:carol', currentPolicy, currentSnapshot, '2026-08-04T02:00:00Z'),
  ];
  const result = evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [...old, ...renewed], now: '2026-08-05T00:00:00Z',
  });
  assert.equal(result.status, 'certified');
  assert.equal(result.approvals.length, 2);
});

test('human rejection blocks prior approvals; withdrawal and recall remove current certification; appeal does not self-approve', () => {
  const currentPolicy = policy();
  const currentSnapshot = snapshot(currentPolicy);
  const approvals = [
    approve('person:alice', currentPolicy, currentSnapshot, '2026-08-10T00:00:00Z'),
    approve('person:bob', currentPolicy, currentSnapshot, '2026-08-10T01:00:00Z'),
  ];
  const rejection = createReviewAttestation({
    decision: 'reject', reviewer: reviewer('person:carol'), reason: '发现未解决风险。', at: '2026-08-10T02:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: [...approvals, rejection], now: '2026-08-12T00:00:00Z',
  }).status, 'rejected');
  const withdraw = createReviewLifecycleEvent({
    action: 'withdraw', actor: reviewer('person:operator'), reason: '发行方主动撤回。', at: '2026-08-11T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: approvals, lifecycleEvents: [withdraw], now: '2026-08-12T00:00:00Z',
  }).status, 'withdrawn');
  const recall = createReviewLifecycleEvent({
    action: 'recall', actor: reviewer('person:operator'), reason: '安全事件召回。', at: '2026-08-11T00:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  const appeal = createReviewLifecycleEvent({
    action: 'appeal', actor: reviewer('person:publisher'), reason: '请求重新复核。', at: '2026-08-11T01:00:00Z',
  }, { policy: currentPolicy, snapshot: currentSnapshot });
  assert.equal(evaluateReviewCertification({
    policy: currentPolicy, snapshot: currentSnapshot, attestations: approvals, lifecycleEvents: [recall, appeal], now: '2026-08-12T00:00:00Z',
  }).status, 'recalled');
});
