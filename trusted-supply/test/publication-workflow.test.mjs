import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import {
  createPublicationEvent,
  createPublicationLifecycleEvent,
  createPublicationResolver,
  createPublicationReview,
  createPublicationSubmission,
  replayPublicationEvents,
  toPublicPublicationProjection,
} from '../lib/creator/publication-workflow.mjs';

const T0 = '2026-08-14T00:00:00.000Z';
const T1 = '2026-08-14T01:00:00.000Z';
const T2 = '2026-08-14T02:00:00.000Z';
const T3 = '2026-08-14T03:00:00.000Z';
const T4 = '2026-08-14T04:00:00.000Z';
const PUB = `pub_${'a'.repeat(64)}`;
const PROD = `prod_${'b'.repeat(64)}`;
const REL = `rel_${'c'.repeat(64)}`;
const WORK = `work_${'d'.repeat(64)}`;
const DRAFT = `sha256:${'e'.repeat(64)}`;
const REGISTRY = `sha256:${'f'.repeat(64)}`;
const LICENSE = `sha256:${'1'.repeat(64)}`;
const EVIDENCE = `sha256:${'2'.repeat(64)}`;
const KEY = 'publication-fixture-key-material-at-least-32-bytes';
const PERSON = name => `sha256:${({ submitter: '4', rights: '5', market: '6', advisor: '7' }[name]).repeat(64)}`;

async function identities() {
  const subjects = new Map([
    ['submitter-code', { subject: 'human:submitter', kind: 'human' }],
    ['rights-code', { subject: 'human:rights', kind: 'human' }],
    ['market-code', { subject: 'human:market', kind: 'human' }],
    ['same-code', { subject: 'human:rights', kind: 'human' }],
    ['agent-code', { subject: 'service:advisor', kind: 'service' }],
  ]);
  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-idp', purpose: 'creator-publication', receiptKey: KEY,
    clock: () => T0, ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: async assertion => subjects.get(assertion.code),
  });
  const receipt = code => verifier.issueReceipt({ code });
  const result = {
    verifier,
    submitter: await receipt('submitter-code'), rights: await receipt('rights-code'),
    market: await receipt('market-code'), same: await receipt('same-code'), agent: await receipt('agent-code'),
  };
  result.canonicalSubjects = new Map([
    [`fixture-idp:${result.submitter.subjectDigest}`, PERSON('submitter')],
    [`fixture-idp:${result.rights.subjectDigest}`, PERSON('rights')],
    [`fixture-idp:${result.same.subjectDigest}`, PERSON('rights')],
    [`fixture-idp:${result.market.subjectDigest}`, PERSON('market')],
    [`fixture-idp:${result.agent.subjectDigest}`, PERSON('advisor')],
  ]);
  return result;
}

function canonicalHuman(ids, { provider, subjectDigest }) {
  const mapping = ids.canonicalSubjects ?? new Map();
  return { canonicalSubjectDigest: mapping.get(`${provider}:${subjectDigest}`) ?? PERSON('advisor') };
}

function draft(overrides = {}) {
  return {
    workId: WORK, publisherId: PUB, productId: PROD, draftRevision: 1, draftDigest: DRAFT,
    target: { releaseId: REL }, rightsDeclaration: { statementVersion: 'rights-v1' }, ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    workId: WORK, publisherId: PUB, productId: PROD, releaseId: REL, draftRevision: 1,
    draftDigest: DRAFT, marketRegistryRevision: REGISTRY, licensePolicyDigest: LICENSE,
    evidenceDigest: EVIDENCE, declarationVersion: 'rights-v1', ...overrides,
  };
}

function trust(ids, now = T0, overrides = {}) {
  return {
    trustedProviderVerifiers: [ids.verifier], now: () => now,
    canonicalHumanResolver: input => canonicalHuman(ids, input),
    publisherRepresentativeResolver: ({ publisherId }) => publisherId === PUB,
    draftResolver: () => draft(),
    productResolver: () => ({ productId: PROD, publisherId: PUB }),
    releaseResolver: () => ({ releaseId: REL, productId: PROD }),
    marketRegistryRevisionResolver: () => REGISTRY,
    reviewerRoleResolver: () => true,
    lifecycleActorResolver: () => true,
    currentBindingResolver: () => binding(),
    ...overrides,
  };
}

