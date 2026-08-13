import {
  COMMERCE_SCHEMA_VERSION,
  ORDER_ID,
  ORGANIZATION_ID,
  PRODUCT_ID,
  RELEASE_ID,
  SAFE_IDENTIFIER,
  clone,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  text,
  timestamp,
  uniqueStrings,
} from './common.mjs';
import { normalizeOfferRevision } from './offer.mjs';

export { CommerceDomainError } from './common.mjs';

const ORDER_KEYS = new Set([
  'schemaVersion', 'orderId', 'organizationId', 'productId', 'releaseScope',
  'offerRevisionId', 'idempotencyKey',
]);
const RELEASE_SCOPE_KEYS = new Set(['releaseIds']);

function trustedNow(now) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed'); }
  if (value instanceof Date) value = value.toISOString();
  return timestamp(value, 'trusted.now');
}

function capability(options, name) {
  if (typeof options?.[name] !== 'function') fail('TRUSTED_CAPABILITY_REQUIRED', `${name} capability is required`);
  return options[name];
}

function invoke(resolver, argument, failureCode, label) {
  try { return resolver(argument); } catch { fail(failureCode, `${label} failed`); }
}

function resolveOffer(offerRevisionId, resolver) {
  const resolved = invoke(resolver, offerRevisionId, 'OFFER_RESOLVER_FAILED', 'trusted Offer resolver');
  if (!resolved || typeof resolved !== 'object') fail('OFFER_RESOLVER_MISMATCH', 'trusted Offer resolver returned no Offer');
  const offerRevision = normalizeOfferRevision(resolved.offerRevision);
  if (offerRevision.offerRevisionId !== offerRevisionId || resolved.currentOfferRevisionId !== offerRevisionId) {
    fail('OFFER_NOT_CURRENT', 'trusted Offer resolver must return the requested current revision');
  }
  return offerRevision;
}

function assertPublishedIdentity(resolver, id, kind, productId) {
  const resolved = invoke(resolver, id, `${kind.toUpperCase()}_RESOLVER_FAILED`, `trusted ${kind} resolver`);
  if (!resolved || typeof resolved !== 'object' || resolved[`${kind}Id`] !== id) fail(`${kind.toUpperCase()}_RESOLVER_MISMATCH`, `trusted ${kind} resolver returned the wrong identity`);
  if (resolved.status !== 'published') fail(`${kind.toUpperCase()}_NOT_PUBLISHED`, `${kind} must be published before a new Order`);
  if (kind === 'release' && resolved.productId !== productId) fail('RELEASE_PRODUCT_MISMATCH', 'Release resolver must bind the Release to the ordered Product');
}

