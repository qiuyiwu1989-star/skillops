import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { CreatorWorkspaceStore } from '../lib/creator/creator-workspace-store.mjs';
import {
  createPublicationEvent,
  createPublicationLifecycleEvent,
  createPublicationResolver,
  createPublicationReview,
  createPublicationSubmission,
  replayPublicationEvents,
  toPublicPublicationProjection,
} from '../lib/creator/publication-workflow.mjs';

const PUB = `pub_${'a'.repeat(64)}`;
const PROD = `prod_${'b'.repeat(64)}`;
const REL = `rel_${'c'.repeat(64)}`;
const WORK = `work_${'d'.repeat(64)}`;
const DRAFT = `sha256:${'e'.repeat(64)}`;
const REGISTRY = `sha256:${'f'.repeat(64)}`;
const LICENSE = `sha256:${'1'.repeat(64)}`;
const EVIDENCE = `sha256:${'2'.repeat(64)}`;
const SUBMITTER = `sha256:${'3'.repeat(64)}`;
const RIGHTS = `sha256:${'4'.repeat(64)}`;
const MARKET = `sha256:${'5'.repeat(64)}`;
const T0 = '2026-08-14T00:00:00.000Z';
const T1 = '2026-08-14T01:00:00.000Z';
const T2 = '2026-08-14T02:00:00.000Z';
const T3 = '2026-08-14T03:00:00.000Z';
const T4 = '2026-08-14T04:00:00.000Z';

function binding(overrides = {}) {
  return {
    workId: WORK,
    publisherId: PUB,
    productId: PROD,
    releaseId: REL,
    draftRevision: 1,
    draftDigest: DRAFT,
    marketRegistryRevision: REGISTRY,
    licensePolicyDigest: LICENSE,
    evidenceDigest: EVIDENCE,
    declarationVersion: 'rights-v1',
    ...overrides,
  };
}

async function identityFixture() {
  const assertions = new Map([
    ['submitter', { subject: 'human:submitter', kind: 'human' }],
    ['rights', { subject: 'human:reviewer-one', kind: 'human' }],
    ['market', { subject: 'human:reviewer-two', kind: 'human' }],
  ]);
  const verifier = createFixtureIdpVerifier({
    provider: 'idp-one',
    purpose: 'creator-publication',
    receiptKey: 'independent-review-provider-one-key-material',
    clock: () => T0,
    ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: async assertion => assertions.get(assertion.code),
  });
  const receipts = {
    submitter: await verifier.issueReceipt({ code: 'submitter' }),
    rights: await verifier.issueReceipt({ code: 'rights' }),
    market: await verifier.issueReceipt({ code: 'market' }),
  };
  const canonical = new Map([
    [`${verifier.provider}:${receipts.submitter.subjectDigest}`, SUBMITTER],
    [`${verifier.provider}:${receipts.rights.subjectDigest}`, RIGHTS],
    [`${verifier.provider}:${receipts.market.subjectDigest}`, MARKET],
  ]);
  return { verifiers: [verifier], receipts, canonical };
}

function trust(identity, now = T0, overrides = {}) {
  return {
    trustedProviderVerifiers: identity.verifiers,
    now: () => now,
    canonicalHumanResolver: ({ provider, subjectDigest }) => ({
      canonicalSubjectDigest: identity.canonical.get(`${provider}:${subjectDigest}`),
    }),
    publisherRepresentativeResolver: () => true,
    reviewerRoleResolver: () => true,
    lifecycleActorResolver: () => true,
    draftResolver: () => ({
      workId: WORK,
      publisherId: PUB,
      productId: PROD,
      draftRevision: 1,
      draftDigest: DRAFT,
      target: { releaseId: REL },
      rightsDeclaration: { statementVersion: 'rights-v1' },
    }),
    productResolver: () => ({ productId: PROD, publisherId: PUB }),
    releaseResolver: () => ({ releaseId: REL, productId: PROD }),
    marketRegistryRevisionResolver: () => REGISTRY,
    currentBindingResolver: () => binding(),
    ...overrides,
  };
}

function event(type, payload, identity) {
  const at = payload.submittedAt ?? payload.reviewedAt ?? payload.occurredAt;
  return createPublicationEvent(type, payload, trust(identity, at));
}

