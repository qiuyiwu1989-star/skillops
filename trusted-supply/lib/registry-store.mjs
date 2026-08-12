import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  REGISTRY_SCHEMA_VERSION,
  RegistryIdentityError,
  canonicalDigest,
  canonicalJson,
  normalizeRelease,
  normalizeSkillId,
  toPublicRegistryValue,
} from './registry-identity.mjs';

const EVENT_TYPES = new Set([
  'skill.upserted', 'skill.aliased', 'release.published', 'release.superseded',
  'release.withdrawn', 'release.revoked', 'listing.upserted', 'listing.withdrawn',
  'projection.receipted',
]);
const EVENT_ID = /^evt_[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export class RegistryStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RegistryStoreError(code, message);
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

function reference(value, label) {
  const normalized = text(value, label, 256);
  if (!REFERENCE.test(normalized)) fail('INVALID_REFERENCE', `${label} contains unsupported characters`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function normalizeSubject(value) {
  const input = object(value, 'event.subject');
  const result = {};
  for (const key of ['skillId', 'releaseId', 'listingId']) {
    if (input[key] !== undefined) result[key] = key === 'skillId' ? normalizeSkillId(input[key]) : reference(input[key], `event.subject.${key}`);
  }
  if (!Object.keys(result).length) fail('INVALID_SUBJECT', 'event.subject must identify a registry entity');
  if (Object.values(result).some(item => /^cand_/i.test(item))) fail('CANDIDATE_ID_FORBIDDEN', 'candidate identity cannot be an event subject');
  return result;
}

function normalizeJson(value, label) {
  object(value, label);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('NOT_JSON', `${label} must be JSON serializable`); }
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) fail('PAYLOAD_TOO_LARGE', `${label} exceeds 2 MiB`);
  return clone(value);
}

function calculatedEventId(body) {
  const hex = crypto.createHash('sha256').update(JSON.stringify(canonicalJson(body))).digest('hex');
  return `evt_${hex}`;
}

export function createRegistryEvent(input = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'eventId', 'sequence', 'type', 'occurredAt', 'actorRef',
    'reasonCode', 'subject', 'payload', 'payloadDigest', 'policyVersion',
  ]), 'event');
  const schemaVersion = input.schemaVersion ?? REGISTRY_SCHEMA_VERSION;
  if (schemaVersion !== REGISTRY_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `event schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`);
  const type = text(input.type, 'event.type', 64);
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported registry event type: ${type}`);
  const payload = normalizeJson(input.payload ?? {}, 'event.payload');
  const payloadDigest = canonicalDigest(payload);
  if (input.payloadDigest !== undefined && input.payloadDigest !== payloadDigest) fail('PAYLOAD_DIGEST_MISMATCH', 'payloadDigest does not match event payload');
  const body = {
    schemaVersion,
    type,
    occurredAt: timestamp(input.occurredAt, 'event.occurredAt'),
    actorRef: reference(input.actorRef, 'event.actorRef'),
    reasonCode: reference(input.reasonCode, 'event.reasonCode'),
    subject: normalizeSubject(input.subject),
    payload,
    payloadDigest,
    policyVersion: reference(input.policyVersion, 'event.policyVersion'),
  };
  const eventId = calculatedEventId(body);
  if (input.eventId !== undefined && input.eventId !== eventId) fail('EVENT_ID_MISMATCH', 'eventId does not match canonical event body');
  return Object.freeze({ ...body, eventId });
}

function listingKey(payload) {
  return `${reference(payload.channel, 'listing.channel')}\0${reference(payload.locale, 'listing.locale')}\0${normalizeSkillId(payload.skillId)}`;
}

function assertReleaseSubject(event, releaseId) {
  if (event.subject.releaseId !== releaseId) fail('SUBJECT_MISMATCH', 'event subject releaseId does not match payload');
}

function applyEvent(projection, event) {
  switch (event.type) {
    case 'skill.upserted': {
      const skillId = normalizeSkillId(event.payload.skillId ?? event.subject.skillId);
      if (event.subject.skillId !== skillId) fail('SUBJECT_MISMATCH', 'event subject skillId does not match payload');
      const previous = projection.skills[skillId];
      projection.skills[skillId] = {
        ...(previous ?? {}),
        ...clone(event.payload),
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        skillId,
        createdAt: previous?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      break;
    }
    case 'skill.aliased': {
      const alias = normalizeSkillId(event.payload.alias);
      const target = normalizeSkillId(event.payload.targetSkillId ?? event.subject.skillId);
      if (alias === target) fail('ALIAS_SELF_REFERENCE', 'skill alias cannot target itself');
      if (projection.aliases[alias] && projection.aliases[alias] !== target) fail('ALIAS_CONFLICT', 'skill alias cannot be rebound');
      let cursor = target;
      const visited = new Set([alias]);
      while (projection.aliases[cursor]) {
        if (visited.has(cursor)) fail('ALIAS_CYCLE', 'skill aliases cannot form a cycle');
        visited.add(cursor);
        cursor = projection.aliases[cursor];
      }
      if (cursor === alias) fail('ALIAS_CYCLE', 'skill aliases cannot form a cycle');
      projection.aliases[alias] = target;
      break;
    }
    case 'release.published': {
      let release;
      try { release = normalizeRelease(event.payload.release ?? event.payload); } catch (error) {
        if (error instanceof RegistryIdentityError) fail(error.code, error.message);
        throw error;
      }
      assertReleaseSubject(event, release.releaseId);
      const versionKey = `${release.skillId}\0${release.version}`;
      const locked = projection.versionLocks[versionKey];
      if (locked && locked !== release.package.packageDigest) fail('VERSION_IMMUTABLE', 'skillId+version is already locked to another package');
      const previous = projection.releases[release.releaseId];
      if (previous && canonicalDigest(previous.release) !== canonicalDigest(release)) fail('RELEASE_IMMUTABLE', 'release content cannot be modified');
      projection.versionLocks[versionKey] = release.package.packageDigest;
      projection.releases[release.releaseId] ??= { release: clone(release), status: 'published', successorReleaseId: null, tombstone: null };
      break;
    }
    case 'release.superseded': {
      const releaseId = reference(event.payload.releaseId ?? event.subject.releaseId, 'releaseId');
      const successorReleaseId = reference(event.payload.successorReleaseId, 'successorReleaseId');
      assertReleaseSubject(event, releaseId);
      const entry = projection.releases[releaseId];
      const successor = projection.releases[successorReleaseId];
      if (!entry || !successor) fail('RELEASE_NOT_FOUND', 'supersede requires existing old and successor releases');
      if (entry.release.skillId !== successor.release.skillId) fail('SKILL_ID_MISMATCH', 'successor must belong to the same skill');
      if (!['published', 'superseded'].includes(entry.status)) fail('STATUS_CANNOT_RELAX', 'withdrawn or revoked release cannot be superseded');
      if (entry.successorReleaseId && entry.successorReleaseId !== successorReleaseId) fail('SUPERSEDE_CONFLICT', 'release successor cannot be changed');
      entry.status = 'superseded';
      entry.successorReleaseId = successorReleaseId;
      break;
    }
    case 'release.withdrawn':
    case 'release.revoked': {
      const releaseId = reference(event.payload.releaseId ?? event.subject.releaseId, 'releaseId');
      assertReleaseSubject(event, releaseId);
      const entry = projection.releases[releaseId];
      if (!entry) fail('RELEASE_NOT_FOUND', 'release transition requires an existing release');
      const nextStatus = event.type === 'release.withdrawn' ? 'withdrawn' : 'revoked';
      if (entry.status === 'revoked' || (entry.status === 'withdrawn' && nextStatus !== 'revoked')) {
        fail('STATUS_CANNOT_RELAX', 'release status cannot be relaxed or repeated with a new event');
      }
      entry.status = nextStatus;
      entry.tombstone = {
        status: nextStatus,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        reasonCode: event.reasonCode,
      };
      break;
    }
    case 'listing.upserted': {
      const key = listingKey(event.payload);
      const release = projection.releases[event.payload.releaseId];
      if (!release) fail('RELEASE_NOT_FOUND', 'listing requires an existing release');
      if (release.release.skillId !== normalizeSkillId(event.payload.skillId)) fail('SKILL_ID_MISMATCH', 'listing release belongs to another skill');
      projection.listings[key] = { ...clone(event.payload), status: 'visible', updatedAt: event.occurredAt };
      break;
    }
    case 'listing.withdrawn': {
      const key = listingKey(event.payload);
      const previous = projection.listings[key];
      projection.listings[key] = { ...(previous ?? clone(event.payload)), status: 'withdrawn', updatedAt: event.occurredAt };
      break;
    }
    case 'projection.receipted':
      projection.receipts[event.eventId] = clone(event.payload);
      break;
    default:
      fail('UNKNOWN_EVENT_TYPE', `unsupported registry event type: ${event.type}`);
  }
  projection.throughSequence = event.sequence;
}

function emptyProjection() {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    throughSequence: 0,
    skills: {},
    aliases: {},
    releases: {},
    versionLocks: {},
    listings: {},
    receipts: {},
  };
}

export function replayRegistryEvents(events) {
  if (!Array.isArray(events)) fail('INVALID_EVENT_LOG', 'events must be an array');
  const projection = emptyProjection();
  const ids = new Map();
  for (let index = 0; index < events.length; index += 1) {
    const input = object(events[index], `events[${index}]`);
    if (input.sequence !== index + 1) fail('SEQUENCE_GAP', `event sequence must be ${index + 1}`);
    const normalized = createRegistryEvent(input);
    const event = { ...normalized, sequence: input.sequence };
    const previous = ids.get(event.eventId);
    if (previous) fail('DUPLICATE_EVENT_ID', `eventId was already used at sequence ${previous}`);
    ids.set(event.eventId, event.sequence);
    applyEvent(projection, event);
  }
  return projection;
}

function publicEvent(event) {
  const payload = toPublicRegistryValue(event.payload);
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt,
    actorRole: 'registry-publisher',
    reasonCode: event.reasonCode,
    subject: toPublicRegistryValue(event.subject),
    payload,
    payloadDigest: canonicalDigest(payload),
    policyVersion: event.policyVersion,
  };
}

function publicProjection(projection) {
  const value = toPublicRegistryValue(projection);
  for (const entry of Object.values(value.releases ?? {})) {
    if (entry.release?.package) delete entry.release.package.storageRef;
  }
  delete value.versionLocks;
  delete value.receipts;
  return value;
}

export class RegistryStore {
  constructor(filePath) {
    if (!filePath) throw new RegistryStoreError('STORE_PATH_REQUIRED', 'registry store file path is required');
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: REGISTRY_SCHEMA_VERSION, events: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { fail('INVALID_STORE', 'registry store is not valid JSON'); }
    if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.events)) fail('UNSUPPORTED_STORE', 'unsupported registry store format');
    replayRegistryEvents(parsed.events);
    return parsed;
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, this.filePath);
  }

  append(input) {
    const data = this.read();
    const normalized = createRegistryEvent(input);
    const sameId = data.events.find(event => event.eventId === normalized.eventId);
    if (sameId) {
      const comparable = { ...sameId };
      delete comparable.sequence;
      if (canonicalDigest(comparable) !== canonicalDigest(normalized)) fail('EVENT_ID_CONFLICT', 'eventId is already bound to another payload');
      return { action: 'unchanged', event: clone(sameId), cursor: String(sameId.sequence) };
    }
    const projection = replayRegistryEvents(data.events);
    if (normalized.type === 'release.published') {
      const release = normalizeRelease(normalized.payload.release ?? normalized.payload);
      const existing = projection.releases[release.releaseId];
      if (existing) {
        if (canonicalDigest(existing.release) !== canonicalDigest(release)) {
          fail('RELEASE_IMMUTABLE', 'release content cannot be modified');
        }
        const original = data.events.find(event => event.type === 'release.published' && event.subject.releaseId === release.releaseId);
        return { action: 'unchanged', event: clone(original), cursor: String(original.sequence) };
      }
    }
    const event = { ...normalized, sequence: data.events.length + 1 };
    applyEvent(projection, event);
    data.events.push(event);
    this.write(data);
    return { action: 'appended', event: clone(event), cursor: String(event.sequence) };
  }

  project() {
    return clone(replayRegistryEvents(this.read().events));
  }

  feed({ after = '0', limit = 100, channel, public: publicOnly = true } = {}) {
    if (!/^(?:0|[1-9]\d*)$/.test(String(after))) fail('INVALID_CURSOR', 'after cursor must be a non-negative integer');
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor)) fail('INVALID_CURSOR', 'after cursor is too large');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail('INVALID_LIMIT', 'limit must be an integer from 1 to 1000');
    const stored = this.read().events;
    if (cursor > stored.length) fail('CURSOR_AHEAD', 'after cursor is ahead of the Registry');
    const pending = stored.slice(cursor);
    const page = [];
    let scanned = 0;
    for (const event of pending) {
      scanned += 1;
      if (!channel || event.payload.channel === undefined || event.payload.channel === channel) page.push(event);
      if (page.length === limit) break;
    }
    const events = publicOnly ? page.map(publicEvent) : clone(page);
    const nextCursor = String(cursor + scanned);
    return { events, nextCursor, hasMore: scanned < pending.length };
  }

  snapshot({ public: publicOnly = true } = {}) {
    const projection = replayRegistryEvents(this.read().events);
    const data = publicOnly ? publicProjection(projection) : clone(projection);
    const throughCursor = String(projection.throughSequence);
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      throughCursor,
      snapshotDigest: canonicalDigest({ throughCursor, data }),
      data,
    };
  }

  static replay(events) {
    return clone(replayRegistryEvents(events));
  }
}
