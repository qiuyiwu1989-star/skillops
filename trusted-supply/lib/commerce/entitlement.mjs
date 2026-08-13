import {
  COMMERCE_SCHEMA_VERSION,
  ENTITLEMENT_ID,
  ORDER_ID,
  ORGANIZATION_ID,
  PRODUCT_ID,
  RELEASE_ID,
  clone,
  compareTime,
  contentId,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  optionalTimestamp,
  text,
  timestamp,
  uniqueStrings,
} from './common.mjs';
import { normalizeLicensePolicy } from './license-policy.mjs';
import { normalizeFreeOrder } from './order.mjs';

export { CommerceDomainError } from './common.mjs';

const ISSUE_KEYS = new Set(['schemaVersion', 'order', 'issuedAt', 'validUntil']);

function effectiveValidity(order, issuedAt, requestedValidUntil) {
  const constraints = order.licensePolicySnapshot.constraints;
  const validFrom = constraints.validFrom && compareTime(constraints.validFrom, issuedAt) > 0 ? constraints.validFrom : issuedAt;
  const candidates = [constraints.validUntil, requestedValidUntil].filter(Boolean);
  const validUntil = candidates.sort(compareTime)[0] ?? null;
  if (validUntil && compareTime(validUntil, validFrom) <= 0) fail('INVALID_VALIDITY_WINDOW', 'Entitlement validUntil must be later than validFrom');
  return { validFrom, validUntil };
}

export function issueEntitlement(input) {
  exactKeys(input, ISSUE_KEYS, 'entitlementIssue');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `entitlementIssue schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  const order = normalizeFreeOrder(input.order);
  const issuedAt = timestamp(input.issuedAt, 'entitlementIssue.issuedAt');
  if (Date.parse(issuedAt) < Date.parse(order.orderedAt)) fail('ENTITLEMENT_PREDATES_ORDER', 'Entitlement cannot predate its source Order');
  const requestedValidUntil = optionalTimestamp(input.validUntil, 'entitlementIssue.validUntil');
  const validity = effectiveValidity(order, issuedAt, requestedValidUntil);
  const body = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    organizationId: order.organizationId,
    productId: order.productId,
    releaseScope: clone(order.releaseScope),
    rights: clone(order.licensePolicySnapshot.rights),
    constraints: clone(order.licensePolicySnapshot.constraints),
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    sourceOrderId: order.orderId,
    sourceOrderDigest: order.orderDigest,
    offerRevisionId: order.offerRevisionId,
    issuedAt,
    status: 'active',
  };
  const entitlementId = contentId('ent', body);
  return deepFreeze({ ...body, entitlementId, entitlementDigest: digest(body) });
}

export function normalizeEntitlement(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'entitlementId', 'organizationId', 'productId', 'releaseScope',
    'rights', 'constraints', 'validFrom', 'validUntil', 'sourceOrderId',
    'sourceOrderDigest', 'offerRevisionId', 'issuedAt', 'status', 'entitlementDigest',
  ]), 'entitlement');
  if (input.schemaVersion !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `entitlement schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  if (input.status !== 'active') fail('ENTITLEMENT_INACTIVE', 'Entitlement is not active');
  const policy = normalizeLicensePolicy({ rights: input.rights, constraints: input.constraints });
  exactKeys(input.releaseScope, new Set(['releaseIds']), 'entitlement.releaseScope');
  const releaseScope = {
    releaseIds: uniqueStrings(input.releaseScope.releaseIds, 'entitlement.releaseScope.releaseIds', { pattern: RELEASE_ID, nonEmpty: true }),
  };
  const body = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    organizationId: text(input.organizationId, 'entitlement.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
    productId: text(input.productId, 'entitlement.productId', { maximum: 69, pattern: PRODUCT_ID }),
    releaseScope,
    rights: clone(policy.rights),
    constraints: clone(policy.constraints),
    validFrom: timestamp(input.validFrom, 'entitlement.validFrom'),
    validUntil: optionalTimestamp(input.validUntil, 'entitlement.validUntil'),
    sourceOrderId: text(input.sourceOrderId, 'entitlement.sourceOrderId', { maximum: 99, pattern: ORDER_ID }),
    sourceOrderDigest: text(input.sourceOrderDigest, 'entitlement.sourceOrderDigest', { maximum: 71, pattern: /^sha256:[a-f0-9]{64}$/ }),
    offerRevisionId: text(input.offerRevisionId, 'entitlement.offerRevisionId', { maximum: 71, pattern: /^offrev_[a-f0-9]{64}$/ }),
    issuedAt: timestamp(input.issuedAt, 'entitlement.issuedAt'),
    status: 'active',
  };
  const expectedId = contentId('ent', body);
  if (!ENTITLEMENT_ID.test(input.entitlementId) || input.entitlementId !== expectedId || input.entitlementDigest !== digest(body)) {
    fail('ENTITLEMENT_DIGEST_MISMATCH', 'Entitlement identity does not match its frozen content');
  }
  return deepFreeze({ ...body, entitlementId: expectedId, entitlementDigest: digest(body) });
}