function review(submission, receipt, role, decision, identity, reviewedAt) {
  return createPublicationReview({
    submissionId: submission.submissionId,
    submissionDigest: submission.submissionDigest,
    role,
    decision,
    reason: `${role} independent review`,
    evidenceDigest: submission.evidenceDigest,
    reviewerReceipt: receipt,
    reviewedAt,
  }, { ...trust(identity, reviewedAt), submissionResolver: () => submission });
}

test('public projection exposes no pending, approved, or rejected private publication item', async () => {
  const identity = await identityFixture();
  const submission = createPublicationSubmission({
    ...binding(),
    submitterReceipt: identity.receipts.submitter,
    submittedAt: T0,
  }, trust(identity));
  const submissionEvent = event('submission.created', submission, identity);

  const pending = replayPublicationEvents([submissionEvent], trust(identity));
  assert.deepEqual(toPublicPublicationProjection(pending).items, {});

  const rights = review(submission, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const market = review(submission, identity.receipts.market, 'market', 'approve', identity, T2);
  const approved = replayPublicationEvents([
    submissionEvent,
    event('review.recorded', rights, identity),
    event('review.recorded', market, identity),
  ], trust(identity, T2));
  assert.equal(Object.values(approved.items)[0].status, 'approved');
  assert.deepEqual(toPublicPublicationProjection(approved).items, {});

  const rejectedReview = review(submission, identity.receipts.rights, 'rights', 'reject', identity, T1);
  const rejected = replayPublicationEvents([
    submissionEvent,
    event('review.recorded', rejectedReview, identity),
  ], trust(identity, T1));
  assert.equal(Object.values(rejected.items)[0].status, 'rejected');
  assert.deepEqual(toPublicPublicationProjection(rejected).items, {});
});

test('two provider-local identities mapped to one canonical human cannot satisfy four-eyes approval', async () => {
  const identity = await identityFixture();
  const secondVerifier = createFixtureIdpVerifier({
    provider: 'idp-two',
    purpose: 'creator-publication',
    receiptKey: 'independent-review-provider-two-key-material',
    clock: () => T0,
    ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: async assertion => assertion.code === 'alias'
      ? { subject: 'different-provider-alias', kind: 'human' }
      : null,
  });
  const aliasReceipt = await secondVerifier.issueReceipt({ code: 'alias' });
  identity.verifiers.push(secondVerifier);
  identity.canonical.set(`${secondVerifier.provider}:${aliasReceipt.subjectDigest}`, RIGHTS);

  const submission = createPublicationSubmission({
    ...binding(),
    submitterReceipt: identity.receipts.submitter,
    submittedAt: T0,
  }, trust(identity));
  const rights = review(submission, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const marketAlias = review(submission, aliasReceipt, 'market', 'approve', identity, T2);
  const projection = replayPublicationEvents([
    event('submission.created', submission, identity),
    event('review.recorded', rights, identity),
    event('review.recorded', marketAlias, identity),
  ], trust(identity, T2));

  const item = Object.values(projection.items)[0];
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.reviewGaps, ['independent_humans_required']);
  assert.deepEqual(toPublicPublicationProjection(projection).items, {});
});

test('lifecycle authorization receives product and release scope and may deny cross-product appeal', async () => {
  const identity = await identityFixture();
  let observed;
  assert.throws(() => createPublicationLifecycleEvent({
    action: 'appeal',
    productId: PROD,
    releaseId: REL,
    actorReceipt: identity.receipts.submitter,
    reason: 'attempt to appeal another Publisher item',
    appealOfEventId: `pubevt_${'9'.repeat(64)}`,
    occurredAt: T1,
  }, trust(identity, T1, {
    lifecycleActorResolver: context => {
      observed = context;
      return false;
    },
  })), error => error.code === 'LIFECYCLE_ACTOR_REQUIRED');
  assert.equal(observed.productId, PROD);
  assert.equal(observed.releaseId, REL);
  assert.equal(observed.action, 'appeal');
  assert.equal(observed.subjectDigest, SUBMITTER);
});

test('public projection removes a published item whose current binding becomes stale', async () => {
  const identity = await identityFixture();
  const submission = createPublicationSubmission({
    ...binding(),
    submitterReceipt: identity.receipts.submitter,
    submittedAt: T0,
  }, trust(identity));
  const rights = review(submission, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const market = review(submission, identity.receipts.market, 'market', 'approve', identity, T2);
  const approvalEvents = [
    event('submission.created', submission, identity),
    event('review.recorded', rights, identity),
    event('review.recorded', market, identity),
  ];
  const approved = replayPublicationEvents(approvalEvents, trust(identity, T2));
  const publish = createPublicationLifecycleEvent({
    action: 'publish',
    productId: PROD,
    releaseId: REL,
    submissionId: submission.submissionId,
    submissionDigest: submission.submissionDigest,
    actorReceipt: identity.receipts.market,
    reason: 'independent publication verification',
    occurredAt: T3,
  }, trust(identity, T3, {
    publicationItemResolver: () => Object.values(approved.items)[0],
  }));
  const published = replayPublicationEvents([
    ...approvalEvents,
    event('lifecycle.recorded', publish, identity),
  ], trust(identity, T3));

  assert.equal(Object.keys(toPublicPublicationProjection(published, {
    currentBindingResolver: () => binding(),
  }).items).length, 1);
  assert.deepEqual(toPublicPublicationProjection(published, {
    currentBindingResolver: () => binding({ marketRegistryRevision: `sha256:${'8'.repeat(64)}` }),
  }).items, {});
  assert.deepEqual(toPublicPublicationProjection(published).items, {});
});

test('private creator projection requires a trusted Publisher-scoped authorizer', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v44-independent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'creator.json');

  assert.throws(() => new CreatorWorkspaceStore(file).projectCreator({ publisherId: PUB }),
    error => error.code === 'CREATOR_PROJECTION_AUTHORITY_REQUIRED');
  assert.throws(() => new CreatorWorkspaceStore(file, {
    creatorProjectionAuthorizer: context => ({
      decision: 'allow',
      publisherId: context.publisherId.replace(/^pub_/, `pub_${'9'.repeat(64)}`).slice(0, 69),
    }),
  }).projectCreator({ publisherId: PUB }), error => error.code === 'CREATOR_PROJECTION_FORBIDDEN');

  const allowed = new CreatorWorkspaceStore(file, {
    creatorProjectionAuthorizer: context => ({ decision: 'allow', publisherId: context.publisherId }),
  }).projectCreator({ publisherId: PUB });
  assert.equal(allowed.publisherId, PUB);
  assert.deepEqual(allowed.works, []);
});

