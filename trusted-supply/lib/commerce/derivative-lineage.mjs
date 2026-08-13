import {
  COMMERCE_SCHEMA_VERSION,
  PRODUCT_ID,
  RELEASE_ID,
  contentId,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  text,
  timestamp,
} from './common.mjs';
import { normalizeEntitlement } from './entitlement.mjs';

export { CommerceDomainError } from './common.mjs';

const CREATE_KEYS = new Set([
  'schemaVersion', 'entitlementId', 'baseReleaseId', 'derivativeProductId',
]);
const LINEAGE_KEYS = new Set([
  'schemaVersion', 'lineageId', 'organizationId', 'baseProductId', 'baseReleaseId',
  'entitlementId', 'entitlementDigest', 'derivativeProductId', 'createdAt', 'lineageDigest',
]);

function resolveEntitlement(entitlementId, resolver) {
  if (typeof resolver !== 'function') fail('TRUSTED_CAPABILITY_REQUIRED', 'entitlementResolver capability is required');
  let raw;
  try { raw = resolver(entitlementId); } catch { fail('ENTITLEMENT_RESOLVER_FAILED', 'trusted Entitlement resolver failed'); }
  const entitlement = normalizeEntitlement(raw);
  if (entitlement.entitlementId !== entitlementId) fail('ENTITLEMENT_RESOLVER_MISMATCH', 'trusted Entitlement resolver returned the wrong identity');
  return entitlement;
}

function trustedNow(now) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed'); }
  if (value instanceof Date) value = value.toISOString();
  return timestamp(value, 'trusted.now');
}

function bodyFrom(input, options) {
  const entitlementId = text(input.entitlementId, 'derivativeLineage.entitlementId', { maximum: 69, pattern: /^ent_[a-f0-9]{64}$/ });
  const entitlement = resolveEntitlement(entitlementId, options.entitlementResolver);
  const baseReleaseId = text(input.baseReleaseId, 'derivativeLineage.baseReleaseId', {
    maximum: 72,
    pattern: RELEASE_ID,
  });
  if (!entitlement.releaseScope.releaseIds.includes(baseReleaseId)
    || (entitlement.constraints.releaseIds.length && !entitlement.constraints.releaseIds.includes(baseReleaseId))) {
    fail('RELEASE_NOT_GRANTED', 'base Release is outside the Entitlement scope');
  }
  if (!entitlement.rights.includes('derive')) {
    fail('DERIVE_RIGHT_REQUIRED', 'Entitlement must explicitly grant derive');
  }
  const createdAt = trustedNow(options.now);
  if (Date.parse(createdAt) < Date.parse(entitlement.validFrom)
    || (entitlement.validUntil && Date.parse(createdAt) >= Date.parse(entitlement.validUntil))) {
    fail('ENTITLEMENT_NOT_CURRENT', 'Entitlement is not current at derivative creation time');
  }
  return {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    organizationId: entitlement.organizationId,
    baseProductId: entitlement.productId,
    baseReleaseId,
    entitlementId: entitlement.entitlementId,
    entitlementDigest: entitlement.entitlementDigest,
    derivativeProductId: text(input.derivativeProductId, 'derivativeLineage.derivativeProductId', {
      maximum: 69,
      pattern: PRODUCT_ID,
    }),
    createdAt,
  };
}

export function createDerivativeLineage(input, options = {}) {
  exactKeys(input, CREATE_KEYS, 'derivativeLineageCreate');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `derivativeLineage schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  }
  const body = bodyFrom(input, options);
  return deepFreeze({
    ...body,
    lineageId: contentId('lineage', body),
    lineageDigest: digest(body),
  });
}

export function normalizeDerivativeLineage(input, options = {}) {
  exactKeys(input, LINEAGE_KEYS, 'derivativeLineage');
  const expected = createDerivativeLineage({
    schemaVersion: input.schemaVersion,
    entitlementId: input.entitlementId,
    baseReleaseId: input.baseReleaseId,
    derivativeProductId: input.derivativeProductId,
  }, { ...options, now: () => input.createdAt });
  if (input.lineageId !== expected.lineageId
    || input.lineageDigest !== expected.lineageDigest
    || input.organizationId !== expected.organizationId
    || input.baseProductId !== expected.baseProductId
    || input.entitlementId !== expected.entitlementId
    || input.entitlementDigest !== expected.entitlementDigest) {
    fail('LINEAGE_DIGEST_MISMATCH', 'derivative lineage does not match trusted Entitlement evidence');
  }
  return expected;
}
