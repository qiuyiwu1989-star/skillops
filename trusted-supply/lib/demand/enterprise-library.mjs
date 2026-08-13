import {
  COMMERCE_SCHEMA_VERSION,
  ORGANIZATION_ID,
  clone,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  text,
  timestamp,
} from '../commerce/common.mjs';
import { normalizeEntitlement } from '../commerce/entitlement.mjs';
import { normalizeEntitlementRevocation } from '../commerce/lifecycle.mjs';
import { normalizeFreeOrder } from '../commerce/order.mjs';

const LIBRARY_SCHEMA_VERSION = 1;
const RELEASE_STATUSES = new Set(['published', 'withdrawn', 'recalled', 'revoked', 'unavailable']);
const ITEM_STATUSES = new Set(['callable', 'withdrawn', 'recalled', 'revoked', 'expired', 'not_yet_valid', 'unavailable']);
const ABILITY_TYPES = new Set(['skill', 'application', 'unknown']);
const FORBIDDEN = ['candidate', 'storageref', 'localpath', 'prompt', 'output', 'token', 'secret', 'receipt', 'subjectdigest', 'principalid'];

export class EnterpriseLibraryError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EnterpriseLibraryError';
    this.code = code;
  }
}

function libraryFail(code, message, cause) {
  throw new EnterpriseLibraryError(code, message, cause);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) libraryFail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function capability(options, name) {
  if (typeof options?.[name] !== 'function') libraryFail('TRUSTED_CAPABILITY_REQUIRED', `${name} capability is required`);
  return options[name];
}

function authorizeOrganization(authorizer) {
  let decision;
  try { decision = authorizer({ purpose: 'enterprise_library.read' }); } catch (cause) {
    libraryFail('ORGANIZATION_AUTHORIZER_FAILED', 'trusted organization authorizer failed', cause);
  }
  if (!decision || typeof decision !== 'object' || decision.decision !== 'allow') {
    libraryFail('ORGANIZATION_FORBIDDEN', 'enterprise library access is not authorized');
  }
  try {
    return text(decision.organizationId, 'organizationAuthorization.organizationId', { maximum: 99, pattern: ORGANIZATION_ID });
  } catch (cause) {
    libraryFail('ORGANIZATION_AUTHORIZATION_INVALID', cause.message, cause);
  }
}

function trustedNow(now) {
  if (typeof now !== 'function') libraryFail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  try {
    const value = now();
    return timestamp(value instanceof Date ? value.toISOString() : value, 'trusted.now');
  } catch (cause) {
    libraryFail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause);
  }
}

function resolveRelease(publicationResolver, releaseId, productId) {
  if (!publicationResolver || typeof publicationResolver.resolveAccessRelease !== 'function') {
    libraryFail('PUBLICATION_RESOLVER_REQUIRED', 'trusted Publication access resolver is required');
  }
  let resolved;
  try { resolved = publicationResolver.resolveAccessRelease(releaseId); } catch (cause) {
    libraryFail('PUBLICATION_RESOLVER_FAILED', 'trusted Publication resolver failed', cause);
  }
  if (resolved == null) return { releaseId, productId, status: 'unavailable' };
  if (typeof resolved !== 'object' || resolved.releaseId !== releaseId || resolved.productId !== productId
    || !RELEASE_STATUSES.has(resolved.status)) {
    libraryFail('PUBLICATION_RESOLVER_MISMATCH', 'trusted Publication resolver returned a mismatched Release');
  }
  return { releaseId, productId, status: resolved.status };
}

function resolveProduct(productResolver, productId) {
  if (productResolver === undefined) return { productId, abilityType: 'unknown', titleZh: '未命名能力' };
  if (typeof productResolver !== 'function') libraryFail('PRODUCT_RESOLVER_INVALID', 'trusted Product resolver must be a function');
  let product;
  try { product = productResolver(productId); } catch (cause) {
    libraryFail('PRODUCT_RESOLVER_FAILED', 'trusted Product resolver failed', cause);
  }
  if (!product || typeof product !== 'object' || product.productId !== productId) {
    libraryFail('PRODUCT_RESOLVER_MISMATCH', 'trusted Product resolver returned the wrong identity');
  }
  const abilityType = product.abilityType ?? 'unknown';
  if (!ABILITY_TYPES.has(abilityType)) libraryFail('PRODUCT_RESOLVER_MISMATCH', 'trusted Product resolver returned an invalid ability type');
  const titleZh = product.titleZh == null ? '未命名能力' : text(product.titleZh, 'product.titleZh', { maximum: 120 });
  return { productId, abilityType, titleZh };
}

