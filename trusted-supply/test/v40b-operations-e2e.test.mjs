import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizePublicOps } from '../../market-preview/ops.js';
import { createFixtureIdpVerifier, toReviewIdentity } from '../lib/idp-receipt.mjs';
import { OrganizationGovernanceStore } from '../lib/organization-governance-store.mjs';
import { projectOrganizationGovernance } from '../lib/organization-governance.mjs';
import {
  createReviewAttestation,
  createReviewEvidenceSnapshot,
  createReviewPolicy,
  evaluateReviewCertification,
} from '../lib/review-policy.mjs';
import { canonicalDigest, normalizeRelease, sourceId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { createRegistryEvent } from '../lib/registry-store.mjs';
import { createZaowuyunEnvelope } from '../lib/zaowuyun-adapter.mjs';
import { PersistentZaowuyunStagingSender, ZaowuyunStagingStore } from '../lib/zaowuyun-staging-store.mjs';
import { createZaowuyunStagingPlan } from '../lib/zaowuyun-staging.mjs';

const NOW = '2026-08-13T12:00:00.000Z';
const D = letter => `sha256:${letter.repeat(64)}`;

function organizationEvent(operationId, type, subject, payload) {
  return {
    schemaVersion: 1,
    operationId,
    type,
    occurredAt: NOW,
    actorPrincipalId: 'principal:owner-fixture',
    organizationId: 'org_yongle',
    subject,
    payload,
  };
}

function append(store, input, options = {}) {
  return store.append(input, {
    expectedRevision: store.read().revision,
    now: NOW,
    ...options,
  });
}

test('two IdP receipts certify, persist through organization and staging restarts, and normalize to public ops without private data', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v40b-operations-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-idp',
    purpose: 'skillops.final-review',
    receiptKey: Buffer.alloc(32, 7),
    clock: () => '2026-08-13T08:00:00Z',
    ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: assertion => ({ subject: `reviewer-${assertion.fixtureId}`, kind: 'human' }),
  });
  const receipts = await Promise.all([
    verifier.issueReceipt({ fixtureId: 'alice' }),
    verifier.issueReceipt({ fixtureId: 'bob' }),
  ]);
  assert.notEqual(receipts[0].subjectDigest, receipts[1].subjectDigest);

  const policy = createReviewPolicy({
    policyId: 'skillops.market.final-review',
    policyVersion: '1.0.0',
    minimumIndependentHumanApprovals: 2,
    approvalValidityDays: 90,
    trustedIdentityProviders: ['fixture-idp'],
  });
  const evidence = createReviewEvidenceSnapshot({
    contentFingerprint: D('a'),
    packageDigest: D('b'),
    licenseDigest: D('c'),
    smsDigest: D('d'),
    evalDigest: D('e'),
  }, { policy });
  const attestations = receipts.map((receipt, index) => createReviewAttestation({
    decision: 'approve',
    reviewer: toReviewIdentity(receipt, {
      trustedProviderVerifiers: [verifier],
      purpose: 'skillops.final-review',
      now: NOW,
    }),
    reason: '已独立复核当前不可变包与证据摘要。',
    at: `2026-08-13T${index ? '10' : '09'}:00:00Z`,
  }, { policy, snapshot: evidence }));
  const certification = evaluateReviewCertification({
    policy,
    snapshot: evidence,
    attestations,
    now: NOW,
  });
  assert.equal(certification.status, 'certified');
  assert.equal(certification.approvals.length, 2);

  const release = normalizeRelease({
    skillId: 'maker/v40b-pilot',
    version: '1.0.0',
    package: { packageDigest: D('b'), manifestDigest: D('f'), storageRef: `cas:${D('b')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: [evidence.smsDigest, evidence.evalDigest],
    reviewRefs: [evidence.evidenceDigest, policy.policyDigest],
    sourceRefs: [sourceId('skillhub', 'https://skillhub.cn/v40b-pilot')],
    publishedAt: '2026-08-13T08:30:00Z',
  });
  const registryRelease = {
    releaseId: release.releaseId,
    skillId: release.skillId,
    version: release.version,
    packageDigest: release.package.packageDigest,
    status: 'published',
    versionLocked: true,
    sms: { total: 90 },
    eval: { successRate: 1 },
    certification: { status: certification.status, humanApprovals: certification.approvals.length },
    evidence: {
      reviewValidUntil: certification.validUntil,
      evalValidUntil: certification.validUntil,
      packageAuditValidUntil: certification.validUntil,
      licenseValidUntil: certification.validUntil,
    },
  };

  const organizationPath = path.join(root, 'organization.json');
  const organization = new OrganizationGovernanceStore(organizationPath);
  append(organization, organizationEvent('op_create_org', 'organization.created',
    { organizationId: 'org_yongle' },
    { organization: { organizationId: 'org_yongle', name: '永乐教育训练营' } }));
  append(organization, organizationEvent('op_create_project', 'project.created',
    { projectId: 'project_pilot' },
    { project: { projectId: 'project_pilot', name: '首批技能试点' } }));
  append(organization, organizationEvent('op_create_establishment', 'establishment.created',
    { establishmentId: 'est_content' },
    { establishment: { establishmentId: 'est_content', projectId: 'project_pilot', name: '内容能力编制', capacity: 3 } }));
  append(organization, organizationEvent('op_enroll', 'enrollment.created',
    { enrollmentId: 'enrollment_v40b' },
    { enrollment: {
      enrollmentId: 'enrollment_v40b',
      establishmentId: 'est_content',
      skillId: release.skillId,
      releaseId: release.releaseId,
    } }), { registryResolver: () => registryRelease });

  const reopenedOrganization = new OrganizationGovernanceStore(organizationPath);
  const organizationProjection = projectOrganizationGovernance(reopenedOrganization.read().events, {
    organizationId: 'org_yongle',
    public: true,
  });
  assert.equal(organizationProjection.enrollments.enrollment_v40b.releaseId, release.releaseId);

  const internal = createRegistryEvent({
    type: 'release.published',
    subject: { skillId: release.skillId, releaseId: release.releaseId },
    payload: { release },
    occurredAt: release.publishedAt,
    actorRef: 'registry-publisher',
    reasonCode: 'v40b_e2e',
    policyVersion: 'registry-v1',
  });
  const payload = toPublicRegistryValue(internal.payload);
  const publicEvent = {
    schemaVersion: 1,
    eventId: internal.eventId,
    sequence: 1,
    type: internal.type,
    occurredAt: internal.occurredAt,
    actorRole: 'registry-publisher',
    reasonCode: internal.reasonCode,
    subject: toPublicRegistryValue(internal.subject),
    payload,
    payloadDigest: canonicalDigest(payload),
    policyVersion: internal.policyVersion,
  };
  const envelope = createZaowuyunEnvelope(publicEvent, {
    release,
    listing: { title: 'V4.0-B 试点技能', description: '可信身份和持久台账联合验收。', category: '内容创作' },
    trust: {
      sms: { ref: evidence.smsDigest, status: 'pass', total: 90, tier: 'A' },
      eval: { ref: evidence.evalDigest, status: 'pass', successRate: 1 },
      review: { refs: [evidence.evidenceDigest, policy.policyDigest], status: 'certified', validUntil: certification.validUntil },
    },
  });
  const plan = createZaowuyunStagingPlan(envelope, { operationId: 'op_stage_v40b', afterCursor: '0' });
  const stagingPath = path.join(root, 'staging.json');
  const staging = new ZaowuyunStagingStore(stagingPath);
  const sender = new PersistentZaowuyunStagingSender({
    store: staging,
    clock: () => '2026-08-13T13:00:00Z',
    transport: {
      send(input) {
        return {
          projectionId: input.projectionId,
          idempotencyKey: input.idempotencyKey,
          payloadDigest: input.payloadDigest,
          status: 'accepted',
          remoteRef: `https://staging.example.invalid/receipts/${input.projectionId}`,
          receivedAt: '2026-08-13T13:00:00Z',
        };
      },
    },
  });
  await sender.send(plan, { confirmationDigest: plan.confirmationDigest });
  const stagingStatus = new ZaowuyunStagingStore(stagingPath).status();
  assert.equal(stagingStatus.receiptCount, 1);

  const normalized = normalizePublicOps({
    schemaVersion: 1,
    generatedAt: '2026-08-13T13:00:01Z',
    organizationProjection,
    stagingStatus,
  });
  assert.equal(normalized.organization.name, '永乐教育训练营');
  assert.equal(normalized.enrollments[0].releaseId, release.releaseId);
  assert.equal(normalized.staging.accepted, 1);
  const serialized = JSON.stringify(normalized);
  for (const forbidden of [
    'principal:owner-fixture', 'reviewer-alice', 'reviewer-bob',
    'receiptKey', 'storageRef', 'prompt', 'output', 'token', 'secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public ops leaked ${forbidden}`);
  }
});
