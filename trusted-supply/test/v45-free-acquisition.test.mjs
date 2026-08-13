import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { AcquisitionLedger } from '../lib/demand/free-acquisition.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const PRODUCT = `prod_${'a'.repeat(64)}`;
const OTHER_PRODUCT = `prod_${'c'.repeat(64)}`;
const RELEASE = `rel_${'b'.repeat(64)}`;

function fixture() {
  const offer = createOffer({
    offerId: 'offer_free_v45',
    productId: PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: createLicensePolicy({
      rights: ['invoke', 'view_source'],
      constraints: { organizationIds: ['org_acme'], releaseIds: [RELEASE] },
    }),
    effectiveAt: AT,
  });
  const request = {
    organizationId: 'org_acme', productId: PRODUCT, releaseIds: [RELEASE],
    offerRevisionId: offer.offerRevisionId, idempotencyKey: 'acquire:free:001',
  };
  const publicationResolver = Object.freeze({
    resolveOrderProduct: productId => productId === PRODUCT ? { productId, status: 'published' } : null,
    resolveOrderRelease: releaseId => releaseId === RELEASE ? { releaseId, productId: PRODUCT, status: 'published' } : null,
  });
  const options = {
    offerResolver: offerRevisionId => ({ offerRevision: offer, currentOfferRevisionId: offerRevisionId }),
    publicationResolver,
    organizationAuthorizer: context => ({ decision: context.purpose === 'market.free_acquisition' ? 'allow' : 'deny', organizationId: 'org_acme' }),
    now: () => AT,
  };
  return { offer, request, options };
}

function directory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v45-acquire-'));
}

test('free acquisition atomically commits one operation containing Order and Entitlement events', () => {
  const file = path.join(directory(), 'acquisition.json');
  const ledger = new AcquisitionLedger(file);
  const { request, options } = fixture();
  const result = ledger.acquire(request, { ...options, expectedRevision: ledger.read().revision });
  assert.equal(result.action, 'committed');
  assert.equal(result.operation.marketEvents.length, 2);
  assert.deepEqual(result.operation.marketEvents.map(event => event.type), ['order.granted', 'entitlement.issued']);
  assert.equal(result.order.orderedAt, AT);
  assert.equal(result.entitlement.issuedAt, AT);
  assert.equal(result.entitlement.sourceOrderDigest, result.order.orderDigest);
  const restarted = new AcquisitionLedger(file).project();
  assert.equal(restarted.operations.length, 1);
  assert.equal(restarted.marketEvents.length, 2);
  assert.equal(restarted.orders[result.order.orderId].orderDigest, result.order.orderDigest);
  assert.equal(restarted.entitlements[result.entitlement.entitlementId].sourceOrderId, result.order.orderId);
  assert.equal(new AcquisitionLedger(file).resolveEntitlement(result.entitlement.entitlementId).entitlementDigest, result.entitlement.entitlementDigest);
});

