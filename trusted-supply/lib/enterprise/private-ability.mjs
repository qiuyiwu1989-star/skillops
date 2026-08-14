import { canonicalDigest, normalizeSemver, normalizeSkillId } from '../registry-identity.mjs';
import { validatePackageArtifact } from '../package.mjs';

export const PRIVATE_ABILITY_SCHEMA_VERSION = 1;

const ORGANIZATION_ID = /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const PRIVATE_PRODUCT_ID = /^privprod_[a-f0-9]{64}$/;
const PRIVATE_RELEASE_ID = /^privrel_[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const RELEASE_ID = /^(?:rel|apprel)_[a-f0-9]{64}$/;
const ENTITLEMENT_ID = /^ent_[a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const PRODUCT_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SOURCE_TYPES = new Set(['self_authored', 'authorized_derivative']);
const PUBLICATION_STATUSES = new Set(['published', 'withdrawn', 'recalled', 'revoked']);
const ENTITLEMENT_STATUSES = new Set(['active', 'expired', 'revoked']);
const EVIDENCE_TYPES = ['packageAudit', 'sms', 'eval', 'review'];
const EXPECTED_EVIDENCE_STATUS = Object.freeze({ packageAudit: 'pass', sms: 'pass', eval: 'pass', review: 'certified' });
const PRIVATE_KEY = /^(?:body|content|prompt|output|token|tokens|secret|password|credential|apiKey|api_key|instructions|systemPrompt|skillBody|package|storageRef|cas|localPath|path|candidate)$/i;
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|file:\/\/|(?:^|[^\p{L}\p{N}._-])\/(?!\/)\S+|(?:^|[^\p{L}\p{N}._-])[A-Za-z]:[\\/]\S+|(?:^|[^\p{L}\p{N}._-])\\\\[^\\\s]+\\\S+|\bcas:sha256:|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*\S{4,}/iu;

export class PrivateAbilityError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PrivateAbilityError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PrivateAbilityError(code, message, cause);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
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

function assertSafe(value, label = 'value') {
  if (typeof value === 'string') {
    if (PRIVATE_VALUE.test(value)) fail('PRIVATE_VALUE', `${label} contains private or sensitive data`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, `${label}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) fail('FORBIDDEN_FIELD', `${label}.${key} is not private ability metadata`);
      assertSafe(item, `${label}.${key}`);
    }
  }
}

function text(value, label, { maximum = 512, pattern } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${label} is invalid`);
  }
  assertSafe(normalized, label);
  return normalized;
}

function optionalTimestamp(value, label) {
  if (value == null) return null;
  return timestamp(value, label);
}

function timestamp(value, label) {
  const normalized = text(value, label, { maximum: 128 });
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(normalized)).toISOString();
}

function trustedNow(now) {
  if (typeof now !== 'function') fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  try {
    const value = now();
    return timestamp(value instanceof Date ? value.toISOString() : value, 'trusted.now');
  } catch (cause) {
    if (cause instanceof PrivateAbilityError) throw cause;
    fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause);
  }
}

function organizationId(value, label = 'organizationId') {
  return text(value, label, { maximum: 99, pattern: ORGANIZATION_ID });
}

function authorizeOrganization(authorizer, requested, purpose) {
  if (typeof authorizer !== 'function') fail('ORGANIZATION_AUTHORIZER_REQUIRED', 'trusted organization authorizer is required');
  let decision;
  try { decision = authorizer({ purpose }); } catch (cause) {
    fail('ORGANIZATION_AUTHORIZER_FAILED', 'trusted organization authorizer failed', cause);
  }
  if (!decision || typeof decision !== 'object' || decision.decision !== 'allow') fail('ORGANIZATION_FORBIDDEN', 'organization action is not authorized');
  const trusted = organizationId(decision.organizationId, 'organizationAuthorization.organizationId');
  if (trusted !== requested) fail('ORGANIZATION_SCOPE_MISMATCH', 'authorized organization does not match request');
  return trusted;
}

function invoke(resolver, argument, requiredCode, failedCode, label) {
  if (typeof resolver !== 'function') fail(requiredCode, `${label} resolver is required`);
  try { return resolver(argument); } catch (cause) { fail(failedCode, `${label} resolver failed`, cause); }
}

