import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from './registry-identity.mjs';
import {
  recomputeZaowuyunIdempotencyKey,
  recomputeZaowuyunPayloadDigest,
  recomputeZaowuyunProjectionId,
  validateZaowuyunEnvelope,
} from './zaowuyun-adapter.mjs';
import { validateZaowuyunStagingPlan } from './zaowuyun-staging.mjs';

const STORE_SCHEMA_VERSION = 1;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROJECTION_ID = /^zyproj_[a-f0-9]{64}$/;
const CURSOR = /^(?:0|[1-9]\d*)$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const PRIVATE = /(?:candidate|principal|reviewer|storageRef|localPath|absolutePath|prompt|output|token|secret|apiKey|credential|productionUrl|privateUrl)/i;
const STATES = new Set(['prepared', 'transport_started', 'accepted', 'reconciliation_required']);
const DEFAULT_MAX_STORE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_OPERATIONS = 50_000;

export class ZaowuyunStagingStoreError extends Error {
  constructor(code, message, { cause, reconciliation } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ZaowuyunStagingStoreError';
    this.code = code;
    if (reconciliation) this.reconciliation = structuredClone(reconciliation);
  }
}

function fail(code, message, options) {
  throw new ZaowuyunStagingStoreError(code, message, options);
}

function clone(value) { return structuredClone(value); }

function positiveLimit(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) fail('INVALID_LIMIT', `${label} must be a positive safe integer`);
  return result;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function normalizeSystemTempPrefix(filePath) {
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, filePath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return path.resolve(fs.realpathSync(temporary), relative);
  }
  return filePath;
}

function containsPrivate(value) {
  if (Array.isArray(value)) return value.some(containsPrivate);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, nested]) => PRIVATE.test(key) || containsPrivate(nested));
  return typeof value === 'string' && (/^cand_/i.test(value) || /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/.test(value));
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('INVALID_OPERATION_RECORD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function revisionFor(body) {
  return canonicalDigest({
    schemaVersion: STORE_SCHEMA_VERSION,
    cursor: body.cursor,
    operations: body.operations,
  });
}

function emptyLedger() {
  const body = { schemaVersion: STORE_SCHEMA_VERSION, cursor: '0', operations: [] };
  return { ...body, revision: revisionFor(body) };
}

function safePath(filePath) {
  const parsed = path.parse(filePath);
  let current = parsed.root;
  const segments = filePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'staging store path must not contain symbolic links');
    if (current === filePath) {
      if (!stat.isFile()) fail('UNSAFE_STORE_PATH', 'staging store target must be a regular file');
    } else if (!stat.isDirectory()) {
      fail('UNSAFE_STORE_PATH', 'staging store ancestors must be directories');
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
    if (error?.code === 'EEXIST') fail('STORE_BUSY', 'staging store is locked by another writer');
    throw error;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function stagingEnvelope(dryRunEnvelope) {
  const envelope = { ...clone(dryRunEnvelope), mode: 'staging-mock' };
  envelope.idempotencyKey = recomputeZaowuyunIdempotencyKey(envelope);
  envelope.projectionId = recomputeZaowuyunProjectionId(envelope);
  envelope.payloadDigest = recomputeZaowuyunPayloadDigest(envelope);
  return validateZaowuyunEnvelope(envelope);
}

function recordFromPlan(plan, at) {
  const envelope = stagingEnvelope(plan.envelope);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    operationId: plan.operationId,
    confirmationDigest: plan.confirmationDigest,
    afterCursor: plan.afterCursor,
    nextCursor: plan.nextCursor,
    projectionId: envelope.projectionId,
    idempotencyKey: envelope.idempotencyKey,
    payloadDigest: envelope.payloadDigest,
    state: 'prepared',
    preparedAt: at,
    updatedAt: at,
  };
}

