import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideAccess } from '../lib/commerce/access-decision.mjs';
import { createDerivativeLineage } from '../lib/commerce/derivative-lineage.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { createOffer, reviseOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { createEntitlementRevocation } from '../lib/commerce/lifecycle.mjs';
import { createMarketEvent, MarketLedger } from '../lib/commerce/market-ledger.mjs';
import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { normalizeRelease, sourceId } from '../lib/registry-identity.mjs';
import { MarketRegistry } from '../lib/market/market-registry.mjs';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFER_FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures/v43-market/free-offer.json'), 'utf8'));
const NOW = '2026-08-14T09:05:00.000Z';
const D = letter => `sha256:${letter.repeat(64)}`;

async function marketApi() {
  return import('../lib/market/domain.mjs');
}

function registryRelease() {
  return normalizeRelease({
    skillId: 'zaowuyun/research-synthesis',
    version: '1.0.0',
    package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('a')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: [D('c')],
    reviewRefs: [D('d')],
    sourceRefs: [sourceId('fixture', 'v43/research-synthesis')],
    publishedAt: '2026-08-14T08:00:00.000Z',
  });
}

async function publisherFixture() {
  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-idp', purpose: 'market-publisher', receiptKey: Buffer.alloc(32, 43),
    clock: () => '2026-08-14T08:00:00.000Z', ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: assertion => {
      if (assertion.fixtureId !== 'zaowuyun') throw new Error('unknown publisher');
      return { subject: 'fixture-publisher-zaowuyun', kind: 'service' };
    },
  });
  return {
    receipt: await verifier.issueReceipt({ fixtureId: 'zaowuyun' }),
    trust: { trustedProviderVerifiers: [verifier], purpose: 'market-publisher', now: NOW },
  };
}

async function marketFixture() {
  const api = await marketApi();
  const release = registryRelease();
  const identity = await publisherFixture();
  const publisher = api.createPublisher({
    kind: 'organization', displayName: '造物云创作者', identityReceipt: identity.receipt,
    createdAt: '2026-08-14T08:05:00.000Z',
  }, identity.trust);
  const parties = {
    creatorPublisherIds: [publisher.publisherId], rightsHolderPublisherId: publisher.publisherId,
    payeePublisherId: null, supportPublisherId: null,
  };
  const product = api.createSkillProduct({
    productKey: 'research-synthesis', publisherId: publisher.publisherId,
    titleZh: '研究综合技能', summaryZh: '用于整理、分析并综合企业研究资料。',
    parties, skillId: release.skillId, releaseId: release.releaseId,
    createdAt: '2026-08-14T08:10:00.000Z',
  }, { registryRelease: release });
  return { api, publisher, product, release, parties };
}

function commerceFixture(product, release, overrides = {}) {
  const licensePolicy = structuredClone(OFFER_FIXTURE.licensePolicy);
  licensePolicy.constraints.releaseIds = [release.releaseId];
  Object.assign(licensePolicy.constraints, overrides.constraints ?? {});
  if (overrides.rights) licensePolicy.rights = overrides.rights;
  const offer = createOffer({
    offerId: OFFER_FIXTURE.offerId, productId: product.productId,
    pricing: OFFER_FIXTURE.pricing, licensePolicy, effectiveAt: OFFER_FIXTURE.effectiveAt,
  });
  const order = createFreeOrder({
    orderId: 'ord_free_001', organizationId: 'org_acme', productId: product.productId,
    releaseScope: { releaseIds: [release.releaseId] }, offerRevisionId: offer.offerRevisionId,
    idempotencyKey: 'idem:free:001',
  }, {
    offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }),
    productResolver: productId => ({ productId, status: 'published' }),
    releaseResolver: releaseId => ({ releaseId, productId: product.productId, status: 'published' }),
    now: () => NOW,
  });
  const entitlement = issueEntitlement({ order, issuedAt: NOW });
  return { offer, order, entitlement };
}

function accessInput(product, release, entitlement, overrides = {}) {
  return {
    entitlementIds: entitlement ? [entitlement.entitlementId] : [], organizationId: 'org_acme',
    productId: product.productId, releaseId: release.releaseId, requiredRights: ['invoke'],
    projectId: 'project_alpha', environment: 'production', ...overrides,
  };
}

