import assert from 'node:assert/strict';
import test from 'node:test';

import { createCreatorWorkspace, createDraftRevision } from '../lib/creator/creator-workspace.mjs';
import {
  createPublicationLifecycleEvent,
  createPublicationResolver,
  createPublicationReview,
  createPublicationSubmission,
  replayPublicationEvents,
  toPublicPublicationProjection,
} from '../lib/creator/publication-workflow.mjs';
import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { decideAccess } from '../lib/commerce/access-decision.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { createPublisher, createSkillProduct } from '../lib/market/domain.mjs';
import { normalizeRelease, sourceId } from '../lib/registry-identity.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;
const TIMES = ['09:00', '09:05', '09:10', '09:15', '09:20', '09:25', '09:30', '09:35'];
const at = index => `2026-08-14T${TIMES[index]}:00.000Z`;

function releaseFixture() {
  return normalizeRelease({
    skillId: 'zaowuyun/research-synthesis', version: '1.0.0',
    package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('a')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: [D('c')], reviewRefs: [D('d')],
    sourceRefs: [sourceId('fixture', 'v44/research-synthesis')], publishedAt: at(0),
  });
}

function verifier(kind = 'human') {
  return createFixtureIdpVerifier({
    provider: 'fixture-idp', purpose: 'creator-publication', receiptKey: Buffer.alloc(32, 44),
    clock: () => at(0), ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: assertion => ({ subject: `fixture-${assertion.id}`, kind }),
  });
}

async function identityFixture() {
  const humanVerifier = verifier();
  const receipts = {};
  for (const id of ['publisher', 'rights', 'market', 'operator']) receipts[id] = await humanVerifier.issueReceipt({ id });
  const canonicalSubjects = new Map([
    [receipts.publisher.subjectDigest, D('1')],
    [receipts.rights.subjectDigest, D('2')],
    [receipts.market.subjectDigest, D('3')],
    [receipts.operator.subjectDigest, D('4')],
  ]);
  return {
    receipts,
    trust: {
      trustedProviderVerifiers: [humanVerifier],
      purpose: 'creator-publication',
      canonicalHumanResolver: ({ provider, subjectDigest }) => ({
        canonicalSubjectDigest: provider === 'fixture-idp' ? canonicalSubjects.get(subjectDigest) : null,
      }),
    },
  };
}

async function domainFixture() {
  const release = releaseFixture();
  const publisherVerifier = createFixtureIdpVerifier({
    provider: 'fixture-publisher-idp', purpose: 'market-publisher', receiptKey: Buffer.alloc(32, 45),
    clock: () => at(0), ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: () => ({ subject: 'zaowuyun-publisher', kind: 'service' }),
  });
  const publisherReceipt = await publisherVerifier.issueReceipt({ id: 'publisher' });
  const publisher = createPublisher({
    kind: 'organization', displayName: '造物云能力实验室', identityReceipt: publisherReceipt, createdAt: at(0),
  }, { trustedProviderVerifiers: [publisherVerifier], purpose: 'market-publisher', now: at(0) });
  const product = createSkillProduct({
    productKey: 'research-synthesis', publisherId: publisher.publisherId,
    titleZh: '研究综合技能', summaryZh: '将公开资料整理为可追溯的研究结论。',
    parties: { creatorPublisherIds: [publisher.publisherId], rightsHolderPublisherId: publisher.publisherId, payeePublisherId: null, supportPublisherId: null },
    skillId: release.skillId, releaseId: release.releaseId, createdAt: at(0),
  }, { registryRelease: release });
  const options = {
    resolvePublisher: () => publisher, resolveProduct: () => product, resolveRegistryRelease: () => release,
  };
  const workspace = createCreatorWorkspace({
    publisherId: publisher.publisherId, productId: product.productId, abilityType: 'skill',
    productKey: product.productKey, createdAt: at(0),
  }, options);
  const draft = createDraftRevision({
    workId: workspace.workId,
    metadata: { titleZh: '研究综合技能', summaryZh: '形成有来源的研究结论。', originalLanguage: 'zh-CN', titleOriginal: null, summaryOriginal: null },
    categoryTags: ['研究分析'], pricingIntent: { model: 'free', currency: 'CNY', amountMinor: 0 },
    supportInfo: { model: 'self_service', responseTimeText: null, supportRef: null },
    target: { skillId: release.skillId, releaseId: release.releaseId },
    rightsDeclaration: { licenseRef: 'license:creator-v1', declaredRights: ['invoke', 'organization_use'], sourceOwnership: 'original', evidenceRefs: ['evidence:rights-v1'], statementVersion: 'rights-v1' },
    savedAt: at(1),
  }, { workspace, ...options });
  return { publisher, product, release, workspace, draft };
}

function publicationOptions(domain, identity, now, extra = {}) {
  return {
    ...identity.trust, now: () => now,
    publisherRepresentativeResolver: () => true,
    reviewerRoleResolver: () => true,
    lifecycleActorResolver: () => true,
    draftResolver: () => domain.draft,
    productResolver: () => ({ productId: domain.product.productId, publisherId: domain.publisher.publisherId }),
    releaseResolver: () => ({ releaseId: domain.release.releaseId, productId: domain.product.productId }),
    marketRegistryRevisionResolver: () => D('9'),
    ...extra,
  };
}

function eventOptions(domain, identity, now, extra = {}) {
  return publicationOptions(domain, identity, now, extra);
}

