import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../registry-identity.mjs';
import { normalizeEntitlement } from './entitlement.mjs';
import { normalizeEntitlementRevocation, normalizeOrderRefundRecord } from './lifecycle.mjs';
import { normalizeFreeOrder } from './order.mjs';

const SCHEMA_VERSION = 1;
const EMPTY_REVISION = canonicalDigest({ schemaVersion: SCHEMA_VERSION, events: [] });
const EVENT_TYPES = new Set([
  'order.granted', 'entitlement.issued', 'entitlement.revoked', 'order.refund_recorded',
]);
const MAX_EVENTS = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;

export class MarketLedgerError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MarketLedgerError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new MarketLedgerError(code, message, cause);
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

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: SCHEMA_VERSION, events });
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
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'market ledger path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) fail('UNSAFE_STORE_PATH', 'market ledger path is not a safe regular-file path');
  }
}

function normalizeEvent(input) {
  exactKeys(input, new Set(['schemaVersion', 'type', 'occurredAt', 'payload', 'eventId']), 'marketEvent');
  const schemaVersion = input.schemaVersion ?? SCHEMA_VERSION;
  if (schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `market event schemaVersion must be ${SCHEMA_VERSION}`);
  if (!EVENT_TYPES.has(input.type)) fail('UNKNOWN_EVENT_TYPE', `unsupported market event type: ${input.type}`);
  let payload;
  try {
    if (input.type === 'order.granted') payload = normalizeFreeOrder(input.payload);
    else if (input.type === 'entitlement.issued') payload = normalizeEntitlement(input.payload);
    else if (input.type === 'entitlement.revoked') payload = normalizeEntitlementRevocation(input.payload);
    else payload = normalizeOrderRefundRecord(input.payload);
  } catch (cause) {
    fail('INVALID_EVENT_PAYLOAD', `market event payload is invalid: ${cause.message}`, cause);
  }
  const body = { schemaVersion, type: input.type, occurredAt: timestamp(input.occurredAt, 'marketEvent.occurredAt'), payload };
  const eventId = `mktevt_${canonicalDigest(body).slice(7)}`;
  if (input.eventId !== undefined && input.eventId !== eventId) fail('EVENT_ID_MISMATCH', 'market eventId does not match its content');
  return Object.freeze({ ...body, eventId });
}

export function createMarketEvent(input) {
  return normalizeEvent(input);
}

