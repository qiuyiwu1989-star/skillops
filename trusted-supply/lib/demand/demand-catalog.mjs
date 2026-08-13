import { normalizeAccessDecision } from '../commerce/access-decision.mjs';
import { normalizeOfferRevision } from '../commerce/offer.mjs';
import { ORGANIZATION_ID, PRODUCT_ID, RELEASE_ID, SAFE_IDENTIFIER } from '../commerce/common.mjs';
import { canonicalDigest } from '../registry-identity.mjs';
import { validateSkillRecord } from '../skill-record.mjs';

export const DEMAND_CATALOG_SCHEMA_VERSION = 1;

const ACQUISITION_STATES = new Set(['entitled', 'free_available', 'purchase_required', 'unavailable']);
const ABILITY_TYPES = new Set(['skill', 'application']);
const PRICING_MODELS = new Set(['free', 'one_time', 'subscription', 'metered', 'quote']);
const PRIVATE_KEYS = /^(?:candidate|candidateId|content|body|prompt|input|inputText|output|outputText|transcript|token|apiKey|secret|credential|password|privateKey|localPath|absolutePath|storageRef|identityReceipt|receipt|subjectDigest|principalId)$/i;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/))/i;

export class DemandCatalogError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DemandCatalogError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DemandCatalogError(code, message, cause);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
  const missing = [...allowed].filter(key => !Object.hasOwn(value, key));
  if (missing.length) fail('MISSING_FIELD', `${label} is missing fields: ${missing.join(', ')}`);
}

function allowedKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function privacyGate(value, label = 'value', seen = new Set()) {
  if (typeof value === 'string') {
    if (/(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+/i.test(value) || SECRET_VALUE.test(value)) {
      fail('PRIVATE_VALUE', `${label} contains private material`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('NOT_JSON', `${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((child, index) => privacyGate(child, `${label}[${index}]`, seen));
  else for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.test(key)) fail('PRIVATE_FIELD', `${label} contains forbidden field: ${key}`);
    privacyGate(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function text(value, label, maximum = 1_000, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${label} is invalid or too long`);
  }
  privacyGate(normalized, label);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(normalized)).toISOString();
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_NUMBER', `${label} is invalid`);
  return value;
}

function stringArray(value, label, { maximum = 100, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > maximum) fail('INVALID_ARRAY', `${label} must be an array within limits`);
  const normalized = value.map((entry, index) => text(entry, `${label}[${index}]`, 500, pattern));
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_VALUE', `${label} cannot contain duplicates`);
  return normalized.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function safeCall(resolver, input, code, label) {
  try { return resolver(input); } catch (cause) { fail(code, `${label} failed`, cause); }
}

function validateSourceCatalog(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'generatedAt', 'publishers', 'products', 'registryReleases',
    'applicationReleases', 'offers', 'catalogDigest',
  ]), 'marketCatalog');
  if (input.schemaVersion !== 1) fail('UNSUPPORTED_MARKET_SCHEMA', 'market catalog schema is unsupported');
  timestamp(input.generatedAt, 'marketCatalog.generatedAt');
  for (const key of ['publishers', 'products', 'registryReleases', 'applicationReleases', 'offers']) {
    if (!Array.isArray(input[key]) || input[key].length > 10_000) fail('INVALID_ARRAY', `marketCatalog.${key} must be an array within limits`);
  }
  privacyGate(input, 'marketCatalog');
  const { catalogDigest, ...body } = clone(input);
  if (catalogDigest !== canonicalDigest(body)) fail('CATALOG_DIGEST_MISMATCH', 'market catalog digest is invalid');
  return deepFreeze(clone(input));
}