function safeRef(value, label) {
  return text(value, label, { maximum: 256, pattern: SAFE_REF });
}

function hash(value, label) {
  return text(value, label, { maximum: 71, pattern: HASH });
}

function normalizeRights(value) {
  if (!Array.isArray(value) || value.length > 20) fail('INVALID_RIGHTS', 'source rights must be an array within limits');
  const rights = value.map((right, index) => text(right, `sourceEvidence.rights[${index}]`, { maximum: 64, pattern: /^[a-z][a-z0-9_]{1,63}$/ }));
  if (new Set(rights).size !== rights.length) fail('INVALID_RIGHTS', 'source rights must not repeat');
  return rights.sort();
}

export function calculatePrivateProductId(input) {
  exactKeys(input, new Set(['organizationId', 'skillId', 'productKey']), 'privateProductIdentity');
  const organizationIdValue = organizationId(input.organizationId);
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (cause) { fail('INVALID_SKILL_ID', cause.message, cause); }
  const productKey = text(input.productKey, 'productKey', { maximum: 64, pattern: PRODUCT_KEY }).toLowerCase();
  return `privprod_${canonicalDigest({ domain: 'skillops.enterprise.private-product.v1', organizationId: organizationIdValue, skillId, productKey }).slice(7)}`;
}

function normalizeSelfEvidence(input, expected = {}) {
  exactKeys(input, new Set(['decision', 'organizationId', 'sourceType', 'evidenceRef', 'evidenceDigest']), 'selfAuthoredEvidence');
  const result = {
    decision: input.decision,
    organizationId: organizationId(input.organizationId, 'sourceEvidence.organizationId'),
    sourceType: input.sourceType,
    evidenceRef: safeRef(input.evidenceRef, 'sourceEvidence.evidenceRef'),
    evidenceDigest: hash(input.evidenceDigest, 'sourceEvidence.evidenceDigest'),
  };
  if (result.decision !== 'allow' || result.sourceType !== 'self_authored'
    || (expected.organizationId && result.organizationId !== expected.organizationId)
    || (expected.evidenceRef && result.evidenceRef !== expected.evidenceRef)) {
    fail('CREATION_EVIDENCE_MISMATCH', 'self-authored evidence does not match private Product');
  }
  return deepFreeze(result);
}

export function normalizeDerivativeSourceEvidence(input, expected = {}, { at, forNewRelease = false } = {}) {
  exactKeys(input, new Set([
    'decision', 'organizationId', 'privateProductId', 'sourceType', 'evidenceRef', 'evidenceDigest',
    'baseProductId', 'baseReleaseId', 'entitlementId', 'entitlementDigest', 'licenseSnapshotDigest',
    'lineageDigest', 'rights', 'validUntil', 'publicationStatus', 'entitlementStatus',
  ]), 'derivativeSourceEvidence');
  const result = {
    decision: input.decision,
    organizationId: organizationId(input.organizationId, 'sourceEvidence.organizationId'),
    privateProductId: text(input.privateProductId, 'sourceEvidence.privateProductId', { maximum: 73, pattern: PRIVATE_PRODUCT_ID }),
    sourceType: input.sourceType,
    evidenceRef: safeRef(input.evidenceRef, 'sourceEvidence.evidenceRef'),
    evidenceDigest: hash(input.evidenceDigest, 'sourceEvidence.evidenceDigest'),
    baseProductId: text(input.baseProductId, 'sourceEvidence.baseProductId', { maximum: 69, pattern: PRODUCT_ID }),
    baseReleaseId: text(input.baseReleaseId, 'sourceEvidence.baseReleaseId', { maximum: 72, pattern: RELEASE_ID }),
    entitlementId: text(input.entitlementId, 'sourceEvidence.entitlementId', { maximum: 69, pattern: ENTITLEMENT_ID }),
    entitlementDigest: hash(input.entitlementDigest, 'sourceEvidence.entitlementDigest'),
    licenseSnapshotDigest: hash(input.licenseSnapshotDigest, 'sourceEvidence.licenseSnapshotDigest'),
    lineageDigest: hash(input.lineageDigest, 'sourceEvidence.lineageDigest'),
    rights: normalizeRights(input.rights),
    validUntil: optionalTimestamp(input.validUntil, 'sourceEvidence.validUntil'),
    publicationStatus: input.publicationStatus,
    entitlementStatus: input.entitlementStatus,
  };
  if (result.decision !== 'allow' || result.sourceType !== 'authorized_derivative') fail('SOURCE_NOT_AUTHORIZED', 'derivative source is not authorized');
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && result[key] !== value) fail(key === 'organizationId' ? 'SOURCE_ORGANIZATION_MISMATCH' : 'SOURCE_EVIDENCE_MISMATCH', `source ${key} does not match private Product`);
  }
  if (!result.rights.includes('derive') || !result.rights.includes('internal_distribute')) {
    fail('DERIVATIVE_RIGHTS_REQUIRED', 'authorized derivative requires derive and internal_distribute rights');
  }
  if (!PUBLICATION_STATUSES.has(result.publicationStatus)) fail('SOURCE_RELEASE_STATUS_INVALID', 'source Publication status is invalid');
  if (!ENTITLEMENT_STATUSES.has(result.entitlementStatus)) fail('SOURCE_ENTITLEMENT_STATUS_INVALID', 'source Entitlement status is invalid');
  if (result.entitlementStatus !== 'active') fail('SOURCE_ENTITLEMENT_BLOCKED', `source Entitlement is ${result.entitlementStatus}`);
  if (['recalled', 'revoked'].includes(result.publicationStatus)) fail('SOURCE_RELEASE_BLOCKED', `source Release is ${result.publicationStatus}`);
  if (forNewRelease && result.publicationStatus === 'withdrawn') fail('SOURCE_WITHDRAWN_FOR_NEW_RELEASE', 'withdrawn source cannot create a new private Release');
  if (at && result.validUntil && Date.parse(result.validUntil) <= Date.parse(at)) fail('SOURCE_ENTITLEMENT_EXPIRED', 'source Entitlement is expired');
  return deepFreeze(result);
}

