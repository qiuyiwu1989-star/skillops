import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendOrganizationEvent,
  replayOrganizationEvents,
} from './organization-governance.mjs';

const STORE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_STORE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100_000;

export class OrganizationGovernanceStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OrganizationGovernanceStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new OrganizationGovernanceStoreError(code, message, cause);
}

function positiveLimit(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) fail('INVALID_LIMIT', `${label} must be a positive safe integer`);
  return resolved;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function revisionFor(events) {
  return digest({ schemaVersion: STORE_SCHEMA_VERSION, events });
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function clone(value) {
  return structuredClone(value);
}

function normalizeSystemTempPrefix(filePath) {
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, filePath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return path.resolve(fs.realpathSync(temporary), relative);
  }
  return filePath;
}

function existingPathIsSafe(filePath) {
  const parsed = path.parse(filePath);
  let current = parsed.root;
  const segments = filePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'organization store path must not contain symbolic links');
    if (current === filePath) {
      if (!stat.isFile()) fail('UNSAFE_STORE_PATH', 'organization store target must be a regular file');
    } else if (!stat.isDirectory()) {
      fail('UNSAFE_STORE_PATH', 'organization store ancestors must be directories');
    }
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === 'EEXIST') fail('STORE_BUSY', 'organization store is locked by another writer');
    throw error;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

export class OrganizationGovernanceStore {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      fail('STORE_PATH_REQUIRED', 'organization store file path is required');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'store options must be an object');
    const unknown = Object.keys(options).filter(key => !['maxStoreBytes', 'maxEventBytes', 'maxEvents', 'faultInjector'].includes(key));
    if (unknown.length) fail('INVALID_OPTIONS', `unknown store options: ${unknown.join(', ')}`);
    if (options.faultInjector !== undefined && typeof options.faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.filePath = normalizeSystemTempPrefix(path.resolve(filePath));
    this.maxStoreBytes = positiveLimit(options.maxStoreBytes, DEFAULT_MAX_STORE_BYTES, 'maxStoreBytes');
    this.maxEventBytes = positiveLimit(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 'maxEventBytes');
    this.maxEvents = positiveLimit(options.maxEvents, DEFAULT_MAX_EVENTS, 'maxEvents');
    this.faultInjector = options.faultInjector ?? (() => {});
    existingPathIsSafe(this.filePath);
  }

  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_STORE', 'organization store must be an object');
    const unknown = Object.keys(data).filter(key => !['schemaVersion', 'revision', 'events'].includes(key));
    if (unknown.length || data.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(data.events)) {
      fail('UNSUPPORTED_STORE', 'unsupported organization store format');
    }
    if (data.events.length > this.maxEvents) fail('EVENT_LIMIT_EXCEEDED', 'organization event count exceeds the hard limit');
    for (const event of data.events) {
      if (byteLength(event) > this.maxEventBytes) fail('EVENT_TOO_LARGE', 'organization event exceeds the hard size limit');
    }
    const expectedRevision = revisionFor(data.events);
    if (data.revision !== expectedRevision) fail('REVISION_MISMATCH', 'organization store revision does not match its event history');
    try {
      replayOrganizationEvents(data.events);
    } catch (error) {
      fail('INVALID_EVENT_LOG', `organization event history cannot be replayed: ${error.message}`, error);
    }
    return { schemaVersion: STORE_SCHEMA_VERSION, revision: expectedRevision, events: clone(data.events) };
  }

  read() {
    existingPathIsSafe(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      const events = [];
      return { schemaVersion: STORE_SCHEMA_VERSION, revision: revisionFor(events), events };
    }
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'organization store target must be a regular file');
    if (stat.size > this.maxStoreBytes) fail('STORE_TOO_LARGE', 'organization store exceeds the hard size limit');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (error) { fail('INVALID_STORE', 'organization store is not valid JSON', error); }
    return this.validate(parsed);
  }

  #write(data) {
    const validated = this.validate(data);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxStoreBytes) fail('STORE_TOO_LARGE', 'organization store exceeds the hard size limit');
    const parent = path.dirname(this.filePath);
    existingPathIsSafe(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    existingPathIsSafe(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const staged = JSON.parse(fs.readFileSync(temporary, 'utf8'));
      this.validate(staged);
      this.faultInjector('beforeRename', { filePath: this.filePath, revision: validated.revision });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    return validated;
  }

  append(input, { expectedRevision, registryResolver, now } = {}) {
    existingPathIsSafe(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    existingPathIsSafe(this.filePath);
    const releaseLock = acquireLock(this.filePath);
    try {
      const current = this.read();
      if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) {
        fail('REVISION_CONFLICT', 'expectedRevision does not match the current organization revision');
      }
      const result = appendOrganizationEvent(current.events, input, { registryResolver, now });
      if (result.action === 'replayed') {
        return { action: result.action, event: result.event, revision: current.revision, projection: clone(result.projection) };
      }
      if (result.events.length > this.maxEvents) fail('EVENT_LIMIT_EXCEEDED', 'organization event count exceeds the hard limit');
      if (byteLength(result.event) > this.maxEventBytes) fail('EVENT_TOO_LARGE', 'organization event exceeds the hard size limit');
      const next = {
        schemaVersion: STORE_SCHEMA_VERSION,
        revision: revisionFor(result.events),
        events: result.events,
      };
      this.#write(next);
      const committed = this.read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'organization store commit could not be verified');
      return { action: result.action, event: result.event, revision: committed.revision, projection: clone(result.projection) };
    } finally {
      releaseLock();
    }
  }

  project() {
    return clone(replayOrganizationEvents(this.read().events));
  }
}
