import { normalizeEntitlement } from '../commerce/entitlement.mjs';
import { canonicalDigest } from '../registry-identity.mjs';
import { normalizePackageManifest, packageDigest } from '../package.mjs';
import {
  normalizePrivateProduct as normalizePrivateProductRecord,
  normalizePrivateRelease as normalizePrivateReleaseRecord,
} from './private-ability.mjs';

export const DERIVATIVE_EVOLUTION_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENTITLEMENT_ID = /^ent_[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const RELEASE_ID = /^(?:rel|apprel)_[a-f0-9]{64}$/;
const PRIVATE_PRODUCT_ID = /^privprod_[a-f0-9]{64}$/;
const PRIVATE_RELEASE_ID = /^privrel_[a-f0-9]{64}$/;
const PROJECT_ID = /^project_[a-z0-9](?:[a-z0-9._-]{0,90}[a-z0-9])?$/;
const SAFE_ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const EVENT_TYPES = new Set(['plan.accepted', 'rollback.selected']);
const RELEASE_STATUSES = new Set(['published', 'evidence_pending', 'available', 'withdrawn', 'recalled', 'revoked']);
const GOVERNANCE_DIGEST_FIELDS = [
  'licenseDigest', 'securityDigest', 'permissionsDigest', 'compatibilityDigest',
  'dependenciesDigest', 'evidenceDigest',
];
const FORK_KEYS = new Set([
  'schemaVersion', 'entitlementId', 'baseReleaseId', 'privateProductId', 'projectId', 'environment',
]);
const EVOLUTION_KEYS = new Set(['schemaVersion', 'predecessorPrivateReleaseId', 'newPrivateReleaseId']);
const COMPARE_KEYS = new Set([
  'schemaVersion', 'lineageId', 'currentPrivateReleaseId', 'currentBaseReleaseId',
  'proposedUpstreamReleaseId', 'projectId', 'environment',
]);
const ROLLBACK_KEYS = new Set([
  'schemaVersion', 'operationId', 'currentPrivateReleaseId', 'targetPrivateReleaseId',
  'projectId', 'environment',
]);

export class DerivativeEvolutionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DerivativeEvolutionError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DerivativeEvolutionError(code, message, cause);
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

function text(value, label, pattern, maximum = 256) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_IDENTITY', `${label} is invalid`);
  }
  return normalized;
}

function digest(value, label) {
  return text(value, label, DIGEST, 71);
}

function timestamp(value, label) {
  const normalized = text(value, label, null, 128);
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(time).toISOString();
}

function trustedNow(now) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch (cause) { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause); }
  return timestamp(value instanceof Date ? value.toISOString() : value, 'trusted.now');
}

function capability(options, name) {
  if (typeof options?.[name] !== 'function') fail('TRUSTED_CAPABILITY_REQUIRED', `${name} capability is required`);
  return options[name];
}

function invoke(resolver, argument, code, label) {
  try { return resolver(argument); } catch (cause) { fail(code, `${label} failed`, cause); }
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function schema(input, label) {
  if ((input.schemaVersion ?? DERIVATIVE_EVOLUTION_SCHEMA_VERSION) !== DERIVATIVE_EVOLUTION_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `${label} schemaVersion must be ${DERIVATIVE_EVOLUTION_SCHEMA_VERSION}`);
  }
}

function authorizeOrganization(options, context) {
  const raw = invoke(capability(options, 'organizationResolver'), context, 'ORGANIZATION_RESOLVER_FAILED', 'trusted organization resolver');
  object(raw, 'organizationDecision');
  if (raw.decision !== 'allow'
    || raw.organizationId !== context.organizationId
    || raw.projectId !== context.projectId
    || raw.environment !== context.environment) {
    fail('ORGANIZATION_ACCESS_DENIED', 'trusted organization resolver did not authorize the exact scope');
  }
  return freeze({ organizationId: context.organizationId, projectId: context.projectId, environment: context.environment });
}

function resolveEntitlement(id, options) {
  const raw = invoke(capability(options, 'entitlementResolver'), id, 'ENTITLEMENT_RESOLVER_FAILED', 'trusted Entitlement resolver');
  let normalized;
  try { normalized = normalizeEntitlement(raw); } catch (cause) { fail('ENTITLEMENT_INVALID', 'trusted Entitlement is invalid or inactive', cause); }
  if (normalized.entitlementId !== id) fail('ENTITLEMENT_RESOLVER_MISMATCH', 'trusted Entitlement resolver returned the wrong identity');
  return normalized;
}

function normalizeGovernance(raw, label) {
  const value = object(raw, `${label}.governance`);
  const result = Object.fromEntries(GOVERNANCE_DIGEST_FIELDS.map(field => [field, digest(value[field], `${label}.governance.${field}`)]));
  for (const field of ['dependenciesKnown', 'evidenceCurrent', 'licenseAllowsUpgrade']) {
    if (typeof value[field] !== 'boolean') fail('INVALID_GOVERNANCE', `${label}.governance.${field} must be boolean`);
    result[field] = value[field];
  }
  return freeze(result);
}

function resolveGovernance(releaseKind, release, options) {
  const releaseId = releaseKind === 'base' ? release.releaseId : release.privateReleaseId;
  const raw = invoke(capability(options, 'governanceResolver'), {
    releaseKind, releaseId, packageDigest: release.packageDigest, manifestDigest: release.manifestDigest,
  }, 'GOVERNANCE_RESOLVER_FAILED', 'trusted governance resolver');
  const value = object(raw, 'trustedGovernance');
  exactKeys(value, new Set([
    'releaseKind', 'releaseId', 'packageDigest', 'manifestDigest', ...GOVERNANCE_DIGEST_FIELDS,
    'dependenciesKnown', 'evidenceCurrent', 'licenseAllowsUpgrade', 'governanceDigest',
  ]), 'trustedGovernance');
  if (value.releaseKind !== releaseKind || value.releaseId !== releaseId
    || value.packageDigest !== release.packageDigest || value.manifestDigest !== release.manifestDigest) {
    fail('GOVERNANCE_RESOLVER_MISMATCH', 'trusted governance resolver returned the wrong Release binding');
  }
  const governance = normalizeGovernance(value, 'trustedGovernance');
  const body = { releaseKind, releaseId, packageDigest: release.packageDigest, manifestDigest: release.manifestDigest, ...clone(governance) };
  if (value.governanceDigest !== canonicalDigest(body)) fail('GOVERNANCE_DIGEST_MISMATCH', 'trusted governance digest does not match its Release binding');
  return governance;
}

