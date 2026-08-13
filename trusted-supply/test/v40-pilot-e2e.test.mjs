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
import {
  OrganizationGovernanceError,
  appendOrganizationEvent,
  projectOrganizationGovernance,
} from '../lib/organization-governance.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { createPilotReadinessReport } from '../lib/pilot-readiness.mjs';
import { createReleaseFromListing } from '../lib/registry-projection.mjs';
import { RegistryStore, createRegistryEvent } from '../lib/registry-store.mjs';
import {
  ZaowuyunMockTransport,
  createZaowuyunEnvelope,
} from '../lib/zaowuyun-adapter.mjs';
import {
  ZaowuyunStagingError,
  ZaowuyunStagingSender,
  createZaowuyunStagingPlan,
} from '../lib/zaowuyun-staging.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const NOW = '2026-08-13T00:00:00.000Z';
const CONTENT = `---
name: v40-pilot
description: Evidence-backed offline pilot fixture.
---

Return a concise evidence report without executing third-party code.
`;
const at = value => () => new Date(value);

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

function certifiedFixture() {
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
      kind: 'skillhub',
      url: 'https://skillhub.cn/skills/v40-pilot?namespace=maker',
      path: 'SKILL.md',
      commit: '1.0.0',
      version: '1.0.0',
      license: 'MIT',
    },
    content: CONTENT,
    license: 'MIT',
    package: artifact,
    catalog: { coordinate: '@maker/v40-pilot', packageComplete: true },
    sms: completeSmsInput(86),
  }, { clock: at(NOW) });
  candidate = recordPackageAudit(candidate, {
    status: 'pass', auditor: 'fixture-package-auditor', findings: [],
  }, { clock: at('2026-08-13T01:00:00Z') });
  const suite = normalizeEvalSuite({
    schemaVersion: 1,
    suiteId: 'fixture/v40-pilot',
    suiteVersion: '1.0.0',
    cases: [{ id: 'evidence', prompt: 'return evidence', assertions: [{ type: 'contains', value: 'evidence' }] }],
  });
  candidate = recordEval(candidate, createEvalResult({
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteDigest: suite.suiteDigest,
    basedOnPackageDigest: artifact.packageDigest,
    runner: 'fixture/offline',
    environment: { adapter: 'fixture' },
    cases: [{
      id: 'evidence',
      status: 'passed',
      durationMs: 1,
      assertions: [{ type: 'contains', value: 'evidence', passed: true, actual: 'evidence' }],
      outputSummary: 'evidence',
      error: null,
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
      decision: 'approve',
      reviewer: reviewer(principalId),
      reason: 'Independent review of the immutable package and evidence.',
      at: time,
    }, { clock: at(time) });
  }
  const listing = toListing(candidate);
  const release = createReleaseFromListing(listing, {
    skillId: 'maker/v40-pilot',
    version: '1.0.0',
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    storageRef: `cas:${artifact.packageDigest}`,
    publishedAt: '2026-08-13T06:00:00Z',
  });
  return { artifact, candidate, listing, release };
}

function registryReleaseEvidence({ listing, release }, overrides = {}) {
  return {
    releaseId: release.releaseId,
    skillId: release.skillId,
    version: release.version,
    packageDigest: release.package.packageDigest,
    status: 'published',
    versionLocked: true,
    sms: { total: listing.sms.total, tier: listing.sms.tier },
    eval: { successRate: listing.eval.successRate },
    certification: { status: 'certified', humanApprovals: 2 },
    evidence: {
      reviewValidUntil: listing.verification.certification.validUntil,
      evalValidUntil: listing.verification.certification.validUntil,
      packageAuditValidUntil: listing.verification.certification.validUntil,
      licenseValidUntil: listing.verification.certification.validUntil,
    },
    ...overrides,
  };
}

function registryResolver(snapshot, fixture, overrides = {}) {
  return ({ skillId, releaseId }) => {
    const entry = snapshot.releases[releaseId];
    assert.ok(entry, 'trusted Registry snapshot must contain the requested Release');
    assert.equal(entry.release.skillId, skillId);
    assert.equal(entry.release.releaseId, releaseId);
    return registryReleaseEvidence(fixture, {
      releaseId: entry.release.releaseId,
      skillId: entry.release.skillId,
      version: entry.release.version,
      packageDigest: entry.release.package.packageDigest,
      status: entry.status,
      ...overrides,
    });
  };
}

function appendOrg(events, input, options = {}) {
  return appendOrganizationEvent(events, {
    schemaVersion: 1,
    occurredAt: NOW,
    actorPrincipalId: 'principal:owner',
    organizationId: 'org_yongle',
    ...input,
  }, { now: NOW, ...options });
}

function bootstrapOrganization() {
  let events = appendOrg([], {
    operationId: 'op_create_org',
    type: 'organization.created',
    subject: { organizationId: 'org_yongle' },
    payload: { organization: { organizationId: 'org_yongle', name: '永乐教育训练营' } },
  }).events;
  events = appendOrg(events, {
    operationId: 'op_create_project',
    type: 'project.created',
    subject: { projectId: 'project_pilot' },
    payload: { project: { projectId: 'project_pilot', name: '首批技能试点' } },
  }).events;
  events = appendOrg(events, {
    operationId: 'op_create_establishment',
    type: 'establishment.created',
    subject: { establishmentId: 'est_content' },
    payload: { establishment: { establishmentId: 'est_content', projectId: 'project_pilot', name: '内容能力编制', capacity: 3 } },
  }).events;
  events = appendOrg(events, {
    operationId: 'op_set_policy',
    type: 'policy.changed',
    subject: { organizationId: 'org_yongle' },
    payload: { policy: { minimumSmsScore: 80, minimumEvalSuccessRate: 1, minimumHumanApprovals: 2, requireVersionLock: true, allowedReleaseStatuses: ['published'] } },
  }).events;
  return events;
}

function assertNoPrivateProjectionData(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ['cand_', 'principal', 'path', 'storageRef', 'SKILL.md', 'prompt', 'output', 'token']) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `public state leaked ${forbidden}`);
  }
}

