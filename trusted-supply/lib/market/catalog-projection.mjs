import { canonicalDigest, normalizeRelease } from '../registry-identity.mjs';
import { normalizeOfferRevision } from '../commerce/offer.mjs';
import { toPublicMarketValue } from './domain.mjs';

export class MarketCatalogProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketCatalogProjectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketCatalogProjectionError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'catalog input must be an object');
  const unknown = Object.keys(input).filter(key => !['publishers', 'products', 'registryReleases', 'applicationReleases', 'offers', 'generatedAt'].includes(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `catalog input contains unknown fields: ${unknown.join(', ')}`);
  for (const key of ['publishers', 'products', 'registryReleases', 'applicationReleases', 'offers']) {
    if (!Array.isArray(input[key]) || input[key].length > 10_000) fail('INVALID_ARRAY', `${key} must be an array within limits`);
  }
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) fail('INVALID_TIMESTAMP', 'generatedAt must be a valid timestamp');
}

function unique(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = value[key];
    if (seen.has(identity)) fail('DUPLICATE_IDENTITY', `${label} contains duplicate ${key}: ${identity}`);
    seen.add(identity);
  }
}

function publicRegistryRelease(input) {
  let release;
  try { release = normalizeRelease(input); } catch (cause) { fail('REGISTRY_RELEASE_INVALID', cause.message); }
  const { storageRef: _privateStorageRef, ...packageValue } = release.package;
  return {
    schemaVersion: release.schemaVersion,
    releaseId: release.releaseId,
    skillId: release.skillId,
    version: release.version,
    status: release.status,
    package: packageValue,
    compatibility: release.compatibility,
    assessmentRefs: release.assessmentRefs,
    reviewRefs: release.reviewRefs,
    sourceRefs: release.sourceRefs,
    publishedAt: release.publishedAt,
  };
}

export function createMarketCatalogProjection(input) {
  exactInput(input);
  const publishers = input.publishers.map(toPublicMarketValue);
  const products = input.products.map(toPublicMarketValue);
  const registryReleases = input.registryReleases.map(publicRegistryRelease);
  const applicationReleases = input.applicationReleases.map(toPublicMarketValue);
  const offers = input.offers.map(value => {
    let offer;
    try { offer = normalizeOfferRevision(value); } catch (cause) { fail('OFFER_INVALID', cause.message); }
    return offer;
  });
  unique(publishers, 'publisherId', 'publishers');
  unique(products, 'productId', 'products');
  unique(registryReleases, 'releaseId', 'registryReleases');
  unique(applicationReleases, 'applicationReleaseId', 'applicationReleases');
  unique(offers, 'offerRevisionId', 'offers');
  const publisherIds = new Set(publishers.map(value => value.publisherId));
  const releaseIds = new Set([
    ...registryReleases.map(value => value.releaseId),
    ...applicationReleases.map(value => value.applicationReleaseId),
  ]);
  const productIds = new Set(products.map(value => value.productId));
  const productsById = new Map(products.map(value => [value.productId, value]));
  for (const product of products) {
    if (!publisherIds.has(product.publisherId)) fail('PUBLISHER_NOT_FOUND', `product ${product.productId} has no public publisher`);
    const partyRefs = [
      ...product.parties.creatorPublisherIds,
      product.parties.rightsHolderPublisherId,
      product.parties.payeePublisherId,
      product.parties.supportPublisherId,
    ].filter(Boolean);
    for (const partyId of partyRefs) {
      if (!publisherIds.has(partyId)) fail('PRODUCT_PARTY_NOT_FOUND', `product ${product.productId} references unknown party ${partyId}`);
    }
    if (product.abilityType === 'skill' && !releaseIds.has(product.releaseId)) fail('RELEASE_NOT_FOUND', `skill product ${product.productId} has no Registry Release`);
  }
  for (const release of applicationReleases) {
    if (!productIds.has(release.productId)) fail('PRODUCT_NOT_FOUND', `application release ${release.applicationReleaseId} has no product`);
    for (const dependency of release.bom) {
      if (!productIds.has(dependency.productId) || !releaseIds.has(dependency.releaseId)) {
        fail('DEPENDENCY_NOT_FOUND', `application release ${release.applicationReleaseId} has an unresolved dependency`);
      }
      const dependencyProduct = productsById.get(dependency.productId);
      if (dependencyProduct.abilityType !== 'skill'
        || dependencyProduct.skillId !== dependency.skillId
        || dependencyProduct.releaseId !== dependency.releaseId) {
        fail('DEPENDENCY_PRODUCT_MISMATCH', `application dependency ${dependency.productId} is not bound to its declared Skill Release`);
      }
    }
  }
  for (const offer of offers) if (!productIds.has(offer.productId)) fail('PRODUCT_NOT_FOUND', `Offer ${offer.offerRevisionId} has no product`);
  const data = {
    schemaVersion: 1,
    generatedAt: new Date(Date.parse(input.generatedAt)).toISOString(),
    publishers: publishers.sort((a, b) => a.publisherId.localeCompare(b.publisherId)),
    products: products.sort((a, b) => a.productId.localeCompare(b.productId)),
    registryReleases: registryReleases.sort((a, b) => a.releaseId.localeCompare(b.releaseId)),
    applicationReleases: applicationReleases.sort((a, b) => a.applicationReleaseId.localeCompare(b.applicationReleaseId)),
    offers: offers.sort((a, b) => a.offerRevisionId.localeCompare(b.offerRevisionId)),
  };
  return deepFreeze({ ...structuredClone(data), catalogDigest: canonicalDigest(data) });
}
