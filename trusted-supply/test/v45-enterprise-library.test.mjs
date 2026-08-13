import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { digest } from '../lib/commerce/common.mjs';
import { createEntitlementRevocation } from '../lib/commerce/lifecycle.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { AcquisitionLedger } from '../lib/demand/free-acquisition.mjs';
import {
  createEnterpriseLibraryResolver,
  normalizeEnterpriseLibraryProjection,
  projectEnterpriseLibrary,
} from '../lib/demand/enterprise-library.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-15T00:00:00.000Z';
const PRODUCT = `prod_${'a'.repeat(64)}`;
const RELEASE = `rel_${'b'.repeat(64)}`;

function source() {
  const offer = createOffer({
    offerId: 'offer_library', productId: PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: createLicensePolicy({
      rights: ['invoke', 'view_source'],
      constraints: { organizationIds: ['org_acme'], releaseIds: [RELEASE], validUntil: '2026-08-20T00:00:00.000Z' },
    }), effectiveAt: AT,
  });
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v45-library-')), 'acquisition.json');
  const ledger = new AcquisitionLedger(file);
  const options = {
    offerResolver: id => ({ offerRevision: offer, currentOfferRevisionId: id }),
    publicationResolver: {
      resolveOrderProduct: productId => ({ productId, status: 'published' }),
      resolveOrderRelease: releaseId => ({ releaseId, productId: PRODUCT, status: 'published' }),
    }, now: () => AT,
    organizationAuthorizer: () => ({ decision: 'allow', organizationId: 'org_acme' }),
  };
  ledger.acquire({
    organizationId: 'org_acme', productId: PRODUCT, releaseIds: [RELEASE],
    offerRevisionId: offer.offerRevisionId, idempotencyKey: 'library:001',
  }, { ...options, expectedRevision: ledger.read().revision });
  const projection = ledger.project();
  return { ledger, projection };
}

function options(status = 'published', now = LATER, organizationId = 'org_acme', ledger = null) {
  return {
    organizationAuthorizer: context => ({ decision: context.purpose === 'enterprise_library.read' ? 'allow' : 'deny', organizationId }),
    publicationResolver: { resolveAccessRelease: releaseId => ({ releaseId, productId: PRODUCT, status }) },
    productResolver: productId => ({ productId, abilityType: 'skill', titleZh: '企业知识检索' }),
    marketProjectionResolver: revision => ledger?.resolveProjection(revision),
    now: () => now,
  };
}

function context(status = 'published', now = LATER, organizationId = 'org_acme') {
  const { ledger, projection } = source();
  return { projection, options: options(status, now, organizationId, ledger), ledger };
}

