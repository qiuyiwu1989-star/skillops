import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAudit,
  configureReview,
  createCandidate,
  recordEval,
  recordPackageAudit,
  recordReviewAttestation,
  toListing,
} from '../lib/candidate.mjs';
import { createEvalResult } from '../lib/eval-result.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { createPilotReadinessReport } from '../lib/pilot-readiness.mjs';
import { createReleaseFromListing } from '../lib/registry-projection.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const at = value => () => new Date(value);
const CONTENT = `---
name: pilot-ready
description: Evidence-backed SkillHub pilot fixture.
---

Return a concise evidence report.
`;

function reviewer(principalId) {
  return {
    kind: 'human',
    principalId,
    subject: `subject:${principalId}`,
    provider: 'fixture-idp',
    displayName: principalId,
    verification: {
      status: 'verified',
      verifiedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
      reference: `fixture://${principalId}`,
    },
  };
}

function completeEvidence() {
  const artifact = createPackageArtifact({
    sourceVersion: '1.0.0',
    collectedAt: '2026-08-13T00:00:00Z',
    files: [
      { path: 'SKILL.md', content: CONTENT, mediaType: 'text/markdown' },
      { path: 'LICENSE', content: 'MIT License\nPermission is hereby granted, free of charge.\n', mediaType: 'text/plain' },
    ],
  });
  let candidate = createCandidate({
    source: {
      kind: 'skillhub', url: 'https://skillhub.cn/skills/pilot-ready?namespace=maker',
      path: 'SKILL.md', commit: '1.0.0', version: '1.0.0', license: 'MIT',
    },
    content: CONTENT,
    license: 'MIT',
    package: artifact,
    catalog: { coordinate: '@maker/pilot-ready', packageComplete: true },
    sms: completeSmsInput(82),
  }, { clock: at('2026-08-13T00:00:00Z') });
  candidate = recordPackageAudit(candidate, {
    status: 'pass', auditor: 'fixture-package-auditor', findings: [],
  }, { clock: at('2026-08-13T01:00:00Z') });
  const suite = normalizeEvalSuite({
    schemaVersion: 1,
    suiteId: 'fixture/pilot-ready',
    suiteVersion: '1.0.0',
    cases: [{ id: 'ready', prompt: 'return ready', assertions: [{ type: 'contains', value: 'ready' }] }],
  });
  candidate = recordEval(candidate, createEvalResult({
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteDigest: suite.suiteDigest,
    basedOnPackageDigest: artifact.packageDigest,
    runner: 'fixture/offline',
    environment: { adapter: 'fixture' },
    cases: [{
      id: 'ready', status: 'passed', durationMs: 1,
      assertions: [{ type: 'contains', value: 'ready', passed: true, actual: 'ready' }],
      outputSummary: 'ready', error: null,
    }],
    startedAt: '2026-08-13T01:59:59Z',
    completedAt: '2026-08-13T02:00:00Z',
  }, { suite, packageDigest: artifact.packageDigest }));
  candidate = configureReview(applyAudit(candidate), {
    policy: {
      policyId: 'skillops.market.final-review',
      policyVersion: '1.0.0',
      minimumIndependentHumanApprovals: 2,
      approvalValidityDays: 90,
      trustedIdentityProviders: ['fixture-idp'],
    },
    submitterPrincipalId: 'person:publisher',
  }, { clock: at('2026-08-13T03:00:00Z') });
  for (const [principalId, time] of [
    ['person:alice', '2026-08-13T04:00:00Z'],
    ['person:bob', '2026-08-13T05:00:00Z'],
  ]) {
    candidate = recordReviewAttestation(candidate, {
      decision: 'approve', reviewer: reviewer(principalId), reason: 'Independent evidence review.', at: time,
    }, { clock: at(time) });
  }
  const listing = toListing(candidate);
  const release = createReleaseFromListing(listing, {
    skillId: 'maker/pilot-ready',
    version: '1.0.0',
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    storageRef: `cas:${artifact.packageDigest}`,
    publishedAt: '2026-08-13T06:00:00Z',
  });
  return { candidate, listing, release };
}

function blockerCodes(item) {
  return item.blockers.map(blocker => blocker.code);
}