function normalizeBaseRelease(raw, expectedId) {
  const value = object(raw, 'trustedBaseRelease');
  exactKeys(value, new Set(['releaseId', 'productId', 'status', 'packageDigest', 'manifestDigest']), 'trustedBaseRelease');
  const releaseId = text(value.releaseId, 'trustedBaseRelease.releaseId', RELEASE_ID, 72);
  if (releaseId !== expectedId) fail('BASE_RELEASE_RESOLVER_MISMATCH', 'trusted base Release resolver returned the wrong identity');
  const status = text(value.status, 'trustedBaseRelease.status', SAFE_ID, 32);
  if (!RELEASE_STATUSES.has(status)) fail('INVALID_RELEASE_STATUS', 'trusted base Release status is unsupported');
  return freeze({
    releaseId,
    productId: text(value.productId, 'trustedBaseRelease.productId', PRODUCT_ID, 69),
    status,
    packageDigest: digest(value.packageDigest ?? value.package?.packageDigest, 'trustedBaseRelease.packageDigest'),
    manifestDigest: digest(value.manifestDigest ?? value.package?.manifestDigest, 'trustedBaseRelease.manifestDigest'),
    governance: null,
  });
}

function resolveBaseRelease(id, options) {
  const release = normalizeBaseRelease(invoke(capability(options, 'baseReleaseResolver'), id, 'BASE_RELEASE_RESOLVER_FAILED', 'trusted base Release resolver'), id);
  return freeze({ ...release, governance: resolveGovernance('base', release, options) });
}

function normalizePrivateProduct(raw, expectedId) {
  let value;
  try { value = normalizePrivateProductRecord(raw); } catch (cause) { fail('PRIVATE_PRODUCT_INVALID', 'trusted private Product is not canonical', cause); }
  if (value.privateProductId !== expectedId) fail('PRIVATE_PRODUCT_RESOLVER_MISMATCH', 'trusted private Product resolver returned the wrong identity');
  return value;
}

function resolvePrivateProduct(id, options) {
  return normalizePrivateProduct(invoke(capability(options, 'privateProductResolver'), id, 'PRIVATE_PRODUCT_RESOLVER_FAILED', 'trusted private Product resolver'), id);
}

function normalizePrivateRelease(raw, expectedId) {
  let value;
  try { value = normalizePrivateReleaseRecord(raw); } catch (cause) { fail('PRIVATE_RELEASE_INVALID', 'trusted private Release is not canonical', cause); }
  if (value.privateReleaseId !== expectedId) fail('PRIVATE_RELEASE_RESOLVER_MISMATCH', 'trusted private Release resolver returned the wrong identity');
  return value;
}

function resolvePrivateRelease(id, options) {
  const record = normalizePrivateRelease(invoke(capability(options, 'privateReleaseResolver'), id, 'PRIVATE_RELEASE_RESOLVER_FAILED', 'trusted private Release resolver'), id);
  const rawState = invoke(capability(options, 'privateReleaseStateResolver'), {
    privateReleaseId: record.privateReleaseId,
    privateProductId: record.privateProductId,
    organizationId: record.organizationId,
    releaseDigest: record.releaseDigest,
  }, 'PRIVATE_RELEASE_STATE_RESOLVER_FAILED', 'trusted private Release state resolver');
  exactKeys(rawState, new Set([
    'privateReleaseId', 'privateProductId', 'organizationId', 'releaseDigest', 'status',
    'target', 'evidenceCurrent', 'stateDigest',
  ]), 'trustedPrivateReleaseState');
  const target = object(rawState.target, 'trustedPrivateReleaseState.target');
  exactKeys(target, new Set(['exists', 'managed', 'drift']), 'trustedPrivateReleaseState.target');
  for (const field of ['exists', 'managed', 'drift']) if (typeof target[field] !== 'boolean') fail('INVALID_TARGET_STATE', `trusted target ${field} must be boolean`);
  if (rawState.privateReleaseId !== record.privateReleaseId || rawState.privateProductId !== record.privateProductId
    || rawState.organizationId !== record.organizationId || rawState.releaseDigest !== record.releaseDigest) {
    fail('PRIVATE_RELEASE_STATE_MISMATCH', 'trusted private Release state returned the wrong binding');
  }
  const status = text(rawState.status, 'trustedPrivateReleaseState.status', SAFE_ID, 32);
  if (!RELEASE_STATUSES.has(status)) fail('INVALID_RELEASE_STATUS', 'trusted private Release state is unsupported');
  if (typeof rawState.evidenceCurrent !== 'boolean') fail('INVALID_TARGET_STATE', 'trusted evidenceCurrent must be boolean');
  const stateBody = {
    privateReleaseId: record.privateReleaseId, privateProductId: record.privateProductId,
    organizationId: record.organizationId, releaseDigest: record.releaseDigest, status,
    target: clone(target), evidenceCurrent: rawState.evidenceCurrent,
  };
  if (rawState.stateDigest !== canonicalDigest(stateBody)) fail('PRIVATE_RELEASE_STATE_DIGEST_MISMATCH', 'trusted private Release state digest is invalid');
  const base = {
    privateReleaseId: record.privateReleaseId,
    privateProductId: record.privateProductId,
    organizationId: record.organizationId,
    status,
    packageDigest: record.packageDigest,
    manifestDigest: record.packageManifestDigest,
    releaseDigest: record.releaseDigest,
    sourceEvidenceDigest: record.sourceEvidenceDigest,
    predecessorPrivateReleaseId: record.previousPrivateReleaseId,
    target: clone(target),
  };
  const governance = resolveGovernance('private', base, options);
  if (governance.evidenceCurrent !== rawState.evidenceCurrent) {
    fail('PRIVATE_RELEASE_STATE_MISMATCH', 'trusted evidence state and governance snapshot disagree');
  }
  return freeze({ ...base, governance: { ...clone(governance), evidenceCurrent: rawState.evidenceCurrent } });
}

function licenseSnapshot(entitlement) {
  return {
    entitlementId: entitlement.entitlementId,
    entitlementDigest: entitlement.entitlementDigest,
    rights: [...entitlement.rights],
    constraints: clone(entitlement.constraints),
    validFrom: entitlement.validFrom,
    validUntil: entitlement.validUntil,
  };
}

