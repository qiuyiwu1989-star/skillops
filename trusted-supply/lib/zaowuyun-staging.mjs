import { canonicalDigest } from './registry-identity.mjs';
import {
  recomputeZaowuyunIdempotencyKey,
  recomputeZaowuyunPayloadDigest,
  recomputeZaowuyunProjectionId,
  validateZaowuyunEnvelope,
} from './zaowuyun-adapter.mjs';

const SCHEMA_VERSION = 1;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const CURSOR = /^(?:0|[1-9]\d*)$/;
const FORBIDDEN = /(?:candidate|storageRef|localPath|absolutePath|reviewer|principal|prompt|output|token|secret|apiKey|credential|productionUrl|privateUrl)/i;

export class ZaowuyunStagingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZaowuyunStagingError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ZaowuyunStagingError(code, message);
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

function operationReference(value, label) {
  const normalized = reference(value, label);
  if (/^cand_/i.test(normalized) || FORBIDDEN.test(normalized)) {
    fail('PRIVATE_DATA_FORBIDDEN', `${label} must not encode private identity or execution data`);
  }
  return normalized;
}

function cursor(value, label) {
  const normalized = String(value);
  if (!CURSOR.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
    fail('INVALID_CURSOR', `${label} must be a non-negative safe integer cursor`);
  }
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function findForbidden(value) {
  if (Array.isArray(value)) return value.some(findForbidden);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, nested]) => FORBIDDEN.test(key) || findForbidden(nested));
  }
  return typeof value === 'string' && /^cand_/i.test(value);
}

function safeEnvelope(input, label) {
  let envelope;
  try {
    envelope = validateZaowuyunEnvelope(input);
  } catch (error) {
    fail('INVALID_ENVELOPE', `${label} is not a valid Zaowuyun envelope: ${error.message}`);
  }
  if (envelope.mode !== 'dry-run') fail('INVALID_ENVELOPE', `${label} must be a dry-run envelope`);
  if (findForbidden(envelope)) fail('PRIVATE_DATA_FORBIDDEN', `${label} contains private data`);
  return envelope;
}

function comparePaths(previous, current, prefix = '') {
  if (previous === undefined && current === undefined) return [];
  if (previous === undefined || current === undefined) return [prefix || '$'];
  if (canonicalDigest(previous) === canonicalDigest(current)) return [];
  if (Array.isArray(previous) || Array.isArray(current) || !previous || !current
      || typeof previous !== 'object' || typeof current !== 'object') {
    return [prefix || '$'];
  }
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  return keys.flatMap(key => comparePaths(previous[key], current[key], prefix ? `${prefix}.${key}` : key));
}

function diffFor(previous, current) {
  const changedPaths = previous === null
    ? comparePaths({}, current)
    : comparePaths(previous, current);
  return {
    kind: previous === null ? 'create' : changedPaths.length ? 'update' : 'no-change',
    changedPaths,
  };
}

function planBody(plan) {
  const { confirmationDigest: _confirmationDigest, ...body } = plan;
  return body;
}

function confirmationDigestFor(plan) {
  return canonicalDigest(planBody(plan));
}

export function createZaowuyunStagingPlan(envelopeInput, options = {}) {
  exactKeys(options, new Set(['operationId', 'afterCursor', 'previousEnvelope']), 'options');
  const envelope = safeEnvelope(envelopeInput, 'envelope');
  const previousEnvelope = options.previousEnvelope === undefined || options.previousEnvelope === null
    ? null
    : safeEnvelope(options.previousEnvelope, 'previousEnvelope');
  const afterCursor = cursor(options.afterCursor, 'options.afterCursor');
  const nextCursor = cursor(envelope.sourceEvent.sequence, 'envelope.sourceEvent.sequence');
  if (Number(nextCursor) <= Number(afterCursor)) {
    fail('CURSOR_MISMATCH', 'envelope sequence must be ahead of afterCursor');
  }
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'dry-run',
    operationId: operationReference(options.operationId, 'options.operationId'),
    afterCursor,
    nextCursor,
    envelope,
    previousEnvelope,
    diff: diffFor(previousEnvelope, envelope),
  };
  plan.confirmationDigest = confirmationDigestFor(plan);
  return Object.freeze(plan);
}

