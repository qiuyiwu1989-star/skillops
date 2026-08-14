import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../registry-identity.mjs';
import {
  DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
  DerivativeEvolutionError,
  createDerivativeEvolutionEvent,
  replayDerivativeEvolutionEvents,
} from './derivative-evolution.mjs';

const MAX_EVENTS = 100_000;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const EMPTY_REVISION = canonicalDigest({ schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, events: [] });

export class DerivativeEvolutionStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DerivativeEvolutionStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new DerivativeEvolutionStoreError(code, message, cause);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
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
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'derivative evolution store path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) fail('UNSAFE_STORE_PATH', 'derivative evolution store path is not a safe regular-file path');
  }
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, events });
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'derivative evolution store is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function normalizeEvent(input, trustOptions) {
  try { return createDerivativeEvolutionEvent(input, trustOptions); } catch (cause) {
    if (cause instanceof DerivativeEvolutionError) fail('INVALID_EVENT', cause.message, cause);
    throw cause;
  }
}

export function replayDerivativeEvolutionStoreEvents(events, trustOptions = {}) {
  try { return replayDerivativeEvolutionEvents(events, trustOptions); } catch (cause) {
    if (cause instanceof DerivativeEvolutionError) fail(cause.code, cause.message, cause);
    throw cause;
  }
}

export class DerivativeEvolutionStore {
  #filePath;
  #trustOptions;
  #faultInjector;

  constructor(filePath, { trustOptions = {}, faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'derivative evolution store path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.#filePath = systemTempPath(filePath);
    this.#trustOptions = Object.freeze({ ...trustOptions });
    this.#faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.#filePath);
  }

  #read() {
    assertSafePath(this.#filePath);
    if (!fs.existsSync(this.#filePath)) return { schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.#filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail('UNSAFE_STORE_PATH', 'derivative evolution store is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'derivative evolution store is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'derivativeEvolutionStore');
    if (value.schemaVersion !== DERIVATIVE_EVOLUTION_SCHEMA_VERSION || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
      fail('UNSUPPORTED_STORE', 'derivative evolution store schema or size is unsupported');
    }
    try { replayDerivativeEvolutionStoreEvents(value.events, this.#trustOptions); } catch (cause) {
      fail('INVALID_STORE', 'derivative evolution event history is invalid', cause);
    }
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'derivative evolution revision does not match events');
    return { schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, revision, events: structuredClone(value.events) };
  }

  #write(value) {
    const parent = path.dirname(this.#filePath);
    assertSafePath(this.#filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.#filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) fail('STORE_TOO_LARGE', 'derivative evolution store exceeds the hard size limit');
    const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.#faultInjector('beforeRename', { revision: value.revision });
      fs.renameSync(temporary, this.#filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  append(input, { expectedRevision } = {}) {
    assertSafePath(this.#filePath);
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.#filePath);
    const releaseLock = acquireLock(this.#filePath);
    try {
      const current = this.#read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match derivative evolution store');
      const event = normalizeEvent(input, this.#trustOptions);
      const operation = current.events.find(row => row.operationId === event.operationId);
      if (operation) {
        if (operation.planDigest !== event.planDigest) fail('OPERATION_CONFLICT', 'operationId cannot bind another planDigest');
        const eventSummary = {
          eventId: operation.eventId, type: operation.type, operationId: operation.operationId,
          planDigest: operation.planDigest, outcome: operation.outcome,
        };
        return Object.freeze({
          action: 'unchanged', revision: current.revision, eventCount: current.events.length,
          event: Object.freeze(eventSummary), statusDigest: canonicalDigest({ revision: current.revision, eventCount: current.events.length, eventSummary }),
        });
      }
      const events = [...current.events, event];
      replayDerivativeEvolutionStoreEvents(events, this.#trustOptions);
      const next = { schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.#read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'derivative evolution commit could not be verified');
      const eventSummary = {
        eventId: event.eventId, type: event.type, operationId: event.operationId,
        planDigest: event.planDigest, outcome: event.outcome,
      };
      return Object.freeze({
        action: 'appended', revision: committed.revision, eventCount: committed.events.length,
        event: Object.freeze(eventSummary), statusDigest: canonicalDigest({ revision: committed.revision, eventCount: committed.events.length, eventSummary }),
      });
    } finally {
      releaseLock();
    }
  }

  snapshot() {
    const state = this.#read();
    return Object.freeze({ schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION, revision: state.revision, eventCount: state.events.length });
  }

  projectOrganization({ organizationAuthorizer } = {}) {
    if (typeof organizationAuthorizer !== 'function') fail('ORGANIZATION_AUTHORIZER_REQUIRED', 'trusted organization authorizer is required');
    let decision;
    try { decision = organizationAuthorizer({ purpose: 'enterprise.derivative_evolution.read' }); } catch (cause) {
      fail('ORGANIZATION_AUTHORIZER_FAILED', 'trusted organization authorizer failed', cause);
    }
    if (!decision || decision.decision !== 'allow' || typeof decision.organizationId !== 'string'
      || !/^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/.test(decision.organizationId)) {
      fail('ORGANIZATION_FORBIDDEN', 'organization evolution projection is not authorized');
    }
    const state = this.#read();
    const events = state.events.filter(event => event.organizationId === decision.organizationId);
    const projection = replayDerivativeEvolutionStoreEvents(events, this.#trustOptions);
    const body = {
      schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
      organizationId: decision.organizationId,
      eventCount: projection.eventCount,
      privateProducts: structuredClone(projection.privateProducts),
      events: structuredClone(projection.events),
    };
    return Object.freeze({ ...body, projectionDigest: canonicalDigest(body) });
  }

  projectPublic() {
    const state = this.#read();
    const projection = replayDerivativeEvolutionStoreEvents(state.events, this.#trustOptions);
    const products = Object.values(projection.privateProducts);
    const body = {
      schemaVersion: DERIVATIVE_EVOLUTION_SCHEMA_VERSION,
      summary: {
        organizations: new Set(products.map(product => product.organizationId)).size,
        privateProducts: products.length,
        planSelections: projection.events.filter(event => event.type === 'plan.accepted').length,
        rollbackSelections: projection.events.filter(event => event.type === 'rollback.selected').length,
      },
    };
    return Object.freeze({ ...body, projectionDigest: canonicalDigest(body) });
  }
}