function validateReceipt(receipt, record, recordedAt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('UNSAFE_RECEIPT', 'transport receipt must be an object');
  const allowed = new Set(['projectionId', 'idempotencyKey', 'status', 'remoteRef', 'receivedAt', 'payloadDigest']);
  if (Object.keys(receipt).some(key => !allowed.has(key))) fail('UNSAFE_RECEIPT', 'transport receipt contains unsupported fields');
  if (receipt.projectionId !== record.projectionId || receipt.idempotencyKey !== record.idempotencyKey || receipt.payloadDigest !== record.payloadDigest) {
    fail('RECEIPT_MISMATCH', 'transport receipt is not bound to the prepared operation');
  }
  if (receipt.status !== 'accepted') fail('RECEIPT_REJECTED', 'transport did not accept the operation');
  if (typeof receipt.remoteRef !== 'string' || !receipt.remoteRef.trim() || receipt.remoteRef.includes('\0') || receipt.remoteRef.length > 2_000) {
    fail('UNSAFE_RECEIPT', 'transport receipt remoteRef is invalid');
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    operationId: record.operationId,
    confirmationDigest: record.confirmationDigest,
    projectionId: record.projectionId,
    idempotencyKey: record.idempotencyKey,
    payloadDigest: record.payloadDigest,
    status: 'accepted',
    remoteRefDigest: canonicalDigest({ remoteRef: receipt.remoteRef.normalize('NFC').trim() }),
    receivedAt: timestamp(receipt.receivedAt, 'receipt.receivedAt'),
    recordedAt,
    cursor: record.nextCursor,
  };
}

function reconciliationArtifact(record, reasonCode, at) {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    state: 'reconciliation_required',
    operationId: record.operationId,
    confirmationDigest: record.confirmationDigest,
    projectionId: record.projectionId,
    idempotencyKey: record.idempotencyKey,
    payloadDigest: record.payloadDigest,
    afterCursor: record.afterCursor,
    nextCursor: record.nextCursor,
    reasonCode,
    recordedAt: at,
  };
}

function publicOperation(record) {
  const result = {
    operationId: record.operationId,
    confirmationDigest: record.confirmationDigest,
    state: record.state,
    afterCursor: record.afterCursor,
    nextCursor: record.nextCursor,
    projectionId: record.projectionId,
    payloadDigest: record.payloadDigest,
    updatedAt: record.updatedAt,
  };
  if (record.receipt) result.receipt = clone(record.receipt);
  if (record.reconciliation) result.reconciliation = clone(record.reconciliation);
  return result;
}