export function validateZaowuyunStagingPlan(input) {
  const plan = object(input, 'plan');
  exactKeys(plan, new Set([
    'schemaVersion', 'mode', 'operationId', 'afterCursor', 'nextCursor', 'envelope',
    'previousEnvelope', 'diff', 'confirmationDigest',
  ]), 'plan');
  if (plan.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `plan schemaVersion must be ${SCHEMA_VERSION}`);
  if (plan.mode !== 'dry-run') fail('MODE_FORBIDDEN', 'only dry-run plans may be confirmed');
  const operationId = operationReference(plan.operationId, 'plan.operationId');
  const afterCursor = cursor(plan.afterCursor, 'plan.afterCursor');
  const nextCursor = cursor(plan.nextCursor, 'plan.nextCursor');
  const envelope = safeEnvelope(plan.envelope, 'plan.envelope');
  const previousEnvelope = plan.previousEnvelope === null
    ? null
    : safeEnvelope(plan.previousEnvelope, 'plan.previousEnvelope');
  if (nextCursor !== String(envelope.sourceEvent.sequence) || Number(nextCursor) <= Number(afterCursor)) {
    fail('CURSOR_MISMATCH', 'plan cursors do not match the Registry envelope sequence');
  }
  object(plan.diff, 'plan.diff');
  const expectedDiff = diffFor(previousEnvelope, envelope);
  if (canonicalDigest(plan.diff) !== canonicalDigest(expectedDiff)) fail('DIFF_MISMATCH', 'plan diff is not deterministic');
  if (!DIGEST.test(plan.confirmationDigest ?? '') || confirmationDigestFor(plan) !== plan.confirmationDigest) {
    fail('PLAN_DIGEST_MISMATCH', 'confirmationDigest does not match the complete plan');
  }
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'dry-run',
    operationId,
    afterCursor,
    nextCursor,
    envelope,
    previousEnvelope,
    diff: expectedDiff,
    confirmationDigest: plan.confirmationDigest,
  };
  if (findForbidden(normalized)) fail('PRIVATE_DATA_FORBIDDEN', 'plan contains private data');
  return normalized;
}

function stagingEnvelope(dryRunEnvelope) {
  const envelope = { ...clone(dryRunEnvelope), mode: 'staging-mock' };
  envelope.idempotencyKey = recomputeZaowuyunIdempotencyKey(envelope);
  envelope.projectionId = recomputeZaowuyunProjectionId(envelope);
  envelope.payloadDigest = recomputeZaowuyunPayloadDigest(envelope);
  try {
    return validateZaowuyunEnvelope(envelope);
  } catch (error) {
    fail('STAGING_ENVELOPE_INVALID', `staging envelope could not be validated: ${error.message}`);
  }
}

