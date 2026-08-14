const PRICING_MODELS = new Set(['free', 'one_time', 'subscription', 'contact']);
const OFFER_STATUSES = new Set(['active', 'draft', 'demo', 'withdrawn']);
const PUBLISHER_KINDS = new Set(['individual', 'organization', 'source_owner']);
const SAFE_HANDLE = /^[\p{L}\p{N}._-]{1,80}$/u;
const SAFE_CREATOR_URL = /^\.\/creator\.html(?:\?publisher=[A-Za-z0-9_%.-]+)?$/;
const FORBIDDEN_KEY = /(?:principal|subject|storageRef|filePath|prompt|output|token|secret|password|credential|apiKey)/i;
const FORBIDDEN_VALUE = /(?:file:\/\/|(?:^|[\s:："'(])\/(?:Users|home|etc|opt|srv|var|tmp)\/|(?:^|[\s:："'(])[A-Za-z]:\\|\\\\[^\\]+\\)/i;

function cleanText(value, maximum = 120) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().replace(/[—–]/g, '-');
  if (!normalized || [...normalized].length > maximum || FORBIDDEN_VALUE.test(normalized)) return null;
  return normalized;
}

function isPublicObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) return false;
    if (typeof entry === 'string' && FORBIDDEN_VALUE.test(entry)) return false;
    if (entry && typeof entry === 'object' && !isPublicObject(entry) && !Array.isArray(entry)) return false;
    if (Array.isArray(entry) && entry.some(item => typeof item !== 'string' || !cleanText(item, 64))) return false;
  }
  return true;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function sourceOwner(listing) {
  const repo = cleanText(listing?.source?.repo, 160);
  const owner = repo?.split('/')[0];
  return owner && SAFE_HANDLE.test(owner) ? owner : '来源待确认';
}

export function publisherForListing(listing = {}) {
  const input = listing?.catalog?.publisher;
  if (isPublicObject(input)) {
    const displayNameZh = cleanText(input.displayNameZh, 80);
    const handle = cleanText(input.handle, 80);
    const kind = cleanText(input.kind, 24);
    const verificationLabelZh = cleanText(input.verificationLabelZh, 40);
    const creatorUrl = cleanText(input.creatorUrl, 160);
    if (displayNameZh && handle && SAFE_HANDLE.test(handle) && PUBLISHER_KINDS.has(kind)
      && verificationLabelZh && (!creatorUrl || SAFE_CREATOR_URL.test(creatorUrl))) {
      return freeze({ displayNameZh, handle, kind, verificationLabelZh, creatorUrl: creatorUrl || null, source: 'catalog' });
    }
  }
  const handle = sourceOwner(listing);
  return freeze({
    displayNameZh: handle,
    handle,
    kind: 'source_owner',
    verificationLabelZh: handle === '来源待确认' ? '创作者待认领' : '来自来源仓库',
    creatorUrl: null,
    source: 'fallback',
  });
}

function validPricing(pricing) {
  if (!isPublicObject(pricing)) return null;
  const model = cleanText(pricing.model, 24);
  const currency = cleanText(pricing.currency, 3);
  const labelZh = cleanText(pricing.labelZh, 48);
  if (!PRICING_MODELS.has(model) || !currency || !labelZh
    || !Number.isSafeInteger(pricing.amountMinor) || pricing.amountMinor < 0) return null;
  if (model === 'free' && pricing.amountMinor !== 0) return null;
  return { model, currency, amountMinor: pricing.amountMinor, labelZh };
}

export function offerForListing(listing = {}) {
  const input = listing?.catalog?.offer;
  if (isPublicObject(input)) {
    const status = cleanText(input.status, 24);
    const pricing = validPricing(input.pricing);
    const rightsLabelZh = cleanText(input.rightsLabelZh, 80);
    const acquisitionLabelZh = cleanText(input.acquisitionLabelZh, 64);
    const noteZh = cleanText(input.noteZh, 100);
    if (OFFER_STATUSES.has(status) && pricing && rightsLabelZh && acquisitionLabelZh && noteZh) {
      return freeze({ status, pricing, rightsLabelZh, acquisitionLabelZh, noteZh, source: 'catalog' });
    }
  }
  return freeze({
    status: 'draft',
    pricing: { model: 'contact', currency: 'CNY', amountMinor: 0, labelZh: '价格待发布' },
    rightsLabelZh: listing?.distribution === 'source_link_only' ? '仅查看来源' : '在线体验与评估',
    acquisitionLabelZh: '正式调用需取得企业授权',
    noteZh: '创作者尚未发布正式 Offer',
    source: 'fallback',
  });
}

export function merchandisingForListing(listing = {}) {
  return freeze({
    publisher: publisherForListing(listing),
    offer: offerForListing(listing),
  });
}

export const MARKET_MERCHANDISING_SCHEMA_VERSION = 1;
