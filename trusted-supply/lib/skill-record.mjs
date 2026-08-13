import {
  assertGeneratedRegistryId,
  canonicalDigest,
  normalizeRelease,
  normalizeSemver,
  normalizeSkillId,
} from './registry-identity.mjs';

export const SKILL_RECORD_SCHEMA_VERSION = 2;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SOURCE_TYPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const INTENT_TAG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const LOCALIZATION_STATUSES = new Set(['source', 'auto_translated', 'human_reviewed']);
const FORBIDDEN_KEYS = /^(?:candidate|candidateId|content|body|prompt|inputText|outputText|transcript|token|apiKey|secret|credential|password|privateKey|localPath|absolutePath|storageRef|reviewer|principal|email)$/i;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/i;

export class SkillRecordValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillRecordValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillRecordValidationError(code, message);
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

function privacyGate(value, label = 'record', seen = new Set()) {
  if (typeof value === 'string') {
    if (/(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+(?:$|[^A-Za-z0-9])/i.test(value)) fail('PRIVATE_VALUE', `${label} contains candidate identity`);
    if (/(?:^|\s)(?:\/[^\s]+|[A-Za-z]:[\\/][^\s]+|file:\/\/[^\s]+)/.test(value)) fail('PRIVATE_VALUE', `${label} contains a local path`);
    if (SECRET_VALUE.test(value)) fail('SECRET_VALUE', `${label} contains secret-shaped material`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('NOT_JSON', `${label} must not contain cycles`);
  seen.add(value);
  if (!Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.test(key)) fail('PRIVATE_FIELD', `${label} contains forbidden field: ${key}`);
      privacyGate(value[key], `${label}.${key}`, seen);
    }
  } else value.forEach((item, index) => privacyGate(item, `${label}[${index}]`, seen));
  seen.delete(value);
}

function text(value, label, maximum = 2_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  privacyGate(normalized, label);
  return normalized;
}

function nullableText(value, label, maximum = 256) {
  return value === null ? null : text(value, label, maximum);
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_DIGEST', `${label} must be sha256:<64 lowercase hexadecimal characters>`);
  return value;
}

function token(value, label) {
  const result = text(value, label, 256);
  if (!TOKEN.test(result)) fail('INVALID_TOKEN', `${label} contains unsupported characters`);
  return result;
}

function stringArray(value, label, { maximum = 50, allowEmpty = true, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    fail('INVALID_ARRAY', `${label} must be an array within limits`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`, 500));
  if (pattern && result.some(item => !pattern.test(item))) fail('INVALID_TOKEN', `${label} contains unsupported values`);
  if (new Set(result).size !== result.length) fail('DUPLICATE_VALUE', `${label} must not contain duplicates`);
  return Object.freeze([...result].sort());
}

function normalizeSource(input) {
  exactKeys(input, new Set(['sourceId', 'type', 'coordinate']), 'source');
  let sourceId;
  try { sourceId = assertGeneratedRegistryId(input.sourceId, 'source'); } catch (error) { fail('INVALID_SOURCE', error.message); }
  const type = text(input.type, 'source.type', 64).toLowerCase();
  if (!SOURCE_TYPE.test(type)) fail('INVALID_SOURCE', 'source.type is invalid');
  const coordinate = text(input.coordinate, 'source.coordinate', 1_024);
  if (/[?#]/.test(coordinate)) fail('PRIVATE_SOURCE_COORDINATE', 'source.coordinate must not contain query or fragment data');
  if (/^https?:\/\//i.test(coordinate)) {
    let parsed;
    try { parsed = new URL(coordinate); } catch { fail('INVALID_SOURCE', 'source.coordinate URL is invalid'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('PRIVATE_SOURCE_COORDINATE', 'source.coordinate URL must not contain userinfo, query, or fragment data');
  }
  return Object.freeze({ sourceId, type, coordinate });
}

function normalizeMetadata(input) {
  exactKeys(input, new Set([
    'titleZh', 'descriptionZh', 'originalTitle', 'originalDescription', 'originalLanguage',
    'localizationStatus', 'translationSource',
  ]), 'metadata');
  const localizationStatus = text(input.localizationStatus, 'metadata.localizationStatus', 32);
  if (!LOCALIZATION_STATUSES.has(localizationStatus)) fail('INVALID_LOCALIZATION', 'metadata.localizationStatus is unsupported');
  const translationSource = nullableText(input.translationSource, 'metadata.translationSource');
  if (localizationStatus === 'source' && translationSource !== null) fail('INVALID_LOCALIZATION', 'source localization must have null translationSource');
  if (localizationStatus !== 'source' && translationSource === null) fail('INVALID_LOCALIZATION', 'translated localization requires translationSource');
  const originalLanguage = text(input.originalLanguage, 'metadata.originalLanguage', 32);
  if (!LANG.test(originalLanguage)) fail('INVALID_LANGUAGE', 'metadata.originalLanguage must be a language tag');
  return Object.freeze({
    titleZh: text(input.titleZh, 'metadata.titleZh', 160),
    descriptionZh: text(input.descriptionZh, 'metadata.descriptionZh', 2_000),
    originalTitle: text(input.originalTitle, 'metadata.originalTitle', 160),
    originalDescription: text(input.originalDescription, 'metadata.originalDescription', 2_000),
    originalLanguage,
    localizationStatus,
    translationSource,
  });
}

function normalizeExample(value, index) {
  exactKeys(value, new Set(['task', 'expectedUse', 'reason']), `routing.examples[${index}]`);
  if (typeof value.expectedUse !== 'boolean') fail('INVALID_BOOLEAN', `routing.examples[${index}].expectedUse must be boolean`);
  return Object.freeze({
    task: text(value.task, `routing.examples[${index}].task`, 500),
    expectedUse: value.expectedUse,
    reason: text(value.reason, `routing.examples[${index}].reason`, 500),
  });
}

function normalizeConfusion(value, index) {
  exactKeys(value, new Set(['skillId', 'reason', 'distinction']), `routing.confusions[${index}]`);
  let skillId;
  try { skillId = normalizeSkillId(value.skillId); } catch (error) { fail('INVALID_SKILL_ID', error.message); }
  return Object.freeze({
    skillId,
    reason: text(value.reason, `routing.confusions[${index}].reason`, 500),
    distinction: text(value.distinction, `routing.confusions[${index}].distinction`, 500),
  });
}

function normalizeRouting(input) {
  exactKeys(input, new Set(['summary', 'intentTags', 'whenToUse', 'whenNotToUse', 'examples', 'confusions']), 'routing');
  if (!Array.isArray(input.examples) || input.examples.length > 50) fail('INVALID_ARRAY', 'routing.examples must be an array within limits');
  if (!Array.isArray(input.confusions) || input.confusions.length > 50) fail('INVALID_ARRAY', 'routing.confusions must be an array within limits');
  const examples = input.examples.map(normalizeExample);
  const confusions = input.confusions.map(normalizeConfusion);
  if (new Set(confusions.map(item => item.skillId)).size !== confusions.length) fail('DUPLICATE_VALUE', 'routing.confusions must not repeat skillId');
  return Object.freeze({
    summary: text(input.summary, 'routing.summary', 1_000),
    intentTags: stringArray(input.intentTags, 'routing.intentTags', { maximum: 30, allowEmpty: false, pattern: INTENT_TAG }),
    whenToUse: stringArray(input.whenToUse, 'routing.whenToUse'),
    whenNotToUse: stringArray(input.whenNotToUse, 'routing.whenNotToUse'),
    examples: Object.freeze(examples),
    confusions: Object.freeze(confusions),
  });
}

function normalizePort(value, label, output = false) {
  exactKeys(value, new Set(output ? ['name', 'description'] : ['name', 'description', 'required']), label);
  if (!output && typeof value.required !== 'boolean') fail('INVALID_BOOLEAN', `${label}.required must be boolean`);
  const result = { name: token(value.name, `${label}.name`), description: text(value.description, `${label}.description`, 500) };
  if (!output) result.required = value.required;
  return Object.freeze(result);
}

function normalizeInterface(input) {
  exactKeys(input, new Set(['inputs', 'outputs']), 'interface');
  if (!Array.isArray(input.inputs) || !Array.isArray(input.outputs) || input.inputs.length > 50 || input.outputs.length > 50) {
    fail('INVALID_ARRAY', 'interface inputs and outputs must be arrays within limits');
  }
  const inputs = input.inputs.map((value, index) => normalizePort(value, `interface.inputs[${index}]`));
  const outputs = input.outputs.map((value, index) => normalizePort(value, `interface.outputs[${index}]`, true));
  for (const [label, values] of [['inputs', inputs], ['outputs', outputs]]) {
    if (new Set(values.map(item => item.name)).size !== values.length) fail('DUPLICATE_VALUE', `interface.${label} names must be unique`);
  }
  return Object.freeze({ inputs: Object.freeze(inputs), outputs: Object.freeze(outputs) });
}

function normalizeDependency(value, label) {
  exactKeys(value, new Set(['skillId', 'releaseId', 'reason']), label);
  let skillId;
  try { skillId = normalizeSkillId(value.skillId); } catch (error) { fail('INVALID_SKILL_ID', error.message); }
  let releaseId = null;
  if (value.releaseId !== null) {
    try { releaseId = assertGeneratedRegistryId(value.releaseId, 'release'); } catch (error) { fail('INVALID_RELEASE', error.message); }
  }
  return Object.freeze({ skillId, releaseId, reason: text(value.reason, `${label}.reason`, 500) });
}

function dependencyArray(value, label) {
  if (!Array.isArray(value) || value.length > 100) fail('INVALID_ARRAY', `${label} must be an array within limits`);
  const result = value.map((item, index) => normalizeDependency(item, `${label}[${index}]`));
  if (new Set(result.map(item => `${item.skillId}\0${item.releaseId}`)).size !== result.length) fail('DUPLICATE_VALUE', `${label} contains duplicates`);
  return Object.freeze(result.sort((a, b) => {
    const left = `${a.skillId}:${a.releaseId}`;
    const right = `${b.skillId}:${b.releaseId}`;
    return left < right ? -1 : left > right ? 1 : 0;
  }));
}

function normalizeDependencies(input) {
  exactKeys(input, new Set(['required', 'optional', 'conflicts']), 'dependencies');
  const result = {
    required: dependencyArray(input.required, 'dependencies.required'),
    optional: dependencyArray(input.optional, 'dependencies.optional'),
    conflicts: dependencyArray(input.conflicts, 'dependencies.conflicts'),
  };
  const seen = new Map();
  for (const [kind, values] of Object.entries(result)) for (const item of values) {
    if (seen.has(item.skillId)) fail('DEPENDENCY_CONTRADICTION', `${item.skillId} appears in both ${seen.get(item.skillId)} and ${kind}`);
    seen.set(item.skillId, kind);
  }
  return Object.freeze(result);
}

function normalizePermissions(input) {
  exactKeys(input, new Set(['required', 'optional', 'prohibited']), 'permissions');
  const result = {
    required: stringArray(input.required, 'permissions.required', { pattern: TOKEN }),
    optional: stringArray(input.optional, 'permissions.optional', { pattern: TOKEN }),
    prohibited: stringArray(input.prohibited, 'permissions.prohibited', { pattern: TOKEN }),
  };
  const seen = new Map();
  for (const [kind, values] of Object.entries(result)) for (const item of values) {
    if (seen.has(item)) fail('PERMISSION_CONTRADICTION', `${item} appears in both ${seen.get(item)} and ${kind}`);
    seen.set(item, kind);
  }
  return Object.freeze(result);
}

function normalizeCompatibility(input) {
  exactKeys(input, new Set(['contract', 'targets']), 'compatibility');
  return Object.freeze({
    contract: token(input.contract, 'compatibility.contract'),
    targets: stringArray(input.targets, 'compatibility.targets', { allowEmpty: false, pattern: SOURCE_TYPE }),
  });
}

function normalizeEvidence(input) {
  exactKeys(input, new Set(['smsDigest', 'evalDigest', 'reviewEvidenceDigest', 'reviewPolicyDigest']), 'evidence');
  return Object.freeze({
    smsDigest: digest(input.smsDigest, 'evidence.smsDigest'),
    evalDigest: digest(input.evalDigest, 'evidence.evalDigest'),
    reviewEvidenceDigest: digest(input.reviewEvidenceDigest, 'evidence.reviewEvidenceDigest'),
    reviewPolicyDigest: digest(input.reviewPolicyDigest, 'evidence.reviewPolicyDigest'),
  });
}

function assertReleaseBinding(core, release) {
  if (core.skillId !== release.skillId || core.releaseId !== release.releaseId || core.version !== release.version
    || core.packageDigest !== release.package.packageDigest) fail('RELEASE_BINDING_MISMATCH', 'record does not match canonical Release identity');
  if (core.compatibility.contract !== release.compatibility.contract
    || JSON.stringify(core.compatibility.targets) !== JSON.stringify(release.compatibility.targets)) {
    fail('COMPATIBILITY_MISMATCH', 'record compatibility does not match canonical Release');
  }
  for (const ref of [core.evidence.smsDigest, core.evidence.evalDigest]) {
    if (!release.assessmentRefs.includes(ref)) fail('EVIDENCE_NOT_CURRENT', 'assessment evidence is not referenced by canonical Release');
  }
  for (const ref of [core.evidence.reviewEvidenceDigest, core.evidence.reviewPolicyDigest]) {
    if (!release.reviewRefs.includes(ref)) fail('EVIDENCE_NOT_CURRENT', 'review evidence is not referenced by canonical Release');
  }
}

function normalizeCore(input) {
  let skillId;
  try { skillId = normalizeSkillId(input.skillId); } catch (error) { fail('INVALID_SKILL_ID', error.message); }
  let releaseId;
  try { releaseId = assertGeneratedRegistryId(input.releaseId, 'release'); } catch (error) { fail('INVALID_RELEASE', error.message); }
  let version;
  try { version = normalizeSemver(input.version); } catch (error) { fail('INVALID_VERSION', error.message); }
  return {
    schemaVersion: SKILL_RECORD_SCHEMA_VERSION,
    skillId,
    releaseId,
    version,
    packageDigest: digest(input.packageDigest, 'packageDigest'),
    source: normalizeSource(input.source),
    metadata: normalizeMetadata(input.metadata),
    routing: normalizeRouting(input.routing),
    interface: normalizeInterface(input.interface),
    dependencies: normalizeDependencies(input.dependencies),
    permissions: normalizePermissions(input.permissions),
    compatibility: normalizeCompatibility(input.compatibility),
    evidence: normalizeEvidence(input.evidence),
  };
}

function routingValue(core) {
  return {
    schemaVersion: SKILL_RECORD_SCHEMA_VERSION,
    skillId: core.skillId,
    releaseId: core.releaseId,
    packageDigest: core.packageDigest,
    routing: core.routing,
    interface: core.interface,
    dependencies: core.dependencies,
    permissions: core.permissions,
    compatibility: core.compatibility,
  };
}

function finalize(core) {
  const routingDigest = canonicalDigest(routingValue(core));
  const recordDigest = canonicalDigest({ ...core, routingDigest });
  return Object.freeze({ ...core, routingDigest, recordDigest });
}

export function createSkillRecord(input) {
  exactKeys(input, new Set(['release', 'source', 'metadata', 'routing', 'interface', 'dependencies', 'permissions', 'compatibility', 'evidence']), 'skill record input');
  privacyGate({
    source: input.source,
    metadata: input.metadata,
    routing: input.routing,
    interface: input.interface,
    dependencies: input.dependencies,
    permissions: input.permissions,
    compatibility: input.compatibility,
    evidence: input.evidence,
  });
  let release;
  try { release = normalizeRelease(input.release); } catch (error) { fail('INVALID_RELEASE', error.message); }
  const core = normalizeCore({
    skillId: release.skillId,
    releaseId: release.releaseId,
    version: release.version,
    packageDigest: release.package.packageDigest,
    source: input.source,
    metadata: input.metadata,
    routing: input.routing,
    interface: input.interface,
    dependencies: input.dependencies,
    permissions: input.permissions,
    compatibility: input.compatibility,
    evidence: input.evidence,
  });
  if (!release.sourceRefs.includes(core.source.sourceId)) fail('SOURCE_NOT_CURRENT', 'source is not referenced by canonical Release');
  assertReleaseBinding(core, release);
  return finalize(core);
}

export function validateSkillRecord(input, { release: releaseInput } = {}) {
  privacyGate(input);
  exactKeys(input, new Set([
    'schemaVersion', 'skillId', 'releaseId', 'version', 'packageDigest', 'source', 'metadata', 'routing',
    'interface', 'dependencies', 'permissions', 'compatibility', 'evidence', 'routingDigest', 'recordDigest',
  ]), 'skill record');
  if (input.schemaVersion !== SKILL_RECORD_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `schemaVersion must be ${SKILL_RECORD_SCHEMA_VERSION}`);
  const canonical = finalize(normalizeCore(input));
  if (input.routingDigest !== canonical.routingDigest) fail('ROUTING_DIGEST_MISMATCH', 'routingDigest does not match current routing fields');
  if (input.recordDigest !== canonical.recordDigest) fail('RECORD_DIGEST_MISMATCH', 'recordDigest does not match current record');
  if (releaseInput !== undefined) {
    let release;
    try { release = normalizeRelease(releaseInput); } catch (error) { fail('INVALID_RELEASE', error.message); }
    if (!release.sourceRefs.includes(canonical.source.sourceId)) fail('SOURCE_NOT_CURRENT', 'source is not referenced by canonical Release');
    assertReleaseBinding(canonical, release);
  }
  return canonical;
}

export function isSkillRecordCurrent(record, { release } = {}) {
  try {
    validateSkillRecord(record, { release });
    return true;
  } catch {
    return false;
  }
}
