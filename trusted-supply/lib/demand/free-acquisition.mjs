import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMERCE_SCHEMA_VERSION,
  ORGANIZATION_ID,
  PRODUCT_ID,
  RELEASE_ID,
  SAFE_IDENTIFIER,
  clone,
  deepFreeze,
  digest,
  exactKeys,
  fail,
  text,
  timestamp,
  uniqueStrings,
} from '../commerce/common.mjs';
import { issueEntitlement, normalizeEntitlement } from '../commerce/entitlement.mjs';
import { createMarketEvent, replayMarketEvents } from '../commerce/market-ledger.mjs';
import { createFreeOrder, normalizeFreeOrder } from '../commerce/order.mjs';

const STORE_SCHEMA_VERSION = 1;
const EMPTY_REVISION = digest({ schemaVersion: STORE_SCHEMA_VERSION, operations: [] });
const MAX_OPERATIONS = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;
const OFFER_REVISION_ID = /^offrev_[a-f0-9]{64}$/;
const OPERATION_ID = /^acq_[a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

const REQUEST_KEYS = new Set([
  'schemaVersion', 'organizationId', 'productId', 'releaseIds', 'offerRevisionId', 'idempotencyKey',
]);

export class AcquisitionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AcquisitionError';
    this.code = code;
  }
}

function acquisitionFail(code, message, cause) {
  throw new AcquisitionError(code, message, cause);
}

function normalizeRequest(input) {
  try {
    exactKeys(input, REQUEST_KEYS, 'freeAcquisitionRequest');
    const schemaVersion = input.schemaVersion ?? COMMERCE_SCHEMA_VERSION;
    if (schemaVersion !== COMMERCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'free acquisition schema is unsupported');
    return deepFreeze({
      schemaVersion,
      organizationId: text(input.organizationId, 'freeAcquisitionRequest.organizationId', { maximum: 99, pattern: ORGANIZATION_ID }),
      productId: text(input.productId, 'freeAcquisitionRequest.productId', { maximum: 69, pattern: PRODUCT_ID }),
      releaseIds: uniqueStrings(input.releaseIds, 'freeAcquisitionRequest.releaseIds', { pattern: RELEASE_ID, nonEmpty: true }),
      offerRevisionId: text(input.offerRevisionId, 'freeAcquisitionRequest.offerRevisionId', { maximum: 71, pattern: OFFER_REVISION_ID }),
      idempotencyKey: text(input.idempotencyKey, 'freeAcquisitionRequest.idempotencyKey', { maximum: 128, pattern: SAFE_IDENTIFIER }),
    });
  } catch (cause) {
    acquisitionFail(cause.code ?? 'INVALID_REQUEST', cause.message, cause);
  }
}

function trustedNow(now) {
  if (typeof now !== 'function') acquisitionFail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  try {
    const value = now();
    return timestamp(value instanceof Date ? value.toISOString() : value, 'trusted.now');
  } catch (cause) {
    acquisitionFail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause);
  }
}

function trustedPublicationResolver(resolver) {
  if (!resolver || typeof resolver !== 'object'
    || typeof resolver.resolveOrderProduct !== 'function'
    || typeof resolver.resolveOrderRelease !== 'function') {
    acquisitionFail('PUBLICATION_RESOLVER_REQUIRED', 'trusted Publication resolver is required');
  }
  return resolver;
}

function trustedOfferResolver(resolver) {
  if (typeof resolver !== 'function') acquisitionFail('OFFER_RESOLVER_REQUIRED', 'trusted Offer resolver is required');
  return resolver;
}