export function replayMarketEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', 'market event log is invalid or too large');
  const projection = {
    schemaVersion: SCHEMA_VERSION,
    orders: {},
    entitlements: {},
    entitlementLifecycle: {},
    refunds: {},
    idempotency: {},
  };
  const eventIds = new Set();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const raw of events) {
    const event = normalizeEvent(raw);
    const eventTime = Date.parse(event.occurredAt);
    if (eventTime < previousTime) fail('EVENT_TIME_REGRESSION', 'market event time must be monotonic');
    previousTime = eventTime;
    if (eventIds.has(event.eventId)) fail('DUPLICATE_EVENT', 'market event log contains a duplicate event');
    eventIds.add(event.eventId);
    if (event.type === 'order.granted') {
      if (event.occurredAt !== event.payload.orderedAt) fail('EVENT_TIME_MISMATCH', 'order event must use orderedAt');
      const previous = projection.idempotency[event.payload.idempotencyKey];
      if (previous && previous.requestDigest !== event.payload.requestDigest) fail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another order request');
      if (projection.orders[event.payload.orderId] && projection.orders[event.payload.orderId].orderDigest !== event.payload.orderDigest) {
        fail('ORDER_CONFLICT', 'orderId is bound to another order');
      }
      projection.orders[event.payload.orderId] = clone(event.payload);
      projection.idempotency[event.payload.idempotencyKey] = {
        requestDigest: event.payload.requestDigest,
        orderId: event.payload.orderId,
      };
    } else if (event.type === 'entitlement.issued') {
      if (event.occurredAt !== event.payload.issuedAt) fail('EVENT_TIME_MISMATCH', 'entitlement event must use issuedAt');
      const order = projection.orders[event.payload.sourceOrderId];
      if (!order || order.orderDigest !== event.payload.sourceOrderDigest) fail('SOURCE_ORDER_REQUIRED', 'entitlement source order is missing or mismatched');
      const existing = projection.entitlements[event.payload.entitlementId];
      if (existing && existing.entitlementDigest !== event.payload.entitlementDigest) fail('ENTITLEMENT_CONFLICT', 'entitlementId is bound to another grant');
      projection.entitlements[event.payload.entitlementId] = clone(event.payload);
      projection.entitlementLifecycle[event.payload.entitlementId] = { status: 'active', eventId: event.eventId };
    } else if (event.type === 'entitlement.revoked') {
      if (event.occurredAt !== event.payload.revokedAt) fail('EVENT_TIME_MISMATCH', 'revocation event must use revokedAt');
      const entitlement = projection.entitlements[event.payload.entitlementId];
      if (!entitlement || entitlement.entitlementDigest !== event.payload.entitlementDigest
        || entitlement.organizationId !== event.payload.organizationId
        || entitlement.productId !== event.payload.productId) {
        fail('ENTITLEMENT_REQUIRED', 'revocation requires the exact previously issued Entitlement');
      }
      const existing = projection.entitlementLifecycle[event.payload.entitlementId];
      if (existing?.status === 'revoked') fail('REVOCATION_CONFLICT', 'Entitlement already has a different revocation event');
      projection.entitlementLifecycle[event.payload.entitlementId] = {
        status: 'revoked', eventId: event.eventId, revocation: clone(event.payload),
      };
    } else {
      if (event.occurredAt !== event.payload.recordedAt) fail('EVENT_TIME_MISMATCH', 'refund event must use recordedAt');
      const order = projection.orders[event.payload.orderId];
      if (!order || order.orderDigest !== event.payload.orderDigest
        || order.organizationId !== event.payload.organizationId
        || order.productId !== event.payload.productId) {
        fail('ORDER_REQUIRED', 'refund record requires the exact previously granted Order');
      }
      if (projection.refunds[event.payload.orderId]) fail('REFUND_CONFLICT', 'Order already has a different refund record');
      projection.refunds[event.payload.orderId] = clone(event.payload);
    }
  }
  return projection;
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'market ledger is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

export class MarketLedger {
  constructor(filePath, { faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'market ledger path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.filePath = systemTempPath(filePath);
    this.faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.filePath);
  }

  read() {
    assertSafePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return { schemaVersion: SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('UNSAFE_STORE_PATH', 'market ledger target is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'market ledger is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'marketLedger');
    if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.events)) fail('UNSUPPORTED_STORE', 'market ledger schema is unsupported');
    replayMarketEvents(value.events);
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'market ledger revision does not match its events');
    return { schemaVersion: SCHEMA_VERSION, revision, events: clone(value.events) };
  }

  #write(value) {
    const parent = path.dirname(this.filePath);
    assertSafePath(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) fail('STORE_TOO_LARGE', 'market ledger exceeds the hard size limit');
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
    assertSafePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const release = acquireLock(this.filePath);
    try {
      const current = this.read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match the market ledger');
      const event = normalizeEvent(input);
      const same = current.events.find(item => item.eventId === event.eventId);
      if (same) return { action: 'unchanged', event: clone(same), revision: current.revision, projection: replayMarketEvents(current.events) };
      if (event.type === 'order.granted') {
        const projection = replayMarketEvents(current.events);
        const prior = projection.idempotency[event.payload.idempotencyKey];
        if (prior && prior.requestDigest !== event.payload.requestDigest) fail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another order request');
        if (prior) {
          const priorOrder = projection.orders[prior.orderId];
          return { action: 'unchanged', event: null, revision: current.revision, projection, order: clone(priorOrder) };
        }
      }
      const events = [...current.events, event];
      const projection = replayMarketEvents(events);
      const next = { schemaVersion: SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'market ledger commit could not be verified');
      return { action: 'appended', event: clone(event), revision: committed.revision, projection };
    } finally {
      release();
    }
  }

  project() {
    return replayMarketEvents(this.read().events);
  }

  resolveEntitlement(entitlementId) {
    const projection = this.project();
    const lifecycle = projection.entitlementLifecycle[entitlementId];
    if (!lifecycle || lifecycle.status !== 'active') return null;
    return clone(projection.entitlements[entitlementId]);
  }
}