function resolveCreationEvidence(context, resolver, at) {
  const raw = invoke(resolver, context, 'CREATION_EVIDENCE_RESOLVER_REQUIRED', 'CREATION_EVIDENCE_RESOLVER_FAILED', 'creation evidence');
  if (!raw) fail('CREATION_EVIDENCE_REQUIRED', 'trusted creation evidence was not found');
  if (context.sourceType === 'self_authored') return normalizeSelfEvidence(raw, context);
  return normalizeDerivativeSourceEvidence(raw, {
    organizationId: context.organizationId,
    privateProductId: context.privateProductId,
    sourceType: context.sourceType,
    evidenceRef: context.evidenceRef,
  }, { at, forNewRelease: true });
}

export function createPrivateProduct(input, options = {}) {
  exactKeys(input, new Set([
    'organizationId', 'skillId', 'productKey', 'titleZh', 'summaryZh', 'sourceType', 'creationEvidenceRef',
  ]), 'privateProductCreate');
  assertSafe(input, 'privateProductCreate');
  const organizationIdValue = organizationId(input.organizationId);
  authorizeOrganization(options.organizationAuthorizer, organizationIdValue, 'enterprise.private_product.create');
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (cause) { fail('INVALID_SKILL_ID', cause.message, cause); }
  const productKey = text(input.productKey, 'productKey', { maximum: 64, pattern: PRODUCT_KEY }).toLowerCase();
  const sourceType = text(input.sourceType, 'sourceType', { maximum: 32 });
  if (!SOURCE_TYPES.has(sourceType)) fail('INVALID_SOURCE_TYPE', 'private Product sourceType is unsupported');
  const creationEvidenceRef = safeRef(input.creationEvidenceRef, 'creationEvidenceRef');
  const createdAt = trustedNow(options.now);
  const privateProductId = calculatePrivateProductId({ organizationId: organizationIdValue, skillId, productKey });
  const sourceEvidence = resolveCreationEvidence({
    organizationId: organizationIdValue, privateProductId, sourceType, evidenceRef: creationEvidenceRef,
    creationEvidenceRef,
  }, options.creationEvidenceResolver, createdAt);
  const body = {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    privateProductId,
    organizationId: organizationIdValue,
    skillId,
    productKey,
    titleZh: text(input.titleZh, 'titleZh', { maximum: 120 }),
    summaryZh: text(input.summaryZh, 'summaryZh', { maximum: 1_000 }),
    sourceType,
    sourceEvidence,
    visibility: 'organization_private',
    createdAt,
  };
  return deepFreeze({ ...body, productDigest: canonicalDigest(body) });
}

