import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyAudit,
  configureReview,
  createCandidate,
  recordEval,
  recordPackageAudit,
  recordReviewAttestation,
  refreshCandidate,
  toListing,
} from '../lib/candidate.mjs';
import { createEvalResult } from '../lib/eval-result.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { CandidateStore } from '../lib/store.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const CONTENT = `---
name: certified-fixture
description: A complete skill used to verify independent certification.
---

Return a concise evidence-backed answer.
`;

const at = value => () => new Date(value);

function policy(overrides = {}) {
  return {
    policyId: 'skillops.market.final-review',
    policyVersion: '1.0.0',
    minimumIndependentHumanApprovals: 2,
    approvalValidityDays: 90,
    trustedIdentityProviders: ['fixture-idp'],
    ...overrides,
  };
}

function reviewer(principalId) {
  return {
    kind: 'human', principalId, subject: `subject:${principalId}`, provider: 'fixture-idp', displayName: principalId,
    verification: {
      status: 'verified', verifiedAt: '2026-08-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
      reference: `fixture://${principalId}`,
    },
  };
}

function packageArtifact(extra = '') {
  return createPackageArtifact({
    sourceVersion: `v1${extra}`,
    collectedAt: '2026-08-13T00:00:00Z',
    files: [
      { path: 'SKILL.md', content: CONTENT, mediaType: 'text/markdown' },
      { path: 'references/evidence.md', content: `evidence${extra}\n`, mediaType: 'text/markdown' },
    ],
  });
}

function evalResult(packageDigest, completedAt = '2026-08-13T02:00:00Z') {
  const suite = normalizeEvalSuite({
    schemaVersion: 1, suiteId: 'fixture/certification', suiteVersion: '1.0.0',
    cases: [{ id: 'concise', prompt: 'return ready', assertions: [{ type: 'contains', value: 'ready' }] }],
  });
  return createEvalResult({
    suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, suiteDigest: suite.suiteDigest,
    basedOnPackageDigest: packageDigest, runner: 'fixture/offline', environment: { adapter: 'fixture' },
    cases: [{
      id: 'concise', status: 'passed', durationMs: 1,
      assertions: [{ type: 'contains', value: 'ready', passed: true, actual: 'ready' }],
      outputSummary: 'ready', error: null,
    }],
    startedAt: '2026-08-13T01:59:59Z', completedAt,
  }, { suite, packageDigest });
}