function submissionInput(receipt, overrides = {}) {
  return { ...binding(), submitterReceipt: receipt, ...overrides };
}

function reviewInput(submission, receipt, role, decision = 'approve', overrides = {}) {
  return {
    submissionId: submission.submissionId, submissionDigest: submission.submissionDigest,
    role, decision, reason: `${role} review`, evidenceDigest: EVIDENCE, reviewerReceipt: receipt, ...overrides,
  };
}

function event(type, payload, ids) {
  return createPublicationEvent(type, payload, trust(ids, payload.submittedAt ?? payload.reviewedAt ?? payload.occurredAt));
}

test('Submission binds immutable Draft/Product/Release/MarketRegistry and a Publisher representative', async () => {
  const ids = await identities();
  const submitted = createPublicationSubmission(submissionInput(ids.submitter), trust(ids));
  assert.match(submitted.submissionId, /^sub_[a-f0-9]{64}$/);
  assert.equal(submitted.marketRegistryRevision, REGISTRY);
  assert.throws(() => createPublicationSubmission(submissionInput(ids.submitter), trust(ids, T0, {
    publisherRepresentativeResolver: () => false,
  })), error => error.code === 'PUBLISHER_REPRESENTATIVE_REQUIRED');
  assert.throws(() => createPublicationSubmission(submissionInput(ids.submitter), trust(ids, T0, {
    marketRegistryRevisionResolver: () => `sha256:${'9'.repeat(64)}`,
  })), error => error.code === 'MARKET_REGISTRY_REVISION_MISMATCH');
  assert.throws(() => createPublicationSubmission(submissionInput(ids.submitter), trust(ids, T0, {
    releaseResolver: () => ({ releaseId: REL, productId: `prod_${'8'.repeat(64)}` }),
  })), error => error.code === 'RELEASE_BINDING_MISMATCH');
});

test('rights and market require two distinct trusted humans; submitter, alias and Agent do not count', async () => {
  const ids = await identities();
  ids.canonicalSubjects = new Map([
    [`fixture-idp:${ids.submitter.subjectDigest}`, PERSON('submitter')],
    [`fixture-idp:${ids.rights.subjectDigest}`, PERSON('rights')],
    [`fixture-idp:${ids.same.subjectDigest}`, PERSON('rights')],
    [`fixture-idp:${ids.market.subjectDigest}`, PERSON('market')],
    [`fixture-idp:${ids.agent.subjectDigest}`, PERSON('advisor')],
  ]);
  const submitted = createPublicationSubmission(submissionInput(ids.submitter), trust(ids));
  assert.throws(() => createPublicationReview(reviewInput(submitted, ids.submitter, 'rights'), {
    ...trust(ids), submissionResolver: () => submitted,
  }), error => error.code === 'SUBMITTER_REVIEW_CONFLICT');
  const rights = createPublicationReview(reviewInput(submitted, ids.rights, 'rights'), {
    ...trust(ids, T1), submissionResolver: () => submitted,
  });
  const alias = createPublicationReview(reviewInput(submitted, ids.same, 'market'), {
    ...trust(ids, T2), submissionResolver: () => submitted,
  });
  const agent = createPublicationReview(reviewInput(submitted, ids.agent, 'market', undefined, {
    decision: 'advisory', recommendation: 'approve',
  }), { ...trust(ids, T2), submissionResolver: () => submitted });
  const sameHuman = replayPublicationEvents([event('submission.created', submitted, ids), event('review.recorded', rights, ids), event('review.recorded', alias, ids), event('review.recorded', agent, ids)], trust(ids, T2));
  const item = Object.values(sameHuman.items)[0];
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.reviewGaps, ['independent_humans_required']);

  const market = createPublicationReview(reviewInput(submitted, ids.market, 'market'), {
    ...trust(ids, T2), submissionResolver: () => submitted,
  });
  const approved = replayPublicationEvents([event('submission.created', submitted, ids), event('review.recorded', rights, ids), event('review.recorded', market, ids)], trust(ids, T2));
  assert.equal(Object.values(approved.items)[0].status, 'approved');
});

