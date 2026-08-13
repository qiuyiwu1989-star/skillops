import {
  COMMERCE_SCHEMA_VERSION,
  ORGANIZATION_ID,
  PRODUCT_ID,
  PROJECT_ID,
  RELEASE_ID,
  SAFE_IDENTIFIER,
  deepFreeze,
  exactKeys,
  fail,
  integer,
  text,
  timestamp,
  uniqueStrings,
} from './common.mjs';
import { LICENSE_RIGHTS } from './license-policy.mjs';
import { normalizeEntitlement } from './entitlement.mjs';

export { CommerceDomainError } from './common.mjs';

const RIGHT = new Set(LICENSE_RIGHTS);
const ACCESS_KEYS = new Set([
  'schemaVersion', 'entitlementIds', 'organizationId', 'productId', 'releaseId',
  'requiredRights', 'projectId', 'environment',
]);
const RELEASE_STATUSES = new Set(['published', 'superseded', 'withdrawn', 'recalled', 'revoked']);
const DENY_PRIORITY = Object.freeze([
  'RELEASE_RECALLED', 'RELEASE_REVOKED', 'ENTITLEMENT_INACTIVE', 'NOT_YET_VALID', 'EXPIRED',
  'ORGANIZATION_NOT_GRANTED', 'RELEASE_NOT_GRANTED', 'RIGHT_MISSING', 'PROJECT_NOT_GRANTED',
  'ENVIRONMENT_NOT_GRANTED', 'SEAT_LIMIT_EXCEEDED', 'INVOCATION_LIMIT_EXCEEDED',
]);

function result(input, decision, code, entitlement = null) {
  return deepFreeze({
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    decision,
    code,
    entitlementId: decision === 'allow' ? entitlement?.entitlementId ?? null : null,
    organizationId: input.organizationId,
    productId: input.productId,
    releaseId: input.releaseId,
    grantedRights: decision === 'allow' ? [...input.requiredRights] : [],
    checkedAt: input.at,
  });
}

function denialCode(entitlement, input, trusted) {
  if (input.releaseStatus === 'recalled') return 'RELEASE_RECALLED';
  if (input.releaseStatus === 'revoked') return 'RELEASE_REVOKED';
  if (Date.parse(input.at) < Date.parse(entitlement.validFrom)) return 'NOT_YET_VALID';
  if (entitlement.validUntil && Date.parse(input.at) >= Date.parse(entitlement.validUntil)) return 'EXPIRED';
  if (entitlement.constraints.organizationIds.length && !entitlement.constraints.organizationIds.includes(input.organizationId)) return 'ORGANIZATION_NOT_GRANTED';
  if (!entitlement.releaseScope.releaseIds.includes(input.releaseId)) return 'RELEASE_NOT_GRANTED';
  if (entitlement.constraints.releaseIds.length && !entitlement.constraints.releaseIds.includes(input.releaseId)) return 'RELEASE_NOT_GRANTED';
  if (input.requiredRights.some(right => !entitlement.rights.includes(right))) return 'RIGHT_MISSING';
  if (entitlement.constraints.projectIds.length && (!input.projectId || !entitlement.constraints.projectIds.includes(input.projectId))) return 'PROJECT_NOT_GRANTED';
  if (entitlement.constraints.environments.length && (!input.environment || !entitlement.constraints.environments.includes(input.environment))) return 'ENVIRONMENT_NOT_GRANTED';
  if (entitlement.constraints.seatLimit !== null && trusted.seatCount > entitlement.constraints.seatLimit) return 'SEAT_LIMIT_EXCEEDED';
  if (entitlement.constraints.invocationLimit !== null && trusted.invocations >= entitlement.constraints.invocationLimit) return 'INVOCATION_LIMIT_EXCEEDED';
  return null;
}