export class ZaowuyunStagingStore {
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'staging store file path is required');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'store options must be an object');
    const unknown = Object.keys(options).filter(key => !['maxStoreBytes', 'maxRecordBytes', 'maxOperations', 'faultInjector'].includes(key));
    if (unknown.length) fail('INVALID_OPTIONS', `unknown store options: ${unknown.join(', ')}`);
    if (options.faultInjector !== undefined && typeof options.faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.filePath = normalizeSystemTempPrefix(path.resolve(filePath));
    this.maxStoreBytes = positiveLimit(options.maxStoreBytes, DEFAULT_MAX_STORE_BYTES, 'maxStoreBytes');
    this.maxRecordBytes = positiveLimit(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes');
    this.maxOperations = positiveLimit(options.maxOperations, DEFAULT_MAX_OPERATIONS, 'maxOperations');
    this.faultInjector = options.faultInjector ?? (() => {});
    safePath(this.filePath);
  }

  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_STORE', 'staging store must be an object');
    const unknown = Object.keys(data).filter(key => !['schemaVersion', 'cursor', 'operations', 'revision'].includes(key));
    if (unknown.length || data.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(data.operations)) fail('UNSUPPORTED_STORE', 'unsupported staging store format');
    if (!CURSOR.test(data.cursor ?? '') || !Number.isSafeInteger(Number(data.cursor))) fail('INVALID_CURSOR', 'staging cursor is invalid');
    if (data.operations.length > this.maxOperations) fail('OPERATION_LIMIT_EXCEEDED', 'staging operation count exceeds the hard limit');
    const ids = new Set();
    let acceptedCursor = 0;
    let unsettled = 0;
    for (const record of data.operations) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || byteLength(record) > this.maxRecordBytes) fail('RECORD_TOO_LARGE', 'staging operation record is invalid or too large');
      exactKeys(record, new Set([
        'schemaVersion', 'operationId', 'confirmationDigest', 'afterCursor', 'nextCursor',
        'projectionId', 'idempotencyKey', 'payloadDigest', 'state', 'preparedAt',
        'updatedAt', 'receipt', 'reconciliation',
      ]), 'staging operation');
      if (record.schemaVersion !== STORE_SCHEMA_VERSION || containsPrivate(record)) fail('INVALID_OPERATION_RECORD', 'staging operation contains an unsupported schema or private data');
      const requiredDigests = ['confirmationDigest', 'payloadDigest'];
      if (!OPERATION.test(record.operationId ?? '') || !PROJECTION_ID.test(record.projectionId ?? '')
          || !OPERATION.test(record.idempotencyKey ?? '')
          || requiredDigests.some(key => !DIGEST.test(record[key] ?? '')) || !STATES.has(record.state)) {
        fail('INVALID_OPERATION_RECORD', 'staging operation record is invalid');
      }
      if (ids.has(record.operationId)) fail('INVALID_OPERATION_RECORD', 'staging operationId must be unique');
      ids.add(record.operationId);
      if (!CURSOR.test(record.afterCursor ?? '') || !CURSOR.test(record.nextCursor ?? '') || Number(record.nextCursor) <= Number(record.afterCursor)) {
        fail('INVALID_OPERATION_RECORD', 'staging operation cursors are invalid');
      }
      timestamp(record.preparedAt, 'record.preparedAt');
      timestamp(record.updatedAt, 'record.updatedAt');
      if (record.state === 'accepted') {
        if (!record.receipt || record.receipt.cursor !== record.nextCursor || record.receipt.status !== 'accepted') fail('INVALID_OPERATION_RECORD', 'accepted operation requires a bound trimmed receipt');
        exactKeys(record.receipt, new Set([
          'schemaVersion', 'operationId', 'confirmationDigest', 'projectionId', 'idempotencyKey',
          'payloadDigest', 'status', 'remoteRefDigest', 'receivedAt', 'recordedAt', 'cursor',
        ]), 'trimmed receipt');
        if (record.receipt.schemaVersion !== STORE_SCHEMA_VERSION || record.receipt.operationId !== record.operationId
            || record.receipt.confirmationDigest !== record.confirmationDigest || record.receipt.projectionId !== record.projectionId
            || record.receipt.idempotencyKey !== record.idempotencyKey || record.receipt.payloadDigest !== record.payloadDigest
            || !DIGEST.test(record.receipt.remoteRefDigest ?? '')) fail('INVALID_OPERATION_RECORD', 'accepted receipt is not bound to its operation');
        timestamp(record.receipt.receivedAt, 'receipt.receivedAt');
        timestamp(record.receipt.recordedAt, 'receipt.recordedAt');
        acceptedCursor = Math.max(acceptedCursor, Number(record.nextCursor));
      } else {
        if (record.receipt !== undefined) fail('INVALID_OPERATION_RECORD', 'unaccepted operation cannot contain a receipt');
        unsettled += 1;
      }
      if (record.state === 'reconciliation_required' && (!record.reconciliation || record.reconciliation.operationId !== record.operationId)) {
        fail('INVALID_OPERATION_RECORD', 'reconciliation operation requires an artifact');
      }
      if (record.state === 'reconciliation_required') {
        exactKeys(record.reconciliation, new Set([
          'schemaVersion', 'state', 'operationId', 'confirmationDigest', 'projectionId',
          'idempotencyKey', 'payloadDigest', 'afterCursor', 'nextCursor', 'reasonCode', 'recordedAt',
        ]), 'reconciliation artifact');
        if (record.reconciliation.schemaVersion !== STORE_SCHEMA_VERSION
            || record.reconciliation.state !== 'reconciliation_required'
            || record.reconciliation.confirmationDigest !== record.confirmationDigest
            || record.reconciliation.projectionId !== record.projectionId
            || record.reconciliation.idempotencyKey !== record.idempotencyKey
            || record.reconciliation.payloadDigest !== record.payloadDigest
            || record.reconciliation.afterCursor !== record.afterCursor
            || record.reconciliation.nextCursor !== record.nextCursor
            || !OPERATION.test(record.reconciliation.reasonCode ?? '')) fail('INVALID_OPERATION_RECORD', 'reconciliation artifact is not bound to its operation');
        timestamp(record.reconciliation.recordedAt, 'reconciliation.recordedAt');
      } else if (record.reconciliation !== undefined) {
        fail('INVALID_OPERATION_RECORD', 'non-reconciliation operation cannot contain a reconciliation artifact');
      }
    }
    if (unsettled > 1 || String(acceptedCursor) !== data.cursor) fail('INVALID_STORE_STATE', 'staging cursor or unsettled operation state is inconsistent');
    const expected = revisionFor(data);
    if (data.revision !== expected) fail('REVISION_MISMATCH', 'staging store revision does not match its contents');
    return clone({ schemaVersion: STORE_SCHEMA_VERSION, cursor: data.cursor, operations: data.operations, revision: expected });
  }

  read() {
    safePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return emptyLedger();
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'staging store target must be a regular file');
    if (stat.size > this.maxStoreBytes) fail('STORE_TOO_LARGE', 'staging store exceeds the hard size limit');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (error) { fail('INVALID_STORE', 'staging store is not valid JSON', { cause: error }); }
    return this.validate(parsed);
  }

  #write(data, phase = 'beforeRename') {
    const body = { schemaVersion: STORE_SCHEMA_VERSION, cursor: data.cursor, operations: data.operations };
    const validated = this.validate({ ...body, revision: revisionFor(body) });
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxStoreBytes) fail('STORE_TOO_LARGE', 'staging store exceeds the hard size limit');
    safePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    safePath(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.validate(JSON.parse(fs.readFileSync(temporary, 'utf8')));
      this.faultInjector(phase, { operationCount: validated.operations.length, revision: validated.revision });
      if (phase !== 'beforeRename') this.faultInjector('beforeRename', { operationCount: validated.operations.length, revision: validated.revision });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    return validated;
  }

  mutate(mutator, phase) {
    safePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    safePath(this.filePath);
    const releaseLock = acquireLock(this.filePath);
    try {
      const current = this.read();
      const next = mutator(clone(current));
      if (next === current || next === undefined) return current;
      return this.#write(next, phase);
    } finally {
      releaseLock();
    }
  }

  prepare(planInput, { confirmationDigest, at } = {}) {
    const plan = validateZaowuyunStagingPlan(planInput);
    if (!DIGEST.test(confirmationDigest ?? '') || confirmationDigest !== plan.confirmationDigest) fail('CONFIRMATION_MISMATCH', 'exact confirmationDigest is required');
    const preparedAt = timestamp(at, 'at');
    let outcome;
    this.mutate(ledger => {
      const existing = ledger.operations.find(row => row.operationId === plan.operationId);
      if (existing) {
        if (existing.confirmationDigest !== plan.confirmationDigest) fail('OPERATION_CONFLICT', 'operationId is bound to another confirmation digest');
        outcome = clone(existing);
        return undefined;
      }
      if (ledger.operations.some(row => row.state !== 'accepted')) fail('CURSOR_IN_FLIGHT', 'another staging operation is unsettled');
      if (plan.afterCursor !== ledger.cursor) fail('CURSOR_CONFLICT', 'plan afterCursor does not match persisted staging cursor');
      if (ledger.operations.length >= this.maxOperations) fail('OPERATION_LIMIT_EXCEEDED', 'staging operation count exceeds the hard limit');
      const record = recordFromPlan(plan, preparedAt);
      if (byteLength(record) > this.maxRecordBytes) fail('RECORD_TOO_LARGE', 'staging operation record exceeds the hard size limit');
      ledger.operations.push(record);
      outcome = clone(record);
      return ledger;
    }, 'beforePrepareCommit');
    return outcome;
  }

  startTransport(operationId, at) {
    let outcome;
    this.mutate(ledger => {
      const record = ledger.operations.find(row => row.operationId === operationId);
      if (!record) fail('OPERATION_NOT_FOUND', 'staging operation does not exist');
      if (record.state !== 'prepared') { outcome = { action: 'existing', record: clone(record) }; return undefined; }
      record.state = 'transport_started';
      record.updatedAt = timestamp(at, 'at');
      outcome = { action: 'started', record: clone(record) };
      return ledger;
    }, 'beforeTransportStartCommit');
    return outcome;
  }

  commitAccepted(operationId, remoteReceipt, at) {
    let outcome;
    this.mutate(ledger => {
      const record = ledger.operations.find(row => row.operationId === operationId);
      if (!record) fail('OPERATION_NOT_FOUND', 'staging operation does not exist');
      if (record.state === 'accepted') { outcome = clone(record.receipt); return undefined; }
      if (record.state !== 'transport_started') fail('INVALID_OPERATION_STATE', 'operation was not marked transport_started');
      const recordedAt = timestamp(at, 'at');
      const receipt = validateReceipt(remoteReceipt, record, recordedAt);
      record.state = 'accepted';
      record.receipt = receipt;
      record.updatedAt = recordedAt;
      ledger.cursor = record.nextCursor;
      outcome = clone(receipt);
      return ledger;
    }, 'beforeCommitAccepted');
    return outcome;
  }

  requireReconciliation(operationId, reasonCode, at) {
    let artifact;
    this.mutate(ledger => {
      const record = ledger.operations.find(row => row.operationId === operationId);
      if (!record) fail('OPERATION_NOT_FOUND', 'staging operation does not exist');
      if (record.state === 'accepted') fail('INVALID_OPERATION_STATE', 'accepted operation cannot enter reconciliation');
      if (record.state === 'reconciliation_required') { artifact = clone(record.reconciliation); return undefined; }
      const recordedAt = timestamp(at, 'at');
      artifact = reconciliationArtifact(record, reasonCode, recordedAt);
      record.state = 'reconciliation_required';
      record.reconciliation = artifact;
      record.updatedAt = recordedAt;
      return ledger;
    }, 'beforeReconciliationCommit');
    return artifact;
  }

  operation(operationId) {
    return clone(this.read().operations.find(row => row.operationId === operationId) ?? null);
  }

  status() {
    const ledger = this.read();
    const operations = ledger.operations.map(publicOperation);
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      cursor: ledger.cursor,
      revision: ledger.revision,
      receiptCount: operations.filter(row => row.state === 'accepted').length,
      reconciliationRequiredCount: operations.filter(row => row.state === 'reconciliation_required' || row.state === 'transport_started').length,
      operations,
    };
  }
}

