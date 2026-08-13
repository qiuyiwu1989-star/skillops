import {
  COMMERCE_SCHEMA_VERSION,
  ENTITLEMENT_ID,
  ORDER_ID,
  ORGANIZATION_ID,
  PRODUCT_ID,
  contentId,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  text,
  timestamp,
} from './common.mjs';
import { normalizeEntitlement } from './entitlement.mjs';
import { normalizeFreeOrder } from './order.mjs';

export { CommerceDomainError } from './common.mjs';

const REASONS = new Set(['customer_request', 'policy_change', 'security_recall', 'duplicate', 'other']);
const HASH = /^sha256:[a-f0-9]{64}$/;

function reason(value, label) {
  const normalized = text(value, label, { maximum: 64, pattern: /^[a-z][a-z0-9_]{1,63}$/ });
  if (!REASONS.has(normalized)) fail('INVALID_REASON', `${label} is unsupported`);
  return normalized;
}

export function createEntitlementRevocation(input) {
  exactKeys(input, new Set(['schemaVersion', 'entitlement', 'reasonCode', 'revokedAt']), 'entitlementRevocationCreate');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported revocation schema');
  const entitlement = normalizeEntitlement(input.entitlement);
  const revokedAt = timestamp(input.revokedAt, 'entitlementRevocation.revokedAt');
  if (Date.parse(revokedAt) < Date.parse(entitlement.issuedAt)) fail('REVOCATION_PREDATES_GRANT', 'revocation cannot predate its Entitlement');
  const body = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    entitlementId: entitlement.entitlementId,
    entitlementDigest: entitlement.entitlementDigest,
    organizationId: entitlement.organizationId,
    productId: entitlement.productId,
    reasonCode: reason(input.reasonCode, 'entitlementRevocation.reasonCode'),
    revokedAt,
  };
  return deepFreeze({ ...body, revocationId: contentId('entrev', body), revocationDigest: digest(body) });
}

export function normalizeEntitlementRevocation(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'revocationId', 'entitlementId', 'entitlementDigest', 'organizationId',
    'productId', 'reasonCode', 'revokedAt', 'revocationDigest',
  ]), 'entitlementRevocation');
  const body = {
    schemaVersion: input.schemaVersion,
    entitlementId: text(input.entitlementId, 'entitlementRevocation.entitlementId', { maximum: 69, pattern: ENTITLEMENT_ID }),
    entitlementDigest: text(input.entitlementDigest, 'entitlementRevocation.entitlementDigest', { maximum: 71, pattern: HASH }),
    organizationId: text(input.organizationId, 'entitlementRevocation.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
    productId: text(input.productId, 'entitlementRevocation.productId', { maximum: 69, pattern: PRODUCT_ID }),
    reasonCode: reason(input.reasonCode, 'entitlementRevocation.reasonCode'),
    revokedAt: timestamp(input.revokedAt, 'entitlementRevocation.revokedAt'),
  };
  if (body.schemaVersion !== COMMERCE_SCHEMA_VERSION
    || input.revocationId !== contentId('entrev', body)
    || input.revocationDigest !== digest(body)) fail('REVOCATION_DIGEST_MISMATCH', 'revocation identity does not match its content');
  return deepFreeze({ ...body, revocationId: input.revocationId, revocationDigest: input.revocationDigest });
}

export function createOrderRefundRecord(input) {
  exactKeys(input, new Set(['schemaVersion', 'order', 'reasonCode', 'recordedAt']), 'orderRefundCreate');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported refund record schema');
  const order = normalizeFreeOrder(input.order);
  const recordedAt = timestamp(input.recordedAt, 'orderRefund.recordedAt');
  if (Date.parse(recordedAt) < Date.parse(order.orderedAt)) fail('REFUND_PREDATES_ORDER', 'refund record cannot predate its Order');
  const body = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    orderId: order.orderId,
    orderDigest: order.orderDigest,
    organizationId: order.organizationId,
    productId: order.productId,
    amountMinor: 0,
    reasonCode: reason(input.reasonCode, 'orderRefund.reasonCode'),
    recordedAt,
    settlementStatus: 'not_applicable_free_order',
  };
  return deepFreeze({ ...body, refundId: contentId('refund', body), refundDigest: digest(body) });
}

export function normalizeOrderRefundRecord(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'refundId', 'orderId', 'orderDigest', 'organizationId', 'productId',
    'amountMinor', 'reasonCode', 'recordedAt', 'settlementStatus', 'refundDigest',
  ]), 'orderRefund');
  const body = {
    schemaVersion: input.schemaVersion,
    orderId: text(input.orderId, 'orderRefund.orderId', { maximum: 99, pattern: ORDER_ID }),
    orderDigest: text(input.orderDigest, 'orderRefund.orderDigest', { maximum: 71, pattern: HASH }),
    organizationId: text(input.organizationId, 'orderRefund.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
    productId: text(input.productId, 'orderRefund.productId', { maximum: 69, pattern: PRODUCT_ID }),
    amountMinor: input.amountMinor,
    reasonCode: reason(input.reasonCode, 'orderRefund.reasonCode'),
    recordedAt: timestamp(input.recordedAt, 'orderRefund.recordedAt'),
    settlementStatus: input.settlementStatus,
  };
  if (body.schemaVersion !== COMMERCE_SCHEMA_VERSION || body.amountMinor !== 0
    || body.settlementStatus !== 'not_applicable_free_order'
    || input.refundId !== contentId('refund', body) || input.refundDigest !== digest(body)) {
    fail('REFUND_DIGEST_MISMATCH', 'refund record identity does not match its content');
  }
  return deepFreeze({ ...body, refundId: input.refundId, refundDigest: input.refundDigest });
}
