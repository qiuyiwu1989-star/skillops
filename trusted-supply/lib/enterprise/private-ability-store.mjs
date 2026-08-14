import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../registry-identity.mjs';
import {
  PRIVATE_ABILITY_SCHEMA_VERSION,
  PrivateAbilityError,
  assessPrivateReleaseEvidence,
  createPrivateProduct,
  createPrivateRelease,
  normalizeDerivativeSourceEvidence,
  normalizePrivateProduct,
  normalizePrivateRelease,
  normalizePrivateReleaseEvidence,
} from './private-ability.mjs';

const MAX_EVENTS = 100_000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const EVENT_TYPES = new Set(['private_product.created', 'private_release.created', 'private_release.evidence_assessed']);
const EMPTY_REVISION = canonicalDigest({ schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, events: [] });
const ORGANIZATION_ID = /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

export class PrivateAbilityStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PrivateAbilityStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PrivateAbilityStoreError(code, message, cause);
}

function clone(value) { return structuredClone(value); }

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
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

function trustedNow(now) {
  if (typeof now !== 'function') fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let value;
  try { value = now(); } catch (cause) { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause); }
  return timestamp(value instanceof Date ? value.toISOString() : value, 'trusted.now');
}

function authorizedOrganization(authorizer, purpose) {
  if (typeof authorizer !== 'function') fail('ORGANIZATION_AUTHORIZER_REQUIRED', 'trusted organization authorizer is required');
  let decision;
  try { decision = authorizer({ purpose }); } catch (cause) { fail('ORGANIZATION_AUTHORIZER_FAILED', 'trusted organization authorizer failed', cause); }
  if (!decision || typeof decision !== 'object' || decision.decision !== 'allow') fail('ORGANIZATION_FORBIDDEN', 'organization projection is not authorized');
  if (typeof decision.organizationId !== 'string' || !ORGANIZATION_ID.test(decision.organizationId)) fail('ORGANIZATION_AUTHORIZATION_INVALID', 'organization authorization is invalid');
  return decision.organizationId;
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
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'private ability Store path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) fail('UNSAFE_STORE_PATH', 'private ability Store path is unsafe');
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'private ability Store is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function createEvent(type, occurredAt, payload) {
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported private ability event: ${type}`);
  const body = { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, type, occurredAt: timestamp(occurredAt, 'event.occurredAt'), payload: clone(payload) };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_EVENT_BYTES) fail('EVENT_TOO_LARGE', 'private ability event exceeds hard size limit');
  return deepFreeze({ ...body, eventId: `privevt_${canonicalDigest(body).slice(7)}` });
}

function normalizeEvent(input) {
  exactKeys(input, new Set(['schemaVersion', 'type', 'occurredAt', 'payload', 'eventId']), 'privateAbilityEvent');
  if (input.schemaVersion !== PRIVATE_ABILITY_SCHEMA_VERSION || !EVENT_TYPES.has(input.type)) fail('UNKNOWN_EVENT_TYPE', 'private ability event is unsupported');
  let payload;
  try {
    if (input.type === 'private_product.created') {
      exactKeys(input.payload, new Set(['product']), 'privateProductEventPayload');
      payload = { product: normalizePrivateProduct(input.payload.product) };
    } else if (input.type === 'private_release.created') {
      exactKeys(input.payload, new Set(['release']), 'privateReleaseEventPayload');
      payload = { release: normalizePrivateRelease(input.payload.release) };
    } else {
      exactKeys(input.payload, new Set(['evidence']), 'privateEvidenceEventPayload');
      payload = { evidence: normalizePrivateReleaseEvidence(input.payload.evidence) };
    }
  } catch (cause) {
    if (cause instanceof PrivateAbilityError) fail('INVALID_EVENT_PAYLOAD', cause.message, cause);
    throw cause;
  }
  const event = createEvent(input.type, input.occurredAt, payload);
  if (event.eventId !== input.eventId) fail('EVENT_ID_MISMATCH', 'private ability event identity is invalid');
  return event;
}

function emptyProjection() {
  return {
    schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
    products: {},
    releases: {},
    releasesByProduct: {},
    evidence: {},
    productIdentityLocks: {},
    versionLocks: {},
  };
}

function applyEvent(projection, event) {
  if (event.type === 'private_product.created') {
    const product = event.payload.product;
    const identity = `${product.organizationId}\0${product.skillId}\0${product.productKey}`;
    const locked = projection.productIdentityLocks[identity];
    if (locked && locked !== product.privateProductId) fail('PRIVATE_PRODUCT_IDENTITY_CONFLICT', 'private Product identity is already locked');
    const existing = projection.products[product.privateProductId];
    if (existing && existing.productDigest !== product.productDigest) fail('PRIVATE_PRODUCT_CONFLICT', 'private Product ID is bound to different content');
    projection.productIdentityLocks[identity] = product.privateProductId;
    projection.products[product.privateProductId] = clone(product);
    projection.releasesByProduct[product.privateProductId] ??= [];
    return;
  }
  if (event.type === 'private_release.created') {
    const release = event.payload.release;
    const product = projection.products[release.privateProductId];
    if (!product || product.organizationId !== release.organizationId || product.sourceType !== release.sourceType) {
      fail('PRIVATE_PRODUCT_REQUIRED', 'private Release requires its exact prior private Product');
    }
    const history = projection.releasesByProduct[release.privateProductId] ?? [];
    const expectedPrevious = history.at(-1) ?? null;
    if (release.previousPrivateReleaseId !== expectedPrevious) fail('PRIVATE_RELEASE_CHAIN_CONFLICT', 'private Release must extend the current immutable Release');
    const versionKey = `${release.privateProductId}\0${release.version}`;
    const locked = projection.versionLocks[versionKey];
    if (locked && locked !== release.privateReleaseId) fail('PRIVATE_VERSION_IMMUTABLE', 'private Product version is already bound to another package');
    const existing = projection.releases[release.privateReleaseId];
    if (existing && existing.releaseDigest !== release.releaseDigest) fail('PRIVATE_RELEASE_CONFLICT', 'private Release ID is bound to different content');
    projection.versionLocks[versionKey] = release.privateReleaseId;
    projection.releases[release.privateReleaseId] = clone(release);
    history.push(release.privateReleaseId);
    projection.releasesByProduct[release.privateProductId] = history;
    return;
  }
  const evidence = event.payload.evidence;
  const release = projection.releases[evidence.privateReleaseId];
  if (!release || release.organizationId !== evidence.organizationId
    || release.privateProductId !== evidence.privateProductId
    || release.packageDigest !== evidence.packageDigest
    || release.packageManifestDigest !== evidence.packageManifestDigest) {
    fail('PRIVATE_RELEASE_REQUIRED', 'evidence requires its exact prior private Release');
  }
  const previous = projection.evidence[evidence.privateReleaseId];
  if (previous && Date.parse(evidence.assessedAt) < Date.parse(previous.assessedAt)) fail('EVIDENCE_TIME_REGRESSION', 'evidence assessment time must be monotonic');
  projection.evidence[evidence.privateReleaseId] = clone(evidence);
}

export function replayPrivateAbilityEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', 'private ability event log is invalid or too large');
  const projection = emptyProjection();
  const ids = new Set();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const raw of events) {
    const event = normalizeEvent(raw);
    const time = Date.parse(event.occurredAt);
    if (time < previousTime) fail('EVENT_TIME_REGRESSION', 'private ability event time must be monotonic');
    previousTime = time;
    if (ids.has(event.eventId)) fail('DUPLICATE_EVENT', 'private ability event log contains a duplicate');
    ids.add(event.eventId);
    applyEvent(projection, event);
  }
  return projection;
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, events });
}

function safeStoreStatus(revision, eventCount) {
  const body = { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, revision, eventCount };
  return { ...body, statusDigest: canonicalDigest(body) };
}

function effectiveEvidence(evidence, at) {
  if (!evidence || evidence.status !== 'callable') return { status: 'evidence_pending', gaps: evidence?.gaps ?? ['evidence_missing'] };
  const expired = Object.entries(evidence.evidence).filter(([, item]) => item?.validUntil && Date.parse(item.validUntil) <= Date.parse(at));
  if (expired.length) return { status: 'evidence_pending', gaps: expired.map(([type]) => `${type}_expired`).sort() };
  return { status: 'callable', gaps: [] };
}

function sourceState(product, resolver, at) {
  if (product.sourceType === 'self_authored') return { status: 'active', publicationStatus: null };
  if (typeof resolver !== 'function') fail('SOURCE_STATUS_RESOLVER_REQUIRED', 'authorized derivative projection requires trusted source status resolver');
  let raw;
  try {
    raw = resolver({ organizationId: product.organizationId, privateProductId: product.privateProductId, sourceEvidence: clone(product.sourceEvidence), at });
  } catch (cause) {
    fail('SOURCE_STATUS_RESOLVER_FAILED', 'trusted source status resolver failed', cause);
  }
  if (!raw) return { status: 'blocked', reason: 'source_status_missing', publicationStatus: null };
  try {
    const current = normalizeDerivativeSourceEvidence(raw, {
      organizationId: product.organizationId,
      privateProductId: product.privateProductId,
      evidenceRef: product.sourceEvidence.evidenceRef,
      baseProductId: product.sourceEvidence.baseProductId,
      baseReleaseId: product.sourceEvidence.baseReleaseId,
      entitlementId: product.sourceEvidence.entitlementId,
      entitlementDigest: product.sourceEvidence.entitlementDigest,
      licenseSnapshotDigest: product.sourceEvidence.licenseSnapshotDigest,
      lineageDigest: product.sourceEvidence.lineageDigest,
    }, { at, forNewRelease: false });
    return { status: 'active', publicationStatus: current.publicationStatus };
  } catch (cause) {
    if (['SOURCE_RELEASE_BLOCKED', 'SOURCE_ENTITLEMENT_BLOCKED', 'SOURCE_ENTITLEMENT_EXPIRED'].includes(cause.code)) {
      return { status: 'blocked', reason: cause.code.toLowerCase(), publicationStatus: raw.publicationStatus ?? null };
    }
    throw cause;
  }
}

function organizationProjection(projection, organizationId, sourceStatusResolver, at) {
  const products = Object.values(projection.products).filter(product => product.organizationId === organizationId).map(product => {
    const source = sourceState(product, sourceStatusResolver, at);
    const releases = (projection.releasesByProduct[product.privateProductId] ?? []).map(id => {
      const release = projection.releases[id];
      const evidence = effectiveEvidence(projection.evidence[id], at);
      const status = source.status === 'blocked' ? 'blocked' : evidence.status;
      return {
        privateReleaseId: id,
        version: release.version,
        packageDigest: release.packageDigest,
        packageManifestDigest: release.packageManifestDigest,
        previousPrivateReleaseId: release.previousPrivateReleaseId,
        status,
        evidenceGaps: source.status === 'blocked' ? [source.reason] : evidence.gaps,
        evidence: projection.evidence[id] ? clone(projection.evidence[id]) : null,
        createdAt: release.createdAt,
        nextAction: status === 'callable' ? '可在企业能力库使用' : status === 'blocked' ? '进入人工处置' : '补齐测试与组织复核',
      };
    });
    return {
      privateProductId: product.privateProductId,
      skillId: product.skillId,
      productKey: product.productKey,
      titleZh: product.titleZh,
      summaryZh: product.summaryZh,
      sourceType: product.sourceType,
      sourceEvidence: clone(product.sourceEvidence),
      sourceStatus: source,
      currentPrivateReleaseId: releases.at(-1)?.privateReleaseId ?? null,
      status: releases.at(-1)?.status ?? (source.status === 'blocked' ? 'blocked' : 'evidence_pending'),
      releases,
      createdAt: product.createdAt,
    };
  }).sort((a, b) => a.privateProductId.localeCompare(b.privateProductId));
  const allReleases = products.flatMap(product => product.releases);
  const summary = {
    products: products.length,
    releases: allReleases.length,
    callable: allReleases.filter(release => release.status === 'callable').length,
    evidencePending: allReleases.filter(release => release.status === 'evidence_pending').length,
    blocked: allReleases.filter(release => release.status === 'blocked').length,
  };
  const body = { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, organizationId, generatedAt: at, summary, products };
  return deepFreeze({ ...body, projectionDigest: canonicalDigest(body) });
}

export class PrivateAbilityStore {
  #filePath;
  #faultInjector;

  constructor(filePath, { faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'private ability Store path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.#filePath = systemTempPath(filePath);
    this.#faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.#filePath);
  }

  #read() {
    assertSafePath(this.#filePath);
    if (!fs.existsSync(this.#filePath)) return { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.#filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail('UNSAFE_STORE_PATH', 'private ability Store is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'private ability Store is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'privateAbilityStore');
    if (value.schemaVersion !== PRIVATE_ABILITY_SCHEMA_VERSION || !Array.isArray(value.events)) fail('UNSUPPORTED_STORE', 'private ability Store schema is unsupported');
    replayPrivateAbilityEvents(value.events);
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'private ability Store revision is invalid');
    return { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, revision, events: clone(value.events) };
  }

  #write(value) {
    assertSafePath(this.#filePath);
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.#filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) fail('STORE_TOO_LARGE', 'private ability Store exceeds hard size limit');
    const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.#faultInjector('beforeRename', { revision: value.revision });
      fs.renameSync(temporary, this.#filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  #append(event, expectedRevision) {
    assertSafePath(this.#filePath);
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.#filePath);
    const release = acquireLock(this.#filePath);
    try {
      const current = this.#read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match private ability Store');
      const normalized = normalizeEvent(event);
      const same = current.events.find(item => item.eventId === normalized.eventId);
      if (same) return { action: 'unchanged', ...safeStoreStatus(current.revision, current.events.length) };
      const events = [...current.events, normalized];
      replayPrivateAbilityEvents(events);
      const next = { schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.#read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'private ability Store commit could not be verified');
      return { action: 'appended', ...safeStoreStatus(committed.revision, committed.events.length) };
    } finally {
      release();
    }
  }

  #snapshot() {
    return replayPrivateAbilityEvents(this.#read().events);
  }

  status() {
    const current = this.#read();
    return deepFreeze(safeStoreStatus(current.revision, current.events.length));
  }

  createProduct(input, options = {}) {
    const product = createPrivateProduct(input, options);
    const event = createEvent('private_product.created', product.createdAt, { product });
    const result = this.#append(event, options.expectedRevision);
    return deepFreeze({ ...result, product: clone(product) });
  }

  createRelease(input, options = {}) {
    const current = this.#read();
    if (options.expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match private ability Store');
    const projection = replayPrivateAbilityEvents(current.events);
    const release = createPrivateRelease(input, {
      ...options,
      privateProductResolver: id => projection.products[id] ?? null,
      previousPrivateReleaseResolver: id => projection.releases[id] ?? null,
    });
    const event = createEvent('private_release.created', release.createdAt, { release });
    const result = this.#append(event, options.expectedRevision);
    return deepFreeze({ ...result, release: clone(release) });
  }

  assessEvidence(input, options = {}) {
    const current = this.#read();
    if (options.expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match private ability Store');
    const projection = replayPrivateAbilityEvents(current.events);
    const evidence = assessPrivateReleaseEvidence(input, {
      ...options,
      privateReleaseResolver: id => projection.releases[id] ?? null,
    });
    const event = createEvent('private_release.evidence_assessed', evidence.assessedAt, { evidence });
    const result = this.#append(event, options.expectedRevision);
    return deepFreeze({ ...result, evidence: clone(evidence) });
  }

  projectOrganization({ organizationAuthorizer, sourceStatusResolver, now } = {}) {
    const organizationId = authorizedOrganization(organizationAuthorizer, 'enterprise.private_ability.read');
    const at = trustedNow(now);
    return organizationProjection(this.#snapshot(), organizationId, sourceStatusResolver, at);
  }

  projectPublic() {
    const projection = this.#snapshot();
    const products = Object.values(projection.products);
    const body = {
      schemaVersion: PRIVATE_ABILITY_SCHEMA_VERSION,
      summary: {
        organizations: new Set(products.map(product => product.organizationId)).size,
        products: products.length,
        releases: Object.keys(projection.releases).length,
        selfAuthored: products.filter(product => product.sourceType === 'self_authored').length,
        authorizedDerivatives: products.filter(product => product.sourceType === 'authorized_derivative').length,
      },
    };
    return deepFreeze({ ...body, projectionDigest: canonicalDigest(body) });
  }

  createOrganizationResolver({ organizationAuthorizer } = {}) {
    const organizationId = authorizedOrganization(organizationAuthorizer, 'enterprise.private_ability.resolve');
    const store = this;
    const reauthorize = () => {
      const current = authorizedOrganization(organizationAuthorizer, 'enterprise.private_ability.resolve');
      if (current !== organizationId) fail('ORGANIZATION_SCOPE_MISMATCH', 'organization resolver scope changed');
      return current;
    };
    return deepFreeze({
      organizationId,
      resolvePrivateProduct(privateProductId) {
        reauthorize();
        const product = store.#snapshot().products[privateProductId];
        return product?.organizationId === organizationId ? clone(product) : null;
      },
      resolvePrivateRelease(privateReleaseId) {
        reauthorize();
        const release = store.#snapshot().releases[privateReleaseId];
        return release?.organizationId === organizationId ? clone(release) : null;
      },
    });
  }
}