export function normalizePrivateProduct(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'privateProductId', 'organizationId', 'skillId', 'productKey', 'titleZh', 'summaryZh',
    'sourceType', 'sourceEvidence', 'visibility', 'createdAt', 'productDigest',
  ]), 'privateProduct');
  assertSafe(input, 'privateProduct');
  if (input.schemaVersion !== PRIVATE_ABILITY_SCHEMA_VERSION || input.visibility !== 'organization_private' || !SOURCE_TYPES.has(input.sourceType)) {
    fail('INVALID_PRIVATE_PRODUCT', 'private Product is unsupported');
  }
  const organizationIdValue = organizationId(input.organizationId);
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (cause) { fail('INVALID_SKILL_ID', cause.message, cause); }
  const productKey = text(input.productKey, 'productKey', { maximum: 64, pattern: PRODUCT_KEY }).toLowerCase();
  const privateProductId = calculatePrivateProductId({ organizationId: organizationIdValue, skillId, productKey });
  if (input.privateProductId !== privateProductId) fail('PRIVATE_PRODUCT_ID_MISMATCH', 'private Product identity is invalid');
  const sourceEvidence = input.sourceType === 'self_authored'
    ? normalizeSelfEvidence(input.sourceEvidence, { organizationId: organizationIdValue })
    : normalizeDerivativeSourceEvidence(input.sourceEvidence, { organizationId: organizationIdValue, privateProductId });
  const body = {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    privateProductId,
    organizationId: organizationIdValue,
    skillId,
    productKey,
    titleZh: text(input.titleZh, 'titleZh', { maximum: 120 }),
    summaryZh: text(input.summaryZh, 'summaryZh', { maximum: 1_000 }),
    sourceType: input.sourceType,
    sourceEvidence,
    visibility: 'organization_private',
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
  if (input.productDigest !== canonicalDigest(body)) fail('PRIVATE_PRODUCT_DIGEST_MISMATCH', 'private Product digest is invalid');
  return deepFreeze({ ...body, productDigest: input.productDigest });
}

function resolvePrivateProduct(privateProductId, resolver) {
  const raw = invoke(resolver, privateProductId, 'PRIVATE_PRODUCT_RESOLVER_REQUIRED', 'PRIVATE_PRODUCT_RESOLVER_FAILED', 'private Product');
  if (!raw) fail('PRIVATE_PRODUCT_NOT_FOUND', 'private Product was not found');
  const product = normalizePrivateProduct(raw);
  if (product.privateProductId !== privateProductId) fail('PRIVATE_PRODUCT_RESOLVER_MISMATCH', 'private Product resolver returned wrong identity');
  return product;
}

function resolvePackage(packageDigest, resolver) {
  const raw = invoke(resolver, packageDigest, 'PACKAGE_RESOLVER_REQUIRED', 'PACKAGE_RESOLVER_FAILED', 'package');
  if (!raw) fail('PACKAGE_NOT_FOUND', 'private Release package was not found');
  let artifact;
  try { artifact = validatePackageArtifact(raw); } catch (cause) { fail('PACKAGE_REJECTED', 'private Release package is not canonical', cause); }
  if (artifact.packageDigest !== packageDigest) fail('PACKAGE_RESOLVER_MISMATCH', 'package resolver returned wrong digest');
  return artifact;
}

function resolvePreviousRelease(previousPrivateReleaseId, resolver, product) {
  if (previousPrivateReleaseId === null) return null;
  const raw = invoke(resolver, previousPrivateReleaseId, 'PREVIOUS_RELEASE_RESOLVER_REQUIRED', 'PREVIOUS_RELEASE_RESOLVER_FAILED', 'previous private Release');
  if (!raw) fail('PREVIOUS_RELEASE_NOT_FOUND', 'previous private Release was not found');
  const previous = normalizePrivateRelease(raw);
  if (previous.privateReleaseId !== previousPrivateReleaseId || previous.privateProductId !== product.privateProductId
    || previous.organizationId !== product.organizationId) {
    fail('PREVIOUS_RELEASE_MISMATCH', 'previous private Release belongs to another Product or organization');
  }
  return previous;
}