function assertEntitlementScope(entitlement, { organizationId, releaseId, projectId, environment, at }) {
  if (entitlement.organizationId !== organizationId) fail('ORGANIZATION_NOT_GRANTED', 'Entitlement does not belong to the authorized organization');
  if (!entitlement.releaseScope.releaseIds.includes(releaseId)
    || (entitlement.constraints.releaseIds.length && !entitlement.constraints.releaseIds.includes(releaseId))) {
    fail('RELEASE_NOT_GRANTED', 'base Release is outside the Entitlement scope');
  }
  for (const right of ['derive', 'internal_distribute']) if (!entitlement.rights.includes(right)) fail('RIGHT_MISSING', `Entitlement is missing ${right}`);
  if (entitlement.constraints.organizationIds.length && !entitlement.constraints.organizationIds.includes(organizationId)) fail('ORGANIZATION_NOT_GRANTED', 'organization is outside Entitlement constraints');
  if (entitlement.constraints.projectIds.length && !entitlement.constraints.projectIds.includes(projectId)) fail('PROJECT_NOT_GRANTED', 'project is outside Entitlement constraints');
  if (entitlement.constraints.environments.length && !entitlement.constraints.environments.includes(environment)) fail('ENVIRONMENT_NOT_GRANTED', 'environment is outside Entitlement constraints');
  if (Date.parse(at) < Date.parse(entitlement.validFrom)) fail('ENTITLEMENT_NOT_YET_VALID', 'Entitlement is not yet valid');
  if (entitlement.validUntil && Date.parse(at) >= Date.parse(entitlement.validUntil)) fail('ENTITLEMENT_EXPIRED', 'Entitlement has expired');
}

export function createDerivativeForkLineage(input, options = {}) {
  exactKeys(input, FORK_KEYS, 'derivativeFork');
  schema(input, 'derivativeFork');
  const entitlementId = text(input.entitlementId, 'derivativeFork.entitlementId', ENTITLEMENT_ID, 69);
  const baseReleaseId = text(input.baseReleaseId, 'derivativeFork.baseReleaseId', RELEASE_ID, 72);
  const privateProductId = text(input.privateProductId, 'derivativeFork.privateProductId', PRIVATE_PRODUCT_ID, 73);
  const projectId = text(input.projectId, 'derivativeFork.projectId', PROJECT_ID, 99);
  const environment = text(input.environment, 'derivativeFork.environment', SAFE_ID, 128);
  const entitlement = resolveEntitlement(entitlementId, options);
  const base = resolveBaseRelease(baseReleaseId, options);
  if (base.productId !== entitlement.productId) fail('BASE_PRODUCT_MISMATCH', 'base Release does not belong to the Entitlement Product');
  if (base.status === 'recalled') fail('BASE_RELEASE_RECALLED', 'recalled base Release cannot start a Fork');
  if (base.status === 'revoked') fail('BASE_RELEASE_REVOKED', 'revoked base Release cannot start a Fork');
  const createdAt = trustedNow(options.now);
  assertEntitlementScope(entitlement, { organizationId: entitlement.organizationId, releaseId: baseReleaseId, projectId, environment, at: createdAt });
  authorizeOrganization(options, { organizationId: entitlement.organizationId, projectId, environment, purpose: 'private_derivative.fork' });
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    organizationId: entitlement.organizationId,
    privateProductId,
    baseProductId: base.productId,
    baseReleaseId,
    entitlementId,
    entitlementDigest: entitlement.entitlementDigest,
    licenseSnapshotDigest: canonicalDigest(licenseSnapshot(entitlement)),
    projectId,
    environment,
    createdAt,
  };
  return freeze({ ...body, lineageId: `lineage_${canonicalDigest(body).slice(7)}`, lineageDigest: canonicalDigest(body) });
}

function normalizeRootLineage(raw, options) {
  const value = object(raw, 'trustedLineage');
  exactKeys(value, new Set([
    'schemaVersion', 'organizationId', 'privateProductId', 'baseProductId', 'baseReleaseId',
    'entitlementId', 'entitlementDigest', 'licenseSnapshotDigest', 'projectId', 'environment',
    'createdAt', 'lineageId', 'lineageDigest',
  ]), 'trustedLineage');
  const expected = createDerivativeForkLineage({
    schemaVersion: value.schemaVersion,
    entitlementId: value.entitlementId,
    baseReleaseId: value.baseReleaseId,
    privateProductId: value.privateProductId,
    projectId: value.projectId,
    environment: value.environment,
  }, { ...options, now: () => value.createdAt });
  if (value.lineageId !== expected.lineageId || value.lineageDigest !== expected.lineageDigest) fail('LINEAGE_DIGEST_MISMATCH', 'trusted lineage does not match its root evidence');
  return expected;
}

function resolveLineage(id, options) {
  const raw = invoke(capability(options, 'lineageResolver'), id, 'LINEAGE_RESOLVER_FAILED', 'trusted lineage resolver');
  const lineage = normalizeRootLineage(raw, options);
  if (lineage.lineageId !== id && lineage.lineageDigest !== id) fail('LINEAGE_RESOLVER_MISMATCH', 'trusted lineage resolver returned the wrong identity');
  return lineage;
}

export function createDerivativeEvolutionLineage(input, options = {}) {
  exactKeys(input, EVOLUTION_KEYS, 'derivativeEvolutionLineage');
  schema(input, 'derivativeEvolutionLineage');
  const predecessor = resolvePrivateRelease(text(input.predecessorPrivateReleaseId, 'predecessorPrivateReleaseId', PRIVATE_RELEASE_ID, 77), options);
  const next = resolvePrivateRelease(text(input.newPrivateReleaseId, 'newPrivateReleaseId', PRIVATE_RELEASE_ID, 77), options);
  const product = resolvePrivateProduct(predecessor.privateProductId, options);
  if (product.sourceType !== 'authorized_derivative') fail('DERIVATIVE_PRODUCT_REQUIRED', 'private evolution requires an authorized derivative Product');
  if (next.privateProductId !== product.privateProductId || next.organizationId !== product.organizationId) fail('CROSS_ORGANIZATION_FORBIDDEN', 'private evolution cannot cross organization or Product boundaries');
  const root = resolveLineage(product.sourceEvidence.lineageDigest, options);
  if (next.predecessorPrivateReleaseId !== predecessor.privateReleaseId) fail('PREDECESSOR_MISMATCH', 'new private Release does not bind its exact predecessor');
  if (predecessor.organizationId !== root.organizationId || next.organizationId !== root.organizationId
    || predecessor.privateProductId !== root.privateProductId || next.privateProductId !== root.privateProductId) {
    fail('CROSS_ORGANIZATION_FORBIDDEN', 'private evolution cannot cross organization or Product boundaries');
  }
  if (product.sourceEvidence.baseProductId !== root.baseProductId || product.sourceEvidence.baseReleaseId !== root.baseReleaseId
    || product.sourceEvidence.entitlementId !== root.entitlementId || product.sourceEvidence.entitlementDigest !== root.entitlementDigest
    || product.sourceEvidence.licenseSnapshotDigest !== root.licenseSnapshotDigest
    || product.sourceEvidence.lineageDigest !== root.lineageDigest) {
    fail('ROOT_LINEAGE_MISMATCH', 'private Product source evidence does not bind the exact root lineage');
  }
  authorizeOrganization(options, { organizationId: root.organizationId, projectId: root.projectId, environment: root.environment, purpose: 'private_derivative.evolve' });
  const rootSummary = {
    organizationId: root.organizationId, privateProductId: root.privateProductId,
    baseProductId: root.baseProductId, baseReleaseId: root.baseReleaseId,
    entitlementId: root.entitlementId, entitlementDigest: root.entitlementDigest,
    licenseSnapshotDigest: root.licenseSnapshotDigest, createdAt: root.createdAt,
  };
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    lineageId: root.lineageId,
    root: rootSummary,
    predecessorPrivateReleaseId: predecessor.privateReleaseId,
    newPrivateReleaseId: next.privateReleaseId,
  };
  return freeze({ ...body, evolutionDigest: canonicalDigest(body) });
}