function validatePublicationProjection(input) {
  exactKeys(input, new Set(['schemaVersion', 'items', 'eventCount']), 'publicationProjection');
  if (input.schemaVersion !== 1) fail('UNSUPPORTED_PUBLICATION_SCHEMA', 'publication projection schema is unsupported');
  integer(input.eventCount, 'publicationProjection.eventCount', 0, 1_000_000);
  object(input.items, 'publicationProjection.items');
  if (Object.keys(input.items).length > 10_000) fail('ITEM_LIMIT_EXCEEDED', 'publication projection has too many items');
  privacyGate(input, 'publicationProjection');
  for (const [key, item] of Object.entries(input.items)) {
    exactKeys(item, new Set([
      'productId', 'releaseId', 'status', 'enforcementStatus', 'submission', 'reviewGaps',
      'nextAction', 'timeline', 'appeals',
    ]), `publicationProjection.items.${key}`);
    text(item.productId, 'publication.productId', 69, PRODUCT_ID);
    text(item.releaseId, 'publication.releaseId', 72, RELEASE_ID);
    if (key !== `${item.productId}:${item.releaseId}`) fail('PUBLICATION_KEY_MISMATCH', 'publication item key does not match Product and Release');
    object(item.submission, 'publication.submission');
    exactKeys(item.submission, new Set([
      'schemaVersion', 'workId', 'publisherId', 'productId', 'releaseId', 'draftRevision', 'draftDigest',
      'marketRegistryRevision', 'licensePolicyDigest', 'evidenceDigest', 'declarationVersion', 'submittedAt',
      'submissionDigest', 'submissionId',
    ]), 'publication.submission');
    if (item.submission.productId !== item.productId || item.submission.releaseId !== item.releaseId) {
      fail('PUBLICATION_BINDING_MISMATCH', 'publication Submission does not match Product and Release');
    }
    if (item.submission.schemaVersion !== 1) fail('INVALID_PUBLICATION_ITEM', 'publication Submission schema is unsupported');
    text(item.submission.workId, 'publication.submission.workId', 256, /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
    text(item.submission.publisherId, 'publication.submission.publisherId', 69, /^pub_[a-f0-9]{64}$/);
    integer(item.submission.draftRevision, 'publication.submission.draftRevision', 1);
    for (const field of ['draftDigest', 'marketRegistryRevision', 'licensePolicyDigest', 'evidenceDigest', 'submissionDigest']) {
      text(item.submission[field], `publication.submission.${field}`, 71, /^sha256:[a-f0-9]{64}$/);
    }
    text(item.submission.declarationVersion, 'publication.submission.declarationVersion', 256, /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
    timestamp(item.submission.submittedAt, 'publication.submission.submittedAt');
    text(item.submission.submissionId, 'publication.submission.submissionId', 68, /^sub_[a-f0-9]{64}$/);
    if (!Array.isArray(item.reviewGaps) || !Array.isArray(item.timeline) || !Array.isArray(item.appeals)) {
      fail('INVALID_PUBLICATION_ITEM', 'publication item arrays are invalid');
    }
    if (item.reviewGaps.length > 20 || item.timeline.length > 10_000 || item.appeals.length > 1_000) {
      fail('ITEM_LIMIT_EXCEEDED', 'publication item history exceeds limits');
    }
    const publishEvent = [...item.timeline].reverse().find(event => event?.type === 'lifecycle.recorded' && event.action === 'publish');
    if (!publishEvent || !Number.isFinite(Date.parse(publishEvent.at))) fail('PUBLISH_EVENT_REQUIRED', 'published item requires a valid publish lifecycle event');
  }
  return input;
}

function releaseIndex(catalog) {
  return new Map([
    ...catalog.registryReleases.map(release => [release.releaseId, release]),
    ...catalog.applicationReleases.map(release => [release.applicationReleaseId, release]),
  ]);
}

function resolveCurrentOffer(productId, catalogOffers, resolver) {
  if (typeof resolver !== 'function') return null;
  const raw = safeCall(resolver, productId, 'OFFER_RESOLVER_FAILED', 'trusted current Offer resolver');
  if (raw == null) return null;
  let offer;
  try { offer = normalizeOfferRevision(raw.offerRevision ?? raw); } catch (cause) { fail('OFFER_INVALID', 'current Offer is invalid', cause); }
  const claimedCurrent = raw.offerRevision ? raw.currentOfferRevisionId : offer.offerRevisionId;
  if (offer.productId !== productId || claimedCurrent !== offer.offerRevisionId) fail('OFFER_BINDING_MISMATCH', 'current Offer does not match Product');
  const catalogOffer = catalogOffers.get(offer.offerRevisionId);
  if (!catalogOffer || canonicalDigest(catalogOffer) !== canonicalDigest(offer)) fail('OFFER_NOT_IN_CATALOG', 'current Offer is not present in trusted catalog');
  return offer;
}

function noEntitlement(organizationId, productId, releaseId, code = 'NO_ENTITLEMENT') {
  return {
    state: 'not_entitled', code, entitlementId: null, organizationId, productId, releaseId, grantedRights: [],
  };
}

function resolveEntitlement({ organizationId, productId, releaseId, requiredRights }, resolver, generatedAt) {
  if (typeof resolver !== 'function') return noEntitlement(organizationId, productId, releaseId);
  const raw = safeCall(resolver, { organizationId, productId, releaseId, requiredRights: [...requiredRights], checkedAt: generatedAt },
    'ENTITLEMENT_RESOLVER_FAILED', 'trusted entitlement summary resolver');
  if (raw == null) return noEntitlement(organizationId, productId, releaseId);
  exactKeys(raw, new Set(['organizationId', 'productId', 'releaseId', 'state', 'code', 'entitlementId', 'grantedRights']), 'entitlementSummary');
  if (raw.organizationId !== organizationId || raw.productId !== productId || raw.releaseId !== releaseId) {
    fail('ENTITLEMENT_SCOPE_MISMATCH', 'entitlement summary does not match trusted organization and ability scope');
  }
  if (!['entitled', 'not_entitled', 'blocked'].includes(raw.state)) fail('INVALID_ENTITLEMENT_STATE', 'entitlement summary state is invalid');
  const code = text(raw.code, 'entitlementSummary.code', 64, /^[A-Z][A-Z0-9_]{1,63}$/);
  const grantedRights = stringArray(raw.grantedRights, 'entitlementSummary.grantedRights', { maximum: 20, pattern: SAFE_IDENTIFIER });
  if (raw.state === 'entitled') {
    const decision = normalizeAccessDecision({
      schemaVersion: 1, decision: 'allow', code: 'ACCESS_ALLOWED', entitlementId: raw.entitlementId,
      organizationId, productId, releaseId, grantedRights, checkedAt: generatedAt,
    }, { organizationId, productId, releaseId, requiredRights, checkedAt: generatedAt });
    return { state: 'entitled', code, entitlementId: decision.entitlementId, organizationId, productId, releaseId, grantedRights };
  }
  if (raw.entitlementId !== null || grantedRights.length) fail('INVALID_ENTITLEMENT_SUMMARY', 'non-entitled summary cannot expose an Entitlement or granted rights');
  return { state: raw.state, code, entitlementId: null, organizationId, productId, releaseId, grantedRights: [] };
}

function acquisitionFrom(summary, offer, { organizationId, releaseId, generatedAt }) {
  if (summary.state === 'entitled') return {
    state: 'entitled', code: 'ENTITLEMENT_VALID', reasonZh: '企业已获得当前版本所需授权。',
    entitlementId: summary.entitlementId, grantedRights: summary.grantedRights,
  };
  if (summary.state === 'blocked') return {
    state: 'unavailable', code: summary.code, reasonZh: '当前企业授权被阻断，暂不可调用。', entitlementId: null, grantedRights: [],
  };
  if (!offer) return {
    state: 'unavailable', code: 'NO_ACTIVE_OFFER', reasonZh: '当前没有可用的获取方案。', entitlementId: null, grantedRights: [],
  };
  const policy = offer.licensePolicy;
  const constraints = policy.constraints;
  if (!policy.rights.includes('invoke')) return { state: 'unavailable', code: 'OFFER_INVOKE_RIGHT_MISSING', reasonZh: '当前获取方案不包含调用权。', entitlementId: null, grantedRights: [] };
  if (constraints.organizationIds.length && !constraints.organizationIds.includes(organizationId)) return { state: 'unavailable', code: 'OFFER_ORGANIZATION_NOT_ELIGIBLE', reasonZh: '当前获取方案不适用于本企业。', entitlementId: null, grantedRights: [] };
  if (constraints.releaseIds.length && !constraints.releaseIds.includes(releaseId)) return { state: 'unavailable', code: 'OFFER_RELEASE_NOT_ELIGIBLE', reasonZh: '当前获取方案不适用于此版本。', entitlementId: null, grantedRights: [] };
  if (constraints.validFrom && Date.parse(generatedAt) < Date.parse(constraints.validFrom)) return { state: 'unavailable', code: 'OFFER_NOT_YET_VALID', reasonZh: '当前获取方案尚未生效。', entitlementId: null, grantedRights: [] };
  if (constraints.validUntil && Date.parse(generatedAt) >= Date.parse(constraints.validUntil)) return { state: 'unavailable', code: 'OFFER_EXPIRED', reasonZh: '当前获取方案已失效。', entitlementId: null, grantedRights: [] };
  if (offer.pricing.model === 'free') return {
    state: 'free_available', code: 'FREE_OFFER_AVAILABLE', reasonZh: '当前版本可免费获取，需由企业确认授权。', entitlementId: null, grantedRights: [],
  };
  return {
    state: 'purchase_required', code: offer.pricing.model === 'quote' ? 'CONTACT_REQUIRED' : 'PURCHASE_REQUIRED',
    reasonZh: offer.pricing.model === 'quote' ? '当前版本需要联系采购并确认报价。' : '当前版本需要完成企业采购授权。',
    entitlementId: null, grantedRights: [],
  };
}

function publicOffer(offer) {
  if (!offer) return null;
  return {
    offerId: offer.offerId,
    offerRevisionId: offer.offerRevisionId,
    pricing: clone(offer.pricing),
    licenseRights: [...offer.licensePolicy.rights],
    effectiveAt: offer.effectiveAt,
  };
}

function publicPublication(item) {
  const published = [...item.timeline].reverse().find(event => event.action === 'publish');
  return {
    status: 'published', enforcementStatus: 'published', submissionId: item.submission.submissionId,
    evidenceDigest: item.submission.evidenceDigest, licensePolicyDigest: item.submission.licensePolicyDigest,
    marketRegistryRevision: item.submission.marketRegistryRevision, publishedAt: published?.at ?? item.submission.submittedAt,
  };
}

function skillSignals(product, release, resolver) {
  if (typeof resolver !== 'function') return { categoryTags: [], taskSignals: { intentTags: [], routingSummary: product.summaryZh, whenToUse: [] }, requiredPermissions: [] };
  const raw = safeCall(resolver, { skillId: product.skillId, releaseId: release.releaseId }, 'SKILL_RECORD_RESOLVER_FAILED', 'trusted Skill Record resolver');
  if (raw == null) return { categoryTags: [], taskSignals: { intentTags: [], routingSummary: product.summaryZh, whenToUse: [] }, requiredPermissions: [] };
  let record;
  try { record = validateSkillRecord(raw); } catch (cause) { fail('SKILL_RECORD_NOT_CURRENT', 'Skill Record is invalid or not current', cause); }
  if (record.skillId !== product.skillId || record.releaseId !== release.releaseId || record.version !== release.version
    || record.packageDigest !== release.package.packageDigest
    || record.compatibility.contract !== release.compatibility.contract
    || canonicalDigest(record.compatibility.targets) !== canonicalDigest(release.compatibility.targets)
    || !release.sourceRefs.includes(record.source.sourceId)
    || ![record.evidence.smsDigest, record.evidence.evalDigest].every(ref => release.assessmentRefs.includes(ref))
    || ![record.evidence.reviewEvidenceDigest, record.evidence.reviewPolicyDigest].every(ref => release.reviewRefs.includes(ref))) {
    fail('SKILL_RECORD_BINDING_MISMATCH', 'Skill Record does not match the current public Release and evidence');
  }
  return {
    categoryTags: [...record.routing.intentTags],
    taskSignals: { intentTags: [...record.routing.intentTags], routingSummary: record.routing.summary, whenToUse: [...record.routing.whenToUse] },
    requiredPermissions: [...record.permissions.required],
  };
}

function dependencyProjection(dependency, context) {
  const summary = resolveEntitlement({
    organizationId: context.organizationId, productId: dependency.productId, releaseId: dependency.releaseId,
    requiredRights: dependency.requiredRights,
  }, context.entitlementSummaryResolver, context.generatedAt);
  let publication;
  try { publication = context.publicationItemResolver({ productId: dependency.productId, releaseId: dependency.releaseId }); } catch (cause) { fail('PUBLICATION_ITEM_RESOLVER_FAILED', 'trusted dependency Publication resolver failed', cause); }
  const publicationCurrent = publication?.productId === dependency.productId && publication?.releaseId === dependency.releaseId
    && publication.status === 'published' && publication.enforcementStatus === 'published';
  const acquisition = publicationCurrent
    ? acquisitionFrom(summary, context.offersByProduct.get(dependency.productId) ?? null, { organizationId: context.organizationId, releaseId: dependency.releaseId, generatedAt: context.generatedAt })
    : { state: 'unavailable', code: 'DEPENDENCY_NOT_CURRENTLY_PUBLISHED', reasonZh: '依赖技能当前未发布或已召回。', entitlementId: null, grantedRights: [] };
  let requiredPermissions = [];
  const dependencyRelease = context.releases.get(dependency.releaseId);
  if (dependencyRelease) {
    const signals = skillSignals({ skillId: dependency.skillId, releaseId: dependency.releaseId, summaryZh: '' }, dependencyRelease, context.skillRecordResolver);
    requiredPermissions = signals.requiredPermissions;
  }
  return {
    productId: dependency.productId, releaseId: dependency.releaseId, skillId: dependency.skillId,
    requirement: dependency.requirement, requiredRights: [...dependency.requiredRights],
    requiredPermissions, acquisition,
  };
}

export function createDemandCatalogProjection(input = {}, options = {}) {
  exactKeys(input, new Set(['marketCatalog', 'publicationProjection', 'organizationId', 'generatedAt']), 'demand catalog input');
  privacyGate(input, 'demand catalog input');
  const organizationId = text(input.organizationId, 'organizationId', 99, ORGANIZATION_ID);
  const generatedAt = timestamp(input.generatedAt, 'generatedAt');
  if (typeof options.marketCatalogResolver !== 'function') fail('MARKET_CATALOG_RESOLVER_REQUIRED', 'trusted Market Catalog resolver is required');
  if (typeof options.publicationItemResolver !== 'function') fail('PUBLICATION_ITEM_RESOLVER_REQUIRED', 'trusted Publication item resolver is required');
  const suppliedCatalog = validateSourceCatalog(input.marketCatalog);
  let resolvedCatalog;
  try { resolvedCatalog = validateSourceCatalog(options.marketCatalogResolver(suppliedCatalog.catalogDigest)); } catch (cause) { fail('MARKET_CATALOG_RESOLVER_FAILED', 'trusted Market Catalog resolver failed', cause); }
  if (resolvedCatalog.catalogDigest !== suppliedCatalog.catalogDigest || canonicalDigest(resolvedCatalog) !== canonicalDigest(suppliedCatalog)) fail('MARKET_CATALOG_TRUST_MISMATCH', 'Market Catalog does not match trusted resolver');
  const catalog = resolvedCatalog;
  const publications = validatePublicationProjection(input.publicationProjection);
  const products = new Map(catalog.products.map(product => [product.productId, product]));
  const publishers = new Map(catalog.publishers.map(publisher => [publisher.publisherId, publisher]));
  const releases = releaseIndex(catalog);
  const offers = new Map(catalog.offers.map(offer => [offer.offerRevisionId, offer]));
  const offersByProduct = new Map();
  for (const product of catalog.products) {
    const offer = resolveCurrentOffer(product.productId, offers, options.currentOfferResolver);
    if (offer) offersByProduct.set(product.productId, offer);
  }
  const context = { organizationId, generatedAt, entitlementSummaryResolver: options.entitlementSummaryResolver, offersByProduct, publicationItemResolver: options.publicationItemResolver, skillRecordResolver: options.skillRecordResolver, releases };
  const items = [];
  for (const publication of Object.values(publications.items)) {
    let trustedPublication;
    try { trustedPublication = options.publicationItemResolver({ productId: publication.productId, releaseId: publication.releaseId }); } catch (cause) { fail('PUBLICATION_ITEM_RESOLVER_FAILED', 'trusted Publication item resolver failed', cause); }
    if (!trustedPublication || canonicalDigest(trustedPublication) !== canonicalDigest(publication)) fail('PUBLICATION_ITEM_TRUST_MISMATCH', 'Publication item does not match trusted current resolver');
    if (publication.status !== 'published' || publication.enforcementStatus !== 'published') continue;
    const product = products.get(publication.productId);
    const release = releases.get(publication.releaseId);
    if (!product || !release) fail('PUBLICATION_CATALOG_BINDING_MISMATCH', 'published item is missing its trusted Product or Release');
    if (product.abilityType === 'skill' && (product.releaseId !== publication.releaseId || release.skillId !== product.skillId)) {
      fail('PUBLICATION_CATALOG_BINDING_MISMATCH', 'published Skill binding does not match trusted catalog');
    }
    if (product.abilityType === 'application' && release.productId !== product.productId) {
      fail('PUBLICATION_CATALOG_BINDING_MISMATCH', 'published Application binding does not match trusted catalog');
    }
    const publisher = publishers.get(product.publisherId);
    if (!publisher) fail('PUBLISHER_NOT_FOUND', 'published Product has no trusted Publisher');
    if (publication.submission.publisherId !== product.publisherId) fail('PUBLICATION_CATALOG_BINDING_MISMATCH', 'published Submission does not match Product Publisher');
    const offer = offersByProduct.get(product.productId) ?? null;
    const requiredRights = offer?.licensePolicy.rights.includes('invoke') ? ['invoke'] : ['invoke'];
    const entitlement = resolveEntitlement({ organizationId, productId: product.productId, releaseId: publication.releaseId, requiredRights }, options.entitlementSummaryResolver, generatedAt);
    let acquisition = acquisitionFrom(entitlement, offer, { organizationId, releaseId: publication.releaseId, generatedAt });
    let signals = { categoryTags: ['应用'], taskSignals: { intentTags: ['应用'], routingSummary: product.summaryZh, whenToUse: [] }, requiredPermissions: [] };
    let dependencies = [];
    if (product.abilityType === 'skill') signals = skillSignals(product, release, options.skillRecordResolver);
    else {
      dependencies = release.bom.map(dependency => dependencyProjection(dependency, context));
      signals.requiredPermissions = [...new Set(dependencies.filter(dependency => dependency.requirement === 'required').flatMap(dependency => dependency.requiredPermissions))].sort();
      const blocked = dependencies.filter(dependency => dependency.requirement === 'required' && dependency.acquisition.state !== 'entitled');
      if (blocked.length) acquisition = {
        state: 'unavailable', code: 'REQUIRED_DEPENDENCY_NOT_ENTITLED',
        reasonZh: `缺少 ${blocked.length} 项必需技能授权，应用暂不可直接使用。`, entitlementId: null, grantedRights: [],
      };
    }
    items.push({
      productId: product.productId, releaseId: publication.releaseId, abilityType: product.abilityType,
      productKey: product.productKey, titleZh: product.titleZh, summaryZh: product.summaryZh,
      publisher: { publisherId: publisher.publisherId, displayName: publisher.displayName, kind: publisher.kind, status: publisher.status },
      version: release.version, categoryTags: signals.categoryTags, taskSignals: signals.taskSignals, requiredPermissions: signals.requiredPermissions,
      publication: publicPublication(publication), offer: publicOffer(offer), acquisition,
      dependencies, callable: acquisition.state === 'entitled',
    });
  }
  items.sort((left, right) => left.titleZh.localeCompare(right.titleZh, 'zh-Hans-CN') || left.productId.localeCompare(right.productId, 'en'));
  const summary = {
    total: items.length,
    entitled: items.filter(item => item.acquisition.state === 'entitled').length,
    freeAvailable: items.filter(item => item.acquisition.state === 'free_available').length,
    purchaseRequired: items.filter(item => item.acquisition.state === 'purchase_required').length,
    unavailable: items.filter(item => item.acquisition.state === 'unavailable').length,
  };
  const body = { schemaVersion: DEMAND_CATALOG_SCHEMA_VERSION, generatedAt, organizationId, sourceCatalogDigest: catalog.catalogDigest, summary, items };
  privacyGate(body, 'demand catalog');
  return deepFreeze({ ...clone(body), projectionDigest: canonicalDigest(body) });
}

function normalizedAcquisition(value, label) {
  exactKeys(value, new Set(['state', 'code', 'reasonZh', 'entitlementId', 'grantedRights']), label);
  if (!ACQUISITION_STATES.has(value.state)) fail('INVALID_ACQUISITION_STATE', `${label}.state is invalid`);
  text(value.code, `${label}.code`, 64, /^[A-Z][A-Z0-9_]{1,63}$/);
  text(value.reasonZh, `${label}.reasonZh`, 500);
  stringArray(value.grantedRights, `${label}.grantedRights`, { maximum: 20, pattern: SAFE_IDENTIFIER });
  if (value.state === 'entitled' && !/^ent_[a-f0-9]{64}$/.test(value.entitlementId ?? '')) fail('INVALID_ENTITLEMENT', `${label} requires a canonical Entitlement`);
  if (value.state !== 'entitled' && (value.entitlementId !== null || value.grantedRights.length)) fail('INVALID_ACQUISITION', `${label} cannot carry authorization`);
}

export function validateDemandCatalogProjection(input) {
  exactKeys(input, new Set(['schemaVersion', 'generatedAt', 'organizationId', 'sourceCatalogDigest', 'summary', 'items', 'projectionDigest']), 'demandCatalogProjection');
  if (input.schemaVersion !== DEMAND_CATALOG_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'demand catalog schema is unsupported');
  timestamp(input.generatedAt, 'generatedAt');
  text(input.organizationId, 'organizationId', 99, ORGANIZATION_ID);
  text(input.sourceCatalogDigest, 'sourceCatalogDigest', 71, /^sha256:[a-f0-9]{64}$/);
  exactKeys(input.summary, new Set(['total', 'entitled', 'freeAvailable', 'purchaseRequired', 'unavailable']), 'summary');
  for (const [key, value] of Object.entries(input.summary)) integer(value, `summary.${key}`, 0, 10_000);
  if (!Array.isArray(input.items) || input.items.length > 10_000) fail('ITEM_LIMIT_EXCEEDED', 'items must be an array within limits');
  const identities = new Set();
  for (const [index, item] of input.items.entries()) {
    const label = `items[${index}]`;
    exactKeys(item, new Set([
      'productId', 'releaseId', 'abilityType', 'productKey', 'titleZh', 'summaryZh', 'publisher', 'version',
      'categoryTags', 'taskSignals', 'requiredPermissions', 'publication', 'offer', 'acquisition', 'dependencies', 'callable',
    ]), label);
    text(item.productId, `${label}.productId`, 69, PRODUCT_ID);
    text(item.releaseId, `${label}.releaseId`, 72, RELEASE_ID);
    const identity = `${item.productId}:${item.releaseId}`;
    if (identities.has(identity)) fail('DUPLICATE_ITEM', 'demand catalog contains duplicate Product and Release');
    identities.add(identity);
    if (!ABILITY_TYPES.has(item.abilityType)) fail('INVALID_ABILITY_TYPE', `${label}.abilityType is invalid`);
    text(item.productKey, `${label}.productKey`, 64, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    text(item.titleZh, `${label}.titleZh`, 160); text(item.summaryZh, `${label}.summaryZh`, 1_000); text(item.version, `${label}.version`, 64);
    exactKeys(item.publisher, new Set(['publisherId', 'displayName', 'kind', 'status']), `${label}.publisher`);
    text(item.publisher.publisherId, `${label}.publisher.publisherId`, 69, /^pub_[a-f0-9]{64}$/);
    text(item.publisher.displayName, `${label}.publisher.displayName`, 120);
    if (!['individual', 'organization'].includes(item.publisher.kind) || item.publisher.status !== 'active') fail('INVALID_PUBLISHER', `${label}.publisher is invalid`);
    stringArray(item.categoryTags, `${label}.categoryTags`, { maximum: 30 });
    exactKeys(item.taskSignals, new Set(['intentTags', 'routingSummary', 'whenToUse']), `${label}.taskSignals`);
    stringArray(item.taskSignals.intentTags, `${label}.taskSignals.intentTags`, { maximum: 30 });
    text(item.taskSignals.routingSummary, `${label}.taskSignals.routingSummary`, 1_000);
    stringArray(item.taskSignals.whenToUse, `${label}.taskSignals.whenToUse`, { maximum: 50 });
    stringArray(item.requiredPermissions, `${label}.requiredPermissions`, { maximum: 100, pattern: SAFE_IDENTIFIER });
    exactKeys(item.publication, new Set(['status', 'enforcementStatus', 'submissionId', 'evidenceDigest', 'licensePolicyDigest', 'marketRegistryRevision', 'publishedAt']), `${label}.publication`);
    if (item.publication.status !== 'published' || item.publication.enforcementStatus !== 'published') fail('NOT_CURRENTLY_PUBLISHED', `${label} is not currently published`);
    text(item.publication.submissionId, `${label}.publication.submissionId`, 68, /^sub_[a-f0-9]{64}$/);
    for (const key of ['evidenceDigest', 'licensePolicyDigest', 'marketRegistryRevision']) text(item.publication[key], `${label}.publication.${key}`, 71, /^sha256:[a-f0-9]{64}$/);
    timestamp(item.publication.publishedAt, `${label}.publication.publishedAt`);
    if (item.offer !== null) {
      exactKeys(item.offer, new Set(['offerId', 'offerRevisionId', 'pricing', 'licenseRights', 'effectiveAt']), `${label}.offer`);
      text(item.offer.offerId, `${label}.offer.offerId`, 101); text(item.offer.offerRevisionId, `${label}.offer.offerRevisionId`, 71, /^offrev_[a-f0-9]{64}$/);
      exactKeys(item.offer.pricing, new Set(['model', 'currency', 'amountMinor']), `${label}.offer.pricing`);
      if (!PRICING_MODELS.has(item.offer.pricing.model) || item.offer.pricing.currency !== 'CNY') fail('INVALID_PRICING', `${label}.offer.pricing is invalid`);
      integer(item.offer.pricing.amountMinor, `${label}.offer.pricing.amountMinor`);
      stringArray(item.offer.licenseRights, `${label}.offer.licenseRights`, { maximum: 20, pattern: SAFE_IDENTIFIER });
      timestamp(item.offer.effectiveAt, `${label}.offer.effectiveAt`);
    }
    normalizedAcquisition(item.acquisition, `${label}.acquisition`);
    if (!Array.isArray(item.dependencies) || item.dependencies.length > 200) fail('INVALID_DEPENDENCIES', `${label}.dependencies is invalid`);
    for (const [depIndex, dependency] of item.dependencies.entries()) {
      const depLabel = `${label}.dependencies[${depIndex}]`;
      exactKeys(dependency, new Set(['productId', 'releaseId', 'skillId', 'requirement', 'requiredRights', 'requiredPermissions', 'acquisition']), depLabel);
      text(dependency.productId, `${depLabel}.productId`, 69, PRODUCT_ID); text(dependency.releaseId, `${depLabel}.releaseId`, 72, RELEASE_ID);
      text(dependency.skillId, `${depLabel}.skillId`, 256); if (!['required', 'optional'].includes(dependency.requirement)) fail('INVALID_REQUIREMENT', `${depLabel}.requirement is invalid`);
      stringArray(dependency.requiredRights, `${depLabel}.requiredRights`, { maximum: 20, pattern: SAFE_IDENTIFIER });
      stringArray(dependency.requiredPermissions, `${depLabel}.requiredPermissions`, { maximum: 100, pattern: SAFE_IDENTIFIER });
      normalizedAcquisition(dependency.acquisition, `${depLabel}.acquisition`);
    }
    if (typeof item.callable !== 'boolean' || item.callable !== (item.acquisition.state === 'entitled')) fail('CALLABLE_MISMATCH', `${label}.callable is inconsistent`);
  }
  const counted = {
    total: input.items.length,
    entitled: input.items.filter(item => item.acquisition.state === 'entitled').length,
    freeAvailable: input.items.filter(item => item.acquisition.state === 'free_available').length,
    purchaseRequired: input.items.filter(item => item.acquisition.state === 'purchase_required').length,
    unavailable: input.items.filter(item => item.acquisition.state === 'unavailable').length,
  };
  if (canonicalDigest(counted) !== canonicalDigest(input.summary)) fail('SUMMARY_MISMATCH', 'demand catalog summary does not match items');
  const { projectionDigest, ...body } = clone(input);
  privacyGate(body, 'demandCatalogProjection');
  if (projectionDigest !== canonicalDigest(body)) fail('PROJECTION_DIGEST_MISMATCH', 'demand catalog projection digest is invalid');
  return deepFreeze({ ...body, projectionDigest });
}

function queryTerms(value) {
  if (!value) return [];
  const normalized = text(value, 'query.taskZh', 500).toLocaleLowerCase('zh-Hans-CN');
  const segments = normalized.split(/[\s，。！？、；：,.!?;:()（）]+/u).filter(Boolean);
  return [...new Set([normalized, ...segments])].slice(0, 30);
}

export function searchDemandCatalog(projectionInput, query = {}) {
  allowedKeys(query, new Set(['taskZh', 'categoryTags', 'abilityTypes', 'acquisitionStates', 'pricingModels', 'limit']), 'demand catalog query');
  const projection = validateDemandCatalogProjection(projectionInput);
  const taskZh = query.taskZh == null || query.taskZh === '' ? null : text(query.taskZh, 'query.taskZh', 500);
  const categoryTags = stringArray(query.categoryTags ?? [], 'query.categoryTags', { maximum: 30 });
  const abilityTypes = stringArray(query.abilityTypes ?? [], 'query.abilityTypes', { maximum: ABILITY_TYPES.size });
  const acquisitionStates = stringArray(query.acquisitionStates ?? [], 'query.acquisitionStates', { maximum: ACQUISITION_STATES.size });
  const pricingModels = stringArray(query.pricingModels ?? [], 'query.pricingModels', { maximum: PRICING_MODELS.size });
  if (abilityTypes.some(value => !ABILITY_TYPES.has(value)) || acquisitionStates.some(value => !ACQUISITION_STATES.has(value))
    || pricingModels.some(value => !PRICING_MODELS.has(value))) fail('INVALID_FILTER', 'query contains an unsupported filter');
  const limit = query.limit === undefined ? 50 : integer(query.limit, 'query.limit', 1, 200);
  const terms = queryTerms(taskZh);
  const results = [];
  for (const item of projection.items) {
    if (abilityTypes.length && !abilityTypes.includes(item.abilityType)) continue;
    if (acquisitionStates.length && !acquisitionStates.includes(item.acquisition.state)) continue;
    const pricingModel = item.offer?.pricing.model ?? 'unavailable';
    if (pricingModels.length && !pricingModels.includes(pricingModel)) continue;
    if (categoryTags.length && !categoryTags.every(tag => item.categoryTags.includes(tag))) continue;
    let score = 0;
    const reasons = [];
    const title = item.titleZh.toLocaleLowerCase('zh-Hans-CN');
    const summary = item.summaryZh.toLocaleLowerCase('zh-Hans-CN');
    const routing = item.taskSignals.routingSummary.toLocaleLowerCase('zh-Hans-CN');
    const tags = item.taskSignals.intentTags.map(value => value.toLocaleLowerCase('zh-Hans-CN'));
    const uses = item.taskSignals.whenToUse.map(value => value.toLocaleLowerCase('zh-Hans-CN'));
    for (const term of terms) {
      if (title.includes(term)) { score += 40; reasons.push(`标题匹配“${term}”`); }
      if (tags.some(tag => tag.includes(term) || term.includes(tag))) { score += 24; reasons.push(`任务标签匹配“${term}”`); }
      if (summary.includes(term)) { score += 16; reasons.push(`能力说明匹配“${term}”`); }
      if (routing.includes(term) || uses.some(value => value.includes(term))) { score += 12; reasons.push(`使用场景匹配“${term}”`); }
    }
    if (terms.length && !score) continue;
    if (categoryTags.length) { score += categoryTags.length * 8; reasons.push(`分类匹配：${categoryTags.join('、')}`); }
    if (abilityTypes.length) reasons.push(`能力类型匹配：${item.abilityType === 'skill' ? '技能' : '应用'}`);
    if (acquisitionStates.length) reasons.push(`授权状态匹配：${item.acquisition.reasonZh}`);
    if (!reasons.length) reasons.push('当前可信市场能力');
    results.push({ ...clone(item), score, matchReasons: [...new Set(reasons)] });
  }
  results.sort((left, right) => right.score - left.score
    || left.titleZh.localeCompare(right.titleZh, 'zh-Hans-CN')
    || left.productId.localeCompare(right.productId, 'en'));
  const normalizedQuery = { taskZh, categoryTags, abilityTypes, acquisitionStates, pricingModels, limit };
  const body = {
    schemaVersion: DEMAND_CATALOG_SCHEMA_VERSION, query: normalizedQuery, resultCount: Math.min(results.length, limit),
    results: results.slice(0, limit), sourceProjectionDigest: projection.projectionDigest,
  };
  return deepFreeze({ ...body, searchDigest: canonicalDigest(body) });
}