function normalizeAccessInput(input) {
  exactKeys(input, ACCESS_KEYS, 'accessRequest');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `accessRequest schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  const entitlementIds = uniqueStrings(input.entitlementIds, 'accessRequest.entitlementIds', { pattern: /^ent_[a-f0-9]{64}$/, maximum: 1_000 });
  const requiredRights = uniqueStrings(input.requiredRights, 'accessRequest.requiredRights', { pattern: SAFE_IDENTIFIER, maximum: LICENSE_RIGHTS.length, nonEmpty: true });
  for (const right of requiredRights) if (!RIGHT.has(right)) fail('INVALID_RIGHT', `unsupported required right: ${right}`);
  return {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    entitlementIds,
    organizationId: text(input.organizationId, 'accessRequest.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
    productId: text(input.productId, 'accessRequest.productId', { maximum: 69, pattern: PRODUCT_ID }),
    releaseId: text(input.releaseId, 'accessRequest.releaseId', { maximum: 72, pattern: RELEASE_ID }),
    requiredRights,
    projectId: input.projectId == null ? null : text(input.projectId, 'accessRequest.projectId', { maximum: 99, pattern: PROJECT_ID }),
    environment: input.environment == null ? null : text(input.environment, 'accessRequest.environment', { maximum: 128, pattern: SAFE_IDENTIFIER }),
  };
}

function trustedNow(now) {
  if (now === undefined) fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed'); }
  if (value instanceof Date) value = value.toISOString();
  return timestamp(value, 'trusted.now');
}

function capability(options, name) {
  if (typeof options?.[name] !== 'function') fail('TRUSTED_CAPABILITY_REQUIRED', `${name} capability is required`);
  return options[name];
}

function resolveRelease(input, resolver) {
  let release;
  try { release = resolver(input.releaseId); } catch { fail('RELEASE_RESOLVER_FAILED', 'trusted Release resolver failed'); }
  if (!release || typeof release !== 'object' || release.releaseId !== input.releaseId) fail('RELEASE_RESOLVER_MISMATCH', 'trusted Release resolver returned the wrong identity');
  const status = text(release.status, 'trustedRelease.status', { maximum: 32 });
  if (!RELEASE_STATUSES.has(status)) fail('INVALID_RELEASE_STATUS', `unsupported Release status: ${status}`);
  return status;
}

function resolveEntitlement(entitlementId, resolver) {
  let raw;
  try { raw = resolver(entitlementId); } catch { fail('ENTITLEMENT_RESOLVER_FAILED', 'trusted Entitlement resolver failed'); }
  if (raw == null) return null;
  const entitlement = normalizeEntitlement(raw);
  if (entitlement.entitlementId !== entitlementId) fail('ENTITLEMENT_RESOLVER_MISMATCH', 'trusted Entitlement resolver returned the wrong identity');
  return entitlement;
}

function trustedCounter(resolver, name, context, field) {
  let resolved;
  try { resolved = resolver(context); } catch { fail(`${name.toUpperCase()}_RESOLVER_FAILED`, `trusted ${name} resolver failed`); }
  const value = resolved && typeof resolved === 'object' ? resolved[field] : resolved;
  return integer(value, `trusted.${field}`);
}

export function normalizeAccessDecision(input, expected = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'decision', 'code', 'entitlementId', 'organizationId', 'productId',
    'releaseId', 'grantedRights', 'checkedAt',
  ]), 'accessDecision');
  exactKeys(expected, new Set(['organizationId', 'productId', 'releaseId', 'requiredRights', 'checkedAt']), 'accessDecisionExpected');
  if (input.schemaVersion !== COMMERCE_SCHEMA_VERSION || !['allow', 'deny'].includes(input.decision)) fail('INVALID_ACCESS_DECISION', 'accessDecision is invalid');
  const normalized = {
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    decision: input.decision,
    code: text(input.code, 'accessDecision.code', { maximum: 64, pattern: /^[A-Z][A-Z0-9_]{1,63}$/ }),
    entitlementId: input.entitlementId === null ? null : text(input.entitlementId, 'accessDecision.entitlementId', { maximum: 69, pattern: /^ent_[a-f0-9]{64}$/ }),
    organizationId: text(input.organizationId, 'accessDecision.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
    productId: text(input.productId, 'accessDecision.productId', { maximum: 69, pattern: PRODUCT_ID }),
    releaseId: text(input.releaseId, 'accessDecision.releaseId', { maximum: 72, pattern: RELEASE_ID }),
    grantedRights: uniqueStrings(input.grantedRights, 'accessDecision.grantedRights', { pattern: SAFE_IDENTIFIER, maximum: LICENSE_RIGHTS.length }),
    checkedAt: timestamp(input.checkedAt, 'accessDecision.checkedAt'),
  };
  if (normalized.decision === 'allow' && (normalized.code !== 'ACCESS_ALLOWED' || !normalized.entitlementId)) fail('INVALID_ACCESS_DECISION', 'allow decision requires ACCESS_ALLOWED and a canonical Entitlement');
  if (normalized.decision === 'deny' && (normalized.code === 'ACCESS_ALLOWED' || normalized.entitlementId !== null || normalized.grantedRights.length)) fail('INVALID_ACCESS_DECISION', 'deny decision cannot carry an Entitlement or granted rights');
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'requiredRights') {
      const rights = uniqueStrings(value, 'accessDecisionExpected.requiredRights', { pattern: SAFE_IDENTIFIER, maximum: LICENSE_RIGHTS.length });
      if (normalized.decision === 'allow' && rights.some(right => !normalized.grantedRights.includes(right))) fail('ACCESS_DECISION_RIGHTS_MISMATCH', 'accessDecision does not grant every required right');
    } else if (value !== undefined && normalized[key] !== value) {
      fail('ACCESS_DECISION_BINDING_MISMATCH', `accessDecision ${key} does not match its trusted context`);
    }
  }
  return deepFreeze(normalized);
}

export function decideAccess(rawInput, options = {}) {
  const input = normalizeAccessInput(rawInput);
  input.at = trustedNow(options.now);
  const entitlementResolver = capability(options, 'entitlementResolver');
  const releaseResolver = capability(options, 'releaseResolver');
  const usageResolver = capability(options, 'usageResolver');
  const seatResolver = capability(options, 'seatResolver');
  input.releaseStatus = resolveRelease(input, releaseResolver);
  if (input.releaseStatus === 'recalled') return result(input, 'deny', 'RELEASE_RECALLED');
  if (input.releaseStatus === 'revoked') return result(input, 'deny', 'RELEASE_REVOKED');
  const valid = [];
  for (const entitlementId of input.entitlementIds) {
    const entitlement = resolveEntitlement(entitlementId, entitlementResolver);
    if (!entitlement) continue;
    if (entitlement.organizationId !== input.organizationId || entitlement.productId !== input.productId) continue;
    const context = {
      entitlementId, organizationId: input.organizationId, productId: input.productId,
      releaseId: input.releaseId, projectId: input.projectId, environment: input.environment,
    };
    const trusted = {
      invocations: trustedCounter(usageResolver, 'usage', context, 'invocations'),
      seatCount: trustedCounter(seatResolver, 'seat', context, 'seatCount'),
    };
    const code = denialCode(entitlement, input, trusted);
    if (!code) return result(input, 'allow', 'ACCESS_ALLOWED', entitlement);
    valid.push({ entitlement, code });
  }
  if (!valid.length) return result(input, 'deny', 'NO_ENTITLEMENT');
  valid.sort((left, right) => DENY_PRIORITY.indexOf(left.code) - DENY_PRIORITY.indexOf(right.code));
  return result(input, 'deny', valid[0].code, valid[0].entitlement);
}

export function requireAccess(input, options) {
  const decision = decideAccess(input, options);
  if (decision.decision !== 'allow') fail(decision.code, `access denied: ${decision.code}`);
  return decision;
}
