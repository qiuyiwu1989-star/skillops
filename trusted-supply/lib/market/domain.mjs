import {
  canonicalDigest,
  normalizeRelease,
  normalizeSemver,
  normalizeSkillId,
} from '../registry-identity.mjs';
import { validateIdpReceipt } from '../idp-receipt.mjs';
import { normalizeAccessDecision as normalizeCommerceAccessDecision } from '../commerce/access-decision.mjs';

export const MARKET_SCHEMA_VERSION = 1;

const PUBLISHER_ID = /^pub_[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const APPLICATION_ID = /^app_[a-f0-9]{64}$/;
const APPLICATION_RELEASE_ID = /^apprel_[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const PRODUCT_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const PUBLISHER_KINDS = new Set(['individual', 'organization']);
const ABILITY_TYPES = new Set(['skill', 'application']);
const DEPENDENCY_REQUIREMENTS = new Set(['required', 'optional']);
const RIGHTS = new Set([
  'invoke', 'organization_use', 'install', 'view_source', 'modify', 'derive',
  'internal_distribute', 'commercial_output', 'redistribute_derivative', 'updates', 'support',
]);
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*\S{4,}/i;

export class MarketDomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MarketDomainError';
    this.code = code;
    if (details !== undefined) this.details = deepFreeze(structuredClone(details));
  }
}

function fail(code, message, details) {
  throw new MarketDomainError(code, message, details);
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
    if (PRIVATE_VALUE.test(value)) fail('PRIVATE_VALUE', `${label} contains a private or sensitive value`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoPrivateValue(nested, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) assertNoPrivateValue(nested, `${label}.${key}`);
  }
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  assertNoPrivateValue(normalized, label);
  return normalized;
}

function id(value, label, pattern) {
  const normalized = text(value, label, 128);
  if (!pattern.test(normalized)) fail('INVALID_ID', `${label} is not a canonical identifier`);
  return normalized;
}

function productKey(value) {
  const normalized = text(value, 'productKey', 64).toLowerCase();
  if (!PRODUCT_KEY.test(normalized) || normalized.startsWith('cand_')) fail('INVALID_PRODUCT_KEY', 'productKey must be a lowercase stable slug');
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function generatedId(prefix, domain, body) {
  return `${prefix}_${canonicalDigest({ domain, ...body }).slice('sha256:'.length)}`;
}

function publisherId(value, label = 'publisherId') {
  return id(value, label, PUBLISHER_ID);
}

function normalizeParties(value) {
  exactKeys(value, new Set([
    'creatorPublisherIds', 'rightsHolderPublisherId', 'payeePublisherId', 'supportPublisherId',
  ]), 'parties');
  if (!Array.isArray(value.creatorPublisherIds) || value.creatorPublisherIds.length < 1 || value.creatorPublisherIds.length > 100) {
    fail('INVALID_PARTIES', 'parties.creatorPublisherIds must contain 1 to 100 publishers');
  }
  const creatorPublisherIds = value.creatorPublisherIds.map((entry, index) => publisherId(entry, `parties.creatorPublisherIds[${index}]`));
  if (new Set(creatorPublisherIds).size !== creatorPublisherIds.length) fail('DUPLICATE_PARTY', 'creator publishers must not repeat');
  return deepFreeze({
    creatorPublisherIds: creatorPublisherIds.sort(),
    rightsHolderPublisherId: publisherId(value.rightsHolderPublisherId, 'parties.rightsHolderPublisherId'),
    payeePublisherId: value.payeePublisherId === null ? null : publisherId(value.payeePublisherId, 'parties.payeePublisherId'),
    supportPublisherId: value.supportPublisherId === null ? null : publisherId(value.supportPublisherId, 'parties.supportPublisherId'),
  });
}

function baseProduct(input, abilityType) {
  const publisherIdValue = publisherId(input.publisherId);
  const key = productKey(input.productKey);
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const base = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    productId: generatedId('prod', 'skillops.market.product.v1', { publisherId: publisherIdValue, abilityType, productKey: key }),
    abilityType,
    publisherId: publisherIdValue,
    productKey: key,
    titleZh: text(input.titleZh, 'titleZh', 120),
    summaryZh: text(input.summaryZh, 'summaryZh', 1_000),
    parties: normalizeParties(input.parties),
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
  };
  return base;
}

function finalizeProduct(value) {
  const productDigest = canonicalDigest(value);
  return deepFreeze({ ...value, productDigest });
}