function manifestFor(releaseKind, release, options) {
  const releaseId = releaseKind === 'base' ? release.releaseId : release.privateReleaseId;
  const raw = invoke(capability(options, 'manifestResolver'), {
    releaseKind, releaseId, packageDigest: release.packageDigest, manifestDigest: release.manifestDigest,
  }, 'MANIFEST_RESOLVER_FAILED', 'trusted manifest resolver');
  if (!Array.isArray(raw)) fail('INVALID_MANIFEST', 'trusted manifest must be an array');
  raw.forEach((entry, index) => exactKeys(entry, new Set(['path', 'size', 'sha256', 'mediaType', 'executable']), `trustedManifest[${index}]`));
  let manifest;
  try { manifest = normalizePackageManifest(raw); } catch (cause) { fail(cause.code ?? 'INVALID_MANIFEST', cause.message, cause); }
  if (canonicalDigest(manifest) !== release.manifestDigest) fail('MANIFEST_DIGEST_MISMATCH', 'trusted manifest does not match Release manifestDigest');
  if (packageDigest(manifest) !== release.packageDigest) fail('PACKAGE_DIGEST_MISMATCH', 'trusted manifest does not match Release packageDigest');
  return manifest;
}

function diffManifests(from, to) {
  const left = new Map(from.map(row => [row.path, row]));
  const right = new Map(to.map(row => [row.path, row]));
  const added = [...right.keys()].filter(path => !left.has(path)).sort();
  const deleted = [...left.keys()].filter(path => !right.has(path)).sort();
  const modified = [...right.keys()].filter(path => left.has(path)
    && canonicalDigest(left.get(path)) !== canonicalDigest(right.get(path))).sort();
  return freeze({ added, modified, deleted });
}

function governanceChanges(currentBase, upstream) {
  const changes = [];
  if (currentBase.packageDigest !== upstream.packageDigest) changes.push({ kind: 'package', fromDigest: currentBase.packageDigest, toDigest: upstream.packageDigest });
  if (currentBase.manifestDigest !== upstream.manifestDigest) changes.push({ kind: 'manifest', fromDigest: currentBase.manifestDigest, toDigest: upstream.manifestDigest });
  for (const field of GOVERNANCE_DIGEST_FIELDS) {
    if (currentBase.governance[field] !== upstream.governance[field]) {
      changes.push({ kind: field.replace(/Digest$/, '').replace(/[A-Z]/g, value => `_${value.toLowerCase()}`), fromDigest: currentBase.governance[field], toDigest: upstream.governance[field] });
    }
  }
  return changes;
}

function comparisonContext(input, options) {
  exactKeys(input, COMPARE_KEYS, 'derivativeComparison');
  schema(input, 'derivativeComparison');
  const lineageId = text(input.lineageId, 'derivativeComparison.lineageId', /^lineage_[a-f0-9]{64}$/, 72);
  const currentPrivate = resolvePrivateRelease(text(input.currentPrivateReleaseId, 'currentPrivateReleaseId', PRIVATE_RELEASE_ID, 77), options);
  const currentBase = resolveBaseRelease(text(input.currentBaseReleaseId, 'currentBaseReleaseId', RELEASE_ID, 72), options);
  const upstream = resolveBaseRelease(text(input.proposedUpstreamReleaseId, 'proposedUpstreamReleaseId', RELEASE_ID, 72), options);
  const root = resolveLineage(lineageId, options);
  const product = resolvePrivateProduct(currentPrivate.privateProductId, options);
  const projectId = text(input.projectId, 'derivativeComparison.projectId', PROJECT_ID, 99);
  const environment = text(input.environment, 'derivativeComparison.environment', SAFE_ID, 128);
  if (currentPrivate.organizationId !== root.organizationId || currentPrivate.privateProductId !== root.privateProductId
    || product.organizationId !== root.organizationId || product.privateProductId !== root.privateProductId
    || product.sourceType !== 'authorized_derivative'
    || product.sourceEvidence.lineageDigest !== root.lineageDigest) fail('PRIVATE_RELEASE_LINEAGE_MISMATCH', 'current private Release is outside the root lineage');
  if (currentBase.productId !== root.baseProductId || upstream.productId !== root.baseProductId) fail('BASE_PRODUCT_MISMATCH', 'base Releases must belong to the root Product');
  authorizeOrganization(options, { organizationId: root.organizationId, projectId, environment, purpose: 'private_derivative.compare' });
  return { root, currentPrivate, currentBase, upstream, projectId, environment };
}

export function compareDerivativeUpstream(input, options = {}) {
  const context = comparisonContext(input, options);
  const currentPrivateManifest = manifestFor('private', context.currentPrivate, options);
  const currentBaseManifest = manifestFor('base', context.currentBase, options);
  const proposedManifest = manifestFor('base', context.upstream, options);
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    organizationId: context.root.organizationId,
    privateProductId: context.root.privateProductId,
    lineageId: context.root.lineageId,
    releases: {
      currentPrivate: { privateReleaseId: context.currentPrivate.privateReleaseId, packageDigest: context.currentPrivate.packageDigest, manifestDigest: context.currentPrivate.manifestDigest },
      currentBase: { releaseId: context.currentBase.releaseId, packageDigest: context.currentBase.packageDigest, manifestDigest: context.currentBase.manifestDigest },
      proposedUpstream: { releaseId: context.upstream.releaseId, packageDigest: context.upstream.packageDigest, manifestDigest: context.upstream.manifestDigest },
    },
    manifestChanges: diffManifests(currentBaseManifest, proposedManifest),
    privateOverlay: diffManifests(currentBaseManifest, currentPrivateManifest),
    governanceChanges: governanceChanges(context.currentBase, context.upstream),
    governanceSnapshot: {
      currentPrivate: clone(context.currentPrivate.governance), currentBase: clone(context.currentBase.governance), proposedUpstream: clone(context.upstream.governance),
    },
    releaseStatuses: {
      currentPrivate: context.currentPrivate.status, currentBase: context.currentBase.status, proposedUpstream: context.upstream.status,
    },
    projectId: context.projectId,
    environment: context.environment,
  };
  return freeze({ ...body, comparisonDigest: canonicalDigest(body) });
}