function accessOptions(entitlement, overrides = {}) {
  return {
    entitlementResolver: id => entitlement && id === entitlement.entitlementId ? entitlement : null,
    releaseResolver: releaseId => ({ releaseId, status: 'published' }),
    usageResolver: () => ({ invocations: 0 }),
    seatResolver: () => ({ seatCount: 1 }),
    now: () => NOW,
    ...overrides,
  };
}

function assertDenied(input, code, entitlement, options = {}) {
  const decision = decideAccess(input, accessOptions(entitlement, options));
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.code, code);
  assert.deepEqual(decision.grantedRights, []);
}

test('publisher → canonical Skill Product → free Offer/Order → Entitlement → allow', async () => {
  const { publisher, product, release } = await marketFixture();
  const { offer, order, entitlement } = commerceFixture(product, release);
  assert.match(publisher.publisherId, /^pub_[a-f0-9]{64}$/);
  assert.match(product.productId, /^prod_[a-f0-9]{64}$/);
  assert.equal(product.skillId, release.skillId);
  assert.equal(product.releaseId, release.releaseId);
  assert.equal(offer.pricing.model, 'free');
  assert.equal(order.offerRevisionId, offer.offerRevisionId);
  assert.equal(entitlement.sourceOrderDigest, order.orderDigest);
  const decision = decideAccess(accessInput(product, release, entitlement), accessOptions(entitlement));
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.entitlementId, entitlement.entitlementId);
});

test('access fails closed without entitlement and on every scoped constraint', async () => {
  const { product, release } = await marketFixture();
  const { entitlement } = commerceFixture(product, release);
  assertDenied(accessInput(product, release, null), 'NO_ENTITLEMENT', null);
  assertDenied(accessInput(product, release, entitlement, { organizationId: 'org_other' }), 'NO_ENTITLEMENT', entitlement);
  assertDenied(accessInput(product, release, entitlement, { productId: `prod_${'f'.repeat(64)}` }), 'NO_ENTITLEMENT', entitlement);
  assertDenied(accessInput(product, release, entitlement, { projectId: 'project_other' }), 'PROJECT_NOT_GRANTED', entitlement);
  assertDenied(accessInput(product, release, entitlement, { environment: 'staging' }), 'ENVIRONMENT_NOT_GRANTED', entitlement);
  assertDenied(accessInput(product, release, entitlement, { releaseId: `rel_${'f'.repeat(64)}` }), 'RELEASE_NOT_GRANTED', entitlement);
  assertDenied(accessInput(product, release, entitlement, { requiredRights: ['modify'] }), 'RIGHT_MISSING', entitlement);
  assertDenied(accessInput(product, release, entitlement), 'INVOCATION_LIMIT_EXCEEDED', entitlement, { usageResolver: () => ({ invocations: 2 }) });
  assertDenied(accessInput(product, release, entitlement), 'SEAT_LIMIT_EXCEEDED', entitlement, { seatResolver: () => ({ seatCount: 4 }) });
  assertDenied(accessInput(product, release, entitlement), 'EXPIRED', entitlement, { now: () => '2026-09-14T09:00:00.000Z' });
});

test('ordinary withdrawal keeps an existing entitlement usable while high-risk recall blocks it', async () => {
  const { product, release } = await marketFixture();
  const { entitlement } = commerceFixture(product, release);
  assert.equal(decideAccess(accessInput(product, release, entitlement), accessOptions(entitlement, {
    releaseResolver: releaseId => ({ releaseId, status: 'withdrawn' }),
  })).decision, 'allow');
  assertDenied(accessInput(product, release, entitlement), 'RELEASE_RECALLED', entitlement, {
    releaseResolver: releaseId => ({ releaseId, status: 'recalled' }),
  });
});

test('historical Order and Entitlement keep the original Offer terms after a revision', async () => {
  const { product, release } = await marketFixture();
  const { offer, order, entitlement } = commerceFixture(product, release);
  const revised = reviseOffer(offer, {
    effectiveAt: '2026-08-15T09:00:00.000Z',
    licensePolicy: { rights: ['organization_use'], constraints: { releaseIds: [release.releaseId] } },
  });
  assert.notEqual(revised.offerRevisionId, offer.offerRevisionId);
  assert.deepEqual(order.licensePolicySnapshot.rights, ['derive', 'invoke', 'organization_use']);
  assert.equal(entitlement.rights.includes('invoke'), true);
});

