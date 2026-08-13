import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFixtureIdpVerifier,
  toReviewIdentity,
  validateIdpReceipt,
} from '../lib/idp-receipt.mjs';
import {
  createReviewAttestation,
  createReviewEvidenceSnapshot,
  createReviewPolicy,
  evaluateReviewCertification,
} from '../lib/review-policy.mjs';

const ISSUED_AT = '2026-08-13T09:00:00.000Z';
const NOW = '2026-08-13T09:05:00.000Z';
const PURPOSE = 'skill-review';
const PROVIDER = 'fixture-idp';
const KEY = Buffer.alloc(32, 23);

function fixtureVerifier({
  provider = PROVIDER,
  purpose = PURPOSE,
  clock = () => new Date(ISSUED_AT),
  identities = {
    alice_token: { subject: 'fixture-subject-alice', kind: 'human' },
    alice_alias_token: { subject: 'fixture-subject-alice', kind: 'human' },
    bob_token: { subject: 'fixture-subject-bob', kind: 'human' },
    service_token: { subject: 'fixture-service-a', kind: 'service' },
  },
  receiptKey = KEY,
} = {}) {
  return createFixtureIdpVerifier({
    provider,
    purpose,
    clock,
    ttlMs: 15 * 60 * 1_000,
    receiptKey,
    assertionVerifier: async assertion => {
      const identity = identities[assertion?.fixtureToken];
      if (!identity) throw new Error('fixture assertion rejected');
      return identity;
    },
  });
}

function trust(verifier, overrides = {}) {
  return {
    trustedProviderVerifiers: [verifier],
    purpose: PURPOSE,
    now: NOW,
    ...overrides,
  };
}