function reason(code, blocking, messageZh) {
  return { code, blocking, messageZh };
}

function requiredReassessments(comparison, options) {
  const resolver = capability(options, 'reassessmentResolver');
  const raw = invoke(resolver, {
    organizationId: comparison.organizationId,
    privateProductId: comparison.privateProductId,
    comparisonDigest: comparison.comparisonDigest,
    proposedUpstreamReleaseId: comparison.releases.proposedUpstream.releaseId,
  }, 'REASSESSMENT_RESOLVER_FAILED', 'trusted reassessment resolver');
  object(raw, 'trustedReassessment');
  if (raw.comparisonDigest !== null && raw.comparisonDigest !== comparison.comparisonDigest) fail('REASSESSMENT_BINDING_MISMATCH', 'reassessment evidence is not bound to this comparison');
  if (raw.comparisonDigest === null
    && (raw.packageAudit === 'passed' || raw.sms === 'passed' || raw.eval === 'passed' || raw.review === 'certified')) {
    fail('REASSESSMENT_BINDING_MISMATCH', 'successful reassessment evidence must bind the exact comparisonDigest');
  }
  const requirements = [
    ['package_audit', 'packageAudit', 'passed'], ['sms', 'sms', 'passed'], ['eval', 'eval', 'passed'], ['review', 'review', 'certified'],
  ];
  return requirements.filter(([, field, expected]) => raw[field] !== expected).map(([kind]) => ({
    kind, code: 'NEW_RELEASE_EVIDENCE_REQUIRED', messageZh: '新私有版本必须重新形成当前证据',
  }));
}

function migrationNotes(changes) {
  const notes = [];
  for (const [key, code] of [['added', 'FILES_ADDED'], ['modified', 'FILES_MODIFIED'], ['deleted', 'FILES_DELETED']]) {
    if (changes[key].length) notes.push({ code, fileCount: changes[key].length });
  }
  return notes;
}

function planWithDigest(body) {
  return freeze({ ...body, planDigest: canonicalDigest(body) });
}

function blockedUpgrade(input, code, messageZh) {
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    operationId: `upgrade:${canonicalDigest(input).slice(7, 31)}`,
    kind: 'upgrade', status: 'blocked', organizationId: null, privateProductId: null,
    currentPrivateReleaseId: input.currentPrivateReleaseId ?? null,
    projectId: input.projectId ?? null, environment: input.environment ?? null,
    target: { proposedUpstreamReleaseId: input.proposedUpstreamReleaseId ?? null },
    comparisonDigest: null, reasons: [reason(code, true, messageZh)], requiredReassessments: [], migrationNotes: [],
    requiredConfirmation: null, nonExecutable: true, automaticUpgrade: false,
  };
  return planWithDigest(body);
}

export function createDerivativeUpgradePlan(input, options = {}) {
  let comparison;
  let context;
  try {
    context = comparisonContext(input, options);
    comparison = compareDerivativeUpstream(input, options);
  } catch (cause) {
    if (cause instanceof DerivativeEvolutionError && ['PACKAGE_DIGEST_MISMATCH', 'MANIFEST_DIGEST_MISMATCH'].includes(cause.code)) {
      return blockedUpgrade(input, cause.code, 'Release 与受信 manifest 的摘要不一致');
    }
    throw cause;
  }
  const reasons = [];
  if (context.currentPrivate.status === 'recalled') reasons.push(reason('PRIVATE_RELEASE_RECALLED', true, '当前私有 Release 已召回'));
  if (context.currentPrivate.status === 'revoked') reasons.push(reason('PRIVATE_RELEASE_REVOKED', true, '当前私有 Release 已撤销'));
  if (context.currentBase.status === 'recalled') reasons.push(reason('BASE_RELEASE_RECALLED', true, '当前基础 Release 已召回'));
  if (context.currentBase.status === 'revoked') reasons.push(reason('BASE_RELEASE_REVOKED', true, '当前基础 Release 已撤销'));
  if (context.upstream.status === 'recalled') reasons.push(reason('UPSTREAM_RECALLED', true, '候选上游 Release 已召回'));
  if (context.upstream.status === 'revoked') reasons.push(reason('UPSTREAM_REVOKED', true, '候选上游 Release 已撤销'));
  if (context.upstream.status === 'withdrawn') reasons.push(reason('UPSTREAM_WITHDRAWN', true, '已下架上游不能形成新的私有升级'));
  if (!context.currentPrivate.target.exists) reasons.push(reason('TARGET_MISSING', true, '当前私有目标不存在'));
  if (!context.currentPrivate.target.managed) reasons.push(reason('TARGET_UNKNOWN', true, '当前私有目标不在受信管理范围'));
  if (context.currentPrivate.target.drift) reasons.push(reason('TARGET_DRIFT', true, '当前私有目标发生漂移'));
  if (!context.currentPrivate.governance.evidenceCurrent) reasons.push(reason('CURRENT_EVIDENCE_STALE', true, '当前私有 Release 证据已失效'));
  if (!context.currentPrivate.governance.dependenciesKnown) reasons.push(reason('CURRENT_DEPENDENCIES_UNKNOWN', true, '当前私有 Release 依赖状态未知'));
  if (!context.currentBase.governance.dependenciesKnown) reasons.push(reason('BASE_DEPENDENCIES_UNKNOWN', true, '当前基础 Release 依赖状态未知'));
  if (!context.upstream.governance.dependenciesKnown) reasons.push(reason('UPSTREAM_DEPENDENCIES_UNKNOWN', true, '候选上游依赖状态未知'));
  if (!context.upstream.governance.licenseAllowsUpgrade) reasons.push(reason('LICENSE_BLOCKS_UPGRADE', true, '当前许可证禁止升级'));
  try {
    const entitlement = resolveEntitlement(context.root.entitlementId, options);
    assertEntitlementScope(entitlement, {
      organizationId: context.root.organizationId, releaseId: context.root.baseReleaseId,
      projectId: context.projectId, environment: context.environment, at: trustedNow(options.now),
    });
    if (entitlement.entitlementDigest !== context.root.entitlementDigest
      || canonicalDigest(licenseSnapshot(entitlement)) !== context.root.licenseSnapshotDigest) {
      reasons.push(reason('LICENSE_SNAPSHOT_CHANGED', true, '二创授权快照已变化'));
    }
  } catch (cause) {
    reasons.push(reason(cause.code ?? 'ENTITLEMENT_INVALID', true, '二创授权已失效'));
  }
  const noChange = comparison.manifestChanges.added.length === 0
    && comparison.manifestChanges.modified.length === 0
    && comparison.manifestChanges.deleted.length === 0
    && comparison.governanceChanges.length === 0;
  let reassessments = [];
  if (!reasons.some(row => row.blocking) && !noChange) reassessments = requiredReassessments(comparison, options);
  const status = reasons.some(row => row.blocking) ? 'blocked' : noChange ? 'no_change' : reassessments.length ? 'reassessment_required' : 'ready';
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    operationId: `upgrade:${comparison.comparisonDigest.slice(7, 31)}`,
    kind: 'upgrade', status,
    organizationId: comparison.organizationId,
    privateProductId: comparison.privateProductId,
    currentPrivateReleaseId: comparison.releases.currentPrivate.privateReleaseId,
    projectId: context.projectId,
    environment: context.environment,
    target: { proposedUpstreamReleaseId: comparison.releases.proposedUpstream.releaseId },
    comparisonDigest: comparison.comparisonDigest,
    reasons,
    requiredReassessments: reassessments,
    migrationNotes: migrationNotes(comparison.manifestChanges),
    requiredConfirmation: status === 'ready' ? { kind: 'plan_digest' } : null,
    nonExecutable: true,
    automaticUpgrade: false,
  };
  return planWithDigest(body);
}

