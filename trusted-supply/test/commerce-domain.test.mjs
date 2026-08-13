import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceDomainError,
  LICENSE_RIGHTS,
  createLicensePolicy,
} from '../lib/commerce/license-policy.mjs';
import { createOffer, isOfferExecutable, reviseOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder, normalizeFreeOrder } from '../lib/commerce/order.mjs';
import { issueEntitlement, normalizeEntitlement } from '../lib/commerce/entitlement.mjs';
import { decideAccess, requireAccess } from '../lib/commerce/access-decision.mjs';

const NOW = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-15T00:00:00.000Z';
const PROD = `prod_${'a'.repeat(64)}`;
const REL = `rel_${'b'.repeat(64)}`;
const REL_2 = `rel_${'c'.repeat(64)}`;

function license(overrides = {}) {
  return createLicensePolicy({
    rights: ['invoke', 'organization_use', 'derive'],
    constraints: {
      organizationIds: ['org_acme'],
      projectIds: ['project_alpha'],
      environments: ['production'],
      releaseIds: [REL],
      seatLimit: 10,
      invocationLimit: 100,
      validFrom: NOW,
      validUntil: '2026-09-14T00:00:00.000Z',
    },
    ...overrides,
  });
}

function freeOffer(overrides = {}) {
  return createOffer({
    offerId: 'offer_free_basic',
    productId: PROD,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: license(),
    effectiveAt: NOW,
    ...overrides,
  });
}

function order(overrides = {}, trustOverrides = {}) {
  const offerRevision = overrides.offerRevision ?? freeOffer();
  const input = {
    orderId: 'ord_free_001',
    organizationId: 'org_acme',
    productId: PROD,
    releaseScope: { releaseIds: [REL] },
    offerRevisionId: offerRevision.offerRevisionId,
    idempotencyKey: 'idem:free:001',
    ...overrides,
  };
  delete input.offerRevision;
  return createFreeOrder(input, {
    offerResolver: offerRevisionId => ({ offerRevision, currentOfferRevisionId: offerRevisionId }),
    productResolver: productId => ({ productId, status: 'published' }),
    releaseResolver: releaseId => ({ releaseId, productId: input.productId, status: 'published' }),
    now: () => NOW,
    ...trustOverrides,
  });
}

function entitlement(overrides = {}) {
  return issueEntitlement({ order: order(), issuedAt: NOW, ...overrides });
}

function access(overrides = {}) {
  return {
    entitlementIds: [entitlement().entitlementId],
    organizationId: 'org_acme',
    productId: PROD,
    releaseId: REL,
    requiredRights: ['invoke'],
    projectId: 'project_alpha',
    environment: 'production',
    ...overrides,
  };
}

function accessOptions(grant = entitlement(), overrides = {}) {
  return {
    entitlementResolver: entitlementId => entitlementId === grant.entitlementId ? grant : null,
    releaseResolver: releaseId => ({ releaseId, status: 'published' }),
    usageResolver: () => ({ invocations: 0 }),
    seatResolver: () => ({ seatCount: 1 }),
    now: () => LATER,
    ...overrides,
  };
}

test('license policy explicitly enumerates rights and constraints', () => {
  const policy = license();
  assert.deepEqual(policy.rights, ['derive', 'invoke', 'organization_use']);
  assert.equal(policy.constraints.invocationLimit, 100);
  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(LICENSE_RIGHTS, [
    'invoke', 'organization_use', 'install', 'view_source', 'modify', 'derive',
    'internal_distribute', 'commercial_output', 'redistribute_derivative', 'updates', 'support',
  ]);
  assert.throws(() => createLicensePolicy({ rights: [] }), error => error instanceof CommerceDomainError && error.code === 'INVALID_ARRAY');
  assert.throws(() => createLicensePolicy({ rights: ['super_admin'] }), error => error.code === 'INVALID_RIGHT');
  assert.throws(() => createLicensePolicy({ rights: ['invoke'], constraints: { secret: 'x' } }), error => error.code === 'UNKNOWN_FIELD');
});

test('free and paid Offers are modeled but only free is executable in V4.3', () => {
  const free = freeOffer();
  assert.equal(free.revision, 1);
  assert.match(free.offerRevisionId, /^offrev_[a-f0-9]{64}$/);
  assert.equal(isOfferExecutable(free), true);
  const paid = createOffer({
    offerId: 'offer_paid_basic', productId: PROD,
    pricing: { model: 'subscription', currency: 'CNY', amountMinor: 9900 },
    licensePolicy: license(), effectiveAt: NOW,
  });
  assert.equal(isOfferExecutable(paid), false);
  assert.throws(() => order({ offerRevision: paid }), error => error.code === 'PAID_ORDER_NOT_EXECUTABLE');
  assert.throws(() => freeOffer({ pricing: { model: 'free', currency: 'CNY', amountMinor: 1 } }), error => error.code === 'INVALID_FREE_PRICE');
});