function trimReceipt(input, envelope, plan, recordedAt) {
  const receipt = object(input, 'transport receipt');
  if (findForbidden(receipt)) fail('UNSAFE_RECEIPT', 'transport receipt contains private fields');
  exactKeys(receipt, new Set([
    'projectionId', 'idempotencyKey', 'status', 'remoteRef', 'receivedAt', 'payloadDigest',
  ]), 'transport receipt');
  if (receipt.projectionId !== envelope.projectionId
      || receipt.idempotencyKey !== envelope.idempotencyKey
      || receipt.payloadDigest !== envelope.payloadDigest) {
    fail('RECEIPT_MISMATCH', 'transport receipt is not bound to the staging envelope');
  }
  if (receipt.status !== 'accepted') fail('RECEIPT_REJECTED', 'transport did not accept the staging envelope');
  const remoteRef = text(receipt.remoteRef, 'transport receipt.remoteRef', 2_000);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    operationId: plan.operationId,
    confirmationDigest: plan.confirmationDigest,
    projectionId: envelope.projectionId,
    idempotencyKey: envelope.idempotencyKey,
    payloadDigest: envelope.payloadDigest,
    status: 'accepted',
    remoteRefDigest: canonicalDigest({ remoteRef }),
    receivedAt: timestamp(receipt.receivedAt, 'transport receipt.receivedAt'),
    recordedAt: timestamp(recordedAt, 'recordedAt'),
    cursor: plan.nextCursor,
  };
  if (findForbidden(result)) fail('UNSAFE_RECEIPT', 'trimmed receipt contains private fields');
  return Object.freeze(result);
}

export class ZaowuyunStagingSender {
  constructor(options = {}) {
    exactKeys(options, new Set(['transport', 'clock', 'initialCursor']), 'options');
    const transport = object(options.transport, 'options.transport');
    if (typeof transport.send !== 'function') fail('TRANSPORT_REQUIRED', 'transport.send must be a function');
    if (options.clock !== undefined && typeof options.clock !== 'function') fail('INVALID_CLOCK', 'clock must be a function');
    this.transport = transport;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.cursor = cursor(options.initialCursor ?? '0', 'options.initialCursor');
    this.bindings = new Map();
    this.receipts = new Map();
    this.inFlight = new Map();
    this.cursorClaim = null;
  }

  async send(planInput, options = {}) {
    exactKeys(options, new Set(['confirmationDigest']), 'options');
    const plan = validateZaowuyunStagingPlan(planInput);
    if (!DIGEST.test(options.confirmationDigest ?? '') || options.confirmationDigest !== plan.confirmationDigest) {
      fail('CONFIRMATION_MISMATCH', 'exact confirmationDigest is required before staging send');
    }
    const binding = this.bindings.get(plan.operationId);
    if (binding && binding !== plan.confirmationDigest) {
      fail('OPERATION_CONFLICT', 'operationId is already bound to another confirmation digest');
    }
    const previous = this.receipts.get(plan.operationId);
    if (previous) return clone(previous);
    const pending = this.inFlight.get(plan.operationId);
    if (pending) return clone(await pending);
    if (this.cursorClaim) {
      fail('CURSOR_IN_FLIGHT', `sender cursor ${this.cursor} is already claimed by another operation`);
    }
    if (plan.afterCursor !== this.cursor) {
      fail('CURSOR_CONFLICT', `plan afterCursor ${plan.afterCursor} does not match sender cursor ${this.cursor}`);
    }
    this.bindings.set(plan.operationId, plan.confirmationDigest);
    const envelope = stagingEnvelope(plan.envelope);
    const recordedAt = timestamp(this.clock(), 'recordedAt');
    this.cursorClaim = Object.freeze({
      operationId: plan.operationId,
      confirmationDigest: plan.confirmationDigest,
      afterCursor: plan.afterCursor,
    });
    const attempt = (async () => {
      const remoteReceipt = await this.transport.send(clone(envelope));
      const receipt = trimReceipt(remoteReceipt, envelope, plan, recordedAt);
      this.receipts.set(plan.operationId, receipt);
      this.cursor = plan.nextCursor;
      return receipt;
    })();
    this.inFlight.set(plan.operationId, attempt);
    try {
      return clone(await attempt);
    } finally {
      this.inFlight.delete(plan.operationId);
      if (this.cursorClaim?.operationId === plan.operationId) this.cursorClaim = null;
    }
  }

  status() {
    return {
      schemaVersion: SCHEMA_VERSION,
      cursor: this.cursor,
      receiptCount: this.receipts.size,
      receipts: [...this.receipts.values()].map(clone),
    };
  }
}
