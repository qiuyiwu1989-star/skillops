import assert from 'node:assert/strict';
import test from 'node:test';

import { createDerivativeLineage, normalizeDerivativeLineage } from '../lib/commerce/derivative-lineage.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';

const RELEASE = `rel_${'a'.repeat(64)}`;
const PRODUCT = `prod_${'b'.repeat(64)}`;
const DERIVATIVE = `prod_${'c'.repeat(64)}`;
const NOW = '2026-08-14T09:05:00.000Z';

function entitlement(rights = ['derive', 'invoke'], { constraintReleaseIds = [RELEASE], orderReleaseIds = [RELEASE] } = {}) {
  const offer = createOffer({
    offerId: 'offer_derivative',
    productId: PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: { rights, constraints: { organizationIds: ['org_acme'], releaseIds: constraintReleaseIds } },
    effectiveAt: NOW,
  });
  const input = {
    orderId: 'ord_derivative', organizationId: 'org_acme', productId: PRODUCT,
    releaseScope: { releaseIds: orderReleaseIds }, offerRevisionId: offer.offerRevisionId,
    idempotencyKey: 'idem:derivative:001',
  };
  const order = createFreeOrder(input, {
    offerResolver: offerRevisionId => ({ offerRevision: offer, currentOfferRevisionId: offerRevisionId }),
    productResolver: productId => ({ productId, status: 'published' }),
    releaseResolver: releaseId => ({ releaseId, productId: PRODUCT, status: 'published' }),
    now: () => NOW,
  });
  return issueEntitlement({ order, issuedAt: NOW });
}

test('derive right creates immutable lineage bound to the trusted Entitlement', () => {
  const grant = entitlement();
  const trusted = { entitlementResolver: id => id === grant.entitlementId ? grant : null, now: () => NOW };
  const lineage = createDerivativeLineage({
    entitlementId: grant.entitlementId, baseReleaseId: RELEASE, derivativeProductId: DERIVATIVE,
  }, trusted);
  assert.match(lineage.lineageId, /^lineage_[a-f0-9]{64}$/);
  assert.match(lineage.lineageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lineage.baseReleaseId, RELEASE);
  assert.equal(lineage.entitlementId, grant.entitlementId);
  assert.equal(normalizeDerivativeLineage(lineage, trusted).lineageId, lineage.lineageId);

  const tampered = structuredClone(lineage);
  tampered.derivativeProductId = `prod_${'d'.repeat(64)}`;
  assert.throws(() => normalizeDerivativeLineage(tampered, trusted), error => error.code === 'LINEAGE_DIGEST_MISMATCH');
});

test('derivative creation fails closed without derive right or outside Release scope', () => {
  const noDerive = entitlement(['invoke']);
  assert.throws(() => createDerivativeLineage({
    entitlementId: noDerive.entitlementId, baseReleaseId: RELEASE,
    derivativeProductId: DERIVATIVE,
  }, { entitlementResolver: () => noDerive, now: () => NOW }), error => error.code === 'DERIVE_RIGHT_REQUIRED');
  const grant = entitlement();
  assert.throws(() => createDerivativeLineage({
    entitlementId: grant.entitlementId, baseReleaseId: `rel_${'f'.repeat(64)}`,
    derivativeProductId: DERIVATIVE,
  }, { entitlementResolver: () => grant, now: () => NOW }), error => error.code === 'RELEASE_NOT_GRANTED');
});

test('derivative creation rejects raw or mismatched Entitlement evidence', () => {
  const grant = entitlement();
  const input = { entitlementId: grant.entitlementId, baseReleaseId: RELEASE, derivativeProductId: DERIVATIVE };
  assert.throws(() => createDerivativeLineage({ ...input, entitlement: grant }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => createDerivativeLineage(input), error => error.code === 'TRUSTED_CAPABILITY_REQUIRED');
  assert.throws(() => createDerivativeLineage(input, {
    entitlementResolver: () => ({ ...grant, entitlementId: `ent_${'f'.repeat(64)}` }), now: () => NOW,
  }), error => ['ENTITLEMENT_DIGEST_MISMATCH', 'ENTITLEMENT_RESOLVER_MISMATCH'].includes(error.code));
});

test('derivative Release must be in both Order scope and non-empty License constraint', () => {
  const second = `rel_${'f'.repeat(64)}`;
  const grant = entitlement(['derive'], { constraintReleaseIds: [RELEASE, second], orderReleaseIds: [RELEASE] });
  assert.throws(() => createDerivativeLineage({
    entitlementId: grant.entitlementId, baseReleaseId: second, derivativeProductId: DERIVATIVE,
  }, { entitlementResolver: () => grant, now: () => NOW }), error => error.code === 'RELEASE_NOT_GRANTED');
});