test('two trusted IdPs cannot make one canonical human satisfy four-eyes', async () => {
  const ids = await identities();
  ids.canonicalSubjects = new Map([
    [`fixture-idp:${ids.submitter.subjectDigest}`, PERSON('submitter')],
    [`fixture-idp:${ids.rights.subjectDigest}`, PERSON('rights')],
  ]);
  const second = createFixtureIdpVerifier({
    provider: 'second-idp', purpose: 'creator-publication', receiptKey: `${KEY}-second`, clock: () => T0,
    ttlMs: 24 * 60 * 60 * 1_000, assertionVerifier: async () => ({ subject: 'alias-at-second-idp', kind: 'human' }),
  });
  const secondReceipt = await second.issueReceipt({ code: 'alias' });
  ids.canonicalSubjects.set(`second-idp:${secondReceipt.subjectDigest}`, PERSON('rights'));
  const trustedProviderVerifiers = [ids.verifier, second];
  const submitted = createPublicationSubmission(submissionInput(ids.submitter), trust(ids, T0, { trustedProviderVerifiers }));
  const rights = createPublicationReview(reviewInput(submitted, ids.rights, 'rights'), {
    ...trust(ids, T1, { trustedProviderVerifiers }), submissionResolver: () => submitted,
  });
  const marketAlias = createPublicationReview(reviewInput(submitted, secondReceipt, 'market'), {
    ...trust(ids, T2, { trustedProviderVerifiers }), submissionResolver: () => submitted,
  });
  const projection = replayPublicationEvents([
    event('submission.created', submitted, { ...ids, verifier: ids.verifier }),
    createPublicationEvent('review.recorded', rights, trust(ids, T1, { trustedProviderVerifiers })),
    createPublicationEvent('review.recorded', marketAlias, trust(ids, T2, { trustedProviderVerifiers })),
  ], trust(ids, T2, { trustedProviderVerifiers }));
  assert.equal(Object.values(projection.items)[0].status, 'pending');
  assert.deepEqual(Object.values(projection.items)[0].reviewGaps, ['independent_humans_required']);
});

test('canonical human capability is mandatory and must return a digest', async () => {
  const ids = await identities();
  assert.throws(() => createPublicationSubmission(submissionInput(ids.submitter), {
    ...trust(ids), canonicalHumanResolver: undefined,
  }), error => error.code === 'TRUSTED_CAPABILITY_REQUIRED');
  assert.throws(() => createPublicationSubmission(submissionInput(ids.submitter), {
    ...trust(ids), canonicalHumanResolver: () => ({ canonicalSubjectDigest: 'local-user' }),
  }), error => error.code === 'CANONICAL_HUMAN_REQUIRED');
});

test('lifecycle authorization is scoped to Product and Release for every action', async () => {
  const ids = await identities();
  const contexts = [];
  const scopedTrust = now => trust(ids, now, {
    lifecycleActorResolver: context => {
      contexts.push(context);
      return context.productId === PROD && context.releaseId === REL;
    },
  });
  assert.doesNotThrow(() => createPublicationLifecycleEvent({
    action: 'withdraw', productId: PROD, releaseId: REL, actorReceipt: ids.market, reason: 'scoped action',
  }, scopedTrust(T3)));
  assert.deepEqual(contexts[0], {
    principalId: `human:${PERSON('market').slice(7)}`, subjectDigest: PERSON('market'), action: 'withdraw',
    productId: PROD, releaseId: REL, at: T3,
  });
  assert.throws(() => createPublicationLifecycleEvent({
    action: 'appeal', productId: `prod_${'9'.repeat(64)}`, releaseId: REL,
    actorReceipt: ids.submitter, reason: 'other product appeal', appealOfEventId: `pubevt_${'8'.repeat(64)}`,
  }, scopedTrust(T4)), error => error.code === 'LIFECYCLE_ACTOR_REQUIRED');
});