function normalizeProjectionSource(input) {
  object(input, 'marketProjection');
  for (const key of ['orders', 'entitlements', 'entitlementLifecycle']) object(input[key], `marketProjection.${key}`);
  if (typeof input.acquisitionRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.acquisitionRevision)
    || typeof input.marketProjectionDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.marketProjectionDigest)) {
    libraryFail('MARKET_PROJECTION_ANCHOR_REQUIRED', 'enterprise library requires a persisted acquisition revision and projection digest');
  }
  const { marketProjectionDigest, ...body } = input;
  if (digest(body) !== marketProjectionDigest) libraryFail('MARKET_PROJECTION_DIGEST_MISMATCH', 'market projection digest is invalid');
  return input;
}

function resolveTrustedMarketProjection(input, resolver) {
  const source = normalizeProjectionSource(input);
  if (typeof resolver !== 'function') libraryFail('MARKET_PROJECTION_RESOLVER_REQUIRED', 'trusted persisted market projection resolver is required');
  let resolved;
  try { resolved = resolver(source.acquisitionRevision); } catch (cause) {
    libraryFail('MARKET_PROJECTION_RESOLVER_FAILED', 'trusted persisted market projection resolver failed', cause);
  }
  if (!resolved || typeof resolved !== 'object') libraryFail('MARKET_PROJECTION_NOT_FOUND', 'persisted market projection was not found');
  const trusted = normalizeProjectionSource(resolved);
  if (trusted.acquisitionRevision !== source.acquisitionRevision
    || trusted.marketProjectionDigest !== source.marketProjectionDigest
    || digest(trusted) !== digest(source)) {
    libraryFail('MARKET_PROJECTION_MISMATCH', 'market projection does not exactly match persisted ledger state');
  }
  return trusted;
}

function statusOf(entitlement, lifecycle, releaseStates, at) {
  if (!lifecycle || !['active', 'revoked'].includes(lifecycle.status)) {
    libraryFail('ENTITLEMENT_LIFECYCLE_INVALID', 'enterprise library requires a trusted Entitlement lifecycle state');
  }
  if (lifecycle.status === 'revoked') {
    let revocation;
    try { revocation = normalizeEntitlementRevocation(lifecycle.revocation); } catch (cause) {
      libraryFail('ENTITLEMENT_LIFECYCLE_INVALID', 'revoked Entitlement lifecycle evidence is invalid', cause);
    }
    if (revocation.entitlementId !== entitlement.entitlementId
      || revocation.entitlementDigest !== entitlement.entitlementDigest
      || revocation.organizationId !== entitlement.organizationId
      || revocation.productId !== entitlement.productId) {
      libraryFail('ENTITLEMENT_LIFECYCLE_MISMATCH', 'Entitlement revocation is bound to another grant');
    }
    return { status: 'revoked', callable: false, blockReason: 'ENTITLEMENT_REVOKED' };
  }
  if (Date.parse(at) < Date.parse(entitlement.validFrom)) return { status: 'not_yet_valid', callable: false, blockReason: 'NOT_YET_VALID' };
  if (entitlement.validUntil && Date.parse(at) >= Date.parse(entitlement.validUntil)) return { status: 'expired', callable: false, blockReason: 'EXPIRED' };
  if (releaseStates.some(release => release.status === 'revoked')) {
    return { status: 'revoked', callable: false, blockReason: 'RELEASE_REVOKED' };
  }
  if (releaseStates.some(release => release.status === 'recalled')) {
    return { status: 'recalled', callable: false, blockReason: 'RELEASE_RECALLED' };
  }
  if (releaseStates.some(release => release.status === 'unavailable')) {
    return { status: 'unavailable', callable: false, blockReason: 'RELEASE_UNAVAILABLE' };
  }
  if (releaseStates.some(release => release.status === 'withdrawn')) {
    return { status: 'withdrawn', callable: true, blockReason: null };
  }
  return { status: 'callable', callable: true, blockReason: null };
}