test('Offer revision changes create a new immutable revision', () => {
  const original = freeOffer();
  const revised = reviseOffer(original, {
    effectiveAt: LATER,
    licensePolicy: createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [REL] } }),
  });
  assert.equal(revised.revision, 2);
  assert.notEqual(revised.offerRevisionId, original.offerRevisionId);
  assert.deepEqual(original.licensePolicy.rights, ['derive', 'invoke', 'organization_use']);
  assert.deepEqual(revised.licensePolicy.rights, ['invoke']);
});

test('free Order freezes price, LicensePolicy and Offer revision evidence', () => {
  const purchased = order();
  assert.equal(purchased.status, 'granted');
  assert.equal(purchased.priceSnapshot.model, 'free');
  assert.deepEqual(purchased.licensePolicySnapshot.rights, ['derive', 'invoke', 'organization_use']);
  assert.match(purchased.requestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(purchased.orderDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalizeFreeOrder(purchased).orderDigest, purchased.orderDigest);

  const tampered = structuredClone(purchased);
  tampered.licensePolicySnapshot.rights = ['invoke'];
  assert.throws(() => normalizeFreeOrder(tampered), error => error.code === 'ORDER_DIGEST_MISMATCH');
});

test('new Order requires current trusted Offer and published Product and Release', () => {
  const offerRevision = freeOffer();
  const current = offerRevision.offerRevisionId;
  assert.throws(() => createFreeOrder({
    orderId: 'ord_raw_offer', organizationId: 'org_acme', productId: PROD,
    releaseScope: { releaseIds: [REL] }, offerRevisionId: current, idempotencyKey: 'idem:raw:001',
    offerRevision,
  }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => order({}, { offerResolver: () => ({ offerRevision, currentOfferRevisionId: `offrev_${'f'.repeat(64)}` }) }), error => error.code === 'OFFER_NOT_CURRENT');
  for (const status of ['draft', 'withdrawn', 'recalled', 'revoked']) {
    assert.throws(() => order({}, { productResolver: productId => ({ productId, status }) }), error => error.code === 'PRODUCT_NOT_PUBLISHED');
    assert.throws(() => order({}, { releaseResolver: releaseId => ({ releaseId, productId: PROD, status }) }), error => error.code === 'RELEASE_NOT_PUBLISHED');
  }
  assert.throws(() => order({}, { releaseResolver: releaseId => ({ releaseId, status: 'published' }) }), error => error.code === 'RELEASE_PRODUCT_MISMATCH');
  assert.throws(() => order({}, { releaseResolver: releaseId => ({ releaseId, productId: `prod_${'d'.repeat(64)}`, status: 'published' }) }), error => error.code === 'RELEASE_PRODUCT_MISMATCH');
  assert.throws(() => order({}, { now: undefined }), error => error.code === 'TRUSTED_CLOCK_REQUIRED');
});

test('same free Order request produces evidence a ledger can idempotently compare', () => {
  const first = order();
  const replay = order();
  const conflict = order({ organizationId: 'org_other', offerRevision: freeOffer({
    licensePolicy: createLicensePolicy({ rights: ['invoke'], constraints: { organizationIds: ['org_other'], releaseIds: [REL] } }),
  }) });
  assert.equal(replay.requestDigest, first.requestDigest);
  assert.equal(replay.orderDigest, first.orderDigest);
  assert.equal(conflict.idempotencyKey, first.idempotencyKey);
  assert.notEqual(conflict.requestDigest, first.requestDigest);
});

test('free acquisition issues a content-addressed verifiable Entitlement', () => {
  const granted = entitlement();
  assert.match(granted.entitlementId, /^ent_[a-f0-9]{64}$/);
  assert.equal(granted.organizationId, 'org_acme');
  assert.equal(granted.sourceOrderId, 'ord_free_001');
  assert.equal(normalizeEntitlement(granted).entitlementId, granted.entitlementId);

  const tampered = structuredClone(granted);
  tampered.rights.push('modify');
  assert.throws(() => normalizeEntitlement(tampered), error => error.code === 'ENTITLEMENT_DIGEST_MISMATCH');
});

test('authorized invocation is allowed and exposes only granted requested rights', () => {
  const grant = entitlement();
  const decision = decideAccess(access({ entitlementIds: [grant.entitlementId] }), accessOptions(grant));
  assert.deepEqual(decision, {
    schemaVersion: 1,
    decision: 'allow',
    code: 'ACCESS_ALLOWED',
    entitlementId: entitlement().entitlementId,
    organizationId: 'org_acme',
    productId: PROD,
    releaseId: REL,
    grantedRights: ['invoke'],
    checkedAt: LATER,
  });
  assert.equal(requireAccess(access({ entitlementIds: [grant.entitlementId] }), accessOptions(grant)).decision, 'allow');
});

test('wrong organization, product, release and missing right deny access', () => {
  const grant = entitlement();
  const options = accessOptions(grant);
  assert.equal(decideAccess(access({ entitlementIds: [grant.entitlementId], organizationId: 'org_other' }), options).code, 'NO_ENTITLEMENT');
  assert.equal(decideAccess(access({ entitlementIds: [grant.entitlementId], productId: `prod_${'d'.repeat(64)}` }), options).code, 'NO_ENTITLEMENT');
  assert.equal(decideAccess(access({ entitlementIds: [grant.entitlementId], releaseId: REL_2 }), options).code, 'RELEASE_NOT_GRANTED');
  assert.equal(decideAccess(access({ entitlementIds: [grant.entitlementId], requiredRights: ['modify'] }), options).code, 'RIGHT_MISSING');
  assert.throws(() => requireAccess(access({ entitlementIds: [grant.entitlementId], requiredRights: ['modify'] }), options), error => error.code === 'RIGHT_MISSING');
});

test('project, environment, time, seat and invocation constraints deny closed', () => {
  const grant = entitlement();
  const request = access({ entitlementIds: [grant.entitlementId] });
  assert.equal(decideAccess({ ...request, projectId: 'project_beta' }, accessOptions(grant)).code, 'PROJECT_NOT_GRANTED');
  assert.equal(decideAccess({ ...request, environment: 'staging' }, accessOptions(grant)).code, 'ENVIRONMENT_NOT_GRANTED');
  assert.equal(decideAccess(request, accessOptions(grant, { now: () => '2026-08-13T00:00:00.000Z' })).code, 'NOT_YET_VALID');
  assert.equal(decideAccess(request, accessOptions(grant, { now: () => '2026-09-14T00:00:00.000Z' })).code, 'EXPIRED');
  assert.equal(decideAccess(request, accessOptions(grant, { seatResolver: () => ({ seatCount: 11 }) })).code, 'SEAT_LIMIT_EXCEEDED');
  assert.equal(decideAccess(request, accessOptions(grant, { usageResolver: () => ({ invocations: 100 }) })).code, 'INVOCATION_LIMIT_EXCEEDED');
});

test('ordinary withdrawal preserves an existing grant while safety recall blocks it', () => {
  const grant = entitlement();
  const request = access({ entitlementIds: [grant.entitlementId] });
  assert.equal(decideAccess(request, accessOptions(grant, { releaseResolver: releaseId => ({ releaseId, status: 'withdrawn' }) })).decision, 'allow');
  assert.equal(decideAccess(request, accessOptions(grant, { releaseResolver: releaseId => ({ releaseId, status: 'recalled' }) })).code, 'RELEASE_RECALLED');
  assert.equal(decideAccess(request, accessOptions(grant, { releaseResolver: releaseId => ({ releaseId, status: 'revoked' }) })).code, 'RELEASE_REVOKED');
});

test('access requires trusted capabilities and rejects self-asserted or mismatched evidence', () => {
  const grant = entitlement();
  const request = access({ entitlementIds: [grant.entitlementId] });
  assert.throws(() => decideAccess(request), error => error.code === 'TRUSTED_CLOCK_REQUIRED');
  assert.throws(() => decideAccess({ ...request, entitlements: [grant] }, accessOptions(grant)), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => decideAccess(request, accessOptions(grant, {
    entitlementResolver: () => ({ ...grant, entitlementId: `ent_${'f'.repeat(64)}` }),
  })), error => ['ENTITLEMENT_DIGEST_MISMATCH', 'ENTITLEMENT_RESOLVER_MISMATCH'].includes(error.code));
  assert.throws(() => decideAccess(request, accessOptions(grant, {
    releaseResolver: () => ({ releaseId: REL_2, status: 'published' }),
  })), error => error.code === 'RELEASE_RESOLVER_MISMATCH');
});

test('Order Release scope and License constraint are intersected, never unioned', () => {
  const offerRevision = freeOffer({
    licensePolicy: createLicensePolicy({
      rights: ['invoke', 'derive'],
      constraints: { organizationIds: ['org_acme'], releaseIds: [REL, REL_2] },
    }),
  });
  const narrow = order({ offerRevision });
  const grant = issueEntitlement({ order: narrow, issuedAt: NOW });
  const request = access({ entitlementIds: [grant.entitlementId], releaseId: REL_2, projectId: null, environment: null });
  assert.equal(decideAccess(request, accessOptions(grant)).code, 'RELEASE_NOT_GRANTED');
});

test('Candidate and sensitive or caller-forged fields are rejected', () => {
  assert.throws(() => order({ productId: 'cand_bad' }), error => error.code === 'CANDIDATE_ID_FORBIDDEN');
  assert.throws(() => createLicensePolicy({ rights: ['invoke'], prompt: 'private' }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => freeOffer({ paid: true }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => issueEntitlement({ order: order(), issuedAt: NOW, token: 'secret' }), error => error.code === 'UNKNOWN_FIELD');
});