test('public projection excludes never-published pending, approved, rejected and changes-requested items', async () => {
  const ids = await identities();
  const submitted = createPublicationSubmission(submissionInput(ids.submitter), trust(ids));
  const submissionEvent = event('submission.created', submitted, ids);
  const pending = replayPublicationEvents([submissionEvent], trust(ids));
  assert.equal(Object.keys(toPublicPublicationProjection(pending, { currentBindingResolver: () => binding() }).items).length, 0);

  const rights = createPublicationReview(reviewInput(submitted, ids.rights, 'rights'), { ...trust(ids, T1), submissionResolver: () => submitted });
  const market = createPublicationReview(reviewInput(submitted, ids.market, 'market'), { ...trust(ids, T2), submissionResolver: () => submitted });
  const approved = replayPublicationEvents([submissionEvent, event('review.recorded', rights, ids), event('review.recorded', market, ids)], trust(ids, T2));
  assert.equal(Object.keys(toPublicPublicationProjection(approved, { currentBindingResolver: () => binding() }).items).length, 0);

  const rejected = createPublicationReview(reviewInput(submitted, ids.rights, 'rights', 'reject'), { ...trust(ids, T1), submissionResolver: () => submitted });
  assert.equal(Object.keys(toPublicPublicationProjection(replayPublicationEvents([submissionEvent, event('review.recorded', rejected, ids)], trust(ids, T1)), { currentBindingResolver: () => binding() }).items).length, 0);
  const changes = createPublicationReview(reviewInput(submitted, ids.rights, 'rights', 'request_changes'), { ...trust(ids, T1), submissionResolver: () => submitted });
  assert.equal(Object.keys(toPublicPublicationProjection(replayPublicationEvents([submissionEvent, event('review.recorded', changes, ids)], trust(ids, T1)), { currentBindingResolver: () => binding() }).items).length, 0);
});

test('request_changes closes old Submission and a new Draft gets no inherited approvals', async () => {
  const ids = await identities();
  const first = createPublicationSubmission(submissionInput(ids.submitter), trust(ids));
  const blocked = createPublicationReview(reviewInput(first, ids.rights, 'rights', 'request_changes'), {
    ...trust(ids, T1), submissionResolver: () => first,
  });
  const revisedDigest = `sha256:${'3'.repeat(64)}`;
  const second = createPublicationSubmission(submissionInput(ids.submitter, { draftRevision: 2, draftDigest: revisedDigest }), trust(ids, T2, {
    draftResolver: () => draft({ draftRevision: 2, draftDigest: revisedDigest }),
  }));
  const projection = replayPublicationEvents([event('submission.created', first, ids), event('review.recorded', blocked, ids), event('submission.created', second, ids)], trust(ids, T2));
  const item = Object.values(projection.items)[0];
  assert.equal(item.submission.submissionId, second.submissionId);
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.reviewGaps, ['rights_approval_required', 'market_approval_required']);
});

async function approvedScenario() {
  const ids = await identities();
  const submitted = createPublicationSubmission(submissionInput(ids.submitter), trust(ids));
  const rights = createPublicationReview(reviewInput(submitted, ids.rights, 'rights'), { ...trust(ids, T1), submissionResolver: () => submitted });
  const market = createPublicationReview(reviewInput(submitted, ids.market, 'market'), { ...trust(ids, T2), submissionResolver: () => submitted });
  const approvalEvents = [event('submission.created', submitted, ids), event('review.recorded', rights, ids), event('review.recorded', market, ids)];
  const approved = replayPublicationEvents(approvalEvents, trust(ids, T2));
  return { ids, submitted, approvalEvents, approved };
}