function buildOrder(input, offerRevision, orderedAt) {
  exactKeys(input, ORDER_KEYS, 'freeOrder');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `freeOrder schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  if (offerRevision.pricing.model !== 'free' || offerRevision.pricing.amountMinor !== 0) {
    fail('PAID_ORDER_NOT_EXECUTABLE', 'V4.3 cannot execute or mark a paid Offer as paid');
  }
  exactKeys(input.releaseScope, RELEASE_SCOPE_KEYS, 'freeOrder.releaseScope');
  const orderId = text(input.orderId, 'freeOrder.orderId', { maximum: 99, pattern: ORDER_ID });
  const organizationId = text(input.organizationId, 'freeOrder.organizationId', { maximum: 99, pattern: ORGANIZATION_ID });
  const productId = text(input.productId, 'freeOrder.productId', { maximum: 69, pattern: PRODUCT_ID });
  const offerRevisionId = text(input.offerRevisionId, 'freeOrder.offerRevisionId', { maximum: 71, pattern: /^offrev_[a-f0-9]{64}$/ });
  if (offerRevisionId !== offerRevision.offerRevisionId) fail('OFFER_REVISION_MISMATCH', 'Order Offer revision identity does not match trusted Offer');
  if (productId !== offerRevision.productId) fail('PRODUCT_MISMATCH', 'Order productId must match Offer productId');
  const releaseIds = uniqueStrings(input.releaseScope.releaseIds, 'freeOrder.releaseScope.releaseIds', { pattern: RELEASE_ID, nonEmpty: true });
  const constrainedReleases = offerRevision.licensePolicy.constraints.releaseIds;
  if (constrainedReleases.length && releaseIds.some(releaseId => !constrainedReleases.includes(releaseId))) {
    fail('RELEASE_NOT_OFFERED', 'Order release scope exceeds the Offer license policy');
  }
  const constrainedOrganizations = offerRevision.licensePolicy.constraints.organizationIds;
  if (constrainedOrganizations.length && !constrainedOrganizations.includes(organizationId)) {
    fail('ORGANIZATION_NOT_OFFERED', 'Order organization is outside the Offer license policy');
  }
  const idempotencyKey = text(input.idempotencyKey, 'freeOrder.idempotencyKey', { maximum: 128, pattern: SAFE_IDENTIFIER });
  if (Date.parse(orderedAt) < Date.parse(offerRevision.effectiveAt)) fail('OFFER_NOT_EFFECTIVE', 'Order predates the Offer revision effective time');
  const request = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    orderId,
    organizationId,
    productId,
    releaseScope: { releaseIds },
    offerRevisionId,
    idempotencyKey,
    orderedAt,
  };
  const body = {
    ...request,
    status: 'granted',
    priceSnapshot: clone(offerRevision.pricing),
    licensePolicySnapshot: clone(offerRevision.licensePolicy),
    offerSnapshot: clone(offerRevision),
  };
  return deepFreeze({ ...body, requestDigest: digest(request), orderDigest: digest(body) });
}

export function createFreeOrder(input, options = {}) {
  exactKeys(input, ORDER_KEYS, 'freeOrder');
  const offerRevisionId = text(input.offerRevisionId, 'freeOrder.offerRevisionId', { maximum: 71, pattern: /^offrev_[a-f0-9]{64}$/ });
  const offerRevision = resolveOffer(offerRevisionId, capability(options, 'offerResolver'));
  const productId = text(input.productId, 'freeOrder.productId', { maximum: 69, pattern: PRODUCT_ID });
  assertPublishedIdentity(capability(options, 'productResolver'), productId, 'product', productId);
  exactKeys(input.releaseScope, RELEASE_SCOPE_KEYS, 'freeOrder.releaseScope');
  const releaseIds = uniqueStrings(input.releaseScope.releaseIds, 'freeOrder.releaseScope.releaseIds', { pattern: RELEASE_ID, nonEmpty: true });
  const releaseResolver = capability(options, 'releaseResolver');
  for (const releaseId of releaseIds) assertPublishedIdentity(releaseResolver, releaseId, 'release', productId);
  return buildOrder(input, offerRevision, trustedNow(options.now));
}

export function normalizeFreeOrder(input) {
  exactKeys(input, new Set([
    ...ORDER_KEYS, 'status', 'priceSnapshot', 'licensePolicySnapshot', 'offerSnapshot',
    'orderedAt', 'requestDigest', 'orderDigest',
  ]), 'order');
  if (input.status !== 'granted') fail('ORDER_NOT_GRANTED', 'Order must have granted status');
  const offerRevision = normalizeOfferRevision(input.offerSnapshot);
  const rebuilt = buildOrder({
    schemaVersion: input.schemaVersion,
    orderId: input.orderId,
    organizationId: input.organizationId,
    productId: input.productId,
    releaseScope: input.releaseScope,
    offerRevisionId: input.offerRevisionId,
    idempotencyKey: input.idempotencyKey,
  }, offerRevision, timestamp(input.orderedAt, 'order.orderedAt'));
  if (input.offerRevisionId !== rebuilt.offerRevisionId
      || digest(input.priceSnapshot) !== digest(rebuilt.priceSnapshot)
      || digest(input.licensePolicySnapshot) !== digest(rebuilt.licensePolicySnapshot)
      || input.requestDigest !== rebuilt.requestDigest
      || input.orderDigest !== rebuilt.orderDigest) {
    fail('ORDER_DIGEST_MISMATCH', 'Order frozen evidence does not match its identity');
  }
  return rebuilt;
}