test('a stale current binding can never downgrade a sticky recall to ordinary withdrawal', async () => {
  const identity = await identityFixture();
  const submission = createPublicationSubmission({
    ...binding(),
    submitterReceipt: identity.receipts.submitter,
    submittedAt: T0,
  }, trust(identity));
  const rights = review(submission, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const market = review(submission, identity.receipts.market, 'market', 'approve', identity, T2);
  const approvalEvents = [
    event('submission.created', submission, identity),
    event('review.recorded', rights, identity),
    event('review.recorded', market, identity),
  ];
  const approved = replayPublicationEvents(approvalEvents, trust(identity, T2));
  const publish = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL,
    submissionId: submission.submissionId, submissionDigest: submission.submissionDigest,
    actorReceipt: identity.receipts.market, reason: 'publish', occurredAt: T3,
  }, trust(identity, T3, { publicationItemResolver: () => Object.values(approved.items)[0] }));
  const publishedEvents = [...approvalEvents, event('lifecycle.recorded', publish, identity)];
  const recall = createPublicationLifecycleEvent({
    action: 'recall', productId: PROD, releaseId: REL,
    actorReceipt: identity.receipts.market, reason: 'high-risk recall',
    riskCode: 'supply_chain_compromise', remediation: 'disable invocation and replace the release', occurredAt: T4,
  }, trust(identity, T4));
  const recalled = replayPublicationEvents([
    ...publishedEvents,
    event('lifecycle.recorded', recall, identity),
  ], trust(identity, T4));

  const stale = createPublicationResolver(recalled, {
    currentBindingResolver: () => binding({ draftDigest: `sha256:${'8'.repeat(64)}` }),
  });
  assert.equal(stale.resolveOrderProduct(PROD), null);
  assert.equal(stale.resolveOrderRelease(REL), null);
  assert.equal(stale.resolveAccessRelease(REL).status, 'recalled');
});

