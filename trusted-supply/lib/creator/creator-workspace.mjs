import { canonicalDigest, normalizeRelease } from '../registry-identity.mjs';
import { toPublicMarketValue } from '../market/domain.mjs';

export const CREATOR_WORKSPACE_SCHEMA_VERSION = 1;

const PUBLISHER_ID = /^pub_[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const WORK_ID = /^work_[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const APPLICATION_ID = /^app_[a-f0-9]{64}$/;
const APPLICATION_RELEASE_ID = /^apprel_[a-f0-9]{64}$/;
const PRODUCT_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ABILITY_TYPES = new Set(['skill', 'application']);
const PRICE_MODELS = new Set(['free', 'paid', 'contact']);
const SUPPORT_MODELS = new Set(['self_service', 'publisher_support', 'enterprise_support']);
const OWNERSHIP = new Set(['original', 'authorized', 'mixed']);
const RIGHTS = new Set([
  'invoke', 'organization_use', 'install', 'view_source', 'modify', 'derive',
  'internal_distribute', 'commercial_output', 'redistribute_derivative', 'updates', 'support',
]);
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|\bcas:sha256:|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*\S{4,}/i;
const FORBIDDEN_KEYS = /^(?:body|content|prompt|output|token|tokens|secret|password|credential|apiKey|api_key|instructions|systemPrompt|skillBody|package|storageRef|cas|localPath|path|candidate)$/i;

export class CreatorWorkspaceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CreatorWorkspaceError';
    this.code = code;
    if (details !== undefined) this.details = deepFreeze(structuredClone(details));
  }
}