test('report accepts only one to three pilot items', () => {
  const options = { generatedAt: '2026-08-13T07:00:00Z' };
  assert.throws(() => createPilotReadinessReport({ items: [], ...options }), /one to three/i);
  assert.throws(() => createPilotReadinessReport({ items: [{}, {}, {}, {}], ...options }), /one to three/i);
  assert.throws(() => createPilotReadinessReport({ items: [{}], generatedAt: 'not-a-time' }), /generatedAt/i);
});

test('missing complete package or redistributable license remains source only', () => {
  const { candidate } = completeEvidence();
  const noPackage = structuredClone(candidate);
  noPackage.artifact.package = null;
  noPackage.catalog.packageComplete = false;
  const noLicense = structuredClone(candidate);
  noLicense.audit.license = {
    status: 'index_only', spdx: null, reason: 'license_missing_or_unclear', redistributable: false,
  };
  const report = createPilotReadinessReport({
    items: [{ candidate: noPackage }, { candidate: noLicense }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.deepEqual(report.summary, { total: 2, sourceOnly: 2, evidencePending: 0, releaseReady: 0 });
  assert.equal(report.items.every(item => item.status === 'source_only'), true);
  assert.equal(report.items.every(item => item.evidenceRefs.sourceId.startsWith('src_')), true);
  assert.ok(report.items.some(item => blockerCodes(item).includes('complete_package_missing')));
  assert.ok(report.items.some(item => blockerCodes(item).includes('license_not_redistributable')));
});

test('complete package without current audit, Eval, certification or listing fails closed as evidence pending', () => {
  const { candidate } = completeEvidence();
  const pending = structuredClone(candidate);
  pending.packageAudit = null;
  pending.eval = { status: 'pending' };
  pending.reviewAttestations = [];
  // A stored `certified` summary is not evidence: readiness must replay the
  // attestations against the current package, Eval and report time.
  const report = createPilotReadinessReport({
    items: [{ candidate: pending }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.equal(report.items[0].status, 'evidence_pending');
  assert.deepEqual(blockerCodes(report.items[0]), [
    'package_audit_missing', 'eval_not_current', 'certification_not_current', 'listing_missing', 'release_missing',
  ]);
});

test('release-ready requires a published, canonical Release bound to current evidence', () => {
  const ready = completeEvidence();
  const report = createPilotReadinessReport({
    items: [{ ...ready, release: { status: 'published', release: ready.release } }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  const item = report.items[0];
  assert.equal(item.status, 'release_ready');
  assert.deepEqual(item.blockers, []);
  assert.equal(item.evidenceRefs.releaseId, ready.release.releaseId);
  assert.equal(item.evidenceRefs.sourceId.startsWith('src_'), true);
  assert.equal(Object.values(item.evidenceRefs).every(value => /^(?:sha256:|rel_|src_)/.test(value)), true);
  const serialized = JSON.stringify(report);
  for (const secret of ['cand_', 'cas:', 'SKILL.md', 'person:alice', 'outputSummary', 'prompt', 'token']) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});

test('report digest ignores display time and input order while lifecycle or identity mismatch blocks readiness', () => {
  const first = completeEvidence();
  const second = completeEvidence();
  const reportA = createPilotReadinessReport({
    items: [{ ...first }, { ...second, release: { status: 'withdrawn', release: second.release } }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  const reportB = createPilotReadinessReport({
    items: [{ ...second, release: { status: 'withdrawn', release: second.release } }, { ...first }],
    generatedAt: '2026-08-14T07:00:00Z',
  });
  assert.equal(reportA.reportDigest, reportB.reportDigest);
  const blocked = reportA.items.find(item => blockerCodes(item).includes('release_not_published'));
  assert.equal(blocked.status, 'evidence_pending');

  const tampered = structuredClone(first.release);
  tampered.releaseId = `rel_${'0'.repeat(64)}`;
  const mismatch = createPilotReadinessReport({
    items: [{ ...first, release: tampered }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.ok(blockerCodes(mismatch.items[0]).includes('release_invalid'));

  const staleManifest = structuredClone(first.release);
  staleManifest.package.manifestDigest = `sha256:${'1'.repeat(64)}`;
  const staleEvidence = createPilotReadinessReport({
    items: [{ ...first, release: staleManifest }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.ok(blockerCodes(staleEvidence.items[0]).includes('release_evidence_mismatch'));
});