function authorizeOrganization(authorizer, request) {
  if (typeof authorizer !== 'function') {
    acquisitionFail('ORGANIZATION_AUTHORIZER_REQUIRED', 'trusted organization authorizer is required');
  }
  let decision;
  try { decision = authorizer({ purpose: 'market.free_acquisition' }); } catch (cause) {
    acquisitionFail('ORGANIZATION_AUTHORIZER_FAILED', 'trusted organization authorizer failed', cause);
  }
  if (!decision || typeof decision !== 'object' || decision.decision !== 'allow') {
    acquisitionFail('ORGANIZATION_FORBIDDEN', 'organization is not authorized for free acquisition');
  }
  let organizationId;
  try {
    organizationId = text(decision.organizationId, 'organizationAuthorization.organizationId', { maximum: 99, pattern: ORGANIZATION_ID });
  } catch (cause) {
    acquisitionFail('ORGANIZATION_AUTHORIZATION_INVALID', cause.message, cause);
  }
  if (organizationId !== request.organizationId) {
    acquisitionFail('ORGANIZATION_SCOPE_MISMATCH', 'authorized organization does not match the acquisition request');
  }
  return organizationId;
}

function deterministicOrderId(request) {
  return `ord_free_${digest(request).slice(7, 55)}`;
}

function operationBody(request, order, entitlement, committedAt) {
  const marketEvents = [
    createMarketEvent({ type: 'order.granted', occurredAt: committedAt, payload: order }),
    createMarketEvent({ type: 'entitlement.issued', occurredAt: committedAt, payload: entitlement }),
  ];
  replayMarketEvents(marketEvents);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    type: 'acquisition.committed',
    committedAt,
    acquisitionRequest: clone(request),
    acquisitionRequestDigest: digest(request),
    order: clone(order),
    entitlement: clone(entitlement),
    marketEvents: clone(marketEvents),
  };
}

function createOperation(request, order, entitlement, committedAt) {
  const body = operationBody(request, order, entitlement, committedAt);
  return deepFreeze({ ...body, operationId: `acq_${digest(body).slice(7)}`, operationDigest: digest(body) });
}

function normalizeOperation(input) {
  try {
    exactKeys(input, new Set([
      'schemaVersion', 'type', 'committedAt', 'acquisitionRequest', 'acquisitionRequestDigest',
      'order', 'entitlement', 'marketEvents', 'operationId', 'operationDigest',
    ]), 'acquisitionOperation');
    if (input.schemaVersion !== STORE_SCHEMA_VERSION || input.type !== 'acquisition.committed') {
      acquisitionFail('UNSUPPORTED_OPERATION', 'acquisition operation is unsupported');
    }
    const request = normalizeRequest(input.acquisitionRequest);
    const order = normalizeFreeOrder(input.order);
    const entitlement = normalizeEntitlement(input.entitlement);
    const committedAt = timestamp(input.committedAt, 'acquisitionOperation.committedAt');
    if (input.acquisitionRequestDigest !== digest(request)) acquisitionFail('REQUEST_DIGEST_MISMATCH', 'acquisition request digest is invalid');
    if (order.organizationId !== request.organizationId || order.productId !== request.productId
      || order.offerRevisionId !== request.offerRevisionId
      || digest(order.releaseScope.releaseIds) !== digest(request.releaseIds)
      || order.idempotencyKey !== request.idempotencyKey
      || order.orderId !== deterministicOrderId(request)) {
      acquisitionFail('ORDER_REQUEST_MISMATCH', 'stored Order is not bound to the acquisition request');
    }
    if (entitlement.sourceOrderId !== order.orderId || entitlement.sourceOrderDigest !== order.orderDigest
      || entitlement.organizationId !== request.organizationId || entitlement.productId !== request.productId) {
      acquisitionFail('ENTITLEMENT_ORDER_MISMATCH', 'stored Entitlement is not bound to the exact Order');
    }
    if (order.orderedAt !== committedAt || entitlement.issuedAt !== committedAt) {
      acquisitionFail('OPERATION_TIME_MISMATCH', 'Order and Entitlement must use the operation commit time');
    }
    const expected = createOperation(request, order, entitlement, committedAt);
    if (!OPERATION_ID.test(input.operationId) || input.operationId !== expected.operationId
      || !HASH.test(input.operationDigest) || input.operationDigest !== expected.operationDigest
      || digest(input.marketEvents) !== digest(expected.marketEvents)) {
      acquisitionFail('OPERATION_DIGEST_MISMATCH', 'acquisition operation identity or market events are invalid');
    }
    return expected;
  } catch (cause) {
    if (cause instanceof AcquisitionError) throw cause;
    acquisitionFail(cause.code ?? 'INVALID_OPERATION', cause.message, cause);
  }
}