export function createPublisher(input, trustOptions = {}) {
  exactKeys(input, new Set(['kind', 'displayName', 'identityReceipt', 'createdAt']), 'publisher');
  assertNoPrivateValue(input, 'publisher');
  if (!PUBLISHER_KINDS.has(input.kind)) fail('INVALID_PUBLISHER_KIND', 'publisher kind must be individual or organization');
  let receipt;
  try {
    receipt = validateIdpReceipt(input.identityReceipt, trustOptions);
  } catch (cause) {
    fail('IDENTITY_RECEIPT_REJECTED', 'publisher identity receipt is not trusted', { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if ((input.kind === 'individual' && receipt.kind !== 'human')
    || (input.kind === 'organization' && receipt.kind !== 'service')) {
    fail('PUBLISHER_KIND_MISMATCH', 'publisher kind does not match the verified identity kind');
  }
  const createdAt = timestamp(input.createdAt, 'createdAt');
  if (Date.parse(createdAt) < Date.parse(receipt.issuedAt) || Date.parse(createdAt) >= Date.parse(receipt.expiresAt)) {
    fail('IDENTITY_RECEIPT_NOT_CURRENT', 'publisher creation must occur during the receipt validity window');
  }
  const body = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    publisherId: generatedId('pub', 'skillops.market.publisher.v1', {
      publisherKind: input.kind,
      identityProvider: receipt.provider,
      identitySubjectDigest: receipt.subjectDigest,
    }),
    kind: input.kind,
    displayName: text(input.displayName, 'displayName', 120),
    identityEvidence: {
      provider: receipt.provider,
      subjectDigest: receipt.subjectDigest,
      identityKind: receipt.kind,
      receiptDigest: receipt.receiptDigest,
      verifiedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
    },
    status: 'active',
    createdAt,
  };
  return deepFreeze({ ...body, publisherDigest: canonicalDigest(body) });
}

const COMMON_PRODUCT_KEYS = [
  'publisherId', 'productKey', 'titleZh', 'summaryZh', 'parties', 'createdAt',
];

export function createSkillProduct(input, { registryRelease } = {}) {
  exactKeys(input, new Set([...COMMON_PRODUCT_KEYS, 'skillId', 'releaseId']), 'skill product');
  if (typeof input.skillId === 'string' && /(?:^|\/)cand_/i.test(input.skillId)) {
    fail('CANDIDATE_ID_FORBIDDEN', 'candidate identity cannot be used as skillId');
  }
  assertNoPrivateValue(input, 'skill product');
  if (!registryRelease) fail('REGISTRY_RELEASE_REQUIRED', 'skill product requires a canonical Registry Release');
  let release;
  try {
    release = normalizeRelease(registryRelease);
  } catch (cause) {
    fail('REGISTRY_RELEASE_REJECTED', 'Registry Release is not canonical', { causeCode: cause.code ?? 'UNKNOWN' });
  }
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (cause) {
    fail('INVALID_SKILL_ID', cause.message);
  }
  const releaseId = id(input.releaseId, 'releaseId', RELEASE_ID);
  if (release.skillId !== skillId || release.releaseId !== releaseId) {
    fail('REGISTRY_BINDING_MISMATCH', 'skill product must bind the supplied canonical Registry Release');
  }
  return finalizeProduct({ ...baseProduct(input, 'skill'), skillId, releaseId });
}

export function createApplicationProduct(input) {
  exactKeys(input, new Set(COMMON_PRODUCT_KEYS), 'application product');
  assertNoPrivateValue(input, 'application product');
  const base = baseProduct(input, 'application');
  const applicationId = generatedId('app', 'skillops.market.application.v1', {
    publisherId: base.publisherId,
    productKey: base.productKey,
  });
  return finalizeProduct({ ...base, applicationId });
}

export function createAbilityProduct(input, options = {}) {
  exactKeys(input, new Set(['abilityType', ...COMMON_PRODUCT_KEYS, ...(input?.abilityType === 'skill' ? ['skillId', 'releaseId'] : [])]), 'ability product');
  if (!ABILITY_TYPES.has(input.abilityType)) fail('INVALID_ABILITY_TYPE', 'abilityType must be skill or application');
  const { abilityType, ...typedInput } = input;
  return abilityType === 'skill'
    ? createSkillProduct(typedInput, options)
    : createApplicationProduct(typedInput);
}

function assertApplicationProduct(product) {
  exactKeys(product, new Set([
    'schemaVersion', 'productId', 'abilityType', 'publisherId', 'productKey', 'titleZh', 'summaryZh',
    'parties', 'status', 'createdAt', 'updatedAt', 'applicationId', 'productDigest',
  ]), 'applicationProduct');
  assertNoPrivateValue(product, 'applicationProduct');
  if (product.schemaVersion !== MARKET_SCHEMA_VERSION || product.abilityType !== 'application' || product.status !== 'draft') {
    fail('INVALID_APPLICATION_PRODUCT', 'applicationProduct is not a supported application product');
  }
  const rebuilt = createApplicationProduct({
    publisherId: product.publisherId,
    productKey: product.productKey,
    titleZh: product.titleZh,
    summaryZh: product.summaryZh,
    parties: product.parties,
    createdAt: product.createdAt,
  });
  if (rebuilt.productId !== product.productId || rebuilt.applicationId !== product.applicationId
    || rebuilt.productDigest !== product.productDigest || product.updatedAt !== product.createdAt) {
    fail('APPLICATION_PRODUCT_TAMPERED', 'applicationProduct identity or digest is invalid');
  }
  return product;
}

function normalizeRights(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > RIGHTS.size) fail('INVALID_RIGHTS', `${label} must be a non-empty rights array`);
  const rights = value.map((entry, index) => {
    const right = text(entry, `${label}[${index}]`, 64);
    if (!RIGHTS.has(right)) fail('INVALID_RIGHT', `${label}[${index}] is unsupported`);
    return right;
  });
  if (new Set(rights).size !== rights.length) fail('DUPLICATE_RIGHT', `${label} must not contain duplicates`);
  if (!rights.includes('invoke')) fail('INVOKE_RIGHT_REQUIRED', `${label} must include invoke`);
  return rights.sort();
}

function normalizeDependency(input, index, resolveRegistryRelease, resolveSkillProduct) {
  const label = `bom[${index}]`;
  exactKeys(input, new Set(['productId', 'skillId', 'releaseId', 'requirement', 'requiredRights']), label);
  if (typeof input.skillId === 'string' && /(?:^|\/)cand_/i.test(input.skillId)) {
    fail('CANDIDATE_ID_FORBIDDEN', `${label}.skillId cannot use candidate identity`);
  }
  assertNoPrivateValue(input, label);
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (cause) { fail('INVALID_SKILL_ID', cause.message); }
  const dependency = {
    productId: id(input.productId, `${label}.productId`, PRODUCT_ID),
    skillId,
    releaseId: id(input.releaseId, `${label}.releaseId`, RELEASE_ID),
    requirement: text(input.requirement, `${label}.requirement`, 16),
    requiredRights: normalizeRights(input.requiredRights, `${label}.requiredRights`),
  };
  if (!DEPENDENCY_REQUIREMENTS.has(dependency.requirement)) fail('INVALID_REQUIREMENT', `${label}.requirement must be required or optional`);
  let resolved;
  try { resolved = resolveRegistryRelease({ skillId: dependency.skillId, releaseId: dependency.releaseId }); } catch (cause) {
    fail('BOM_RELEASE_RESOLUTION_FAILED', `${label} Registry Release resolution failed`, { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if (!resolved) fail('BOM_RELEASE_NOT_FOUND', `${label} does not resolve to a Registry Release`);
  let release;
  try { release = normalizeRelease(resolved); } catch (cause) {
    fail('BOM_RELEASE_REJECTED', `${label} did not resolve to a canonical Registry Release`, { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if (release.skillId !== dependency.skillId || release.releaseId !== dependency.releaseId) {
    fail('BOM_RELEASE_MISMATCH', `${label} does not match the resolved Registry Release`);
  }
  let product;
  try { product = toPublicMarketValue(resolveSkillProduct({ productId: dependency.productId })); } catch (cause) {
    fail('BOM_PRODUCT_RESOLUTION_FAILED', `${label} Skill Product resolution failed`, { causeCode: cause.code ?? 'UNKNOWN' });
  }
  if (product.abilityType !== 'skill' || product.productId !== dependency.productId
    || product.skillId !== dependency.skillId || product.releaseId !== dependency.releaseId) {
    fail('BOM_PRODUCT_MISMATCH', `${label} product is not bound to the declared Skill Release`);
  }
  return dependency;
}

export function createApplicationRelease(input, { applicationProduct, resolveRegistryRelease, resolveSkillProduct } = {}) {
  exactKeys(input, new Set(['applicationId', 'productId', 'version', 'bom', 'publishedAt']), 'application release');
  assertNoPrivateValue(input, 'application release');
  const product = assertApplicationProduct(applicationProduct);
  const applicationId = id(input.applicationId, 'applicationId', APPLICATION_ID);
  const productId = id(input.productId, 'productId', PRODUCT_ID);
  if (applicationId !== product.applicationId || productId !== product.productId) {
    fail('APPLICATION_BINDING_MISMATCH', 'application release must bind the validated application product');
  }
  if (typeof resolveRegistryRelease !== 'function') fail('RELEASE_RESOLVER_REQUIRED', 'resolveRegistryRelease must be a function');
  if (typeof resolveSkillProduct !== 'function') fail('PRODUCT_RESOLVER_REQUIRED', 'resolveSkillProduct must be a function');
  let version;
  try { version = normalizeSemver(input.version); } catch (cause) { fail('INVALID_VERSION', cause.message); }
  if (!Array.isArray(input.bom) || input.bom.length < 1 || input.bom.length > 200) fail('INVALID_BOM', 'bom must contain 1 to 200 dependencies');
  const bom = input.bom.map((dependency, index) => normalizeDependency(dependency, index, resolveRegistryRelease, resolveSkillProduct));
  const duplicate = new Set();
  for (const dependency of bom) {
    const key = `${dependency.skillId}\0${dependency.releaseId}`;
    if (duplicate.has(key)) fail('DUPLICATE_BOM_DEPENDENCY', `bom repeats ${dependency.skillId} at ${dependency.releaseId}`);
    duplicate.add(key);
  }
  bom.sort((left, right) => `${left.skillId}\0${left.releaseId}`.localeCompare(`${right.skillId}\0${right.releaseId}`, 'en'));
  const core = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    applicationId,
    productId,
    version,
    status: 'published',
    bom,
    publishedAt: timestamp(input.publishedAt, 'publishedAt'),
  };
  const releaseDigest = canonicalDigest(core);
  return deepFreeze({
    ...core,
    applicationReleaseId: generatedId('apprel', 'skillops.market.application-release.v1', { releaseDigest }),
    releaseDigest,
  });
}

export function assertApplicationBomAuthorized(applicationRelease, { authorizeDependency, organizationId, checkedAt } = {}) {
  exactKeys(applicationRelease, new Set([
    'schemaVersion', 'applicationId', 'productId', 'version', 'status', 'bom', 'publishedAt',
    'applicationReleaseId', 'releaseDigest',
  ]), 'applicationRelease');
  if (!applicationRelease || !APPLICATION_RELEASE_ID.test(applicationRelease.applicationReleaseId ?? '')
    || !APPLICATION_ID.test(applicationRelease.applicationId ?? '') || !PRODUCT_ID.test(applicationRelease.productId ?? '')
    || !Array.isArray(applicationRelease.bom) || canonicalDigest({
      schemaVersion: applicationRelease.schemaVersion,
      applicationId: applicationRelease.applicationId,
      productId: applicationRelease.productId,
      version: applicationRelease.version,
      status: applicationRelease.status,
      bom: applicationRelease.bom,
      publishedAt: applicationRelease.publishedAt,
    }) !== applicationRelease.releaseDigest
    || generatedId('apprel', 'skillops.market.application-release.v1', { releaseDigest: applicationRelease.releaseDigest }) !== applicationRelease.applicationReleaseId) {
    fail('APPLICATION_RELEASE_TAMPERED', 'applicationRelease identity or digest is invalid');
  }
  assertNoPrivateValue(applicationRelease, 'applicationRelease');
  if (typeof authorizeDependency !== 'function') fail('ACCESS_CHECK_REQUIRED', 'authorizeDependency must be a function');
  if (typeof organizationId !== 'string' || typeof checkedAt !== 'string') fail('ACCESS_CONTEXT_REQUIRED', 'organizationId and checkedAt are required');
  const authorizedDependencies = [];
  const omittedOptionalDependencies = [];
  for (let index = 0; index < applicationRelease.bom.length; index += 1) {
    const dependency = applicationRelease.bom[index];
    let decision;
    try { decision = authorizeDependency(dependency); } catch (cause) {
      fail('BOM_ACCESS_CHECK_FAILED', `authorization check failed for ${dependency.skillId}`, { causeCode: cause.code ?? 'UNKNOWN' });
    }
    let checked;
    try {
      checked = normalizeCommerceAccessDecision(decision, {
        organizationId, productId: dependency.productId, releaseId: dependency.releaseId,
        requiredRights: dependency.requiredRights, checkedAt,
      });
    } catch (cause) {
      fail(cause.code ?? 'INVALID_ACCESS_DECISION', `authorization decision is invalid for ${dependency.skillId}`);
    }
    if (checked.decision === 'allow') authorizedDependencies.push({ dependency, decision: checked });
    else if (dependency.requirement === 'optional') omittedOptionalDependencies.push({ dependency, decision: checked });
    else fail('BOM_DEPENDENCY_UNAUTHORIZED', `required dependency ${dependency.skillId} is not authorized`, {
      productId: dependency.productId,
      skillId: dependency.skillId,
      releaseId: dependency.releaseId,
      decisionCode: checked.code,
    });
  }
  return deepFreeze({
    schemaVersion: MARKET_SCHEMA_VERSION,
    applicationReleaseId: applicationRelease.applicationReleaseId,
    authorizedDependencies,
    omittedOptionalDependencies,
  });
}

export function toPublicMarketValue(value) {
  assertNoPrivateValue(value, 'market value');
  if (value?.publisherId && value?.identityEvidence) {
    const allowed = new Set([
      'schemaVersion', 'publisherId', 'kind', 'displayName', 'identityEvidence', 'status', 'createdAt', 'publisherDigest',
    ]);
    exactKeys(value, allowed, 'publisher');
    exactKeys(value.identityEvidence, new Set([
      'provider', 'subjectDigest', 'identityKind', 'receiptDigest', 'verifiedAt', 'expiresAt',
    ]), 'publisher.identityEvidence');
    const { publisherDigest, ...publisherBody } = value;
    if (!PUBLISHER_ID.test(value.publisherId ?? '') || canonicalDigest(publisherBody) !== publisherDigest) {
      fail('PUBLISHER_TAMPERED', 'publisher identity or digest is invalid');
    }
    return deepFreeze({
      schemaVersion: value.schemaVersion,
      publisherId: value.publisherId,
      kind: value.kind,
      displayName: value.displayName,
      verification: {
        provider: value.identityEvidence.provider,
        identityKind: value.identityEvidence.identityKind,
        verifiedAt: value.identityEvidence.verifiedAt,
        expiresAt: value.identityEvidence.expiresAt,
      },
      status: value.status,
      createdAt: value.createdAt,
    });
  }
  if (value?.productId && value?.productDigest) {
    const common = [
      'schemaVersion', 'productId', 'abilityType', 'publisherId', 'productKey', 'titleZh', 'summaryZh',
      'parties', 'status', 'createdAt', 'updatedAt', 'productDigest',
    ];
    exactKeys(value, new Set([
      ...common,
      ...(value.abilityType === 'skill' ? ['skillId', 'releaseId'] : value.abilityType === 'application' ? ['applicationId'] : []),
    ]), 'ability product');
    if (!ABILITY_TYPES.has(value.abilityType) || value.schemaVersion !== MARKET_SCHEMA_VERSION || value.status !== 'draft') {
      fail('INVALID_ABILITY_PRODUCT', 'ability product is invalid');
    }
    normalizeParties(value.parties);
    const expectedProductId = generatedId('prod', 'skillops.market.product.v1', {
      publisherId: publisherId(value.publisherId),
      abilityType: value.abilityType,
      productKey: productKey(value.productKey),
    });
    const { productDigest, ...productBody } = value;
    if (value.productId !== expectedProductId || canonicalDigest(productBody) !== productDigest) {
      fail('ABILITY_PRODUCT_TAMPERED', 'ability product identity or digest is invalid');
    }
    if (value.abilityType === 'skill') {
      try { normalizeSkillId(value.skillId); } catch (cause) { fail('INVALID_SKILL_ID', cause.message); }
      id(value.releaseId, 'releaseId', RELEASE_ID);
    } else {
      const expectedApplicationId = generatedId('app', 'skillops.market.application.v1', {
        publisherId: value.publisherId,
        productKey: value.productKey,
      });
      if (value.applicationId !== expectedApplicationId) fail('ABILITY_PRODUCT_TAMPERED', 'application identity is invalid');
    }
    return deepFreeze(structuredClone(value));
  }
  if (value?.applicationReleaseId && value?.releaseDigest) {
    exactKeys(value, new Set([
      'schemaVersion', 'applicationId', 'productId', 'version', 'status', 'bom', 'publishedAt',
      'applicationReleaseId', 'releaseDigest',
    ]), 'application release');
    const { applicationReleaseId, releaseDigest, ...releaseBody } = value;
    if (canonicalDigest(releaseBody) !== releaseDigest
      || generatedId('apprel', 'skillops.market.application-release.v1', { releaseDigest }) !== applicationReleaseId) {
      fail('APPLICATION_RELEASE_TAMPERED', 'application release identity or digest is invalid');
    }
    return deepFreeze(structuredClone(value));
  }
  fail('UNSUPPORTED_PUBLIC_VALUE', 'value is not a validated market domain object');
}
