import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  REGISTRY_SCHEMA_VERSION,
  canonicalDigest,
  createReleaseId,
  normalizeSkillId,
  toPublicRegistryValue,
} from '../../../../trusted-supply/lib/registry-identity.mjs';

const CACHE_SCHEMA_VERSION = 1;
const SOURCE_ID = /^regsrc_[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const EVENT_ID = /^evt_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EVENT_TYPES = new Set([
  'skill.upserted', 'skill.aliased', 'release.published', 'release.superseded',
  'release.withdrawn', 'release.revoked', 'listing.upserted', 'listing.withdrawn',
  'projection.receipted',
]);
const PUBLIC_RELEASE_KEYS = new Set([
  'schemaVersion', 'releaseId', 'skillId', 'version', 'status', 'package',
  'compatibility', 'assessmentRefs', 'reviewRefs', 'sourceRefs', 'publishedAt',
]);
const PUBLIC_PACKAGE_KEYS = new Set(['packageDigest', 'manifestDigest']);
const PUBLIC_COMPATIBILITY_KEYS = new Set(['contract', 'targets']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SOURCE_REF = /^src_[a-f0-9]{64}$/;
const PRIVATE_KEY = /(?:candidate|storageRef|localPath|absolutePath|reviewer|principal|subjectId|email|token|apiKey|credential|privateUrl)/i;

export class RegistryClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryClientError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RegistryClientError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function integerCursor(value, label = 'cursor') {
  if (!/^(?:0|[1-9]\d*)$/.test(String(value))) fail('INVALID_CURSOR', `${label} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('INVALID_CURSOR', `${label} is too large`);
  return number;
}

function assertSourceId(value) {
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) fail('INVALID_SOURCE_ID', 'Registry source ID must be regsrc_<sha256>');
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function stringArray(value, label, { pattern } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail('INVALID_RELEASE', `${label} must be a non-empty bounded array`);
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || !item || item.length > 256 || (pattern && !pattern.test(item))) fail('INVALID_RELEASE', `${label}[${index}] is invalid`);
    if (/^cand_/i.test(item)) fail('PRIVATE_VALUE', `${label}[${index}] contains candidate identity`);
    return item;
  });
  if (new Set(normalized).size !== normalized.length) fail('INVALID_RELEASE', `${label} contains duplicate values`);
  return normalized;
}

function assertPublic(value, label = 'Registry value') {
  const visit = (nested, key = '') => {
    if (key && PRIVATE_KEY.test(key)) fail('PRIVATE_FIELD', `${label} contains private field ${key}`);
    if (typeof nested === 'string' && (/^cand_/i.test(nested) || /^(?:\/|[A-Za-z]:[\\/])/.test(nested) || nested.startsWith('file://'))) {
      fail('PRIVATE_VALUE', `${label} contains a private value`);
    }
    if (Array.isArray(nested)) nested.forEach(item => visit(item));
    else if (nested && typeof nested === 'object') Object.entries(nested).forEach(([childKey, item]) => visit(item, childKey));
  };
  visit(value);
  return value;
}

function emptyProjection() {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    throughSequence: 0,
    skills: {}, aliases: {}, releases: {}, listings: {},
  };
}

function validateReleaseIdentity(release, expectedReleaseId) {
  exactKeys(release, PUBLIC_RELEASE_KEYS, 'release');
  if (release.schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported release schemaVersion');
  if (!RELEASE_ID.test(expectedReleaseId) || release.releaseId !== expectedReleaseId) fail('INVALID_RELEASE_ID', 'release key and embedded identity differ');
  if (normalizeSkillId(release.skillId) !== release.skillId) fail('INVALID_RELEASE', 'release skillId must be canonical');
  if (typeof release.version !== 'string' || !SEMVER.test(release.version)) fail('INVALID_RELEASE', 'release version must be SemVer');
  if (release.status !== 'published') fail('INVALID_RELEASE_STATUS', 'immutable release entity must retain published status');
  exactKeys(release.package, PUBLIC_PACKAGE_KEYS, 'release.package');
  if (!DIGEST.test(release.package.packageDigest) || !DIGEST.test(release.package.manifestDigest)) fail('INVALID_RELEASE', 'release package digests are invalid');
  exactKeys(release.compatibility, PUBLIC_COMPATIBILITY_KEYS, 'release.compatibility');
  if (typeof release.compatibility.contract !== 'string' || !release.compatibility.contract) fail('INVALID_RELEASE', 'release compatibility contract is required');
  stringArray(release.compatibility.targets, 'release.compatibility.targets');
  stringArray(release.assessmentRefs, 'release.assessmentRefs');
  stringArray(release.reviewRefs, 'release.reviewRefs');
  stringArray(release.sourceRefs, 'release.sourceRefs', { pattern: SOURCE_REF });
  if (typeof release.publishedAt !== 'string' || !Number.isFinite(Date.parse(release.publishedAt))) fail('INVALID_RELEASE', 'release publishedAt is invalid');
  let calculated;
  try {
    calculated = createReleaseId({
      schemaVersion: release.schemaVersion,
      skillId: release.skillId,
      version: release.version,
      packageDigest: release.package?.packageDigest,
    });
  } catch {
    fail('INVALID_RELEASE_ID', 'release identity inputs are invalid');
  }
  if (calculated !== expectedReleaseId) fail('RELEASE_ID_MISMATCH', 'releaseId does not match immutable release inputs');
  return release;
}

function validateProjection(projection) {
  object(projection.skills, 'projection.skills');
  object(projection.aliases, 'projection.aliases');
  object(projection.releases, 'projection.releases');
  object(projection.listings, 'projection.listings');
  const versions = new Map();
  for (const [releaseId, entry] of Object.entries(projection.releases)) {
    object(entry, `release entry ${releaseId}`);
    validateReleaseIdentity(entry.release, releaseId);
    if (!['published', 'superseded', 'withdrawn', 'revoked'].includes(entry.status)) fail('INVALID_RELEASE_STATUS', `release ${releaseId} has an unknown status`);
    const versionKey = `${entry.release.skillId}\0${entry.release.version}`;
    const previous = versions.get(versionKey);
    if (previous && previous !== entry.release.package.packageDigest) fail('VERSION_IMMUTABLE', 'skillId+version maps to multiple package digests');
    versions.set(versionKey, entry.release.package.packageDigest);
  }
  return projection;
}

function listingKey(payload) {
  for (const key of ['channel', 'locale', 'skillId']) {
    if (typeof payload[key] !== 'string' || !payload[key]) fail('INVALID_EVENT', `listing payload requires ${key}`);
  }
  return `${payload.channel}\0${payload.locale}\0${normalizeSkillId(payload.skillId)}`;
}

function releaseEntry(projection, releaseId) {
  const entry = projection.releases[releaseId];
  if (!entry) fail('RELEASE_NOT_FOUND', `release ${releaseId} is not in the verified projection`);
  return entry;
}

function applyPublicEvent(projection, event) {
  const payload = object(event.payload, 'event.payload');
  switch (event.type) {
    case 'skill.upserted': {
      const skillId = normalizeSkillId(payload.skillId ?? event.subject?.skillId);
      projection.skills[skillId] = {
        ...(projection.skills[skillId] ?? {}), ...clone(payload), skillId,
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        createdAt: projection.skills[skillId]?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      break;
    }
    case 'skill.aliased': {
      const alias = normalizeSkillId(payload.alias);
      const target = normalizeSkillId(payload.targetSkillId ?? event.subject?.skillId);
      if (alias === target || (projection.aliases[alias] && projection.aliases[alias] !== target)) fail('ALIAS_CONFLICT', 'invalid Registry alias transition');
      projection.aliases[alias] = target;
      break;
    }
    case 'release.published': {
      const release = object(payload.release ?? payload, 'release');
      if (!RELEASE_ID.test(release.releaseId) || release.releaseId !== event.subject?.releaseId) fail('INVALID_RELEASE_ID', 'published release identity is invalid');
      validateReleaseIdentity(release, release.releaseId);
      for (const entry of Object.values(projection.releases)) {
        if (entry.release.skillId === release.skillId && entry.release.version === release.version && entry.release.package.packageDigest !== release.package.packageDigest) {
          fail('VERSION_IMMUTABLE', 'skillId+version is already bound to another package digest');
        }
      }
      const existing = projection.releases[release.releaseId];
      if (existing && canonicalDigest(existing.release) !== canonicalDigest(release)) fail('RELEASE_IMMUTABLE', 'release content changed after publication');
      projection.releases[release.releaseId] ??= { release: clone(release), status: 'published', successorReleaseId: null, tombstone: null };
      break;
    }
    case 'release.superseded': {
      const releaseId = payload.releaseId ?? event.subject?.releaseId;
      const entry = releaseEntry(projection, releaseId);
      releaseEntry(projection, payload.successorReleaseId);
      if (entry.status === 'withdrawn' || entry.status === 'revoked') fail('STATUS_CANNOT_RELAX', 'terminal release status cannot be relaxed');
      if (entry.successorReleaseId && entry.successorReleaseId !== payload.successorReleaseId) fail('SUPERSEDE_CONFLICT', 'release successor changed');
      entry.status = 'superseded';
      entry.successorReleaseId = payload.successorReleaseId;
      break;
    }
    case 'release.withdrawn':
    case 'release.revoked': {
      const releaseId = payload.releaseId ?? event.subject?.releaseId;
      const entry = releaseEntry(projection, releaseId);
      const nextStatus = event.type === 'release.revoked' ? 'revoked' : 'withdrawn';
      if (entry.status === 'revoked' || (entry.status === 'withdrawn' && nextStatus !== 'revoked')) fail('STATUS_CANNOT_RELAX', 'invalid terminal release transition');
      entry.status = nextStatus;
      entry.tombstone = { status: nextStatus, eventId: event.eventId, occurredAt: event.occurredAt, reasonCode: event.reasonCode };
      break;
    }
    case 'listing.upserted': {
      releaseEntry(projection, payload.releaseId);
      projection.listings[listingKey(payload)] = { ...clone(payload), status: 'visible', updatedAt: event.occurredAt };
      break;
    }
    case 'listing.withdrawn': {
      const key = listingKey(payload);
      projection.listings[key] = { ...(projection.listings[key] ?? clone(payload)), status: 'withdrawn', updatedAt: event.occurredAt };
      break;
    }
    case 'projection.receipted':
      break;
    default:
      fail('UNKNOWN_EVENT_TYPE', `unsupported Registry event type ${event.type}`);
  }
  projection.throughSequence = event.sequence;
}

function validateEvent(input, expectedSequence) {
  const event = object(input, 'event');
  if (event.schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported event schemaVersion');
  if (event.sequence !== expectedSequence) fail('SEQUENCE_GAP', `expected Registry sequence ${expectedSequence}`);
  if (!EVENT_ID.test(event.eventId)) fail('INVALID_EVENT_ID', 'Registry eventId is invalid');
  if (!EVENT_TYPES.has(event.type)) fail('UNKNOWN_EVENT_TYPE', `unsupported Registry event type ${event.type}`);
  if (!DIGEST.test(event.payloadDigest) || canonicalDigest(event.payload) !== event.payloadDigest) fail('PAYLOAD_DIGEST_MISMATCH', 'Registry event payload digest does not match');
  assertPublic(event, 'Registry event');
  return clone(event);
}

function normalizeSnapshot(input) {
  const snapshot = object(input, 'snapshot');
  if (snapshot.schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported snapshot schemaVersion');
  const cursor = integerCursor(snapshot.throughCursor, 'snapshot throughCursor');
  const data = object(snapshot.data, 'snapshot.data');
  if (data.schemaVersion !== REGISTRY_SCHEMA_VERSION || data.throughSequence !== cursor) fail('SNAPSHOT_SEQUENCE_MISMATCH', 'snapshot cursor does not match projection sequence');
  if (!DIGEST.test(snapshot.snapshotDigest) || canonicalDigest({ throughCursor: String(cursor), data }) !== snapshot.snapshotDigest) {
    fail('SNAPSHOT_DIGEST_MISMATCH', 'Registry snapshot digest does not match');
  }
  assertPublic(data, 'Registry snapshot');
  const projection = validateProjection({ ...emptyProjection(), ...clone(toPublicRegistryValue(data)) });
  return { cursor, projection };
}

function cacheEnvelope(sourceId, cursor, data) {
  if (object(data, 'Registry cache projection').throughSequence !== cursor) fail('CACHE_SEQUENCE_MISMATCH', 'Registry cache cursor does not match its projection');
  const publicData = validateProjection(clone(toPublicRegistryValue(data)));
  assertPublic(publicData, 'Registry cache');
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
    sourceId,
    cursor: String(cursor),
    cacheDigest: canonicalDigest({ sourceId, cursor: String(cursor), data: publicData }),
    data: publicData,
  };
}

export function createRegistrySourceId(coordinate) {
  if (typeof coordinate !== 'string' || !coordinate.trim() || coordinate.includes('\0')) fail('INVALID_SOURCE_COORDINATE', 'Registry source coordinate is invalid');
  const digest = crypto.createHash('sha256').update(`skillops.registry-source.v1\0${coordinate.normalize('NFC').trim()}`, 'utf8').digest('hex');
  return `regsrc_${digest}`;
}

export class RegistryCache {
  constructor(filePath, { sourceId } = {}) {
    if (typeof filePath !== 'string' || !filePath) fail('CACHE_PATH_REQUIRED', 'Registry cache path is required');
    this.filePath = path.resolve(filePath);
    this.sourceId = assertSourceId(sourceId);
  }

  read({ required = false } = {}) {
    if (!fs.existsSync(this.filePath)) {
      if (required) fail('CACHE_NOT_FOUND', 'verified Registry cache is unavailable');
      return null;
    }
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { fail('INVALID_CACHE', 'Registry cache is not valid JSON'); }
    object(value, 'cache');
    if (value.cacheSchemaVersion !== CACHE_SCHEMA_VERSION || value.registrySchemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported Registry cache schema');
    if (value.sourceId !== this.sourceId) fail('SOURCE_MISMATCH', 'Registry cache belongs to another source');
    const cursor = integerCursor(value.cursor, 'cache cursor');
    if (!DIGEST.test(value.cacheDigest) || canonicalDigest({ sourceId: value.sourceId, cursor: String(cursor), data: value.data }) !== value.cacheDigest) fail('CACHE_DIGEST_MISMATCH', 'Registry cache digest does not match');
    object(value.data, 'cache.data');
    if (value.data.throughSequence !== cursor) fail('CACHE_SEQUENCE_MISMATCH', 'Registry cache cursor does not match its projection');
    assertPublic(value.data, 'Registry cache');
    validateProjection(value.data);
    return clone(value);
  }

  write(envelope) {
    const value = clone(envelope);
    if (value.sourceId !== this.sourceId) fail('SOURCE_MISMATCH', 'cannot write cache for another Registry source');
    const cursor = integerCursor(value.cursor, 'cache cursor');
    if (object(value.data, 'cache.data').throughSequence !== cursor) fail('CACHE_SEQUENCE_MISMATCH', 'Registry cache cursor does not match its projection');
    validateProjection(value.data);
    const verified = cacheEnvelope(this.sourceId, cursor, value.data);
    if (value.cacheDigest !== verified.cacheDigest) fail('CACHE_DIGEST_MISMATCH', 'cache envelope is not canonical');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(verified, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return clone(verified);
  }

  resolveRelease(releaseId) {
    if (releaseId === 'latest' || /^cand_/i.test(String(releaseId))) fail('MUTABLE_RELEASE_FORBIDDEN', 'an explicit immutable releaseId is required');
    if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) fail('INVALID_RELEASE_ID', 'releaseId must be rel_<sha256>');
    const cache = this.read({ required: true });
    const entry = cache.data.releases?.[releaseId];
    if (!entry) fail('RELEASE_NOT_FOUND', 'release is not present in the verified offline cache');
    if (entry.status === 'withdrawn') fail('RELEASE_WITHDRAWN', 'withdrawn release cannot be resolved for distribution');
    if (entry.status === 'revoked') fail('RELEASE_REVOKED', 'revoked release cannot be resolved for distribution');
    return clone({ ...entry, registrySourceId: this.sourceId, feedCursor: cache.cursor });
  }
}

export function createLocalRegistrySource(store, { coordinate = 'local-registry' } = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.feed !== 'function') fail('INVALID_SOURCE', 'source requires snapshot and feed methods');
  return Object.freeze({
    sourceId: createRegistrySourceId(coordinate),
    snapshot: () => store.snapshot({ public: true }),
    feed: options => store.feed({ ...options, public: true }),
  });
}

export function syncRegistry({ cache, source, pageLimit = 100 } = {}) {
  if (!(cache instanceof RegistryCache)) fail('INVALID_CACHE', 'sync requires a RegistryCache');
  if (!source || typeof source !== 'object' || typeof source.snapshot !== 'function' || typeof source.feed !== 'function') fail('INVALID_SOURCE', 'sync source requires snapshot and feed');
  if (source.sourceId !== cache.sourceId) fail('SOURCE_MISMATCH', 'Registry source and cache identities differ');
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 1_000) fail('INVALID_LIMIT', 'pageLimit must be from 1 to 1000');

  const previous = cache.read();
  let cursor;
  let projection;
  if (previous) {
    cursor = integerCursor(previous.cursor);
    projection = clone(previous.data);
  } else {
    const snapshot = normalizeSnapshot(source.snapshot());
    cursor = snapshot.cursor;
    projection = snapshot.projection;
  }

  while (true) {
    const page = object(source.feed({ after: String(cursor), limit: pageLimit }), 'feed page');
    if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') fail('INVALID_FEED', 'feed page shape is invalid');
    let expected = cursor + 1;
    for (const input of page.events) {
      const event = validateEvent(input, expected);
      applyPublicEvent(projection, event);
      expected += 1;
    }
    const nextCursor = integerCursor(page.nextCursor, 'feed nextCursor');
    const expectedCursor = expected - 1;
    if (nextCursor < cursor) fail('CURSOR_ROLLBACK', 'Registry feed cursor moved backwards');
    if (nextCursor !== expectedCursor) fail('CURSOR_DISCONTINUITY', 'Registry feed cursor does not match delivered events');
    if (page.hasMore && nextCursor === cursor) fail('FEED_STALLED', 'Registry feed made no progress');
    cursor = nextCursor;
    projection.throughSequence = cursor;
    if (!page.hasMore) break;
  }

  const next = cacheEnvelope(cache.sourceId, cursor, projection);
  cache.write(next);
  return { action: previous ? (previous.cacheDigest === next.cacheDigest ? 'unchanged' : 'updated') : 'initialized', cache: clone(next) };
}