function replayOperations(operations) {
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) {
    acquisitionFail('OPERATION_LIMIT_EXCEEDED', 'acquisition operation log is invalid or too large');
  }
  const normalized = [];
  const ids = new Set();
  const requestKeys = new Map();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const raw of operations) {
    const operation = normalizeOperation(raw);
    if (ids.has(operation.operationId)) acquisitionFail('DUPLICATE_OPERATION', 'acquisition operation log contains a duplicate');
    if (Date.parse(operation.committedAt) < previousTime) acquisitionFail('OPERATION_TIME_REGRESSION', 'acquisition operation time must be monotonic');
    previousTime = Date.parse(operation.committedAt);
    ids.add(operation.operationId);
    const key = `${operation.acquisitionRequest.organizationId}\0${operation.acquisitionRequest.idempotencyKey}`;
    const previous = requestKeys.get(key);
    if (previous && previous !== operation.acquisitionRequestDigest) {
      acquisitionFail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another acquisition request');
    }
    if (previous) acquisitionFail('DUPLICATE_IDEMPOTENCY_OPERATION', 'idempotent acquisition was committed more than once');
    requestKeys.set(key, operation.acquisitionRequestDigest);
    normalized.push(operation);
  }
  const marketEvents = normalized.flatMap(operation => operation.marketEvents);
  const projection = replayMarketEvents(marketEvents);
  const body = {
    ...projection,
    acquisitionSchemaVersion: STORE_SCHEMA_VERSION,
    acquisitionRevision: revisionFor(normalized),
    operations: normalized.map(operation => ({
      operationId: operation.operationId,
      operationDigest: operation.operationDigest,
      acquisitionRequestDigest: operation.acquisitionRequestDigest,
      organizationId: operation.acquisitionRequest.organizationId,
      idempotencyKey: operation.acquisitionRequest.idempotencyKey,
      orderId: operation.order.orderId,
      entitlementId: operation.entitlement.entitlementId,
      committedAt: operation.committedAt,
    })),
    marketEvents,
  };
  return deepFreeze({ ...body, marketProjectionDigest: digest(body) });
}

