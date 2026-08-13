import {
  COMMERCE_SCHEMA_VERSION,
  ORGANIZATION_ID,
  PROJECT_ID,
  RELEASE_ID,
  SAFE_IDENTIFIER,
  compareTime,
  deepFreeze,
  exactKeys,
  fail,
  integer,
  optionalTimestamp,
  text,
  uniqueStrings,
} from './common.mjs';

export { CommerceDomainError } from './common.mjs';

export const LICENSE_RIGHTS = Object.freeze([
  'invoke',
  'organization_use',
  'install',
  'view_source',
  'modify',
  'derive',
  'internal_distribute',
  'commercial_output',
  'redistribute_derivative',
  'updates',
  'support',
]);

const RIGHT = new Set(LICENSE_RIGHTS);
const POLICY_KEYS = new Set(['schemaVersion', 'rights', 'constraints']);
const CONSTRAINT_KEYS = new Set([
  'organizationIds', 'projectIds', 'environments', 'releaseIds',
  'seatLimit', 'invocationLimit', 'validFrom', 'validUntil',
]);

function rights(value) {
  const normalized = uniqueStrings(value, 'licensePolicy.rights', { pattern: SAFE_IDENTIFIER, maximum: LICENSE_RIGHTS.length, nonEmpty: true });
  for (const right of normalized) {
    if (!RIGHT.has(right)) fail('INVALID_RIGHT', `unsupported license right: ${right}`);
  }
  return normalized;
}

function constraints(input = {}) {
  exactKeys(input, CONSTRAINT_KEYS, 'licensePolicy.constraints');
  const result = {
    organizationIds: uniqueStrings(input.organizationIds ?? [], 'licensePolicy.constraints.organizationIds', { pattern: ORGANIZATION_ID }),
    projectIds: uniqueStrings(input.projectIds ?? [], 'licensePolicy.constraints.projectIds', { pattern: PROJECT_ID }),
    environments: uniqueStrings(input.environments ?? [], 'licensePolicy.constraints.environments', { pattern: SAFE_IDENTIFIER }),
    releaseIds: uniqueStrings(input.releaseIds ?? [], 'licensePolicy.constraints.releaseIds', { pattern: RELEASE_ID }),
    seatLimit: input.seatLimit == null ? null : integer(input.seatLimit, 'licensePolicy.constraints.seatLimit', { minimum: 1 }),
    invocationLimit: input.invocationLimit == null ? null : integer(input.invocationLimit, 'licensePolicy.constraints.invocationLimit', { minimum: 1 }),
    validFrom: optionalTimestamp(input.validFrom, 'licensePolicy.constraints.validFrom'),
    validUntil: optionalTimestamp(input.validUntil, 'licensePolicy.constraints.validUntil'),
  };
  if (result.validFrom && result.validUntil && compareTime(result.validUntil, result.validFrom) <= 0) {
    fail('INVALID_VALIDITY_WINDOW', 'licensePolicy validUntil must be later than validFrom');
  }
  return result;
}

export function normalizeLicensePolicy(input) {
  exactKeys(input, POLICY_KEYS, 'licensePolicy');
  if ((input.schemaVersion ?? COMMERCE_SCHEMA_VERSION) !== COMMERCE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `licensePolicy schemaVersion must be ${COMMERCE_SCHEMA_VERSION}`);
  }
  return deepFreeze({
    schemaVersion: COMMERCE_SCHEMA_VERSION,
    rights: rights(input.rights),
    constraints: constraints(input.constraints),
  });
}

export const createLicensePolicy = normalizeLicensePolicy;

export function hasLicenseRight(policy, right) {
  const normalized = normalizeLicensePolicy(policy);
  return normalized.rights.includes(text(right, 'right', { maximum: 64, pattern: SAFE_IDENTIFIER }));
}