export class PersistentZaowuyunStagingSender {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_OPTIONS', 'sender options must be an object');
    const unknown = Object.keys(options).filter(key => !['store', 'transport', 'clock'].includes(key));
    if (unknown.length) fail('INVALID_OPTIONS', `unknown sender options: ${unknown.join(', ')}`);
    if (!(options.store instanceof ZaowuyunStagingStore)) fail('STORE_REQUIRED', 'a ZaowuyunStagingStore is required');
    if (!options.transport || typeof options.transport !== 'object' || typeof options.transport.send !== 'function') fail('TRANSPORT_REQUIRED', 'transport.send must be a function');
    if (options.clock !== undefined && typeof options.clock !== 'function') fail('INVALID_CLOCK', 'clock must be a function');
    this.store = options.store;
    this.transport = options.transport;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  now() { return timestamp(this.clock(), 'clock'); }

  async send(planInput, { confirmationDigest } = {}) {
    const plan = validateZaowuyunStagingPlan(planInput);
    const prepared = this.store.prepare(plan, { confirmationDigest, at: this.now() });
    if (prepared.state === 'accepted') return clone(prepared.receipt);
    if (prepared.state === 'transport_started' || prepared.state === 'reconciliation_required') {
      let artifact = prepared.reconciliation;
      if (!artifact) {
        try { artifact = this.store.requireReconciliation(plan.operationId, 'INTERRUPTED_AFTER_TRANSPORT_START', this.now()); } catch { artifact = reconciliationArtifact(prepared, 'INTERRUPTED_AFTER_TRANSPORT_START', this.now()); }
      }
      fail('RECONCILIATION_REQUIRED', 'operation outcome is uncertain; blind resend is blocked', { reconciliation: artifact });
    }
    const claim = this.store.startTransport(plan.operationId, this.now());
    if (claim.action !== 'started') {
      const existing = claim.record;
      if (existing.state === 'accepted') return clone(existing.receipt);
      let artifact = existing.reconciliation;
      if (!artifact) {
        try { artifact = this.store.requireReconciliation(plan.operationId, 'CONCURRENT_OR_INTERRUPTED_TRANSPORT', this.now()); }
        catch { artifact = reconciliationArtifact(existing, 'CONCURRENT_OR_INTERRUPTED_TRANSPORT', this.now()); }
      }
      fail('RECONCILIATION_REQUIRED', 'operation transport is already claimed; blind resend is blocked', { reconciliation: artifact });
    }
    const started = claim.record;
    const outbound = stagingEnvelope(plan.envelope);
    let remoteReceipt;
    try {
      remoteReceipt = await this.transport.send(clone(outbound));
    } catch (error) {
      let artifact;
      try { artifact = this.store.requireReconciliation(plan.operationId, 'TRANSPORT_OUTCOME_UNKNOWN', this.now()); }
      catch { artifact = reconciliationArtifact(started, 'TRANSPORT_OUTCOME_UNKNOWN', this.now()); }
      fail('RECONCILIATION_REQUIRED', 'transport outcome is uncertain; blind resend is blocked', { cause: error, reconciliation: artifact });
    }
    try {
      return this.store.commitAccepted(plan.operationId, remoteReceipt, this.now());
    } catch (error) {
      let artifact;
      try { artifact = this.store.requireReconciliation(plan.operationId, 'LOCAL_COMMIT_AFTER_ACCEPT_FAILED', this.now()); }
      catch { artifact = reconciliationArtifact(started, 'LOCAL_COMMIT_AFTER_ACCEPT_FAILED', this.now()); }
      fail('RECONCILIATION_REQUIRED', 'remote acceptance could not be committed locally; reconciliation is required', { cause: error, reconciliation: artifact });
    }
  }
}