test('Application BOM fails closed when a required dependency lacks authorization', async () => {
  const { api, publisher, product, release, parties } = await marketFixture();
  const application = api.createApplicationProduct({
    productKey: 'research-workbench', publisherId: publisher.publisherId,
    titleZh: '企业研究应用', summaryZh: '组合研究技能完成企业报告。', parties,
    createdAt: '2026-08-14T08:20:00.000Z',
  });
  const applicationRelease = api.createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0',
    bom: [{ productId: product.productId, skillId: release.skillId, releaseId: release.releaseId,
      requirement: 'required', requiredRights: ['invoke', 'organization_use'] }],
    publishedAt: '2026-08-14T08:30:00.000Z',
  }, { applicationProduct: application, resolveRegistryRelease: () => release, resolveSkillProduct: () => product });
  assert.throws(() => api.assertApplicationBomAuthorized(applicationRelease, {
    authorizeDependency: dependency => ({
      schemaVersion: 1, decision: 'deny', code: 'NO_ENTITLEMENT', entitlementId: null,
      organizationId: 'org_acme', productId: dependency.productId, releaseId: dependency.releaseId,
      grantedRights: [], checkedAt: NOW,
    }),
    organizationId: 'org_acme', checkedAt: NOW,
  }), error => error.code === 'BOM_DEPENDENCY_UNAUTHORIZED');
  assert.doesNotThrow(() => api.assertApplicationBomAuthorized(applicationRelease, {
    authorizeDependency: dependency => ({
      schemaVersion: 1, decision: 'allow', code: 'ACCESS_ALLOWED',
      entitlementId: `ent_${'a'.repeat(64)}`, organizationId: 'org_acme',
      productId: dependency.productId, releaseId: dependency.releaseId,
      grantedRights: dependency.requiredRights, checkedAt: NOW,
    }),
    organizationId: 'org_acme', checkedAt: NOW,
  }));
});

test('enterprise derivative requires derive right and records immutable lineage evidence', async () => {
  const { product, release } = await marketFixture();
  const denied = commerceFixture(product, release, { rights: ['invoke', 'organization_use'] });
  assertDenied(accessInput(product, release, denied.entitlement, { requiredRights: ['derive'] }), 'RIGHT_MISSING', denied.entitlement);
  const allowed = commerceFixture(product, release);
  const decision = decideAccess(accessInput(product, release, allowed.entitlement, { requiredRights: ['derive'] }), accessOptions(allowed.entitlement));
  assert.equal(decision.decision, 'allow');
  const lineage = createDerivativeLineage({
    entitlementId: allowed.entitlement.entitlementId,
    baseReleaseId: release.releaseId,
    derivativeProductId: `prod_${'e'.repeat(64)}`,
  }, { entitlementResolver: () => allowed.entitlement, now: () => NOW });
  assert.match(lineage.baseReleaseId, /^rel_[a-f0-9]{64}$/);
  assert.match(lineage.entitlementId, /^ent_[a-f0-9]{64}$/);
  assert.match(lineage.lineageDigest, /^sha256:[a-f0-9]{64}$/);
});

test('Candidate identities and sensitive fields are rejected or absent from public market values', async () => {
  const { api, product } = await marketFixture();
  assert.throws(() => api.createSkillProduct({
    productKey: 'candidate-leak', publisherId: product.publisherId,
    titleZh: '非法候选商品', summaryZh: '不得把候选身份暴露为市场商品。', parties: product.parties,
    skillId: 'cand_bad/skill', releaseId: `rel_${'a'.repeat(64)}`, createdAt: NOW,
  }, { registryRelease: { skillId: 'cand_bad/skill', releaseId: `rel_${'a'.repeat(64)}` } }), error => error.code === 'CANDIDATE_ID_FORBIDDEN');
  assert.throws(() => api.toPublicMarketValue({
    product, candidateId: 'cand_private', localPath: '/private/cas/package',
    identityReceipt: { subjectDigest: D('a') }, enterpriseContent: '机密正文',
    prompt: '秘密提示词', output: '完整输出', token: 'secret-token', apiKey: 'secret-key',
  }), error => error.code === 'PRIVATE_VALUE');
  const serialized = JSON.stringify(api.toPublicMarketValue(product));
  for (const forbidden of ['cand_', '/private/', 'subjectDigest', '机密正文', '秘密提示词', '完整输出', 'secret-token', 'secret-key']) assert.equal(serialized.includes(forbidden), false);
});