function rollbackBlockedBody(operationId, currentId, targetId, organizationId, productId, projectId, environment, reasons) {
  return {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, operationId, kind: 'rollback', status: 'blocked',
    organizationId, privateProductId: productId, currentPrivateReleaseId: currentId,
    projectId, environment,
    target: { privateReleaseId: targetId, packageDigest: null, manifestDigest: null },
    reasons, requiredConfirmation: null, nonExecutable: true, automaticUpgrade: false,
  };
}

export function createDerivativeRollbackPlan(input, options = {}) {
  exactKeys(input, ROLLBACK_KEYS, 'derivativeRollback');
  schema(input, 'derivativeRollback');
  const operationId = text(input.operationId, 'derivativeRollback.operationId', /^[a-z][a-z0-9._:-]{2,127}$/);
  const currentId = text(input.currentPrivateReleaseId, 'currentPrivateReleaseId', PRIVATE_RELEASE_ID, 77);
  const targetId = text(input.targetPrivateReleaseId, 'targetPrivateReleaseId', PRIVATE_RELEASE_ID, 77);
  const projectId = text(input.projectId, 'derivativeRollback.projectId', PROJECT_ID, 99);
  const environment = text(input.environment, 'derivativeRollback.environment', SAFE_ID, 128);
  const current = resolvePrivateRelease(currentId, options);
  const target = resolvePrivateRelease(targetId, options);
  const currentProduct = resolvePrivateProduct(current.privateProductId, options);
  const targetProduct = resolvePrivateProduct(target.privateProductId, options);
  const reasons = [];
  if (current.organizationId !== target.organizationId) reasons.push(reason('CROSS_ORGANIZATION_FORBIDDEN', true, '回滚不得跨组织'));
  if (current.privateProductId !== target.privateProductId) reasons.push(reason('PRIVATE_PRODUCT_MISMATCH', true, '回滚目标必须属于同一私有 Product'));
  if (currentProduct.sourceType !== 'authorized_derivative' || targetProduct.sourceType !== 'authorized_derivative'
    || currentProduct.sourceEvidence.lineageDigest !== targetProduct.sourceEvidence.lineageDigest) reasons.push(reason('ROOT_LINEAGE_MISMATCH', true, '回滚目标必须保留同一根血缘'));
  authorizeOrganization(options, { organizationId: current.organizationId, projectId, environment, purpose: 'private_derivative.rollback' });
  if (target.status === 'recalled') reasons.push(reason('TARGET_RELEASE_RECALLED', true, '回滚目标已召回'));
  if (target.status === 'revoked') reasons.push(reason('TARGET_RELEASE_REVOKED', true, '回滚目标已撤销'));
  if (!target.target.exists) reasons.push(reason('TARGET_MISSING', true, '回滚目标不存在'));
  if (!target.target.managed) reasons.push(reason('TARGET_UNKNOWN', true, '回滚目标不在受信管理范围'));
  if (target.target.drift) reasons.push(reason('TARGET_DRIFT', true, '回滚目标发生漂移'));
  if (!target.governance.evidenceCurrent) reasons.push(reason('TARGET_EVIDENCE_STALE', true, '回滚目标证据已失效'));
  if (!target.governance.dependenciesKnown) reasons.push(reason('TARGET_DEPENDENCIES_UNKNOWN', true, '回滚目标依赖状态未知'));
  try { manifestFor('private', target, options); } catch (cause) { reasons.push(reason(cause.code ?? 'PACKAGE_DIGEST_MISMATCH', true, '回滚目标包摘要不一致')); }
  if (currentProduct.sourceType === 'authorized_derivative' && targetProduct.sourceType === 'authorized_derivative'
    && currentProduct.sourceEvidence.lineageDigest === targetProduct.sourceEvidence.lineageDigest) {
    try {
      const root = resolveLineage(currentProduct.sourceEvidence.lineageDigest, options);
      const base = resolveBaseRelease(root.baseReleaseId, options);
      if (base.status === 'recalled') reasons.push(reason('BASE_RELEASE_RECALLED', true, '根基础 Release 已召回'));
      if (base.status === 'revoked') reasons.push(reason('BASE_RELEASE_REVOKED', true, '根基础 Release 已撤销'));
      const entitlement = resolveEntitlement(root.entitlementId, options);
      assertEntitlementScope(entitlement, { organizationId: root.organizationId, releaseId: root.baseReleaseId, projectId, environment, at: trustedNow(options.now) });
      if (entitlement.entitlementDigest !== root.entitlementDigest || canonicalDigest(licenseSnapshot(entitlement)) !== root.licenseSnapshotDigest) {
        reasons.push(reason('LICENSE_SNAPSHOT_CHANGED', true, '二创授权快照已变化'));
      }
    } catch (cause) { reasons.push(reason(cause.code ?? 'ENTITLEMENT_INVALID', true, '二创授权或根血缘已失效')); }
  }
  const status = reasons.some(row => row.blocking) ? 'blocked' : currentId === targetId ? 'no_change' : 'ready';
  const body = status === 'blocked'
    ? rollbackBlockedBody(operationId, currentId, targetId, current.organizationId, current.privateProductId, projectId, environment, reasons)
    : {
      schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, operationId, kind: 'rollback', status,
      organizationId: current.organizationId, privateProductId: current.privateProductId,
      currentPrivateReleaseId: currentId,
      projectId, environment,
      target: { privateReleaseId: targetId, packageDigest: target.packageDigest, manifestDigest: target.manifestDigest },
      reasons, requiredConfirmation: status === 'ready' ? { kind: 'plan_digest' } : null,
      nonExecutable: true, automaticUpgrade: false,
    };
  return planWithDigest(body);
}