test('Draft → Submit → two independent approvals → Publish → Withdraw/Recall is enforced', async () => {
  const domain = await domainFixture();
  const identity = await identityFixture();
  const submission = createPublicationSubmission({
    workId: domain.workspace.workId, publisherId: domain.publisher.publisherId, productId: domain.product.productId,
    releaseId: domain.release.releaseId, draftRevision: domain.draft.draftRevision, draftDigest: domain.draft.draftDigest,
    marketRegistryRevision: D('9'), licensePolicyDigest: D('e'), evidenceDigest: D('f'),
    declarationVersion: 'rights-v1', submitterReceipt: identity.receipts.publisher, submittedAt: at(2),
  }, publicationOptions(domain, identity, at(2)));
  const events = [];
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('submission.created', submission,
    eventOptions(domain, identity, at(2))));
  const review = (role, receipt, reviewedAt) => createPublicationReview({
    submissionId: submission.submissionId, submissionDigest: submission.submissionDigest, role, decision: 'approve',
    reason: `${role} 独立复核通过。`, evidenceDigest: submission.evidenceDigest, reviewerReceipt: receipt, reviewedAt,
  }, publicationOptions(domain, identity, reviewedAt, { submissionResolver: () => submission }));
  const rights = review('rights', identity.receipts.rights, at(3));
  const market = review('market', identity.receipts.market, at(4));
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('review.recorded', rights,
    eventOptions(domain, identity, at(3), { submissionResolver: () => submission })));
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('review.recorded', market,
    eventOptions(domain, identity, at(4), { submissionResolver: () => submission })));
  const replayOptions = eventOptions(domain, identity, at(4), { submissionResolver: () => submission });
  let projection = replayPublicationEvents(events, replayOptions);
  assert.equal(Object.values(projection.items)[0].status, 'approved');
  const lifecycle = (action, occurredAt, extra = {}) => createPublicationLifecycleEvent({
    action, productId: domain.product.productId, releaseId: domain.release.releaseId,
    actorReceipt: identity.receipts.operator, reason: `${action} lifecycle`, occurredAt, ...extra,
  }, publicationOptions(domain, identity, occurredAt, action === 'publish' ? {
    publicationItemResolver: () => Object.values(projection.items)[0],
    currentBindingResolver: () => submission,
  } : {}));
  const publish = lifecycle('publish', at(5), { submissionId: submission.submissionId, submissionDigest: submission.submissionDigest });
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('lifecycle.recorded', publish,
    eventOptions(domain, identity, at(5))));
  projection = replayPublicationEvents(events, replayOptions);
  assert.equal(Object.values(projection.items)[0].status, 'published');
  let resolver = createPublicationResolver(projection, { currentBindingResolver: () => ({ ...submission }) });
  assert.equal(resolver.resolveOrderProduct(domain.product.productId).status, 'published');
  const offer = createOffer({
    offerId: 'offer_v44_free', productId: domain.product.productId,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: { rights: ['invoke', 'organization_use'], constraints: { organizationIds: ['org_acme'], releaseIds: [domain.release.releaseId] } },
    effectiveAt: at(5),
  });
  const order = createFreeOrder({
    orderId: 'ord_v44_free', organizationId: 'org_acme', productId: domain.product.productId,
    releaseScope: { releaseIds: [domain.release.releaseId] }, offerRevisionId: offer.offerRevisionId,
    idempotencyKey: 'idem:v44:free',
  }, {
    offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }),
    productResolver: resolver.resolveOrderProduct, releaseResolver: resolver.resolveOrderRelease, now: () => at(5),
  });
  const entitlement = issueEntitlement({ order, issuedAt: at(5) });
  const accessRequest = {
    entitlementIds: [entitlement.entitlementId], organizationId: 'org_acme', productId: domain.product.productId,
    releaseId: domain.release.releaseId, requiredRights: ['invoke'],
  };
  const accessOptions = () => ({
    entitlementResolver: id => id === entitlement.entitlementId ? entitlement : null,
    releaseResolver: resolver.resolveAccessRelease, usageResolver: () => ({ invocations: 0 }),
    seatResolver: () => ({ seatCount: 1 }), now: () => at(7),
  });
  const withdraw = lifecycle('withdraw', at(6));
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('lifecycle.recorded', withdraw,
    eventOptions(domain, identity, at(6))));
  projection = replayPublicationEvents(events, replayOptions);
  resolver = createPublicationResolver(projection, { currentBindingResolver: () => ({ ...submission }) });
  assert.equal(resolver.resolveOrderProduct(domain.product.productId), null);
  assert.equal(resolver.resolveAccessRelease(domain.release.releaseId).status, 'withdrawn');
  assert.equal(decideAccess(accessRequest, accessOptions()).decision, 'allow');
  const recall = lifecycle('recall', at(7), { riskCode: 'security-risk', remediation: '升级到修复版本后重新复核。' });
  events.push((await import('../lib/creator/publication-workflow.mjs')).createPublicationEvent('lifecycle.recorded', recall,
    eventOptions(domain, identity, at(7))));
  projection = replayPublicationEvents(events, replayOptions);
  resolver = createPublicationResolver(projection, { currentBindingResolver: () => ({ ...submission }) });
  assert.equal(resolver.resolveAccessRelease(domain.release.releaseId).status, 'recalled');
  assert.equal(decideAccess(accessRequest, accessOptions()).code, 'RELEASE_RECALLED');
  const publicProjection = toPublicPublicationProjection(projection, {
    currentBindingResolver: () => ({ ...submission }),
  });
  assert.equal(Object.keys(publicProjection.items).length, 1);
  const serialized = JSON.stringify(publicProjection);
  for (const forbidden of ['receipt', 'subjectDigest', 'principalId', 'candidate', 'storageRef', 'prompt', 'output', 'token', 'secret']) assert.equal(serialized.includes(forbidden), false);
});