function revalidateDerivativeSource(product, resolver, at, forNewRelease) {
  if (product.sourceType !== 'authorized_derivative') return null;
  const raw = invoke(resolver, {
    organizationId: product.organizationId,
    privateProductId: product.privateProductId,
    sourceEvidence: structuredClone(product.sourceEvidence),
    at,
  }, 'SOURCE_STATUS_RESOLVER_REQUIRED', 'SOURCE_STATUS_RESOLVER_FAILED', 'source status');
  if (!raw) fail('SOURCE_STATUS_REQUIRED', 'current derivative source status was not found');
  const current = normalizeDerivativeSourceEvidence(raw, {
    organizationId: product.organizationId,
    privateProductId: product.privateProductId,
    evidenceRef: product.sourceEvidence.evidenceRef,
    baseProductId: product.sourceEvidence.baseProductId,
    baseReleaseId: product.sourceEvidence.baseReleaseId,
    entitlementId: product.sourceEvidence.entitlementId,
    entitlementDigest: product.sourceEvidence.entitlementDigest,
    licenseSnapshotDigest: product.sourceEvidence.licenseSnapshotDigest,
    lineageDigest: product.sourceEvidence.lineageDigest,
  }, { at, forNewRelease });
  return current;
}

export function createPrivateRelease(input, options = {}) {
  exactKeys(input, new Set([
    'organizationId', 'privateProductId', 'version', 'packageDigest', 'previousPrivateReleaseId',
  ]), 'privateReleaseCreate');
  assertSafe(input, 'privateReleaseCreate');
  const organizationIdValue = organizationId(input.organizationId);
  authorizeOrganization(options.organizationAuthorizer, organizationIdValue, 'enterprise.private_release.create');
  const privateProductId = text(input.privateProductId, 'privateProductId', { maximum: 73, pattern: PRIVATE_PRODUCT_ID });
  const product = resolvePrivateProduct(privateProductId, options.privateProductResolver);
  if (product.organizationId !== organizationIdValue) fail('PRIVATE_PRODUCT_ORGANIZATION_MISMATCH', 'private Product belongs to another organization');
  let version;
  try { version = normalizeSemver(input.version); } catch (cause) { fail('INVALID_VERSION', cause.message, cause); }
  const packageDigest = hash(input.packageDigest, 'packageDigest');
  const packageArtifact = resolvePackage(packageDigest, options.packageResolver);
  const previousPrivateReleaseId = input.previousPrivateReleaseId === null ? null
    : text(input.previousPrivateReleaseId, 'previousPrivateReleaseId', { maximum: 72, pattern: PRIVATE_RELEASE_ID });
  const previous = resolvePreviousRelease(previousPrivateReleaseId, options.previousPrivateReleaseResolver, product);
  if (previous && previous.version === version) fail('PRIVATE_VERSION_IMMUTABLE', 'new private Release must use a new version');
  const createdAt = trustedNow(options.now);
  const currentSource = revalidateDerivativeSource(product, options.sourceStatusResolver, createdAt, true);
  const packageManifestDigest = canonicalDigest(packageArtifact.manifest);
  const identity = { privateProductId, version, packageDigest };
  const body = {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    privateReleaseId: `privrel_${canonicalDigest({ domain: 'skillops.enterprise.private-release.v1', ...identity }).slice(7)}`,
    organizationId: organizationIdValue,
    privateProductId,
    version,
    packageDigest,
    packageManifestDigest,
    fileCount: packageArtifact.fileCount,
    totalBytes: packageArtifact.totalBytes,
    previousPrivateReleaseId,
    sourceType: product.sourceType,
    sourceEvidenceDigest: currentSource?.evidenceDigest ?? product.sourceEvidence.evidenceDigest,
    status: 'evidence_pending',
    createdAt,
  };
  return deepFreeze({ ...body, releaseDigest: canonicalDigest(body) });
}