test('same idempotency key is stable for the same request and conflicts with different request evidence', async () => {
  const { product, release } = await marketFixture();
  const { offer, order } = commerceFixture(product, release);
  const resolvers = {
    offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }),
    productResolver: productId => ({ productId, status: 'published' }),
    releaseResolver: releaseId => ({ releaseId, productId: product.productId, status: 'published' }),
    now: () => order.orderedAt,
  };
  const replay = createFreeOrder({
    orderId: order.orderId, organizationId: order.organizationId, productId: order.productId,
    releaseScope: order.releaseScope, offerRevisionId: offer.offerRevisionId, idempotencyKey: order.idempotencyKey,
  }, resolvers);
  assert.equal(replay.requestDigest, order.requestDigest);
  const conflict = createFreeOrder({
    orderId: 'ord_free_conflict', organizationId: order.organizationId, productId: order.productId,
    releaseScope: order.releaseScope, offerRevisionId: offer.offerRevisionId, idempotencyKey: order.idempotencyKey,
  }, resolvers);
  assert.notEqual(conflict.requestDigest, order.requestDigest);
});

test('ledger revocation removes the trusted Entitlement from subsequent access decisions', async () => {
  const { product, release } = await marketFixture();
  const { order, entitlement } = commerceFixture(product, release);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-e2e-'));
  const ledger = new MarketLedger(path.join(root, 'ledger.json'));
  let state = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: NOW, payload: order }), { expectedRevision: ledger.read().revision });
  state = ledger.append(createMarketEvent({ type: 'entitlement.issued', occurredAt: NOW, payload: entitlement }), { expectedRevision: state.revision });
  const trusted = accessOptions(entitlement, { entitlementResolver: id => ledger.resolveEntitlement(id) });
  assert.equal(decideAccess(accessInput(product, release, entitlement), trusted).decision, 'allow');
  const revocation = createEntitlementRevocation({ entitlement, reasonCode: 'security_recall', revokedAt: NOW });
  ledger.append(createMarketEvent({ type: 'entitlement.revoked', occurredAt: NOW, payload: revocation }), { expectedRevision: state.revision });
  assert.equal(decideAccess(accessInput(product, release, entitlement), trusted).code, 'NO_ENTITLEMENT');
});

test('trusted MarketRegistry Product↔Release binding drives free Order creation', async () => {
  const { publisher, product, release } = await marketFixture();
  const identity = await publisherFixture();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-registry-e2e-'));
  const registry = new MarketRegistry(path.join(root, 'registry.json'));
  const registeredPublisher = registry.registerPublisher({
    kind: 'organization', displayName: '造物云创作者', identityReceipt: identity.receipt,
    createdAt: '2026-08-14T08:05:00.000Z',
  }, { trustOptions: identity.trust, expectedRevision: registry.snapshot().revision }).publisher;
  assert.equal(registeredPublisher.publisherId, publisher.publisherId);
  const registered = registry.registerSkillProduct({
    productKey: product.productKey, publisherId: product.publisherId,
    titleZh: product.titleZh, summaryZh: product.summaryZh, parties: product.parties,
    skillId: product.skillId, releaseId: product.releaseId, createdAt: product.createdAt,
  }, {
    resolveRegistryRelease: () => release,
    authorizePublication: ({ publisherId, skillId, releaseId }) => ({
      decision: 'allow', publisherId, skillId, releaseId,
      authorityRef: 'registry:publication-authority', policyVersion: 'market-publication-v1',
      authorizedAt: NOW,
    }),
    expectedRevision: registry.snapshot().revision,
  }).product;
  const offer = createOffer({
    offerId: OFFER_FIXTURE.offerId, productId: registered.productId,
    pricing: OFFER_FIXTURE.pricing,
    licensePolicy: { ...OFFER_FIXTURE.licensePolicy, constraints: { ...OFFER_FIXTURE.licensePolicy.constraints, releaseIds: [release.releaseId] } },
    effectiveAt: OFFER_FIXTURE.effectiveAt,
  });
  const order = createFreeOrder({
    orderId: 'ord_registry_bound', organizationId: 'org_acme', productId: registered.productId,
    releaseScope: { releaseIds: [release.releaseId] }, offerRevisionId: offer.offerRevisionId,
    idempotencyKey: 'idem:registry-bound:001',
  }, {
    offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }),
    productResolver: id => registry.resolveOrderProduct(id),
    releaseResolver: id => registry.resolveOrderRelease(id),
    now: () => NOW,
  });
  assert.equal(order.productId, registered.productId);
  assert.equal(order.releaseScope.releaseIds[0], release.releaseId);
});