function normalizeLifecycle(input, entitlement) {
  object(input, 'enterpriseLibrary.item.entitlementLifecycle');
  exactKeys(input, new Set(['status', 'revocation']), 'enterpriseLibrary.item.entitlementLifecycle');
  if (!['active', 'revoked'].includes(input.status)) libraryFail('ENTITLEMENT_LIFECYCLE_INVALID', 'enterprise library lifecycle status is invalid');
  if (input.status === 'active') {
    if (input.revocation !== null) libraryFail('ENTITLEMENT_LIFECYCLE_INVALID', 'active Entitlement cannot carry revocation evidence');
    return { status: 'active', revocation: null };
  }
  let revocation;
  try { revocation = normalizeEntitlementRevocation(input.revocation); } catch (cause) {
    libraryFail('ENTITLEMENT_LIFECYCLE_INVALID', 'revoked Entitlement lifecycle evidence is invalid', cause);
  }
  if (revocation.entitlementId !== entitlement.entitlementId
    || revocation.entitlementDigest !== entitlement.entitlementDigest
    || revocation.organizationId !== entitlement.organizationId
    || revocation.productId !== entitlement.productId) {
    libraryFail('ENTITLEMENT_LIFECYCLE_MISMATCH', 'Entitlement revocation is bound to another grant');
  }
  return { status: 'revoked', revocation };
}

function safeCheck(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const forbidden of FORBIDDEN) {
    if (serialized.includes(forbidden)) libraryFail('PRIVATE_VALUE', `enterprise library contains forbidden ${forbidden}`);
  }
}

function normalizeReleaseItem(input, productId) {
  object(input, 'enterpriseLibrary.release');
  try {
    exactKeys(input, new Set(['releaseId', 'productId', 'status']), 'enterpriseLibrary.release');
    const releaseId = text(input.releaseId, 'enterpriseLibrary.release.releaseId', { maximum: 72, pattern: /^(?:rel|apprel)_[a-f0-9]{64}$/ });
    if (input.productId !== productId || !RELEASE_STATUSES.has(input.status)) libraryFail('RELEASE_BINDING_INVALID', 'enterprise library Release binding is invalid');
    return { releaseId, productId, status: input.status };
  } catch (cause) {
    if (cause instanceof EnterpriseLibraryError) throw cause;
    libraryFail(cause.code ?? 'INVALID_RELEASE', cause.message, cause);
  }
}