test('same idempotency request replays without reading clock while changed request fails closed', () => {
  const file = path.join(directory(), 'acquisition.json');
  const ledger = new AcquisitionLedger(file);
  const { request, options } = fixture();
  const first = ledger.acquire(request, { ...options, expectedRevision: ledger.read().revision });
  const bytes = fs.readFileSync(file);
  const replay = ledger.acquire(request, {
    ...options, expectedRevision: first.revision, now: () => { throw new Error('clock must not be called'); },
  });
  assert.equal(replay.action, 'unchanged');
  assert.equal(replay.entitlement.entitlementId, first.entitlement.entitlementId);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => ledger.acquire({ ...request, releaseIds: [`rel_${'d'.repeat(64)}`] }, {
    ...options, expectedRevision: first.revision,
  }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('CAS, validation and write failures produce no half-commit', () => {
  const file = path.join(directory(), 'acquisition.json');
  const { request, options } = fixture();
  const ledger = new AcquisitionLedger(file);
  assert.throws(() => ledger.acquire(request, { ...options, expectedRevision: 'sha256:wrong' }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => ledger.acquire(request, {
    ...options,
    expectedRevision: ledger.read().revision,
    publicationResolver: { ...options.publicationResolver, resolveOrderRelease: releaseId => ({ releaseId, productId: OTHER_PRODUCT, status: 'published' }) },
  }), error => error.code === 'RELEASE_PRODUCT_MISMATCH');
  assert.equal(fs.existsSync(file), false);
  for (const status of ['withdrawn', 'recalled']) {
    assert.throws(() => ledger.acquire(request, {
      ...options,
      expectedRevision: ledger.read().revision,
      publicationResolver: {
        resolveOrderProduct: productId => ({ productId, status: 'published' }),
        resolveOrderRelease: releaseId => ({ releaseId, productId: PRODUCT, status }),
      },
    }), error => ['RELEASE_NOT_PUBLISHED', 'ACQUISITION_REJECTED'].includes(error.code));
    assert.equal(fs.existsSync(file), false);
  }
  const faulty = new AcquisitionLedger(file, { faultInjector: stage => { if (stage === 'beforeRename') throw new Error('fixture failure'); } });
  assert.throws(() => faulty.acquire(request, { ...options, expectedRevision: faulty.read().revision }), error => error.code === 'ACQUISITION_REJECTED');
  assert.equal(fs.existsSync(file), false);
});

test('unsafe nested symlink paths are rejected without touching the outside target', t => {
  if (process.platform === 'win32') return t.skip('symlink fixture is POSIX-specific');
  const root = directory();
  const outside = directory();
  fs.symlinkSync(outside, path.join(root, 'state'));
  assert.throws(() => new AcquisitionLedger(path.join(root, 'state', 'acquisition.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('request surface accepts IDs only and validates current active free Offer', () => {
  const ledger = new AcquisitionLedger(path.join(directory(), 'acquisition.json'));
  const { request, options, offer } = fixture();
  assert.throws(() => ledger.acquire({ ...request, price: 0 }, {
    ...options, expectedRevision: ledger.read().revision,
  }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => ledger.acquire({ ...request, organizationId: 'org_other', idempotencyKey: 'acquire:other:001' }, {
    ...options, expectedRevision: ledger.read().revision,
    organizationAuthorizer: () => ({ decision: 'allow', organizationId: 'org_other' }),
  }), error => error.code === 'ORGANIZATION_NOT_OFFERED');
  assert.throws(() => ledger.acquire(request, {
    ...options,
    expectedRevision: ledger.read().revision,
    offerResolver: offerRevisionId => ({ offerRevision: offer, currentOfferRevisionId: `offrev_${'f'.repeat(64)}` }),
  }), error => error.code === 'OFFER_NOT_CURRENT');
});

test('free acquisition requires trusted organization scope and never trusts caller organizationId', () => {
  const file = path.join(directory(), 'acquisition.json');
  const ledger = new AcquisitionLedger(file);
  const { request, options } = fixture();
  const withoutAuthorizer = { ...options };
  delete withoutAuthorizer.organizationAuthorizer;
  assert.throws(() => ledger.acquire(request, {
    ...withoutAuthorizer, expectedRevision: ledger.read().revision,
  }), error => error.code === 'ORGANIZATION_AUTHORIZER_REQUIRED');
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => ledger.acquire(request, {
    ...options,
    expectedRevision: ledger.read().revision,
    organizationAuthorizer: () => ({ decision: 'deny', organizationId: 'org_acme' }),
  }), error => error.code === 'ORGANIZATION_FORBIDDEN');
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => ledger.acquire(request, {
    ...options,
    expectedRevision: ledger.read().revision,
    organizationAuthorizer: () => ({ decision: 'allow', organizationId: 'org_other' }),
  }), error => error.code === 'ORGANIZATION_SCOPE_MISMATCH');
  assert.equal(fs.existsSync(file), false);

  const unrestrictedOffer = createOffer({
    offerId: 'offer_unrestricted', productId: PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [RELEASE] } }),
    effectiveAt: AT,
  });
  assert.throws(() => ledger.acquire({
    ...request, organizationId: 'org_other', offerRevisionId: unrestrictedOffer.offerRevisionId,
    idempotencyKey: 'acquire:cross-org:001',
  }, {
    ...options,
    offerResolver: id => ({ offerRevision: unrestrictedOffer, currentOfferRevisionId: id }),
    expectedRevision: ledger.read().revision,
  }), error => error.code === 'ORGANIZATION_SCOPE_MISMATCH');
  assert.equal(fs.existsSync(file), false);
});