test('publish consumes current approvals; withdraw preserves Access while recall blocks Access; appeal never restores', async () => {
  const { ids, submitted, approvalEvents, approved } = await approvedScenario();
  const publishedEvent = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL, submissionId: submitted.submissionId,
    submissionDigest: submitted.submissionDigest, actorReceipt: ids.market, reason: 'publish',
  }, { ...trust(ids, T3), publicationItemResolver: () => Object.values(approved.items)[0] });
  const publishedEvents = [...approvalEvents, event('lifecycle.recorded', publishedEvent, ids)];
  const published = replayPublicationEvents(publishedEvents, trust(ids, T3));
  assert.equal(createPublicationResolver(published, { currentBindingResolver: () => binding() }).resolveOrderRelease(REL).status, 'published');

  const withdraw = createPublicationLifecycleEvent({
    action: 'withdraw', productId: PROD, releaseId: REL, actorReceipt: ids.market, reason: 'ordinary withdrawal',
  }, trust(ids, T4));
  const withdrawnEvents = [...publishedEvents, event('lifecycle.recorded', withdraw, ids)];
  const withdrawn = replayPublicationEvents(withdrawnEvents, trust(ids, T4));
  const withdrawnResolver = createPublicationResolver(withdrawn, { currentBindingResolver: () => binding() });
  assert.equal(withdrawnResolver.resolveOrderRelease(REL), null);
  assert.equal(withdrawnResolver.resolveAccessRelease(REL).status, 'withdrawn');

  const recall = createPublicationLifecycleEvent({
    action: 'recall', productId: PROD, releaseId: REL, actorReceipt: ids.market,
    reason: 'high risk', riskCode: 'supply_chain_compromise', remediation: 'rollback to prior release', occurredAt: '2026-08-14T05:00:00.000Z',
  }, trust(ids, '2026-08-14T05:00:00.000Z'));
  const recalledEvents = [...withdrawnEvents, event('lifecycle.recorded', recall, ids)];
  const recalled = replayPublicationEvents(recalledEvents, trust(ids, '2026-08-14T05:00:00.000Z'));
  assert.equal(createPublicationResolver(recalled, { currentBindingResolver: () => binding() }).resolveAccessRelease(REL).status, 'recalled');
  assert.equal(createPublicationResolver(recalled, {
    currentBindingResolver: () => binding({ evidenceDigest: `sha256:${'9'.repeat(64)}` }),
  }).resolveAccessRelease(REL).status, 'recalled');

  const recallEventId = recalledEvents.at(-1).eventId;
  const appeal = createPublicationLifecycleEvent({
    action: 'appeal', productId: PROD, releaseId: REL, actorReceipt: ids.submitter,
    reason: 'request human reconsideration', appealOfEventId: recallEventId, occurredAt: '2026-08-14T06:00:00.000Z',
  }, trust(ids, '2026-08-14T06:00:00.000Z'));
  const appealed = replayPublicationEvents([...recalledEvents, event('lifecycle.recorded', appeal, ids)], trust(ids, '2026-08-14T06:00:00.000Z'));
  const item = Object.values(appealed.items)[0];
  assert.equal(item.status, 'appealed');
  assert.equal(item.enforcementStatus, 'recalled');
  assert.equal(createPublicationResolver(appealed, { currentBindingResolver: () => binding() }).resolveAccessRelease(REL).status, 'recalled');
  assert.doesNotMatch(JSON.stringify(toPublicPublicationProjection(appealed, { currentBindingResolver: () => binding() })), /receipt|subjectDigest|principalId|token|secret/i);
  assert.equal(Object.keys(toPublicPublicationProjection(appealed, {
    currentBindingResolver: () => binding({ marketRegistryRevision: `sha256:${'9'.repeat(64)}` }),
  }).items).length, 0);
});

test('stale current binding blocks publish and resolver fails closed', async () => {
  const { ids, submitted, approved } = await approvedScenario();
  assert.throws(() => createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL, submissionId: submitted.submissionId,
    submissionDigest: submitted.submissionDigest, actorReceipt: ids.market, reason: 'publish',
  }, {
    ...trust(ids, T3), publicationItemResolver: () => Object.values(approved.items)[0],
    currentBindingResolver: () => binding({ marketRegistryRevision: `sha256:${'9'.repeat(64)}` }),
  }), error => error.code === 'SUBMISSION_STALE');
});