function fail(code, message, details) {
  throw new CreatorWorkspaceError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function assertNoPrivateValue(value, label = 'value') {
  if (typeof value === 'string') {
    if (PRIVATE_VALUE.test(value)) fail('PRIVATE_VALUE', `${label} contains private, candidate, package, or sensitive data`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateValue(entry, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) fail('FORBIDDEN_FIELD', `${label}.${key} is not creator metadata`);
      assertNoPrivateValue(entry, `${label}.${key}`);
    }
  }
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  assertNoPrivateValue(normalized, label);
  return normalized;
}

function optionalText(value, label, maximum) {
  return value === null ? null : text(value, label, maximum);
}

function id(value, label, pattern) {
  const normalized = text(value, label, 128);
  if (!pattern.test(normalized)) fail('INVALID_ID', `${label} is not a canonical identifier`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(normalized)).toISOString();
}

function productKey(value) {
  const normalized = text(value, 'productKey', 64).toLowerCase();
  if (!PRODUCT_KEY.test(normalized) || normalized.startsWith('cand_')) fail('INVALID_PRODUCT_KEY', 'productKey must be a stable lowercase slug');
  return normalized;
}

function generatedId(prefix, domain, body) {
  return `${prefix}_${canonicalDigest({ domain, ...body }).slice('sha256:'.length)}`;
}

function resolve(label, resolver, identity) {
  if (typeof resolver !== 'function') fail(`${label.toUpperCase()}_RESOLVER_REQUIRED`, `${label} resolver must be a trusted function`);
  let value;
  try { value = resolver(identity); } catch (cause) {
    fail(`${label.toUpperCase()}_RESOLUTION_FAILED`, `${label} resolution failed`, { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if (!value) fail(`${label.toUpperCase()}_NOT_FOUND`, `${label} was not found`);
  return value;
}

function validatePublisher(publisherId, resolver) {
  const expected = id(publisherId, 'publisherId', PUBLISHER_ID);
  const publisher = resolve('publisher', resolver, { publisherId: expected });
  if (publisher.publisherId !== expected || publisher.status !== 'active' || !['individual', 'organization'].includes(publisher.kind)) {
    fail('PUBLISHER_MISMATCH', 'resolved Publisher does not match an active trusted Publisher');
  }
  assertNoPrivateValue(publisher, 'resolvedPublisher');
  return publisher;
}

function validateProduct({ productId, publisherId, abilityType, productKey: key }, resolver) {
  const expected = id(productId, 'productId', PRODUCT_ID);
  let product;
  try { product = toPublicMarketValue(resolve('product', resolver, { productId: expected })); } catch (cause) {
    if (cause instanceof CreatorWorkspaceError) throw cause;
    fail('PRODUCT_REJECTED', 'resolved Product is not a trusted Market Product', { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if (product.productId !== expected || product.publisherId !== publisherId
    || product.abilityType !== abilityType || product.productKey !== key) {
    fail('PRODUCT_BINDING_MISMATCH', 'workspace identity does not match the trusted Product');
  }
  return product;
}

export function createCreatorWorkspace(input, { resolvePublisher, resolveProduct } = {}) {
  exactKeys(input, new Set(['publisherId', 'productId', 'abilityType', 'productKey', 'createdAt']), 'creatorWorkspace');
  assertNoPrivateValue(input, 'creatorWorkspace');
  const publisherId = id(input.publisherId, 'publisherId', PUBLISHER_ID);
  const productId = id(input.productId, 'productId', PRODUCT_ID);
  const abilityType = text(input.abilityType, 'abilityType', 16);
  if (!ABILITY_TYPES.has(abilityType)) fail('INVALID_ABILITY_TYPE', 'abilityType must be skill or application');
  const key = productKey(input.productKey);
  validatePublisher(publisherId, resolvePublisher);
  validateProduct({ productId, publisherId, abilityType, productKey: key }, resolveProduct);
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const body = {
    schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION,
    workId: generatedId('work', 'skillops.creator.workspace.v1', { publisherId, abilityType, productKey: key }),
    publisherId,
    productId,
    abilityType,
    productKey: key,
    visibility: 'private',
    createdAt,
  };
  return deepFreeze({ ...body, workspaceDigest: canonicalDigest(body) });
}

export function normalizeCreatorWorkspace(value) {
  exactKeys(value, new Set([
    'schemaVersion', 'workId', 'publisherId', 'productId', 'abilityType', 'productKey',
    'visibility', 'createdAt', 'workspaceDigest',
  ]), 'creatorWorkspace');
  assertNoPrivateValue(value, 'creatorWorkspace');
  if (value.schemaVersion !== CREATOR_WORKSPACE_SCHEMA_VERSION || value.visibility !== 'private'
    || !ABILITY_TYPES.has(value.abilityType)) fail('INVALID_WORKSPACE', 'creatorWorkspace is invalid');
  id(value.workId, 'workId', WORK_ID);
  const publisherId = id(value.publisherId, 'publisherId', PUBLISHER_ID);
  id(value.productId, 'productId', PRODUCT_ID);
  const key = productKey(value.productKey);
  const createdAt = timestamp(value.createdAt, 'createdAt');
  const expectedWorkId = generatedId('work', 'skillops.creator.workspace.v1', {
    publisherId, abilityType: value.abilityType, productKey: key,
  });
  const { workspaceDigest, ...body } = value;
  if (value.workId !== expectedWorkId || value.createdAt !== createdAt || canonicalDigest(body) !== workspaceDigest) {
    fail('WORKSPACE_TAMPERED', 'creatorWorkspace identity or digest is invalid');
  }
  return deepFreeze(structuredClone(value));
}

function normalizeMetadata(input) {
  exactKeys(input, new Set(['titleZh', 'summaryZh', 'originalLanguage', 'titleOriginal', 'summaryOriginal']), 'metadata');
  const originalLanguage = text(input.originalLanguage, 'metadata.originalLanguage', 16);
  if (!LANGUAGE.test(originalLanguage)) fail('INVALID_LANGUAGE', 'metadata.originalLanguage must be a supported language tag');
  return deepFreeze({
    titleZh: text(input.titleZh, 'metadata.titleZh', 120),
    summaryZh: text(input.summaryZh, 'metadata.summaryZh', 1_000),
    originalLanguage,
    titleOriginal: optionalText(input.titleOriginal, 'metadata.titleOriginal', 120),
    summaryOriginal: optionalText(input.summaryOriginal, 'metadata.summaryOriginal', 1_000),
  });
}

function normalizeTags(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) fail('INVALID_TAGS', 'categoryTags must contain 1 to 20 tags');
  const tags = input.map((entry, index) => text(entry, `categoryTags[${index}]`, 40).toLowerCase());
  if (new Set(tags).size !== tags.length) fail('DUPLICATE_TAG', 'categoryTags must not repeat');
  return tags.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function normalizePricingIntent(input) {
  exactKeys(input, new Set(['model', 'currency', 'amountMinor']), 'pricingIntent');
  const model = text(input.model, 'pricingIntent.model', 16);
  if (!PRICE_MODELS.has(model)) fail('INVALID_PRICING_MODEL', 'pricingIntent.model is unsupported');
  const currency = input.currency === null ? null : text(input.currency, 'pricingIntent.currency', 3).toUpperCase();
  const amountMinor = input.amountMinor;
  if (model === 'free' && (currency !== 'CNY' || amountMinor !== 0)) fail('INVALID_FREE_PRICE', 'free intent must be CNY 0');
  if (model === 'paid' && (!/^[A-Z]{3}$/.test(currency ?? '') || !Number.isSafeInteger(amountMinor) || amountMinor < 1)) {
    fail('INVALID_PAID_PRICE', 'paid intent requires a currency and positive integer amountMinor');
  }
  if (model === 'contact' && (currency !== null || amountMinor !== null)) fail('INVALID_CONTACT_PRICE', 'contact intent must not set an amount');
  return deepFreeze({ model, currency, amountMinor });
}

function normalizeSupportInfo(input) {
  exactKeys(input, new Set(['model', 'responseTimeText', 'supportRef']), 'supportInfo');
  const model = text(input.model, 'supportInfo.model', 32);
  if (!SUPPORT_MODELS.has(model)) fail('INVALID_SUPPORT_MODEL', 'supportInfo.model is unsupported');
  const supportRef = input.supportRef === null ? null : text(input.supportRef, 'supportInfo.supportRef', 256);
  if (supportRef !== null && !REFERENCE.test(supportRef)) fail('INVALID_REFERENCE', 'supportInfo.supportRef must be a safe reference');
  return deepFreeze({
    model,
    responseTimeText: optionalText(input.responseTimeText, 'supportInfo.responseTimeText', 120),
    supportRef,
  });
}

function normalizeRightsDeclaration(input) {
  exactKeys(input, new Set(['licenseRef', 'declaredRights', 'sourceOwnership', 'evidenceRefs', 'statementVersion']), 'rightsDeclaration');
  const licenseRef = text(input.licenseRef, 'rightsDeclaration.licenseRef', 256);
  const statementVersion = text(input.statementVersion, 'rightsDeclaration.statementVersion', 64);
  if (!REFERENCE.test(licenseRef) || !REFERENCE.test(statementVersion)) fail('INVALID_REFERENCE', 'rights declaration references are invalid');
  if (!Array.isArray(input.declaredRights) || input.declaredRights.length < 1 || input.declaredRights.length > RIGHTS.size) {
    fail('INVALID_RIGHTS', 'rightsDeclaration.declaredRights must be non-empty');
  }
  const declaredRights = input.declaredRights.map((entry, index) => text(entry, `rightsDeclaration.declaredRights[${index}]`, 64));
  if (declaredRights.some(right => !RIGHTS.has(right)) || new Set(declaredRights).size !== declaredRights.length) {
    fail('INVALID_RIGHTS', 'rightsDeclaration.declaredRights contains unsupported or duplicate rights');
  }
  const sourceOwnership = text(input.sourceOwnership, 'rightsDeclaration.sourceOwnership', 16);
  if (!OWNERSHIP.has(sourceOwnership)) fail('INVALID_OWNERSHIP', 'rightsDeclaration.sourceOwnership is unsupported');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > 50) {
    fail('INVALID_EVIDENCE_REFS', 'rightsDeclaration.evidenceRefs must be non-empty');
  }
  const evidenceRefs = input.evidenceRefs.map((entry, index) => {
    const ref = text(entry, `rightsDeclaration.evidenceRefs[${index}]`, 256);
    if (!REFERENCE.test(ref)) fail('INVALID_REFERENCE', `rightsDeclaration.evidenceRefs[${index}] is invalid`);
    return ref;
  });
  if (new Set(evidenceRefs).size !== evidenceRefs.length) fail('DUPLICATE_REFERENCE', 'evidenceRefs must not repeat');
  return deepFreeze({ licenseRef, declaredRights: declaredRights.sort(), sourceOwnership, evidenceRefs: evidenceRefs.sort(), statementVersion });
}

function normalizeTarget(input, workspace, options) {
  if (workspace.abilityType === 'skill') {
    exactKeys(input, new Set(['skillId', 'releaseId']), 'target');
    const skillId = text(input.skillId, 'target.skillId', 128);
    const releaseId = id(input.releaseId, 'target.releaseId', RELEASE_ID);
    const raw = resolve('registry_release', options.resolveRegistryRelease, { skillId, releaseId });
    let release;
    try { release = normalizeRelease(raw); } catch (cause) {
      fail('REGISTRY_RELEASE_REJECTED', 'target does not resolve to a canonical Registry Release', { causeCode: cause.code ?? 'UNKNOWN' });
    }
    const product = validateProduct(workspace, options.resolveProduct);
    if (release.skillId !== skillId || release.releaseId !== releaseId
      || product.skillId !== skillId || product.releaseId !== releaseId) {
      fail('TARGET_BINDING_MISMATCH', 'Skill target does not match its Product and Registry Release');
    }
    return deepFreeze({ skillId, releaseId });
  }
  exactKeys(input, new Set(['applicationId', 'applicationReleaseId']), 'target');
  const applicationId = id(input.applicationId, 'target.applicationId', APPLICATION_ID);
  const applicationReleaseId = id(input.applicationReleaseId, 'target.applicationReleaseId', APPLICATION_RELEASE_ID);
  let release;
  try { release = toPublicMarketValue(resolve('application_release', options.resolveApplicationRelease, { applicationReleaseId })); } catch (cause) {
    if (cause instanceof CreatorWorkspaceError) throw cause;
    fail('APPLICATION_RELEASE_REJECTED', 'target does not resolve to a trusted Application Release', { causeCode: cause.code ?? 'UNKNOWN' });
  }
  const product = validateProduct(workspace, options.resolveProduct);
  if (release.applicationReleaseId !== applicationReleaseId || release.applicationId !== applicationId
    || release.productId !== workspace.productId || product.applicationId !== applicationId) {
    fail('TARGET_BINDING_MISMATCH', 'Application target does not match its Product and Application Release');
  }
  return deepFreeze({ applicationId, applicationReleaseId });
}

export function createDraftRevision(input, options = {}) {
  exactKeys(input, new Set([
    'workId', 'metadata', 'categoryTags', 'pricingIntent', 'supportInfo', 'target',
    'rightsDeclaration', 'savedAt',
  ]), 'draftRevision');
  assertNoPrivateValue(input, 'draftRevision');
  const workspace = normalizeCreatorWorkspace(options.workspace);
  if (id(input.workId, 'workId', WORK_ID) !== workspace.workId) fail('WORKSPACE_BINDING_MISMATCH', 'draft workId does not match its workspace');
  validatePublisher(workspace.publisherId, options.resolvePublisher);
  validateProduct(workspace, options.resolveProduct);
  let previous = null;
  if (options.previousDraft !== undefined && options.previousDraft !== null) {
    previous = normalizeDraftRevision(options.previousDraft);
    if (previous.workId !== workspace.workId) fail('DRAFT_HISTORY_MISMATCH', 'previous draft belongs to another workspace');
  }
  const savedAt = timestamp(input.savedAt, 'savedAt');
  if (previous && Date.parse(savedAt) < Date.parse(previous.savedAt)) fail('DRAFT_TIME_REGRESSION', 'draft savedAt must be monotonic');
  const body = {
    schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION,
    workId: workspace.workId,
    draftRevision: (previous?.draftRevision ?? 0) + 1,
    publisherId: workspace.publisherId,
    productId: workspace.productId,
    abilityType: workspace.abilityType,
    productKey: workspace.productKey,
    target: normalizeTarget(input.target, workspace, options),
    metadata: normalizeMetadata(input.metadata),
    categoryTags: normalizeTags(input.categoryTags),
    pricingIntent: normalizePricingIntent(input.pricingIntent),
    supportInfo: normalizeSupportInfo(input.supportInfo),
    rightsDeclaration: normalizeRightsDeclaration(input.rightsDeclaration),
    savedAt,
  };
  return deepFreeze({ ...body, draftDigest: canonicalDigest(body) });
}

export function normalizeDraftRevision(value) {
  exactKeys(value, new Set([
    'schemaVersion', 'workId', 'draftRevision', 'publisherId', 'productId', 'abilityType',
    'productKey', 'target', 'metadata', 'categoryTags', 'pricingIntent', 'supportInfo',
    'rightsDeclaration', 'savedAt', 'draftDigest',
  ]), 'draftRevision');
  assertNoPrivateValue(value, 'draftRevision');
  if (value.schemaVersion !== CREATOR_WORKSPACE_SCHEMA_VERSION || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 1) {
    fail('INVALID_DRAFT_REVISION', 'draftRevision is invalid');
  }
  id(value.workId, 'workId', WORK_ID);
  id(value.publisherId, 'publisherId', PUBLISHER_ID);
  id(value.productId, 'productId', PRODUCT_ID);
  if (!ABILITY_TYPES.has(value.abilityType)) fail('INVALID_ABILITY_TYPE', 'abilityType is invalid');
  productKey(value.productKey);
  if (value.abilityType === 'skill') {
    exactKeys(value.target, new Set(['skillId', 'releaseId']), 'target');
    text(value.target.skillId, 'target.skillId', 128);
    id(value.target.releaseId, 'target.releaseId', RELEASE_ID);
  } else {
    exactKeys(value.target, new Set(['applicationId', 'applicationReleaseId']), 'target');
    id(value.target.applicationId, 'target.applicationId', APPLICATION_ID);
    id(value.target.applicationReleaseId, 'target.applicationReleaseId', APPLICATION_RELEASE_ID);
  }
  normalizeMetadata(value.metadata);
  normalizeTags(value.categoryTags);
  normalizePricingIntent(value.pricingIntent);
  normalizeSupportInfo(value.supportInfo);
  normalizeRightsDeclaration(value.rightsDeclaration);
  timestamp(value.savedAt, 'savedAt');
  const { draftDigest, ...body } = value;
  if (canonicalDigest(body) !== draftDigest) fail('DRAFT_TAMPERED', 'draftRevision digest does not match its content');
  return deepFreeze(structuredClone(value));
}

export function toCreatorDraftValue(value) {
  const draft = normalizeDraftRevision(value);
  return deepFreeze(structuredClone(draft));
}