export function normalizeDerivativeEvolutionPlan(input) {
  const value = object(input, 'derivativeEvolutionPlan');
  exactKeys(value, new Set([
    'schemaVersion', 'operationId', 'kind', 'status', 'organizationId', 'privateProductId',
    'currentPrivateReleaseId', 'projectId', 'environment', 'target', 'comparisonDigest',
    'reasons', 'requiredReassessments', 'migrationNotes', 'requiredConfirmation',
    'nonExecutable', 'automaticUpgrade', 'planDigest',
  ]), 'derivativeEvolutionPlan');
  if (value.schemaVersion !== DERIVATIVE_EVOLUTION_SCHEMA_VERSION
    || !['upgrade', 'rollback'].includes(value.kind)
    || !['ready', 'reassessment_required', 'blocked', 'no_change'].includes(value.status)
    || value.nonExecutable !== true || value.automaticUpgrade !== false) {
    fail('INVALID_PLAN', 'derivative evolution plan is invalid or executable');
  }
  const planDigest = digest(value.planDigest, 'derivativeEvolutionPlan.planDigest');
  const body = clone(value);
  delete body.planDigest;
  if (canonicalDigest(body) !== planDigest) fail('PLAN_DIGEST_MISMATCH', 'planDigest does not match the complete plan');
  text(value.operationId, 'derivativeEvolutionPlan.operationId', /^[a-z][a-z0-9._:-]{2,127}$/);
  text(value.organizationId, 'derivativeEvolutionPlan.organizationId', /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/, 99);
  text(value.privateProductId, 'derivativeEvolutionPlan.privateProductId', PRIVATE_PRODUCT_ID, 73);
  text(value.currentPrivateReleaseId, 'derivativeEvolutionPlan.currentPrivateReleaseId', PRIVATE_RELEASE_ID, 77);
  text(value.projectId, 'derivativeEvolutionPlan.projectId', PROJECT_ID, 99);
  text(value.environment, 'derivativeEvolutionPlan.environment', SAFE_ID, 128);
  if (value.kind === 'upgrade') {
    exactKeys(value.target, new Set(['proposedUpstreamReleaseId']), 'derivativeEvolutionPlan.target');
    text(value.target.proposedUpstreamReleaseId, 'derivativeEvolutionPlan.target.proposedUpstreamReleaseId', RELEASE_ID, 72);
  } else {
    exactKeys(value.target, new Set(['privateReleaseId', 'packageDigest', 'manifestDigest']), 'derivativeEvolutionPlan.target');
    text(value.target.privateReleaseId, 'derivativeEvolutionPlan.target.privateReleaseId', PRIVATE_RELEASE_ID, 77);
    digest(value.target.packageDigest, 'derivativeEvolutionPlan.target.packageDigest');
    digest(value.target.manifestDigest, 'derivativeEvolutionPlan.target.manifestDigest');
  }
  return freeze(clone(value));
}

function planFromResolver(planDigest, options) {
  const raw = invoke(capability(options, 'planResolver'), planDigest, 'PLAN_RESOLVER_FAILED', 'trusted plan resolver');
  const plan = normalizeDerivativeEvolutionPlan(raw);
  if (plan.planDigest !== planDigest) fail('PLAN_RESOLVER_MISMATCH', 'trusted plan resolver returned the wrong identity');
  return plan;
}

function confirmationFor(plan, resolver) {
  const targetDigest = canonicalDigest(plan.target);
  const raw = invoke(resolver, {
    purpose: 'enterprise.derivative_evolution.confirm',
    planDigest: plan.planDigest,
    kind: plan.kind,
    organizationId: plan.organizationId,
    privateProductId: plan.privateProductId,
    currentPrivateReleaseId: plan.currentPrivateReleaseId,
    target: clone(plan.target),
    projectId: plan.projectId,
    environment: plan.environment,
  }, 'CONFIRMATION_STATUS_RESOLVER_FAILED', 'trusted confirmation status resolver');
  exactKeys(raw, new Set([
    'decision', 'planDigest', 'organizationId', 'privateProductId', 'currentPrivateReleaseId',
    'targetDigest', 'checkedAt', 'confirmationDigest',
  ]), 'trustedConfirmationStatus');
  const body = {
    decision: raw.decision,
    planDigest: digest(raw.planDigest, 'trustedConfirmationStatus.planDigest'),
    organizationId: text(raw.organizationId, 'trustedConfirmationStatus.organizationId', /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/, 99),
    privateProductId: text(raw.privateProductId, 'trustedConfirmationStatus.privateProductId', PRIVATE_PRODUCT_ID, 73),
    currentPrivateReleaseId: text(raw.currentPrivateReleaseId, 'trustedConfirmationStatus.currentPrivateReleaseId', PRIVATE_RELEASE_ID, 77),
    targetDigest: digest(raw.targetDigest, 'trustedConfirmationStatus.targetDigest'),
    checkedAt: timestamp(raw.checkedAt, 'trustedConfirmationStatus.checkedAt'),
  };
  if (body.decision !== 'allow' || body.planDigest !== plan.planDigest
    || body.organizationId !== plan.organizationId || body.privateProductId !== plan.privateProductId
    || body.currentPrivateReleaseId !== plan.currentPrivateReleaseId || body.targetDigest !== targetDigest) {
    fail('CONFIRMATION_STATUS_BLOCKED', 'current trusted state no longer allows this plan selection');
  }
  if (raw.confirmationDigest !== canonicalDigest(body)) fail('CONFIRMATION_STATUS_DIGEST_MISMATCH', 'trusted confirmation status digest is invalid');
  return freeze({ ...body, confirmationDigest: raw.confirmationDigest });
}