function revisionFor(operations) {
  return digest({ schemaVersion: STORE_SCHEMA_VERSION, operations });
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
    if (stat.isSymbolicLink()) acquisitionFail('UNSAFE_STORE_PATH', 'acquisition ledger path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) {
      acquisitionFail('UNSAFE_STORE_PATH', 'acquisition ledger path is not a safe regular-file path');
    }
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (cause) {
    if (cause?.code === 'EEXIST') acquisitionFail('STORE_BUSY', 'acquisition ledger is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

export class AcquisitionLedger {
  constructor(filePath, { faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      acquisitionFail('STORE_PATH_REQUIRED', 'acquisition ledger path is required');
    }
    if (faultInjector !== undefined && typeof faultInjector !== 'function') {
      acquisitionFail('INVALID_OPTIONS', 'faultInjector must be a function');
    }
    this.filePath = systemTempPath(filePath);
    this.faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.filePath);
  }

  read() {
    assertSafePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return { schemaVersion: STORE_SCHEMA_VERSION, revision: EMPTY_REVISION, operations: [] };
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) acquisitionFail('UNSAFE_STORE_PATH', 'acquisition ledger target is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (cause) {
      acquisitionFail('INVALID_STORE', 'acquisition ledger is not valid JSON', cause);
    }
    try { exactKeys(value, new Set(['schemaVersion', 'revision', 'operations']), 'acquisitionLedger'); } catch (cause) {
      acquisitionFail(cause.code ?? 'INVALID_STORE', cause.message, cause);
    }
    if (value.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(value.operations)) acquisitionFail('UNSUPPORTED_STORE', 'acquisition ledger schema is unsupported');
    replayOperations(value.operations);
    const revision = revisionFor(value.operations);
    if (value.revision !== revision) acquisitionFail('REVISION_MISMATCH', 'acquisition ledger revision does not match its operations');
    return { schemaVersion: STORE_SCHEMA_VERSION, revision, operations: clone(value.operations) };
  }

  #write(value) {
    const parent = path.dirname(this.filePath);
    assertSafePath(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) acquisitionFail('STORE_TOO_LARGE', 'acquisition ledger exceeds the hard size limit');
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.faultInjector('beforeRename', { revision: value.revision });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  acquire(input, { expectedRevision, offerResolver, publicationResolver, organizationAuthorizer, now } = {}) {
    const request = normalizeRequest(input);
    authorizeOrganization(organizationAuthorizer, request);
    const trustedPublication = trustedPublicationResolver(publicationResolver);
    const trustedOffer = trustedOfferResolver(offerResolver);
    assertSafePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const release = acquireLock(this.filePath);
    try {
      const current = this.read();
      if (expectedRevision !== current.revision) acquisitionFail('REVISION_CONFLICT', 'expectedRevision does not match the acquisition ledger');
      const projection = replayOperations(current.operations);
      const key = `${request.organizationId}\0${request.idempotencyKey}`;
      const prior = current.operations.map(normalizeOperation).find(operation => (
        `${operation.acquisitionRequest.organizationId}\0${operation.acquisitionRequest.idempotencyKey}` === key
      ));
      if (prior) {
        if (prior.acquisitionRequestDigest !== digest(request)) acquisitionFail('IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another acquisition request');
        return deepFreeze({
          action: 'unchanged', revision: current.revision, operation: clone(prior),
          order: clone(prior.order), entitlement: clone(prior.entitlement), projection,
        });
      }
      const committedAt = trustedNow(now);
      const order = createFreeOrder({
        orderId: deterministicOrderId(request),
        organizationId: request.organizationId,
        productId: request.productId,
        releaseScope: { releaseIds: request.releaseIds },
        offerRevisionId: request.offerRevisionId,
        idempotencyKey: request.idempotencyKey,
      }, {
        offerResolver: trustedOffer,
        productResolver: productId => trustedPublication.resolveOrderProduct(productId),
        releaseResolver: releaseId => trustedPublication.resolveOrderRelease(releaseId),
        now: () => committedAt,
      });
      const entitlement = issueEntitlement({ order, issuedAt: committedAt });
      const operation = createOperation(request, order, entitlement, committedAt);
      const operations = [...current.operations, operation];
      const nextProjection = replayOperations(operations);
      const next = { schemaVersion: STORE_SCHEMA_VERSION, revision: revisionFor(operations), operations };
      this.#write(next);
      const committed = this.read();
      if (committed.revision !== next.revision) acquisitionFail('COMMIT_VERIFICATION_FAILED', 'acquisition commit could not be verified');
      return deepFreeze({
        action: 'committed', revision: committed.revision, operation: clone(operation),
        order: clone(order), entitlement: clone(entitlement), projection: nextProjection,
      });
    } catch (cause) {
      if (cause instanceof AcquisitionError) throw cause;
      acquisitionFail(cause.code ?? 'ACQUISITION_REJECTED', cause.message, cause);
    } finally {
      release();
    }
  }

  project() {
    return replayOperations(this.read().operations);
  }

  resolveProjection(acquisitionRevision) {
    if (typeof acquisitionRevision !== 'string' || !HASH.test(acquisitionRevision)) {
      acquisitionFail('INVALID_REVISION', 'acquisition revision is invalid');
    }
    const projection = this.project();
    return projection.acquisitionRevision === acquisitionRevision ? clone(projection) : null;
  }

  resolveEntitlement(entitlementId) {
    const projection = this.project();
    const lifecycle = projection.entitlementLifecycle[entitlementId];
    if (!lifecycle || lifecycle.status !== 'active') return null;
    return clone(projection.entitlements[entitlementId]);
  }
}