test('new Submission never changes published or recalled enforcement state', async () => {
  const { ids, submitted, approvalEvents, approved } = await approvedScenario();
  const publish = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL, submissionId: submitted.submissionId,
    submissionDigest: submitted.submissionDigest, actorReceipt: ids.market, reason: 'publish',
  }, { ...trust(ids, T3), publicationItemResolver: () => Object.values(approved.items)[0] });
  const publishedEvents = [...approvalEvents, event('lifecycle.recorded', publish, ids)];

  const secondDigest = `sha256:${'8'.repeat(64)}`;
  const secondBinding = binding({ draftRevision: 2, draftDigest: secondDigest });
  const second = createPublicationSubmission(submissionInput(ids.submitter, {
    draftRevision: 2, draftDigest: secondDigest,
  }), trust(ids, T4, { draftResolver: () => draft({ draftRevision: 2, draftDigest: secondDigest }) }));
  const pendingPublished = replayPublicationEvents([...publishedEvents, event('submission.created', second, ids)], trust(ids, T4));
  const publishedItem = Object.values(pendingPublished.items)[0];
  assert.equal(publishedItem.status, 'pending');
  assert.equal(publishedItem.enforcementStatus, 'published');
  const publishedResolver = createPublicationResolver(pendingPublished, { currentBindingResolver: () => secondBinding });
  assert.equal(publishedResolver.resolveOrderProduct(PROD), null);
  assert.equal(publishedResolver.resolveOrderRelease(REL), null);
  assert.equal(publishedResolver.resolveAccessRelease(REL).status, 'published');

  const secondRights = createPublicationReview(reviewInput(second, ids.rights, 'rights'), {
    ...trust(ids, '2026-08-14T04:10:00.000Z'), submissionResolver: () => second,
  });
  const secondMarket = createPublicationReview(reviewInput(second, ids.market, 'market'), {
    ...trust(ids, '2026-08-14T04:20:00.000Z'), submissionResolver: () => second,
  });
  const reapprovedEvents = [
    ...publishedEvents, event('submission.created', second, ids),
    event('review.recorded', secondRights, ids), event('review.recorded', secondMarket, ids),
  ];
  const reapproved = replayPublicationEvents(reapprovedEvents, trust(ids, '2026-08-14T04:20:00.000Z'));
  const reapprovedResolver = createPublicationResolver(reapproved, { currentBindingResolver: () => secondBinding });
  assert.equal(Object.values(reapproved.items)[0].status, 'approved');
  assert.equal(reapprovedResolver.resolveOrderRelease(REL), null);
  assert.equal(reapprovedResolver.resolveAccessRelease(REL).status, 'published');
  const republish = createPublicationLifecycleEvent({
    action: 'publish', productId: PROD, releaseId: REL, submissionId: second.submissionId,
    submissionDigest: second.submissionDigest, actorReceipt: ids.market, reason: 'republish approved revision',
    occurredAt: '2026-08-14T04:30:00.000Z',
  }, {
    ...trust(ids, '2026-08-14T04:30:00.000Z'), publicationItemResolver: () => Object.values(reapproved.items)[0],
    currentBindingResolver: () => secondBinding,
  });
  const republished = replayPublicationEvents([...reapprovedEvents, event('lifecycle.recorded', republish, ids)], trust(ids, '2026-08-14T04:30:00.000Z'));
  assert.equal(createPublicationResolver(republished, { currentBindingResolver: () => secondBinding }).resolveOrderRelease(REL).status, 'published');

  const recall = createPublicationLifecycleEvent({
    action: 'recall', productId: PROD, releaseId: REL, actorReceipt: ids.market,
    reason: 'high risk', riskCode: 'supply_chain_compromise', remediation: 'rollback',
    occurredAt: '2026-08-14T05:00:00.000Z',
  }, trust(ids, '2026-08-14T05:00:00.000Z'));
  const recalledEvents = [...publishedEvents, event('lifecycle.recorded', recall, ids)];
  const thirdDigest = `sha256:${'a'.repeat(64)}`;
  const third = createPublicationSubmission(submissionInput(ids.submitter, {
    draftRevision: 3, draftDigest: thirdDigest,
  }), trust(ids, '2026-08-14T06:00:00.000Z', {
    draftResolver: () => draft({ draftRevision: 3, draftDigest: thirdDigest }),
  }));
  const pendingRecalled = replayPublicationEvents([...recalledEvents, event('submission.created', third, ids)], trust(ids, '2026-08-14T06:00:00.000Z'));
  const recalledItem = Object.values(pendingRecalled.items)[0];
  assert.equal(recalledItem.status, 'pending');
  assert.equal(recalledItem.enforcementStatus, 'recalled');
  assert.equal(createPublicationResolver(pendingRecalled, {
    currentBindingResolver: () => binding({ draftRevision: 3, draftDigest: thirdDigest }),
  }).resolveAccessRelease(REL).status, 'recalled');
  assert.equal(createPublicationResolver(pendingRecalled, {
    currentBindingResolver: () => binding({ evidenceDigest: `sha256:${'9'.repeat(64)}` }),
  }).resolveAccessRelease(REL).status, 'recalled');
});