export function normalizePrivateRelease(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'privateReleaseId', 'organizationId', 'privateProductId', 'version', 'packageDigest',
    'packageManifestDigest', 'fileCount', 'totalBytes', 'previousPrivateReleaseId', 'sourceType',
    'sourceEvidenceDigest', 'status', 'createdAt', 'releaseDigest',
  ]), 'privateRelease');
  assertSafe(input, 'privateRelease');
  if (input.schemaVersion !== PRIVATE_ABILITY_SCHEMA_VERSION || input.status !== 'evidence_pending' || !SOURCE_TYPES.has(input.sourceType)) {
    fail('INVALID_PRIVATE_RELEASE', 'private Release is unsupported');
  }
  const privateProductId = text(input.privateProductId, 'privateProductId', { maximum: 73, pattern: PRIVATE_PRODUCT_ID });
  let version;
  try { version = normalizeSemver(input.version); } catch (cause) { fail('INVALID_VERSION', cause.message, cause); }
  const packageDigest = hash(input.packageDigest, 'packageDigest');
  const expectedId = `privrel_${canonicalDigest({ domain: 'skillops.enterprise.private-release.v1', privateProductId, version, packageDigest }).slice(7)}`;
  const body = {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    privateReleaseId: text(input.privateReleaseId, 'privateReleaseId', { maximum: 72, pattern: PRIVATE_RELEASE_ID }),
    organizationId: organizationId(input.organizationId),
    privateProductId,
    version,
    packageDigest,
    packageManifestDigest: hash(input.packageManifestDigest, 'packageManifestDigest'),
    fileCount: input.fileCount,
    totalBytes: input.totalBytes,
    previousPrivateReleaseId: input.previousPrivateReleaseId === null ? null
      : text(input.previousPrivateReleaseId, 'previousPrivateReleaseId', { maximum: 72, pattern: PRIVATE_RELEASE_ID }),
    sourceType: input.sourceType,
    sourceEvidenceDigest: hash(input.sourceEvidenceDigest, 'sourceEvidenceDigest'),
    status: 'evidence_pending',
    createdAt: timestamp(input.createdAt, 'createdAt'),
  };
  if (!Number.isSafeInteger(body.fileCount) || body.fileCount < 1 || !Number.isSafeInteger(body.totalBytes) || body.totalBytes < 0) {
    fail('INVALID_PACKAGE_SUMMARY', 'private Release package summary is invalid');
  }
  if (body.privateReleaseId !== expectedId || input.releaseDigest !== canonicalDigest(body)) {
    fail('PRIVATE_RELEASE_DIGEST_MISMATCH', 'private Release identity or digest is invalid');
  }
  return deepFreeze({ ...body, releaseDigest: input.releaseDigest });
}

function normalizeEvidenceItem(input, type, release, assessedAt) {
  if (input === null) return null;
  exactKeys(input, new Set([
    'status', 'evidenceDigest', 'basedOnPackageDigest', 'basedOnManifestDigest', 'validUntil', 'current',
  ]), `${type}Evidence`);
  const result = {
    status: text(input.status, `${type}Evidence.status`, { maximum: 32 }),
    evidenceDigest: hash(input.evidenceDigest, `${type}Evidence.evidenceDigest`),
    basedOnPackageDigest: hash(input.basedOnPackageDigest, `${type}Evidence.basedOnPackageDigest`),
    basedOnManifestDigest: hash(input.basedOnManifestDigest, `${type}Evidence.basedOnManifestDigest`),
    validUntil: optionalTimestamp(input.validUntil, `${type}Evidence.validUntil`),
  };
  if (result.basedOnPackageDigest !== release.packageDigest || result.basedOnManifestDigest !== release.packageManifestDigest) {
    fail('EVIDENCE_BINDING_MISMATCH', `${type} evidence is bound to another package or manifest`);
  }
  result.current = result.validUntil !== null && Date.parse(result.validUntil) > Date.parse(assessedAt);
  if (input.current !== undefined && input.current !== result.current) fail('EVIDENCE_CURRENT_MISMATCH', `${type} evidence current flag is invalid`);
  return deepFreeze(result);
}

