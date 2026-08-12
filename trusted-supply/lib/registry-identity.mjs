import crypto from 'node:crypto';

export const REGISTRY_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GENERATED_ID = /^(?:rel|src)_[a-f0-9]{64}$/;
const SOURCE_ID = /^src_[a-f0-9]{64}$/;
const SKILL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const TARGET = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class RegistryIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryIdentityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RegistryIdentityError(code, message);
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

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function reference(value, label) {
  const normalized = text(value, label, 256);
  if (!REFERENCE.test(normalized)) fail('INVALID_REFERENCE', `${label} contains unsupported characters`);
  return normalized;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function canonicalDigest(value) {
  let serialized;
  try {
    serialized = JSON.stringify(canonicalJson(value));
  } catch {
    fail('NOT_JSON', 'value must be JSON serializable');
  }
  if (serialized === undefined) fail('NOT_JSON', 'value must be JSON serializable');
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;
}

export function normalizePackageDigest(value) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('INVALID_PACKAGE_DIGEST', 'packageDigest must be sha256:<64 lowercase hexadecimal characters>');
  }
  return value;
}

export function normalizeSkillId(value) {
  const normalized = text(value, 'skillId', 127).toLowerCase();
  const parts = normalized.split('/');
  if (parts.length !== 2 || parts.some(part => !SKILL_PART.test(part))) {
    fail('INVALID_SKILL_ID', 'skillId must be lowercase namespace/name');
  }
  if (parts.some(part => part.startsWith('cand_'))) fail('CANDIDATE_ID_FORBIDDEN', 'candidate identity cannot be used as skillId');
  return normalized;
}

export function normalizeSemver(value) {
  const normalized = text(value, 'version', 128);
  const match = normalized.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) fail('INVALID_SEMVER', 'version must be valid SemVer');
  return normalized;
}

function releaseInput(skillOrInput, version, packageDigest) {
  return typeof skillOrInput === 'object' && skillOrInput !== null
    ? skillOrInput
    : { skillId: skillOrInput, version, packageDigest };
}

export function releaseId(skillOrInput, version, packageDigest) {
  const input = releaseInput(skillOrInput, version, packageDigest);
  const schemaVersion = input.schemaVersion ?? REGISTRY_SCHEMA_VERSION;
  if (schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `release schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`);
  const skillId = normalizeSkillId(input.skillId);
  const semver = normalizeSemver(input.version);
  const digest = normalizePackageDigest(input.packageDigest ?? input.package?.packageDigest);
  const hash = crypto.createHash('sha256')
    .update(`skillops.release.v1\0${skillId}\0${semver}\0${digest}`, 'utf8')
    .digest('hex');
  return `rel_${hash}`;
}

export const createReleaseId = releaseId;

function sourceInput(typeOrInput, coordinate) {
  return typeof typeOrInput === 'object' && typeOrInput !== null ? typeOrInput : { type: typeOrInput, coordinate };
}

export function sourceId(typeOrInput, coordinate) {
  const input = sourceInput(typeOrInput, coordinate);
  const type = text(input.type, 'source.type', 64).toLowerCase();
  if (!TARGET.test(type)) fail('INVALID_SOURCE_TYPE', 'source.type contains unsupported characters');
  const normalizedCoordinate = text(input.coordinate, 'source.coordinate', 2_048);
  if (/^cand_/i.test(normalizedCoordinate)) fail('CANDIDATE_ID_FORBIDDEN', 'candidate identity cannot be used as a source coordinate');
  const hash = crypto.createHash('sha256')
    .update(`skillops.source.v1\0${type}\0${normalizedCoordinate}`, 'utf8')
    .digest('hex');
  return `src_${hash}`;
}

export const createSourceId = sourceId;

function stringArray(value, label, { pattern = REFERENCE, maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maximum) fail('INVALID_ARRAY', `${label} must be an array within limits`);
  const normalized = value.map((item, index) => {
    const result = text(item, `${label}[${index}]`, 256);
    if (!pattern.test(result)) fail('INVALID_REFERENCE', `${label}[${index}] is invalid`);
    if (/^cand_/i.test(result)) fail('CANDIDATE_ID_FORBIDDEN', `${label}[${index}] cannot use candidate identity`);
    return result;
  });
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_REFERENCE', `${label} must not contain duplicates`);
  return [...normalized].sort();
}