test('enterprise library is organization-authorized, canonical and privacy-safe', () => {
  const fixture = context();
  const projection = projectEnterpriseLibrary(fixture.projection, fixture.options);
  assert.equal(projection.organizationId, 'org_acme');
  assert.deepEqual(projection.summary, { total: 1, callable: 1, blocked: 0, withdrawn: 0 });
  assert.equal(projection.items[0].status, 'callable');
  assert.equal(projection.items[0].callable, true);
  assert.deepEqual(projection.items[0].rights, ['invoke', 'view_source']);
  assert.equal(projection.items[0].sourceOrder.orderId.startsWith('ord_free_'), true);
  assert.equal(normalizeEnterpriseLibraryProjection(projection).projectionDigest, projection.projectionDigest);
  const resolver = createEnterpriseLibraryResolver(projection);
  assert.equal(resolver.organizationId, 'org_acme');
  assert.equal(resolver.listCallable().length, 1);
  assert.equal(resolver.resolveEntitlement(projection.items[0].entitlementId).entitlementDigest, projection.items[0].entitlementDigest);
  const serialized = JSON.stringify(projection).toLowerCase();
  for (const forbidden of ['candidate', 'storageref', 'localpath', 'prompt', 'output', 'token', 'secret', 'receipt', 'subjectdigest', 'principalid']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('cross-organization reads fail closed and never expose another tenant entitlement', () => {
  const fixture = context('published', LATER, 'org_other');
  const other = projectEnterpriseLibrary(fixture.projection, fixture.options);
  assert.equal(other.summary.total, 0);
  assert.deepEqual(other.items, []);
  assert.throws(() => projectEnterpriseLibrary(fixture.projection, {
    ...fixture.options, organizationAuthorizer: () => ({ decision: 'deny', organizationId: 'org_acme' }),
  }), error => error.code === 'ORGANIZATION_FORBIDDEN');
  assert.throws(() => projectEnterpriseLibrary(fixture.projection, {
    ...fixture.options, organizationAuthorizer: () => ({ decision: 'allow', organizationId: '../org_acme' }),
  }), error => error.code === 'ORGANIZATION_AUTHORIZATION_INVALID');
});

test('withdraw preserves invocation while recall and revocation block it', () => {
  const withdrawnFixture = context('withdrawn');
  const withdrawn = projectEnterpriseLibrary(withdrawnFixture.projection, withdrawnFixture.options);
  assert.equal(withdrawn.items[0].status, 'withdrawn');
  assert.equal(withdrawn.items[0].callable, true);
  const recalledFixture = context('recalled');
  const recalled = projectEnterpriseLibrary(recalledFixture.projection, recalledFixture.options);
  assert.equal(recalled.items[0].status, 'recalled');
  assert.equal(recalled.items[0].callable, false);
  assert.equal(recalled.items[0].blockReason, 'RELEASE_RECALLED');
  const revokedFixture = context('revoked');
  const releaseRevoked = projectEnterpriseLibrary(revokedFixture.projection, revokedFixture.options);
  assert.equal(releaseRevoked.items[0].status, 'revoked');
  assert.equal(releaseRevoked.items[0].callable, false);
  assert.equal(releaseRevoked.items[0].blockReason, 'RELEASE_REVOKED');
  const lifecycleFixture = context();
  const revokedSource = structuredClone(lifecycleFixture.projection);
  const entitlementId = Object.keys(revokedSource.entitlements)[0];
  const revocation = createEntitlementRevocation({
    entitlement: revokedSource.entitlements[entitlementId], reasonCode: 'customer_request', revokedAt: LATER,
  });
  revokedSource.entitlementLifecycle[entitlementId] = { status: 'revoked', eventId: 'mktevt_fixture', revocation };
  const trustedRevoked = structuredClone(revokedSource);
  const { marketProjectionDigest: _oldDigest, ...revokedBody } = trustedRevoked;
  trustedRevoked.marketProjectionDigest = digest(revokedBody);
  const revoked = projectEnterpriseLibrary(trustedRevoked, {
    ...lifecycleFixture.options, marketProjectionResolver: () => trustedRevoked,
  });
  assert.equal(revoked.items[0].status, 'revoked');
  assert.equal(revoked.items[0].callable, false);
  assert.equal(revoked.items[0].blockReason, 'ENTITLEMENT_REVOKED');
});

test('not-yet-valid, expired, unavailable and mismatched release fail closed', () => {
  const futureFixture = context('published', '2026-08-13T00:00:00.000Z');
  const future = projectEnterpriseLibrary(futureFixture.projection, futureFixture.options);
  assert.equal(future.items[0].status, 'not_yet_valid');
  const expiredFixture = context('published', '2026-08-20T00:00:00.000Z');
  const expired = projectEnterpriseLibrary(expiredFixture.projection, expiredFixture.options);
  assert.equal(expired.items[0].status, 'expired');
  const unavailableFixture = context();
  const unavailable = projectEnterpriseLibrary(unavailableFixture.projection, {
    ...unavailableFixture.options, publicationResolver: { resolveAccessRelease: () => null },
  });
  assert.equal(unavailable.items[0].status, 'unavailable');
  assert.throws(() => projectEnterpriseLibrary(unavailableFixture.projection, {
    ...unavailableFixture.options, publicationResolver: { resolveAccessRelease: releaseId => ({ releaseId, productId: `prod_${'f'.repeat(64)}`, status: 'published' }) },
  }), error => error.code === 'PUBLICATION_RESOLVER_MISMATCH');
});

test('projection digest, canonical Entitlement and source Order cannot be forged', () => {
  const fixture = context();
  const projection = projectEnterpriseLibrary(fixture.projection, fixture.options);
  assert.throws(() => normalizeEnterpriseLibraryProjection({ ...projection, generatedAt: '2026-08-16T00:00:00.000Z' }), error => error.code === 'PROJECTION_DIGEST_MISMATCH');
  const changed = structuredClone(projection);
  changed.items[0].rights = ['invoke'];
  assert.throws(() => normalizeEnterpriseLibraryProjection(changed), error => error.code === 'ENTITLEMENT_BINDING_INVALID');
  const recalledFixture = context('recalled');
  const forgedCallable = structuredClone(projectEnterpriseLibrary(recalledFixture.projection, recalledFixture.options));
  forgedCallable.items[0].status = 'callable';
  forgedCallable.items[0].callable = true;
  forgedCallable.items[0].blockReason = null;
  assert.throws(() => normalizeEnterpriseLibraryProjection(forgedCallable), error => error.code === 'ITEM_STATUS_MISMATCH');
  const badSource = structuredClone(fixture.projection);
  const orderId = Object.keys(badSource.orders)[0];
  delete badSource.orders[orderId];
  assert.throws(() => projectEnterpriseLibrary(badSource, {
    ...fixture.options, marketProjectionResolver: () => badSource,
  }), error => ['MARKET_PROJECTION_DIGEST_MISMATCH', 'SOURCE_ORDER_INVALID'].includes(error.code));
  const missingLifecycle = structuredClone(fixture.projection);
  const entitlementId = Object.keys(missingLifecycle.entitlements)[0];
  delete missingLifecycle.entitlementLifecycle[entitlementId];
  assert.throws(() => projectEnterpriseLibrary(missingLifecycle, {
    ...fixture.options, marketProjectionResolver: () => missingLifecycle,
  }), error => ['MARKET_PROJECTION_DIGEST_MISMATCH', 'ENTITLEMENT_LIFECYCLE_INVALID'].includes(error.code));
});

test('enterprise library requires the exact persisted acquisition projection trust anchor', () => {
  const fixture = context();
  const withoutResolver = { ...fixture.options };
  delete withoutResolver.marketProjectionResolver;
  assert.throws(() => projectEnterpriseLibrary(fixture.projection, withoutResolver), error => error.code === 'MARKET_PROJECTION_RESOLVER_REQUIRED');
  const callerProjection = structuredClone(fixture.projection);
  assert.throws(() => projectEnterpriseLibrary(callerProjection, {
    ...fixture.options, marketProjectionResolver: () => null,
  }), error => error.code === 'MARKET_PROJECTION_NOT_FOUND');
  const forged = structuredClone(fixture.projection);
  forged.orders = {};
  const { marketProjectionDigest: _digest, ...forgedBody } = forged;
  forged.marketProjectionDigest = digest(forgedBody);
  assert.throws(() => projectEnterpriseLibrary(forged, fixture.options), error => error.code === 'MARKET_PROJECTION_MISMATCH');
  assert.throws(() => projectEnterpriseLibrary({ orders: {}, entitlements: {}, entitlementLifecycle: {} }, fixture.options), error => error.code === 'MARKET_PROJECTION_ANCHOR_REQUIRED');
});