test('complete package flows through trust, Registry, readiness, organization enrollment and exact staging confirmation', async t => {
  const fixture = certifiedFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v40-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new RegistryStore(path.join(directory, 'registry.json'));
  const publication = registry.append(createRegistryEvent({
    type: 'release.published',
    subject: { skillId: fixture.release.skillId, releaseId: fixture.release.releaseId },
    payload: {
      release: fixture.release,
      candidateId: fixture.candidate.id,
      localPath: '/private/cas/package',
    },
    occurredAt: fixture.release.publishedAt,
    actorRef: 'principal:registry-publisher',
    reasonCode: 'v40_pilot_certified',
    policyVersion: 'registry-v1',
  }));
  registry.append(createRegistryEvent({
    type: 'listing.upserted',
    subject: { skillId: fixture.release.skillId, listingId: 'public:zh-CN' },
    payload: {
      channel: 'public', locale: 'zh-CN', skillId: fixture.release.skillId, releaseId: fixture.release.releaseId,
      title: 'V4.0 可信试点技能', description: '完成全包审计、离线评估与双人终审。', category: '内容创作',
      candidateId: fixture.candidate.id,
    },
    occurredAt: '2026-08-13T06:01:00Z',
    actorRef: 'principal:registry-publisher',
    reasonCode: 'v40_pilot_listing',
    policyVersion: 'registry-v1',
  }));
  const publicFeed = registry.feed({ after: '0' });
  const publicReleaseEvent = publicFeed.events.find(event => event.type === 'release.published');
  assert.ok(publicReleaseEvent);
  assert.equal(publicReleaseEvent.sequence, 1);
  assertNoPrivateProjectionData(publicFeed);

  const readiness = createPilotReadinessReport({
    items: [{ ...fixture, release: { status: 'published', release: fixture.release } }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.deepEqual(readiness.summary, { total: 1, sourceOnly: 0, evidencePending: 0, releaseReady: 1 });
  assert.equal(readiness.items[0].status, 'release_ready');

  let organizationEvents = bootstrapOrganization();
  organizationEvents = appendOrg(organizationEvents, {
    operationId: 'op_enroll_release',
    type: 'enrollment.created',
    subject: { enrollmentId: 'enrollment_v40_pilot' },
    payload: { enrollment: {
      enrollmentId: 'enrollment_v40_pilot', establishmentId: 'est_content',
      skillId: fixture.release.skillId, releaseId: fixture.release.releaseId,
    } },
  }, { registryResolver: registryResolver(registry.snapshot().data, fixture) }).events;
  const publicOrganization = projectOrganizationGovernance(organizationEvents, {
    organizationId: 'org_yongle', public: true,
  });
  assert.equal(publicOrganization.enrollments.enrollment_v40_pilot.releaseId, fixture.release.releaseId);
  assertNoPrivateProjectionData(publicOrganization);

  const envelope = createZaowuyunEnvelope(publicReleaseEvent, {
    release: fixture.release,
    listing: { title: 'V4.0 可信试点技能', description: '完成全包审计、离线评估与双人终审。', category: '内容创作' },
    trust: {
      sms: { ref: fixture.listing.verification.evidence.smsDigest, status: 'pass', total: fixture.listing.sms.total, tier: fixture.listing.sms.tier },
      eval: { ref: fixture.listing.verification.evidence.evalDigest, status: 'pass', successRate: fixture.listing.eval.successRate },
      review: {
        refs: [fixture.listing.verification.evidence.policyDigest, fixture.listing.verification.evidence.evidenceDigest],
        status: 'certified', validUntil: fixture.listing.verification.certification.validUntil,
      },
    },
  });
  const plan = createZaowuyunStagingPlan(envelope, {
    operationId: 'op_publish_v40_pilot', afterCursor: '0',
  });
  const transport = new ZaowuyunMockTransport({ clock: () => '2026-08-13T08:00:00Z' });
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T08:00:01Z' });

  await assert.rejects(
    sender.send(plan, { confirmationDigest: `sha256:${'f'.repeat(64)}` }),
    error => error instanceof ZaowuyunStagingError && error.code === 'CONFIRMATION_MISMATCH',
  );
  assert.equal(transport.receipts.size, 0, 'wrong confirmation must perform zero sends');
  assert.deepEqual(sender.status(), { schemaVersion: 1, cursor: '0', receiptCount: 0, receipts: [] });

  const receipt = await sender.send(plan, { confirmationDigest: plan.confirmationDigest });
  const retry = await sender.send(structuredClone(plan), { confirmationDigest: plan.confirmationDigest });
  assert.deepEqual(retry, receipt);
  assert.equal(transport.receipts.size, 1, 'exact confirmation is idempotent');
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.cursor, publication.cursor);
  assertNoPrivateProjectionData(sender.status());
});

test('missing evidence is not release-ready and cannot be enrolled', t => {
  const fixture = certifiedFixture();
  const pendingCandidate = structuredClone(fixture.candidate);
  pendingCandidate.eval = { status: 'pending' };
  pendingCandidate.reviewAttestations = [];
  const readiness = createPilotReadinessReport({
    items: [{ candidate: pendingCandidate }],
    generatedAt: '2026-08-13T07:00:00Z',
  });
  assert.equal(readiness.items[0].status, 'evidence_pending');
  assert.notEqual(readiness.items[0].status, 'release_ready');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v40-blocked-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new RegistryStore(path.join(directory, 'registry.json'));
  registry.append(createRegistryEvent({
    type: 'release.published',
    subject: { skillId: fixture.release.skillId, releaseId: fixture.release.releaseId },
    payload: { release: fixture.release },
    occurredAt: fixture.release.publishedAt,
    actorRef: 'role:registry-publisher',
    reasonCode: 'v40_pending_evidence',
    policyVersion: 'registry-v1',
  }));
  const organizationEvents = bootstrapOrganization();
  assert.throws(() => appendOrg(organizationEvents, {
    operationId: 'op_block_pending_enrollment',
    type: 'enrollment.created',
    subject: { enrollmentId: 'enrollment_pending' },
    payload: { enrollment: {
      enrollmentId: 'enrollment_pending', establishmentId: 'est_content',
      skillId: fixture.release.skillId, releaseId: fixture.release.releaseId,
    } },
  }, {
    registryResolver: registryResolver(registry.snapshot().data, fixture, {
      certification: { status: 'pending', humanApprovals: 0 },
    }),
  }), error => error instanceof OrganizationGovernanceError && error.code === 'CERTIFICATION_REQUIRED');
});