test('fixture verifier issues a minimal versioned receipt without raw identity or assertion data', async () => {
  const verifier = fixtureVerifier();
  const receipt = await verifier.issueReceipt({ fixtureToken: 'alice_token' });

  assert.deepEqual(Object.keys(receipt).sort(), [
    'expiresAt', 'issuedAt', 'kind', 'provider', 'purpose', 'receiptDigest', 'schemaVersion', 'subjectDigest',
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.provider, PROVIDER);
  assert.equal(receipt.purpose, PURPOSE);
  assert.equal(receipt.kind, 'human');
  assert.match(receipt.subjectDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.receiptDigest, /^sha256:[a-f0-9]{64}$/);

  const serialized = JSON.stringify(receipt);
  for (const secret of ['fixture-subject-alice', 'alice_token', 'principal', 'email', 'token', 'secret', 'verified']) {
    assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
  }
  assert.deepEqual(validateIdpReceipt(receipt, trust(verifier)), receipt);
});

test('caller supplied trust claims and identity fields cannot mint a receipt', async () => {
  const verifier = fixtureVerifier();
  for (const assertion of [
    { fixtureToken: 'alice_token', verified: true },
    { fixtureToken: 'alice_token', subject: 'fixture-subject-bob' },
    { fixtureToken: 'alice_token', principal: 'person:mallory' },
    { fixtureToken: 'alice_token', email: 'mallory@example.test' },
  ]) {
    await assert.rejects(() => verifier.issueReceipt(assertion), error => error.code === 'untrusted_assertion_claim');
  }
});

test('unknown provider and wrong purpose fail closed', async () => {
  const trusted = fixtureVerifier();
  const unknown = fixtureVerifier({ provider: 'fixture-other-idp', receiptKey: Buffer.alloc(32, 29) });
  const wrongPurpose = fixtureVerifier({ purpose: 'organization-login', receiptKey: Buffer.alloc(32, 31) });

  const unknownReceipt = await unknown.issueReceipt({ fixtureToken: 'alice_token' });
  assert.throws(
    () => validateIdpReceipt(unknownReceipt, trust(trusted)),
    error => error.code === 'untrusted_provider',
  );

  const purposeReceipt = await wrongPurpose.issueReceipt({ fixtureToken: 'alice_token' });
  assert.throws(
    () => validateIdpReceipt(purposeReceipt, trust(wrongPurpose)),
    error => error.code === 'wrong_purpose',
  );
});

test('expired, future-issued, and tampered receipts fail closed', async () => {
  const verifier = fixtureVerifier();
  const receipt = await verifier.issueReceipt({ fixtureToken: 'alice_token' });

  assert.throws(
    () => validateIdpReceipt(receipt, trust(verifier, { now: '2026-08-13T09:15:00.000Z' })),
    error => error.code === 'receipt_expired',
  );

  const futureVerifier = fixtureVerifier({ clock: () => new Date('2026-08-13T10:00:00.000Z') });
  const futureReceipt = await futureVerifier.issueReceipt({ fixtureToken: 'alice_token' });
  assert.throws(
    () => validateIdpReceipt(futureReceipt, trust(futureVerifier)),
    error => error.code === 'receipt_not_yet_valid',
  );

  const tampered = { ...receipt, kind: 'service' };
  assert.throws(
    () => validateIdpReceipt(tampered, trust(verifier)),
    error => error.code === 'receipt_digest_mismatch',
  );

  const attacker = fixtureVerifier({ receiptKey: Buffer.alloc(32, 41) });
  const forgedBySameNamedProvider = await attacker.issueReceipt({ fixtureToken: 'alice_token' });
  assert.throws(
    () => validateIdpReceipt(forgedBySameNamedProvider, trust(verifier)),
    error => error.code === 'receipt_digest_mismatch',
  );
});

test('provider assertion output must be minimal and cannot self-declare verification', async () => {
  const verifier = fixtureVerifier({
    identities: {
      malicious: { subject: 'fixture-subject-mallory', kind: 'human', verified: true },
    },
  });
  await assert.rejects(
    () => verifier.issueReceipt({ fixtureToken: 'malicious' }),
    error => error.code === 'invalid_provider_assertion',
  );
});

test('review adapter derives stable pseudonymous identity and maps service receipts to agent reviewers', async () => {
  const verifier = fixtureVerifier();
  const firstReceipt = await verifier.issueReceipt({ fixtureToken: 'alice_token' });
  const aliasReceipt = await verifier.issueReceipt({ fixtureToken: 'alice_alias_token' });
  const serviceReceipt = await verifier.issueReceipt({ fixtureToken: 'service_token' });

  const first = toReviewIdentity(firstReceipt, trust(verifier));
  const alias = toReviewIdentity(aliasReceipt, trust(verifier));
  const service = toReviewIdentity(serviceReceipt, trust(verifier));

  assert.equal(first.kind, 'human');
  assert.equal(first.principalId, alias.principalId);
  assert.equal(first.subject, alias.subject);
  assert.equal(first.provider, PROVIDER);
  assert.equal(first.displayName.startsWith('human:'), true);
  assert.deepEqual(first.verification, {
    status: 'verified',
    verifiedAt: ISSUED_AT,
    expiresAt: '2026-08-13T09:15:00.000Z',
    reference: `idp-receipt:${firstReceipt.receiptDigest}`,
  });
  assert.equal(service.kind, 'agent');
  assert.equal(service.verification.status, 'service');
  assert.equal(JSON.stringify(first).includes('fixture-subject-alice'), false);
});

test('two different human subjects satisfy four-eyes while aliases of one subject count once', async () => {
  const verifier = fixtureVerifier();
  const policy = createReviewPolicy({
    policyId: 'policy:idp-receipt-test',
    policyVersion: '1.0.0',
    trustedIdentityProviders: [PROVIDER],
  });
  const digest = value => `sha256:${value.repeat(64).slice(0, 64)}`;
  const snapshot = createReviewEvidenceSnapshot({
    contentFingerprint: digest('1'),
    packageDigest: digest('2'),
    licenseDigest: digest('3'),
    smsDigest: digest('4'),
    evalDigest: digest('5'),
  }, { policy });
  const makeApproval = async (token, at) => createReviewAttestation({
    decision: 'approve',
    reviewer: toReviewIdentity(await verifier.issueReceipt({ fixtureToken: token }), trust(verifier)),
    reason: '已独立复核全部稳定证据。',
    at,
  }, { policy, snapshot });

  const alice = await makeApproval('alice_token', '2026-08-13T09:06:00.000Z');
  const aliceAlias = await makeApproval('alice_alias_token', '2026-08-13T09:07:00.000Z');
  const bob = await makeApproval('bob_token', '2026-08-13T09:08:00.000Z');

  assert.equal(evaluateReviewCertification({
    policy, snapshot, attestations: [alice, aliceAlias], now: '2026-08-13T09:10:00.000Z',
  }).status, 'pending');
  assert.equal(evaluateReviewCertification({
    policy, snapshot, attestations: [alice, bob], now: '2026-08-13T09:10:00.000Z',
  }).status, 'certified');
});