test('a new submission after recall cannot clear the sticky recall enforcement state', async () => {
  const identity = await identityFixture();
  const first = createPublicationSubmission({
    ...binding(), submitterReceipt: identity.receipts.submitter, submittedAt: T0,
  }, trust(identity));
  const rights = review(first, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const market = review(first, identity.receipts.market, 'market', 'approve', identity, T2);
  const approvedEvents = [
    event('submission.created', first, identity),
    event('review.recorded', rights, identity),
    event('review.recorded', market, identity),
  ];
  const approved = replayPublicationEvents(approvedEvents, trust(identity, T2));
  const publish = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL,
    submissionId: first.submissionId, submissionDigest: first.submissionDigest,
    actorReceipt: identity.receipts.market, reason: 'publish', occurredAt: T3,
  }, trust(identity, T3, { publicationItemResolver: () => Object.values(approved.items)[0] }));
  const recall = createPublicationLifecycleEvent({
    action: 'recall', productId: PROD, releaseId: REL,
    actorReceipt: identity.receipts.market, reason: 'high-risk recall',
    riskCode: 'supply_chain_compromise', remediation: 'replace the release', occurredAt: T4,
  }, trust(identity, T4));
  const recalledEvents = [
    ...approvedEvents,
    event('lifecycle.recorded', publish, identity),
    event('lifecycle.recorded', recall, identity),
  ];
  const secondBinding = binding({ draftRevision: 2, draftDigest: `sha256:${'7'.repeat(64)}` });
  const second = createPublicationSubmission({
    ...secondBinding,
    submitterReceipt: identity.receipts.submitter,
    submittedAt: '2026-08-14T05:00:00.000Z',
  }, trust(identity, '2026-08-14T05:00:00.000Z', {
    draftResolver: () => ({
      workId: WORK, publisherId: PUB, productId: PROD, draftRevision: 2,
      draftDigest: secondBinding.draftDigest, target: { releaseId: REL },
      rightsDeclaration: { statementVersion: 'rights-v1' },
    }),
  }));
  const afterResubmission = replayPublicationEvents([
    ...recalledEvents,
    event('submission.created', second, identity),
  ], trust(identity, '2026-08-14T05:00:00.000Z'));
  const item = Object.values(afterResubmission.items)[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.enforcementStatus, 'recalled');
  const resolver = createPublicationResolver(afterResubmission, {
    currentBindingResolver: () => secondBinding,
  });
  assert.equal(resolver.resolveAccessRelease(REL).status, 'recalled');
});

test('a pending resubmission blocks new orders without revoking a previously published access grant', async () => {
  const identity = await identityFixture();
  const first = createPublicationSubmission({
    ...binding(), submitterReceipt: identity.receipts.submitter, submittedAt: T0,
  }, trust(identity));
  const rights = review(first, identity.receipts.rights, 'rights', 'approve', identity, T1);
  const market = review(first, identity.receipts.market, 'market', 'approve', identity, T2);
  const approvalEvents = [
    event('submission.created', first, identity),
    event('review.recorded', rights, identity),
    event('review.recorded', market, identity),
  ];
  const approved = replayPublicationEvents(approvalEvents, trust(identity, T2));
  const publish = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL,
    submissionId: first.submissionId, submissionDigest: first.submissionDigest,
    actorReceipt: identity.receipts.market, reason: 'publish', occurredAt: T3,
  }, trust(identity, T3, { publicationItemResolver: () => Object.values(approved.items)[0] }));
  const secondBinding = binding({ draftRevision: 2, draftDigest: `sha256:${'7'.repeat(64)}` });
  const second = createPublicationSubmission({
    ...secondBinding, submitterReceipt: identity.receipts.submitter,
    submittedAt: T4,
  }, trust(identity, T4, {
    draftResolver: () => ({
      workId: WORK, publisherId: PUB, productId: PROD, draftRevision: 2,
      draftDigest: secondBinding.draftDigest, target: { releaseId: REL },
      rightsDeclaration: { statementVersion: 'rights-v1' },
    }),
  }));
  const pending = replayPublicationEvents([
    ...approvalEvents,
    event('lifecycle.recorded', publish, identity),
    event('submission.created', second, identity),
  ], trust(identity, T4));
  const resolver = createPublicationResolver(pending, {
    currentBindingResolver: () => secondBinding,
  });

  assert.equal(Object.values(pending.items)[0].status, 'pending');
  assert.equal(Object.values(pending.items)[0].enforcementStatus, 'published');
  assert.equal(resolver.resolveOrderProduct(PROD), null);
  assert.equal(resolver.resolveOrderRelease(REL), null);
  assert.equal(resolver.resolveAccessRelease(REL).status, 'published');
  assert.deepEqual(toPublicPublicationProjection(pending, {
    currentBindingResolver: () => secondBinding,
  }).items, {});
});