function validateStoredConfirmation(plan, confirmedAt, confirmationDigest) {
  const body = {
    decision: 'allow', planDigest: plan.planDigest, organizationId: plan.organizationId,
    privateProductId: plan.privateProductId, currentPrivateReleaseId: plan.currentPrivateReleaseId,
    targetDigest: canonicalDigest(plan.target), checkedAt: timestamp(confirmedAt, 'event.confirmedAt'),
  };
  if (digest(confirmationDigest, 'event.confirmationDigest') !== canonicalDigest(body)) {
    fail('CONFIRMATION_STATUS_DIGEST_MISMATCH', 'stored confirmation status digest is invalid');
  }
  return body;
}

export function createDerivativeEvolutionEvent(input, options = {}) {
  exactKeys(input, new Set(['type', 'operationId', 'planDigest', 'confirmPlanDigest', 'occurredAt']), 'derivativeEvolutionEventInput');
  const type = text(input.type, 'event.type', null, 32);
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', 'unsupported derivative evolution event type');
  const operationId = text(input.operationId, 'event.operationId', /^[a-z][a-z0-9._:-]{2,127}$/);
  const planDigest = digest(input.planDigest, 'event.planDigest');
  if (digest(input.confirmPlanDigest, 'event.confirmPlanDigest') !== planDigest) fail('CONFIRMATION_MISMATCH', 'confirmation must exactly match planDigest');
  const plan = planFromResolver(planDigest, options);
  if (plan.operationId !== operationId) fail('OPERATION_PLAN_MISMATCH', 'operationId does not match the trusted plan');
  if (plan.status !== 'ready') fail('PLAN_NOT_READY', 'only a ready plan can be selected');
  if ((type === 'rollback.selected') !== (plan.kind === 'rollback')) fail('EVENT_PLAN_KIND_MISMATCH', 'event type does not match plan kind');
  authorizeOrganization(options, {
    organizationId: plan.organizationId,
    projectId: plan.projectId ?? null,
    environment: plan.environment ?? null,
    purpose: type,
  });
  const confirmation = confirmationFor(plan, capability(options, 'confirmationStatusResolver'));
  const occurredAt = timestamp(input.occurredAt, 'event.occurredAt');
  if (Date.parse(confirmation.checkedAt) > Date.parse(occurredAt)) fail('CONFIRMATION_TIME_INVALID', 'confirmation cannot occur after the selection event');
  const body = {
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    type, operationId, planDigest,
    organizationId: plan.organizationId,
    privateProductId: plan.privateProductId,
    currentPrivateReleaseId: plan.currentPrivateReleaseId,
    selectedTarget: clone(plan.target),
    confirmedAt: confirmation.checkedAt,
    confirmationDigest: confirmation.confirmationDigest,
    occurredAt,
    outcome: 'selection_recorded',
  };
  return freeze({ ...body, eventId: `devevt_${canonicalDigest(body).slice(7)}` });
}

export function replayDerivativeEvolutionEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length > 100_000) fail('EVENT_LIMIT_EXCEEDED', 'derivative evolution event log is invalid or too large');
  const privateProducts = {};
  const operations = new Map();
  const normalizedEvents = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const raw of events) {
    exactKeys(raw, new Set([
      'schemaVersion', 'type', 'operationId', 'planDigest', 'organizationId', 'privateProductId',
      'currentPrivateReleaseId', 'selectedTarget', 'confirmedAt', 'confirmationDigest', 'occurredAt', 'outcome', 'eventId',
    ]), 'derivativeEvolutionEvent');
    const plan = planFromResolver(raw.planDigest, options);
    if (!EVENT_TYPES.has(raw.type) || raw.operationId !== plan.operationId || plan.status !== 'ready'
      || ((raw.type === 'rollback.selected') !== (plan.kind === 'rollback'))) {
      fail('INVALID_EVENT', 'stored event does not match its trusted ready plan');
    }
    validateStoredConfirmation(plan, raw.confirmedAt, raw.confirmationDigest);
    const body = {
      schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
      type: raw.type, operationId: raw.operationId, planDigest: raw.planDigest,
      organizationId: plan.organizationId, privateProductId: plan.privateProductId,
      currentPrivateReleaseId: plan.currentPrivateReleaseId, selectedTarget: clone(plan.target),
      confirmedAt: timestamp(raw.confirmedAt, 'event.confirmedAt'), confirmationDigest: raw.confirmationDigest,
      occurredAt: timestamp(raw.occurredAt, 'event.occurredAt'), outcome: 'selection_recorded',
    };
    const rebuilt = freeze({ ...body, eventId: `devevt_${canonicalDigest(body).slice(7)}` });
    if (canonicalDigest(raw) !== canonicalDigest(rebuilt)) fail('EVENT_DIGEST_MISMATCH', 'event content does not match trusted plan evidence');
    const time = Date.parse(rebuilt.occurredAt);
    if (time < previousTime) fail('EVENT_TIME_REGRESSION', 'event time must be monotonic');
    previousTime = time;
    const existing = operations.get(rebuilt.operationId);
    if (existing && existing !== rebuilt.planDigest) fail('OPERATION_CONFLICT', 'operationId cannot bind another planDigest');
    if (existing) fail('DUPLICATE_EVENT', 'event log contains a duplicate operation');
    operations.set(rebuilt.operationId, rebuilt.planDigest);
    normalizedEvents.push(rebuilt);
    const current = privateProducts[rebuilt.privateProductId] ?? {
      organizationId: rebuilt.organizationId, privateProductId: rebuilt.privateProductId,
      selectedPlanDigest: null, selectedTarget: null, currentReleaseChanged: false, history: [],
    };
    if (current.organizationId !== rebuilt.organizationId) fail('CROSS_ORGANIZATION_FORBIDDEN', 'event history crosses organization boundaries');
    current.selectedPlanDigest = rebuilt.planDigest;
    current.selectedTarget = clone(rebuilt.selectedTarget);
    current.history.push({ eventId: rebuilt.eventId, type: rebuilt.type, operationId: rebuilt.operationId, planDigest: rebuilt.planDigest, occurredAt: rebuilt.occurredAt });
    privateProducts[rebuilt.privateProductId] = current;
  }
  return freeze({
    schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
    eventCount: normalizedEvents.length,
    privateProducts,
    events: normalizedEvents,
  });
}
