import {
  COMMERCE_SCHEMA_VERSION,
  OFFER_ID,
  PRODUCT_ID,
  contentId,
  deepFreeze,
  exactKeys,
  fail,
  integer,
  text,
  timestamp,
} from './common.mjs';
import { normalizeLicensePolicy } from './license-policy.mjs';

export { CommerceDomainError } from './common.mjs';

export const PRICING_MODELS = Object.freeze(['free', 'one_time', 'subscription', 'metered', 'quote']);

const PRICING_MODEL = new Set(PRICING_MODELS);
const OFFER_KEYS = new Set(['schemaVersion', 'offerId', 'productId', 'pricing', 'licensePolicy', 'effectiveAt']);
const REVISION_KEYS = new Set(['schemaVersion', 'pricing', 'licensePolicy', 'effectiveAt']);
const PRICING_KEYS = new Set(['model', 'currency', 'amountMinor']);

function normalizePricing(input) {
  exactKeys(input, PRICING_KEYS, 'pricing');
  const model = text(input.model, 'pricing.model', { maximum: 32 });
  if (!PRICING_MODEL.has(model)) fail('INVALID_PRICING_MODEL', `unsupported pricing model: ${model}`);
  const currency = text(input.currency, 'pricing.currency', { maximum: 3 });
  if (currency !== 'CNY') fail('INVALID_CURRENCY', 'V4.3 pricing currency must be CNY');
  const amountMinor = integer(input.amountMinor, 'pricing.amountMinor', { minimum: 0 });
  if (model === 'free' && amountMinor !== 0) fail('INVALID_FREE_PRICE', 'free Offer amountMinor must be 0');
  if (!['free', 'quote'].includes(model) && amountMinor === 0) fail('INVALID_PAID_PRICE', `${model} Offer amountMinor must be greater than 0`);
  return { model, currency, amountMinor };
}

function revisionBody({ offerId, productId, revision, pricing, licensePolicy, effectiveAt }) {
  return {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    offerId,
    productId,
    revision,
    status: 'active',
    pricing,
    licensePolicy,
    effectiveAt,
  };
}

function freezeRevision(body) {
  const offerRevisionId = contentId('offrev', body);
  return deepFreeze({ ...body, offerRevisionId });
}

export function createOffer(input) {
  exactKeys(input, OFFER_KEYS, 'offer');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `offer schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  const offerId = text(input.offerId, 'offer.offerId', { maximum: 101, pattern: OFFER_ID });
  const productId = text(input.productId, 'offer.productId', { maximum: 69, pattern: PRODUCT_ID });
  return freezeRevision(revisionBody({
    offerId,
    productId,
    revision: 1,
    pricing: normalizePricing(input.pricing),
    licensePolicy: normalizeLicensePolicy(input.licensePolicy),
    effectiveAt: timestamp(input.effectiveAt, 'offer.effectiveAt'),
  }));
}

export function reviseOffer(previous, input) {
  exactKeys(input, REVISION_KEYS, 'offerRevision');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `offerRevision schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  const current = normalizeOfferRevision(previous);
  const effectiveAt = timestamp(input.effectiveAt, 'offerRevision.effectiveAt');
  if (Date.parse(effectiveAt) <= Date.parse(current.effectiveAt)) fail('REVISION_TIME_CONFLICT', 'revised Offer must become effective after the previous revision');
  return freezeRevision(revisionBody({
    offerId: current.offerId,
    productId: current.productId,
    revision: current.revision + 1,
    pricing: input.pricing === undefined ? current.pricing : normalizePricing(input.pricing),
    licensePolicy: input.licensePolicy === undefined ? current.licensePolicy : normalizeLicensePolicy(input.licensePolicy),
    effectiveAt,
  }));
}

export function normalizeOfferRevision(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'offerId', 'productId', 'revision', 'status', 'pricing',
    'licensePolicy', 'effectiveAt', 'offerRevisionId',
  ]), 'offerRevision');
  if (input.schemaVersion !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `offerRevision schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  if (input.status !== 'active') fail('OFFER_NOT_ACTIVE', 'Offer revision is not active');
  const body = revisionBody({
    offerId: text(input.offerId, 'offerRevision.offerId', { maximum: 101, pattern: OFFER_ID }),
    productId: text(input.productId, 'offerRevision.productId', { maximum: 69, pattern: PRODUCT_ID }),
    revision: integer(input.revision, 'offerRevision.revision', { minimum: 1 }),
    pricing: normalizePricing(input.pricing),
    licensePolicy: normalizeLicensePolicy(input.licensePolicy),
    effectiveAt: timestamp(input.effectiveAt, 'offerRevision.effectiveAt'),
  });
  const expected = contentId('offrev', body);
  if (input.offerRevisionId !== expected) fail('OFFER_REVISION_DIGEST_MISMATCH', 'Offer revision identity does not match its frozen content');
  return freezeRevision(body);
}

export function isOfferExecutable(offerRevision) {
  try {
    return normalizeOfferRevision(offerRevision).pricing.model === 'free';
  } catch {
    return false;
  }
}
