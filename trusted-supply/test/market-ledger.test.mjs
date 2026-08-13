import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { createEntitlementRevocation, createOrderRefundRecord } from '../lib/commerce/lifecycle.mjs';
import { MarketLedger, createMarketEvent } from '../lib/commerce/market-ledger.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const PRODUCT = `prod_${'a'.repeat(64)}`;
const RELEASE = `rel_${'b'.repeat(64)}`;

function order(overrides = {}) {
  const licensePolicy = createLicensePolicy({ rights: ['invoke'], constraints: { organizationIds: ['org_acme'], releaseIds: [RELEASE] } });
  const offerRevision = createOffer({
    offerId: 'offer_free', productId: PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy, effectiveAt: AT,
  });
  const input = {
    orderId: 'ord_free', organizationId: 'org_acme', productId: PRODUCT,
    releaseScope: { releaseIds: [RELEASE] }, offerRevisionId: offerRevision.offerRevisionId,
    idempotencyKey: 'idem:free:001', ...overrides,
  };
  const orderedAt = input.orderedAt ?? AT;
  delete input.orderedAt;
  return createFreeOrder(input, {
    offerResolver: offerRevisionId => ({ offerRevision, currentOfferRevisionId: offerRevisionId }),
    productResolver: productId => ({ productId, status: 'published' }),
    releaseResolver: releaseId => ({ releaseId, productId: input.productId, status: 'published' }),
    now: () => orderedAt,
  });
}

test('ledger atomically persists an order and its entitlement across restart', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const file = path.join(directory, 'ledger.json');
  const ledger = new MarketLedger(file);
  const first = ledger.read();
  const granted = order();
  const added = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: first.revision });
  const entitlement = issueEntitlement({ order: granted, issuedAt: AT });
  ledger.append(createMarketEvent({ type: 'entitlement.issued', occurredAt: AT, payload: entitlement }), { expectedRevision: added.revision });
  const restarted = new MarketLedger(file).project();
  assert.equal(restarted.orders[granted.orderId].orderDigest, granted.orderDigest);
  assert.equal(restarted.entitlements[entitlement.entitlementId].sourceOrderId, granted.orderId);
  assert.equal(new MarketLedger(file).write, undefined);
});

test('same idempotency request replays while a changed request conflicts without writing', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const file = path.join(directory, 'ledger.json');
  const ledger = new MarketLedger(file);
  const granted = order();
  const first = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: ledger.read().revision });
  const replay = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: first.revision });
  assert.equal(replay.action, 'unchanged');
  const bytes = fs.readFileSync(file);
  const conflicting = order({ orderId: 'ord_other' });
  assert.throws(() => ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: conflicting }), { expectedRevision: first.revision }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('entitlement cannot be appended before its exact source order', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const ledger = new MarketLedger(path.join(directory, 'ledger.json'));
  const granted = order();
  const entitlement = issueEntitlement({ order: granted, issuedAt: AT });
  assert.throws(() => ledger.append(createMarketEvent({ type: 'entitlement.issued', occurredAt: AT, payload: entitlement }), { expectedRevision: ledger.read().revision }), error => error.code === 'SOURCE_ORDER_REQUIRED');
});

test('revision conflict and injected write failure leave history unchanged', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const file = path.join(directory, 'ledger.json');
  const granted = order();
  const ledger = new MarketLedger(file);
  assert.throws(() => ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: 'sha256:wrong' }), error => error.code === 'REVISION_CONFLICT');
  const faulty = new MarketLedger(file, { faultInjector: stage => { if (stage === 'beforeRename') throw new Error('fixture failure'); } });
  assert.throws(() => faulty.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: faulty.read().revision }), /fixture failure/);
  assert.equal(fs.existsSync(file), false);
});

test('nested symlink parent is rejected and the outside directory is unchanged', t => {
  if (process.platform === 'win32') return t.skip('symlink fixture is POSIX-specific');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-outside-'));
  fs.symlinkSync(outside, path.join(root, 'state'));
  assert.throws(() => new MarketLedger(path.join(root, 'state', 'ledger.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('revocation and free-order refund records append without erasing historical grants', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const ledger = new MarketLedger(path.join(directory, 'ledger.json'));
  const granted = order();
  const issued = issueEntitlement({ order: granted, issuedAt: AT });
  let state = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: granted }), { expectedRevision: ledger.read().revision });
  state = ledger.append(createMarketEvent({ type: 'entitlement.issued', occurredAt: AT, payload: issued }), { expectedRevision: state.revision });
  const revocation = createEntitlementRevocation({ entitlement: issued, reasonCode: 'customer_request', revokedAt: AT });
  state = ledger.append(createMarketEvent({ type: 'entitlement.revoked', occurredAt: AT, payload: revocation }), { expectedRevision: state.revision });
  const refund = createOrderRefundRecord({ order: granted, reasonCode: 'customer_request', recordedAt: AT });
  ledger.append(createMarketEvent({ type: 'order.refund_recorded', occurredAt: AT, payload: refund }), { expectedRevision: state.revision });

  const projection = ledger.project();
  assert.equal(projection.orders[granted.orderId].orderDigest, granted.orderDigest);
  assert.equal(projection.entitlements[issued.entitlementId].entitlementDigest, issued.entitlementDigest);
  assert.equal(projection.entitlementLifecycle[issued.entitlementId].status, 'revoked');
  assert.equal(projection.refunds[granted.orderId].settlementStatus, 'not_applicable_free_order');
});

test('lifecycle records require exact prior evidence and monotonic event time', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-'));
  const ledger = new MarketLedger(path.join(directory, 'ledger.json'));
  const granted = order();
  const issued = issueEntitlement({ order: granted, issuedAt: AT });
  const revocation = createEntitlementRevocation({ entitlement: issued, reasonCode: 'security_recall', revokedAt: AT });
  assert.throws(() => ledger.append(createMarketEvent({ type: 'entitlement.revoked', occurredAt: AT, payload: revocation }), {
    expectedRevision: ledger.read().revision,
  }), error => error.code === 'ENTITLEMENT_REQUIRED');

  const lateOrder = order({ orderedAt: '2026-08-14T01:00:00.000Z' });
  const first = ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: lateOrder.orderedAt, payload: lateOrder }), { expectedRevision: ledger.read().revision });
  const earlier = order({ orderId: 'ord_earlier', idempotencyKey: 'idem:earlier:001' });
  assert.throws(() => ledger.append(createMarketEvent({ type: 'order.granted', occurredAt: AT, payload: earlier }), {
    expectedRevision: first.revision,
  }), error => error.code === 'EVENT_TIME_REGRESSION');
});