function completeCandidate() {
  let candidate = createCandidate({
    source: { kind: 'fixture', repo: 'fixture/certified', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: CONTENT, license: 'MIT', package: packageArtifact(), catalog: { packageComplete: true },
    sms: completeSmsInput(82),
  }, { clock: at('2026-08-13T00:00:00Z') });
  candidate = recordPackageAudit(candidate, { status: 'pass', auditor: 'fixture-auditor', findings: [] }, {
    clock: at('2026-08-13T01:00:00Z'),
  });
  candidate = recordEval(candidate, evalResult(candidate.artifact.package.packageDigest));
  candidate = applyAudit(candidate);
  return configureReview(candidate, { policy: policy(), submitterPrincipalId: 'person:publisher' }, {
    clock: at('2026-08-13T03:00:00Z'),
  });
}

function attest(candidate, principalId, time) {
  return recordReviewAttestation(candidate, {
    decision: 'approve', reviewer: reviewer(principalId), reason: `${principalId} 已独立复核所有稳定证据。`, at: time,
  }, { clock: at(time) });
}

test('complete package becomes install eligible only after two independent trusted human approvals', () => {
  let candidate = completeCandidate();
  assert.equal(candidate.certification.status, 'pending');
  assert.equal(candidate.reviewEvidence.evidenceDigest.startsWith('sha256:'), true);
  assert.throws(() => toListing(candidate), /only approved/i);

  candidate = attest(candidate, 'person:alice', '2026-08-13T04:00:00Z');
  assert.equal(candidate.certification.status, 'pending');
  candidate = attest(candidate, 'person:bob', '2026-08-13T05:00:00Z');
  assert.equal(candidate.certification.status, 'certified');
  assert.equal(candidate.status, 'approved');
  assert.equal(candidate.reviewAttestations.length, 2);

  const listing = toListing(candidate);
  assert.equal(listing.verification.status, 'certified');
  assert.equal(listing.install.status, 'eligible');
  assert.equal(listing.install.reason, 'certified_complete_package');
});

test('stable review digests ignore display timestamps but material evidence changes stale certification and preserve history', () => {
  let candidate = attest(attest(completeCandidate(), 'person:alice', '2026-08-13T04:00:00Z'), 'person:bob', '2026-08-13T05:00:00Z');
  const originalEvidence = candidate.reviewEvidence;
  const originalEvents = candidate.reviewAttestations;

  const sameEvalAtDifferentDisplayTime = evalResult(candidate.artifact.package.packageDigest, '2026-08-13T09:00:00Z');
  candidate = recordEval(candidate, sameEvalAtDifferentDisplayTime);
  assert.equal(candidate.reviewEvidence.evidenceDigest, originalEvidence.evidenceDigest);
  assert.equal(candidate.certification.status, 'certified');

  candidate = refreshCandidate(candidate, {
    content: candidate.artifact.content,
    package: packageArtifact('-changed'),
    source: { ...candidate.source, commit: 'v2' },
  }, { clock: at('2026-08-14T00:00:00Z') });
  assert.equal(candidate.certification.status, 'stale');
  assert.ok(candidate.certification.reasons.includes('package_changed'));
  assert.equal(candidate.reviewAttestations.length, originalEvents.length);
  assert.deepEqual(candidate.reviewAttestations, originalEvents);
});

test('legacy string review remains history and source-only listing, never current certification or install eligibility', () => {
  let candidate = applyAudit(createCandidate({
    source: { kind: 'fixture', repo: 'fixture/legacy', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: CONTENT, license: 'MIT', sms: completeSmsInput(82), catalog: { packageComplete: false },
  }));
  candidate = {
    ...candidate,
    status: 'approved', reviewedFingerprint: candidate.artifact.fingerprint,
    reviewEvents: [{
      id: 'review_legacy', decision: 'approve', reviewer: 'arbitrary-string', reviewerType: 'human', reason: 'legacy',
      basedOnFingerprint: candidate.artifact.fingerprint, basedOnPackageDigest: null,
      basedOnPackageManifestFingerprint: null, at: '2026-08-01T00:00:00Z',
    }],
  };
  const listing = toListing(candidate);
  assert.equal(candidate.certification.status, 'pending');
  assert.equal(listing.install.status, 'source_required');
  assert.equal(listing.install.reason, 'complete_package_missing');
  assert.equal(listing.verification.lastReview.reviewer, 'arbitrary-string');
});

test('store exposes certification API and rejects attestation or lifecycle history mutation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-review-candidate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CandidateStore(path.join(directory, 'candidates.json'));
  const seeded = completeCandidate();
  store.write({ schemaVersion: 1, candidates: [seeded] });

  let current = store.reviewAttest(seeded.id, {
    decision: 'approve', reviewer: reviewer('person:alice'), reason: 'Alice 独立批准。', at: '2026-08-13T04:00:00Z',
  }, { clock: at('2026-08-13T04:00:00Z') });
  current = store.reviewAttest(seeded.id, {
    decision: 'approve', reviewer: reviewer('person:bob'), reason: 'Bob 独立批准。', at: '2026-08-13T05:00:00Z',
  }, { clock: at('2026-08-13T05:00:00Z') });
  assert.equal(store.reviewStatus(seeded.id, { clock: at('2026-08-13T06:00:00Z') }).certification.status, 'certified');
  assert.throws(() => store.update(seeded.id, value => ({ ...value, reviewAttestations: value.reviewAttestations.slice(1) })), /append-only/i);

  current = store.reviewLifecycle(seeded.id, {
    action: 'recall', actor: reviewer('person:operator'), reason: '安全事件召回。', at: '2026-08-13T07:00:00Z',
  }, { clock: at('2026-08-13T07:00:00Z') });
  assert.equal(current.certification.status, 'recalled');
  assert.throws(() => store.update(seeded.id, value => ({ ...value, reviewLifecycleEvents: [] })), /append-only/i);
});
