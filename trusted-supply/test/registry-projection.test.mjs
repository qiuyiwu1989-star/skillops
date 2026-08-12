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
  toListing,
} from '../lib/candidate.mjs';
import { createEvalResult } from '../lib/eval-result.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { createReleaseFromListing } from '../lib/registry-projection.mjs';
import { canonicalDigest, releaseId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { RegistryStore, createRegistryEvent } from '../lib/registry-store.mjs';
import {
  createManagedDistributionPlan,
  createManagedLockV2,
} from '../../dist-src/skillops/scripts/lib/managed-distribution.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const CONTENT = `---
name: registry-fixture
description: Certified package promoted into the immutable Registry.
---

Return an evidence-backed answer.
`;
const at = value => () => new Date(value);

function reviewer(principalId) {
  return {
    kind: 'human', principalId, subject: `subject:${principalId}`, provider: 'fixture-idp', displayName: principalId,
    verification: {
      status: 'verified', verifiedAt: '2026-08-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
      reference: `fixture://${principalId}`,
    },
  };
}

function certifiedListing() {
  const artifact = createPackageArtifact({
    sourceVersion: 'v1', collectedAt: '2026-08-13T00:00:00Z',
    files: [
      { path: 'SKILL.md', content: CONTENT, mediaType: 'text/markdown' },
      { path: 'references/evidence.md', content: 'verified\n', mediaType: 'text/markdown' },
    ],
  });
  let candidate = createCandidate({
    source: { kind: 'fixture', repo: 'fixture/registry', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: CONTENT, license: 'MIT', package: artifact, catalog: { packageComplete: true }, sms: completeSmsInput(82),
  }, { clock: at('2026-08-13T00:00:00Z') });
  candidate = recordPackageAudit(candidate, { status: 'pass', auditor: 'fixture-auditor', findings: [] }, {
    clock: at('2026-08-13T01:00:00Z'),
  });
  const suite = normalizeEvalSuite({
    schemaVersion: 1, suiteId: 'fixture/registry', suiteVersion: '1.0.0',
    cases: [{ id: 'ready', prompt: 'return ready', assertions: [{ type: 'contains', value: 'ready' }] }],
  });
  candidate = recordEval(candidate, createEvalResult({
    suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, suiteDigest: suite.suiteDigest,
    basedOnPackageDigest: artifact.packageDigest, runner: 'fixture/offline', environment: { adapter: 'fixture' },
    cases: [{
      id: 'ready', status: 'passed', durationMs: 1,
      assertions: [{ type: 'contains', value: 'ready', passed: true, actual: 'ready' }],
      outputSummary: 'ready', error: null,
    }],
    startedAt: '2026-08-13T01:59:59Z', completedAt: '2026-08-13T02:00:00Z',
  }, { suite, packageDigest: artifact.packageDigest }));
  candidate = configureReview(applyAudit(candidate), {
    policy: {
      policyId: 'skillops.market.final-review', policyVersion: '1.0.0', minimumIndependentHumanApprovals: 2,
      approvalValidityDays: 90, trustedIdentityProviders: ['fixture-idp'],
    },
    submitterPrincipalId: 'person:publisher',
  }, { clock: at('2026-08-13T03:00:00Z') });
  for (const [principalId, time] of [['person:alice', '2026-08-13T04:00:00Z'], ['person:bob', '2026-08-13T05:00:00Z']]) {
    candidate = recordReviewAttestation(candidate, {
      decision: 'approve', reviewer: reviewer(principalId), reason: `${principalId} independently approved stable evidence.`, at: time,
    }, { clock: at(time) });
  }
  return toListing(candidate);
}

function input(overrides = {}) {
  return {
    skillId: 'Qiuyiwu/Registry-Fixture', version: '1.2.0',
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    storageRef: null,
    sourceCoordinates: [{ type: 'fixture', coordinate: 'fixture/registry@v1:SKILL.md' }],
    publishedAt: '2026-08-13T06:00:00Z',
    ...overrides,
  };
}

test('certified install-eligible listing projects into immutable Release without candidate identity', () => {
  const listing = certifiedListing();
  const release = createReleaseFromListing(listing, input({ storageRef: `cas:${listing.package.packageDigest}` }));
  assert.equal(release.releaseId, releaseId('qiuyiwu/registry-fixture', '1.2.0', listing.package.packageDigest));
  assert.equal(release.package.manifestDigest, canonicalDigest(listing.package.manifest));
  assert.deepEqual(release.assessmentRefs, [listing.verification.evidence.evalDigest, listing.verification.evidence.smsDigest].sort());
  assert.deepEqual(release.reviewRefs, [listing.verification.evidence.evidenceDigest, listing.verification.evidence.policyDigest].sort());
  assert.match(release.sourceRefs[0], /^src_[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(release).includes(listing.id), false);
  assert.equal(toPublicRegistryValue(release).package.storageRef, undefined);
});

test('projection refuses uncertified, incomplete, stale audit and non-current Eval listings', () => {
  const listing = certifiedListing();
  const storageRef = `cas:${listing.package.packageDigest}`;
  const cases = [
    [{ ...listing, verification: { ...listing.verification, status: 'approved' } }, /certified/i],
    [{ ...listing, install: { ...listing.install, status: 'source_required' } }, /install eligible/i],
    [{ ...listing, install: { ...listing.install, packageComplete: false } }, /complete package/i],
    [{ ...listing, package: { ...listing.package, audit: { ...listing.package.audit, status: 'review' } } }, /package audit/i],
    [{ ...listing, eval: { ...listing.eval, basedOnPackageDigest: `sha256:${'0'.repeat(64)}` } }, /Eval/i],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => createReleaseFromListing(value, input({ storageRef })), pattern);
  }
});

test('projection refuses expired certification and candidate identities in product or source coordinates', () => {
  const listing = certifiedListing();
  const storageRef = `cas:${listing.package.packageDigest}`;
  assert.throws(() => createReleaseFromListing(listing, input({ storageRef, publishedAt: '2027-12-01T00:00:00Z' })), /expired/i);
  assert.throws(() => createReleaseFromListing(listing, input({ storageRef, skillId: 'cand_secret/package' })), /candidate/i);
  assert.throws(() => createReleaseFromListing(listing, input({
    storageRef, sourceCoordinates: [{ type: 'fixture', coordinate: 'cand_secret' }],
  })), /candidate/i);
});

test('release identity and evidence refs ignore display-only timestamps', () => {
  const listing = certifiedListing();
  const release = createReleaseFromListing(listing, input({ storageRef: `cas:${listing.package.packageDigest}` }));
  const changedDisplayTimes = {
    ...listing,
    eval: { ...listing.eval, startedAt: '2026-08-13T02:59:59Z', completedAt: '2026-08-13T03:00:00Z' },
    package: { ...listing.package, collectedAt: '2026-08-13T03:30:00Z' },
  };
  const projectedAgain = createReleaseFromListing(changedDisplayTimes, input({ storageRef: `cas:${listing.package.packageDigest}` }));
  assert.equal(projectedAgain.releaseId, release.releaseId);
  assert.deepEqual(projectedAgain.assessmentRefs, release.assessmentRefs);
  assert.deepEqual(projectedAgain.reviewRefs, release.reviewRefs);
});

test('certified listing publishes through Registry feed into a Release-bound install plan and Lock v2', t => {
  const listing = certifiedListing();
  const release = createReleaseFromListing(listing, input({ storageRef: `cas:${listing.package.packageDigest}` }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-release-chain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new RegistryStore(path.join(directory, 'registry.json'));
  const publication = registry.append(createRegistryEvent({
    type: 'release.published',
    subject: { skillId: release.skillId, releaseId: release.releaseId },
    payload: { release },
    occurredAt: release.publishedAt,
    actorRef: 'role:registry-publisher',
    reasonCode: 'certified_release',
    policyVersion: 'registry-v1',
  }));
  const publicRelease = registry.snapshot().data.releases[release.releaseId];
  assert.equal(publication.action, 'appended');
  assert.equal(publicRelease.status, 'published');
  assert.equal(Object.hasOwn(publicRelease.release.package, 'storageRef'), false);

  const plan = createManagedDistributionPlan({
    operationId: 'op_certified_release_001', action: 'install',
    skillId: release.skillId, releaseId: release.releaseId, version: release.version,
    packageDigest: release.package.packageDigest, registrySourceId: 'regsrc_local_registry',
    releaseStatus: publicRelease.status, manifest: listing.package.manifest,
    manifestDigest: release.package.manifestDigest,
    trustSnapshot: {
      policyVersion: listing.verification.certification.policyDigest,
      reviewValidUntil: listing.verification.certification.validUntil,
      feedCursor: publication.cursor,
      reviewDigest: listing.verification.evidence.evidenceDigest,
      evalDigest: listing.verification.evidence.evalDigest,
      licenseDigest: listing.verification.evidence.licenseDigest,
    },
    targetState: { exists: false, managed: false },
  }, { now: release.publishedAt });
  assert.equal(plan.status, 'ready');
  const lock = createManagedLockV2(plan, {
    installationId: 'inst_certified_release_001', targetPath: '/fixture/skills/registry-fixture',
    deployedFingerprint: `sha256:${'9'.repeat(64)}`, installedAt: release.publishedAt,
  });
  assert.equal(lock.releaseId, release.releaseId);
  assert.equal(lock.packageDigest, release.package.packageDigest);
  assert.equal(JSON.stringify({ publicRelease, plan, lock }).includes('cand_'), false);

  registry.append(createRegistryEvent({
    type: 'release.revoked', subject: { releaseId: release.releaseId }, payload: { releaseId: release.releaseId },
    occurredAt: '2026-08-13T07:00:00Z', actorRef: 'role:registry-publisher',
    reasonCode: 'fixture_revoke', policyVersion: 'registry-v1',
  }));
  const revoked = createManagedDistributionPlan({
    operationId: 'op_revoked_release_001', action: 'install',
    skillId: release.skillId, releaseId: release.releaseId, version: release.version,
    packageDigest: release.package.packageDigest, registrySourceId: 'regsrc_local_registry',
    releaseStatus: registry.snapshot().data.releases[release.releaseId].status,
    manifest: listing.package.manifest, manifestDigest: release.package.manifestDigest,
    trustSnapshot: plan.lockDraft.trustSnapshot, targetState: { exists: false, managed: false },
  }, { now: '2026-08-13T07:01:00Z' });
  assert.equal(revoked.status, 'blocked');
  assert.equal(revoked.distributionStatus, 'revoked');
});
