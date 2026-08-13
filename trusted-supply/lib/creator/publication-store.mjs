import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../registry-identity.mjs';
import {
  PUBLICATION_SCHEMA_VERSION,
  PublicationWorkflowError,
  createPublicationEvent,
  replayPublicationEvents,
} from './publication-workflow.mjs';

const MAX_EVENTS = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;
const EMPTY_REVISION = canonicalDigest({ schemaVersion: PUBLICATION_SCHEMA_VERSION, events: [] });

export class PublicationStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PublicationStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PublicationStoreError(code, message, cause);
}

function clone(value) {
  return structuredClone(value);
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

function systemTempPath(filePath) {
  const resolved = path.resolve(filePath);
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return path.resolve(fs.realpathSync(temporary), relative);
  }
  return resolved;
}

function assertSafePath(filePath) {
  const parsed = path.parse(filePath);
  let current = parsed.root;
  for (const segment of filePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'publication store path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) fail('UNSAFE_STORE_PATH', 'publication store path is not a safe regular-file path');
  }
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: PUBLICATION_SCHEMA_VERSION, events });
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'publication store is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function normalizeEvent(input, trustOptions) {
  try { return createPublicationEvent(input.type, input.payload, trustOptions); } catch (cause) {
    if (cause instanceof PublicationWorkflowError) fail('INVALID_EVENT', cause.message, cause);
    throw cause;
  }
}

export class PublicationStore {
  constructor(filePath, { trustOptions = {}, faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'publication store path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.filePath = systemTempPath(filePath);
    this.trustOptions = trustOptions;
    this.faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.filePath);
  }

  read() {
    assertSafePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return { schemaVersion: PUBLICATION_SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('UNSAFE_STORE_PATH', 'publication store target is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'publication store is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'publication store');
    if (value.schemaVersion !== PUBLICATION_SCHEMA_VERSION || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
      fail('UNSUPPORTED_STORE', 'publication store schema or size is unsupported');
    }
    try { replayPublicationEvents(value.events, this.trustOptions); } catch (cause) { fail('INVALID_STORE', 'publication event history is invalid', cause); }
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'publication store revision does not match events');
    return { schemaVersion: PUBLICATION_SCHEMA_VERSION, revision, events: clone(value.events) };
  }

  #write(value) {
    const parent = path.dirname(this.filePath);
    assertSafePath(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) fail('STORE_TOO_LARGE', 'publication store exceeds the hard size limit');
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.faultInjector('beforeRename', { revision: value.revision });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  append(input, { expectedRevision } = {}) {
    exactKeys(input, new Set(['type', 'payload']), 'publication append input');
    assertSafePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const release = acquireLock(this.filePath);
    try {
      const current = this.read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match the publication store');
      const event = normalizeEvent(input, this.trustOptions);
      const existing = current.events.find(item => item.eventId === event.eventId);
      if (existing) return { action: 'unchanged', revision: current.revision, event: clone(existing), projection: replayPublicationEvents(current.events, this.trustOptions) };
      const events = [...current.events, event];
      let projection;
      try { projection = replayPublicationEvents(events, this.trustOptions); } catch (cause) { fail('EVENT_REJECTED', cause.message, cause); }
      const next = { schemaVersion: PUBLICATION_SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'publication store commit could not be verified');
      return { action: 'appended', revision: committed.revision, event: clone(event), projection };
    } finally {
      release();
    }
  }

  snapshot() {
    const state = this.read();
    return Object.freeze({ schemaVersion: PUBLICATION_SCHEMA_VERSION, revision: state.revision, eventCount: state.events.length });
  }

  project() {
    return replayPublicationEvents(this.read().events, this.trustOptions);
  }
}