function evidenceBody(release, raw, assessedAt) {
  exactKeys(raw, new Set(EVIDENCE_TYPES), 'privateReleaseEvidenceResolverResult');
  const evidence = {};
  const gaps = [];
  for (const type of EVIDENCE_TYPES) {
    evidence[type] = normalizeEvidenceItem(raw[type], type, release, assessedAt);
    if (evidence[type] === null) gaps.push(`${type}_missing`);
    else if (evidence[type].validUntil === null) gaps.push(`${type}_validity_missing`);
    else if (!evidence[type].current) gaps.push(`${type}_expired`);
    else if (evidence[type].status !== EXPECTED_EVIDENCE_STATUS[type]) gaps.push(`${type}_not_passed`);
  }
  gaps.sort();
  return {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    evidenceAssessmentId: `privev_${canonicalDigest({ privateReleaseId: release.privateReleaseId, assessedAt, evidence }).slice(7)}`,
    organizationId: release.organizationId,
    privateProductId: release.privateProductId,
    privateReleaseId: release.privateReleaseId,
    packageDigest: release.packageDigest,
    packageManifestDigest: release.packageManifestDigest,
    status: gaps.length ? 'evidence_pending' : 'callable',
    gaps,
    evidence,
    assessedAt,
  };
}

export function assessPrivateReleaseEvidence(input, options = {}) {
  exactKeys(input, new Set(['organizationId', 'privateReleaseId']), 'privateReleaseEvidenceAssess');
  const organizationIdValue = organizationId(input.organizationId);
  authorizeOrganization(options.organizationAuthorizer, organizationIdValue, 'enterprise.private_release.assess');
  const privateReleaseId = text(input.privateReleaseId, 'privateReleaseId', { maximum: 72, pattern: PRIVATE_RELEASE_ID });
  const rawRelease = invoke(options.privateReleaseResolver, privateReleaseId, 'PRIVATE_RELEASE_RESOLVER_REQUIRED', 'PRIVATE_RELEASE_RESOLVER_FAILED', 'private Release');
  if (!rawRelease) fail('PRIVATE_RELEASE_NOT_FOUND', 'private Release was not found');
  const release = normalizePrivateRelease(rawRelease);
  if (release.privateReleaseId !== privateReleaseId || release.organizationId !== organizationIdValue) {
    fail('PRIVATE_RELEASE_ORGANIZATION_MISMATCH', 'private Release belongs to another organization');
  }
  const assessedAt = trustedNow(options.now);
  const raw = invoke(options.evidenceResolver, {
    organizationId: organizationIdValue,
    privateProductId: release.privateProductId,
    privateReleaseId,
    packageDigest: release.packageDigest,
    packageManifestDigest: release.packageManifestDigest,
    assessedAt,
  }, 'EVIDENCE_RESOLVER_REQUIRED', 'EVIDENCE_RESOLVER_FAILED', 'private Release evidence');
  if (!raw) fail('EVIDENCE_RESOLVER_MISMATCH', 'trusted evidence resolver returned no snapshot');
  const body = evidenceBody(release, raw, assessedAt);
  return deepFreeze({ ...body, evidenceAssessmentDigest: canonicalDigest(body) });
}

export function normalizePrivateReleaseEvidence(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'evidenceAssessmentId', 'organizationId', 'privateProductId', 'privateReleaseId',
    'packageDigest', 'packageManifestDigest', 'status', 'gaps', 'evidence', 'assessedAt', 'evidenceAssessmentDigest',
  ]), 'privateReleaseEvidence');
  if (input.schemaVersion !== PRIVATE_ABILITY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'private Release evidence schema is unsupported');
  const release = {
    organizationId: organizationId(input.organizationId),
    privateProductId: text(input.privateProductId, 'privateProductId', { maximum: 73, pattern: PRIVATE_PRODUCT_ID }),
    privateReleaseId: text(input.privateReleaseId, 'privateReleaseId', { maximum: 72, pattern: PRIVATE_RELEASE_ID }),
    packageDigest: hash(input.packageDigest, 'packageDigest'),
    packageManifestDigest: hash(input.packageManifestDigest, 'packageManifestDigest'),
  };
  const assessedAt = timestamp(input.assessedAt, 'assessedAt');
  const body = evidenceBody(release, input.evidence, assessedAt);
  if (body.evidenceAssessmentId !== input.evidenceAssessmentId || body.status !== input.status
    || canonicalDigest(body.gaps) !== canonicalDigest(input.gaps)
    || input.evidenceAssessmentDigest !== canonicalDigest(body)) {
    fail('PRIVATE_EVIDENCE_DIGEST_MISMATCH', 'private Release evidence assessment is invalid');
  }
  return deepFreeze({ ...body, evidenceAssessmentDigest: input.evidenceAssessmentDigest });
}