function nonEmptyStringArray(value, label, options) {
  const result = stringArray(value, label, options);
  if (!result.length) fail('INVALID_ARRAY', `${label} must not be empty`);
  return result;
}

export function normalizeRelease(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'releaseId', 'skillId', 'version', 'status', 'package',
    'compatibility', 'assessmentRefs', 'reviewRefs', 'sourceRefs', 'publishedAt',
  ]), 'release');
  const schemaVersion = input.schemaVersion ?? REGISTRY_SCHEMA_VERSION;
  if (schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `release schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`);
  const skillId = normalizeSkillId(input.skillId);
  const version = normalizeSemver(input.version);
  const packageInput = object(input.package, 'release.package');
  exactKeys(packageInput, new Set(['packageDigest', 'manifestDigest', 'storageRef']), 'release.package');
  const packageDigest = normalizePackageDigest(packageInput.packageDigest);
  const manifestDigest = normalizePackageDigest(packageInput.manifestDigest);
  const calculatedReleaseId = releaseId({ schemaVersion, skillId, version, packageDigest });
  if (input.releaseId !== undefined && input.releaseId !== calculatedReleaseId) {
    fail('RELEASE_ID_MISMATCH', 'releaseId does not match canonical release identity');
  }
  if (input.status !== undefined && input.status !== 'published') fail('INVALID_RELEASE_STATUS', 'new releases must have published status');
  const compatibilityInput = object(input.compatibility, 'release.compatibility');
  exactKeys(compatibilityInput, new Set(['contract', 'targets']), 'release.compatibility');
  const targets = stringArray(compatibilityInput.targets, 'release.compatibility.targets', { pattern: TARGET, maximum: 50 });
  if (!targets.length) fail('INVALID_ARRAY', 'release.compatibility.targets must not be empty');
  const storageRef = text(packageInput.storageRef, 'release.package.storageRef', 1_024);
  if (storageRef !== `cas:${packageDigest}`) fail('INVALID_STORAGE_REF', 'release.package.storageRef must match packageDigest');
  return Object.freeze({
    schemaVersion,
    releaseId: calculatedReleaseId,
    skillId,
    version,
    status: 'published',
    package: Object.freeze({ packageDigest, manifestDigest, storageRef }),
    compatibility: Object.freeze({
      contract: reference(compatibilityInput.contract, 'release.compatibility.contract'),
      targets: Object.freeze(targets),
    }),
    assessmentRefs: Object.freeze(nonEmptyStringArray(input.assessmentRefs, 'release.assessmentRefs')),
    reviewRefs: Object.freeze(nonEmptyStringArray(input.reviewRefs, 'release.reviewRefs')),
    sourceRefs: Object.freeze(nonEmptyStringArray(input.sourceRefs, 'release.sourceRefs', { pattern: SOURCE_ID })),
    publishedAt: timestamp(input.publishedAt, 'release.publishedAt'),
  });
}

const PRIVATE_KEYS = /(?:candidate|storageRef|localPath|absolutePath|reviewer|principal|subjectId|email|token|apiKey|credential|privateUrl)/i;

function isAbsolutePath(value) {
  return typeof value === 'string' && (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith('file://'));
}

export function toPublicRegistryValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(typeof item === 'string' && (/^cand_/i.test(item) || isAbsolutePath(item))))
      .map(toPublicRegistryValue);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEYS.test(key)) continue;
      if (typeof nested === 'string' && (/^cand_/i.test(nested) || isAbsolutePath(nested))) continue;
      result[key] = toPublicRegistryValue(nested);
    }
    return result;
  }
  return value;
}

export function assertGeneratedRegistryId(value, kind) {
  const expected = kind === 'release' ? /^rel_[a-f0-9]{64}$/ : kind === 'source' ? /^src_[a-f0-9]{64}$/ : null;
  if (!expected || typeof value !== 'string' || !expected.test(value)) fail('INVALID_GENERATED_ID', `${kind} ID is invalid`);
  return value;
}