function normalizeItem(input, organizationId, generatedAt) {
  object(input, 'enterpriseLibrary.item');
  try {
    exactKeys(input, new Set([
      'entitlementId', 'entitlementDigest', 'organizationId', 'productId', 'abilityType', 'titleZh',
      'releaseIds', 'releases', 'rights', 'constraints', 'validFrom', 'validUntil', 'sourceOrder',
      'status', 'callable', 'blockReason', 'entitlement', 'entitlementLifecycle',
    ]), 'enterpriseLibrary.item');
    const entitlement = normalizeEntitlement(input.entitlement);
    if (entitlement.organizationId !== organizationId || input.organizationId !== organizationId
      || input.entitlementId !== entitlement.entitlementId || input.entitlementDigest !== entitlement.entitlementDigest
      || input.productId !== entitlement.productId || digest(input.releaseIds) !== digest(entitlement.releaseScope.releaseIds)
      || digest(input.rights) !== digest(entitlement.rights) || digest(input.constraints) !== digest(entitlement.constraints)
      || input.validFrom !== entitlement.validFrom || input.validUntil !== entitlement.validUntil) {
      libraryFail('ENTITLEMENT_BINDING_INVALID', 'enterprise library item is not bound to its canonical Entitlement');
    }
    if (!ABILITY_TYPES.has(input.abilityType) || typeof input.titleZh !== 'string' || !input.titleZh.trim()) {
      libraryFail('PRODUCT_METADATA_INVALID', 'enterprise library Product metadata is invalid');
    }
    if (!Array.isArray(input.releases) || input.releases.length !== entitlement.releaseScope.releaseIds.length) {
      libraryFail('RELEASE_BINDING_INVALID', 'enterprise library Release set is invalid');
    }
    const releases = input.releases.map(release => normalizeReleaseItem(release, entitlement.productId));
    if (digest(releases.map(release => release.releaseId).sort()) !== digest(entitlement.releaseScope.releaseIds)) {
      libraryFail('RELEASE_BINDING_INVALID', 'enterprise library Release identities are invalid');
    }
    object(input.sourceOrder, 'enterpriseLibrary.item.sourceOrder');
    exactKeys(input.sourceOrder, new Set(['orderId', 'orderDigest', 'offerRevisionId']), 'enterpriseLibrary.item.sourceOrder');
    if (input.sourceOrder.orderId !== entitlement.sourceOrderId
      || input.sourceOrder.orderDigest !== entitlement.sourceOrderDigest
      || input.sourceOrder.offerRevisionId !== entitlement.offerRevisionId) {
      libraryFail('ORDER_BINDING_INVALID', 'enterprise library source Order is invalid');
    }
    if (!ITEM_STATUSES.has(input.status) || typeof input.callable !== 'boolean'
      || (input.callable && input.blockReason !== null)
      || (!input.callable && (typeof input.blockReason !== 'string' || !input.blockReason))) {
      libraryFail('ITEM_STATUS_INVALID', 'enterprise library status is invalid');
    }
    const entitlementLifecycle = normalizeLifecycle(input.entitlementLifecycle, entitlement);
    const effective = statusOf(entitlement, entitlementLifecycle, releases, generatedAt);
    if (input.status !== effective.status || input.callable !== effective.callable || input.blockReason !== effective.blockReason) {
      libraryFail('ITEM_STATUS_MISMATCH', 'enterprise library status does not match its frozen lifecycle evidence');
    }
    return deepFreeze({ ...clone(input), releases, entitlementLifecycle });
  } catch (cause) {
    if (cause instanceof EnterpriseLibraryError) throw cause;
    libraryFail(cause.code ?? 'INVALID_LIBRARY_ITEM', cause.message, cause);
  }
}

export function normalizeEnterpriseLibraryProjection(input) {
  object(input, 'enterpriseLibrary');
  try {
    exactKeys(input, new Set([
      'schemaVersion', 'generatedAt', 'organizationId', 'summary', 'items', 'projectionDigest',
    ]), 'enterpriseLibrary');
    if (input.schemaVersion !== LIBRARY_SCHEMA_VERSION) libraryFail('UNSUPPORTED_SCHEMA', 'enterprise library schema is unsupported');
    const generatedAt = timestamp(input.generatedAt, 'enterpriseLibrary.generatedAt');
    const organizationId = text(input.organizationId, 'enterpriseLibrary.organizationId', { maximum: 99, pattern: ORGANIZATION_ID });
    if (!Array.isArray(input.items) || input.items.length > 100_000) libraryFail('INVALID_ITEMS', 'enterprise library items are invalid or too large');
    const items = input.items.map(item => normalizeItem(item, organizationId, generatedAt)).sort((a, b) => a.entitlementId.localeCompare(b.entitlementId));
    if (new Set(items.map(item => item.entitlementId)).size !== items.length) libraryFail('DUPLICATE_ENTITLEMENT', 'enterprise library contains duplicate Entitlements');
    object(input.summary, 'enterpriseLibrary.summary');
    exactKeys(input.summary, new Set(['total', 'callable', 'blocked', 'withdrawn']), 'enterpriseLibrary.summary');
    const expectedSummary = {
      total: items.length,
      callable: items.filter(item => item.callable).length,
      blocked: items.filter(item => !item.callable).length,
      withdrawn: items.filter(item => item.status === 'withdrawn').length,
    };
    if (digest(input.summary) !== digest(expectedSummary)) libraryFail('SUMMARY_MISMATCH', 'enterprise library summary is invalid');
    const body = { schemaVersion: LIBRARY_SCHEMA_VERSION, generatedAt, organizationId, summary: expectedSummary, items };
    if (input.projectionDigest !== digest(body)) libraryFail('PROJECTION_DIGEST_MISMATCH', 'enterprise library projection digest is invalid');
    safeCheck(body);
    return deepFreeze({ ...body, projectionDigest: digest(body) });
  } catch (cause) {
    if (cause instanceof EnterpriseLibraryError) throw cause;
    libraryFail(cause.code ?? 'INVALID_PROJECTION', cause.message, cause);
  }
}

export function projectEnterpriseLibrary(marketProjection, options = {}) {
  const source = resolveTrustedMarketProjection(marketProjection, options.marketProjectionResolver);
  const organizationId = authorizeOrganization(capability(options, 'organizationAuthorizer'));
  const generatedAt = trustedNow(options.now);
  const items = [];
  for (const rawEntitlement of Object.values(source.entitlements)) {
    let entitlement;
    try { entitlement = normalizeEntitlement(rawEntitlement); } catch (cause) {
      libraryFail(cause.code ?? 'INVALID_ENTITLEMENT', cause.message, cause);
    }
    if (entitlement.organizationId !== organizationId) continue;
    const orderRaw = source.orders[entitlement.sourceOrderId];
    let order;
    try { order = normalizeFreeOrder(orderRaw); } catch (cause) {
      libraryFail('SOURCE_ORDER_INVALID', 'enterprise library Entitlement source Order is missing or invalid', cause);
    }
    if (order.orderDigest !== entitlement.sourceOrderDigest || order.organizationId !== organizationId
      || order.productId !== entitlement.productId) {
      libraryFail('SOURCE_ORDER_MISMATCH', 'enterprise library Entitlement source Order is mismatched');
    }
    const releases = entitlement.releaseScope.releaseIds.map(releaseId => (
      resolveRelease(options.publicationResolver, releaseId, entitlement.productId)
    ));
    const lifecycle = source.entitlementLifecycle[entitlement.entitlementId];
    const effective = statusOf(entitlement, lifecycle, releases, generatedAt);
    const entitlementLifecycle = lifecycle.status === 'revoked'
      ? { status: 'revoked', revocation: clone(lifecycle.revocation) }
      : { status: 'active', revocation: null };
    const product = resolveProduct(options.productResolver, entitlement.productId);
    items.push({
      entitlementId: entitlement.entitlementId,
      entitlementDigest: entitlement.entitlementDigest,
      organizationId,
      productId: entitlement.productId,
      abilityType: product.abilityType,
      titleZh: product.titleZh,
      releaseIds: clone(entitlement.releaseScope.releaseIds),
      releases,
      rights: clone(entitlement.rights),
      constraints: clone(entitlement.constraints),
      validFrom: entitlement.validFrom,
      validUntil: entitlement.validUntil,
      sourceOrder: {
        orderId: entitlement.sourceOrderId,
        orderDigest: entitlement.sourceOrderDigest,
        offerRevisionId: entitlement.offerRevisionId,
      },
      status: effective.status,
      callable: effective.callable,
      blockReason: effective.blockReason,
      entitlement: clone(entitlement),
      entitlementLifecycle,
    });
  }
  items.sort((a, b) => a.entitlementId.localeCompare(b.entitlementId));
  const summary = {
    total: items.length,
    callable: items.filter(item => item.callable).length,
    blocked: items.filter(item => !item.callable).length,
    withdrawn: items.filter(item => item.status === 'withdrawn').length,
  };
  const body = { schemaVersion: LIBRARY_SCHEMA_VERSION, generatedAt, organizationId, summary, items };
  safeCheck(body);
  return normalizeEnterpriseLibraryProjection({ ...body, projectionDigest: digest(body) });
}

export function createEnterpriseLibraryResolver(projectionInput) {
  const projection = normalizeEnterpriseLibraryProjection(projectionInput);
  const byId = new Map(projection.items.map(item => [item.entitlementId, item]));
  return deepFreeze({
    organizationId: projection.organizationId,
    projectionDigest: projection.projectionDigest,
    resolveEntitlement(entitlementId) {
      const item = byId.get(entitlementId);
      return item ? clone(item) : null;
    },
    listCallable() {
      return clone(projection.items.filter(item => item.callable));
    },
  });
}
