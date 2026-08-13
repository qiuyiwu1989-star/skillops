import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest, normalizeRelease } from '../registry-identity.mjs';
import {
  createApplicationProduct,
  createApplicationRelease,
  createPublisher,
  createSkillProduct,
  toPublicMarketValue,
} from './domain.mjs';

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 100_000;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const EMPTY_REVISION = canonicalDigest({ schemaVersion: SCHEMA_VERSION, events: [] });
const EVENT_TYPES = new Set([
  'publisher.registered',
  'product.registered',
  'application_release.published',
]);
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export class MarketRegistryError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MarketRegistryError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new MarketRegistryError(code, message, cause);
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

function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  return normalized;
}

function reference(value, label) {
  const normalized = text(value, label);
  if (!REFERENCE.test(normalized) || /^cand_/i.test(normalized)) fail('INVALID_REFERENCE', `${label} is not a safe stable reference`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(normalized)).toISOString();
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
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'market registry path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) {
      fail('UNSAFE_STORE_PATH', 'market registry path is not a safe regular-file path');
    }
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'market registry is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: SCHEMA_VERSION, events });
}

function assertPublisherReferences(product, projection) {
  const ids = [
    product.publisherId,
    ...product.parties.creatorPublisherIds,
    product.parties.rightsHolderPublisherId,
    product.parties.payeePublisherId,
    product.parties.supportPublisherId,
  ].filter(Boolean);
  for (const publisherId of new Set(ids)) {
    const publisher = projection.publishers[publisherId];
    if (!publisher) fail('PUBLISHER_NOT_REGISTERED', `publisher ${publisherId} is not registered`);
    if (publisher.status !== 'active') fail('PUBLISHER_NOT_ACTIVE', `publisher ${publisherId} is not active`);
  }
}

function normalizePublicationAuthorization(input, expected) {
  exactKeys(input, new Set([
    'decision', 'publisherId', 'skillId', 'releaseId', 'authorityRef', 'policyVersion', 'authorizedAt',
    'authorizationDigest',
  ]), 'publication authorization');
  const authorization = {
    decision: text(input.decision, 'publication authorization decision', 16),
    publisherId: text(input.publisherId, 'publication authorization publisherId', 128),
    skillId: text(input.skillId, 'publication authorization skillId', 128),
    releaseId: text(input.releaseId, 'publication authorization releaseId', 128),
    authorityRef: reference(input.authorityRef, 'publication authorization authorityRef'),
    policyVersion: reference(input.policyVersion, 'publication authorization policyVersion'),
    authorizedAt: timestamp(input.authorizedAt, 'publication authorization authorizedAt'),
  };
  if (authorization.decision !== 'allow') fail('PUBLICATION_NOT_AUTHORIZED', 'trusted publication authority denied this registration');
  for (const key of ['publisherId', 'skillId', 'releaseId']) {
    if (authorization[key] !== expected[key]) fail('PUBLICATION_AUTHORIZATION_MISMATCH', `publication authorization ${key} does not match`);
  }
  const authorizationDigest = canonicalDigest(authorization);
  if (input.authorizationDigest !== undefined && input.authorizationDigest !== authorizationDigest) {
    fail('PUBLICATION_AUTHORIZATION_TAMPERED', 'publication authorization digest does not match');
  }
  return Object.freeze({ ...authorization, authorizationDigest });
}

function createEvent(type, occurredAt, payload) {
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported market registry event type: ${type}`);
  const body = { schemaVersion: SCHEMA_VERSION, type, occurredAt: timestamp(occurredAt, 'event.occurredAt'), payload: clone(payload) };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) fail('EVENT_TOO_LARGE', 'market registry event exceeds the hard size limit');
  return Object.freeze({ ...body, eventId: `mkreg_${canonicalDigest(body).slice('sha256:'.length)}` });
}

function emptyProjection() {
  return {
    schemaVersion: SCHEMA_VERSION,
    publishers: {},
    products: {},
    applicationReleases: {},
    applicationVersionLocks: {},
  };
}

function applyEvent(projection, event) {
  if (event.type === 'publisher.registered') {
    const publisher = event.payload.publisher;
    const prior = projection.publishers[publisher.publisherId];
    if (prior && prior.publisherDigest !== publisher.publisherDigest) fail('PUBLISHER_CONFLICT', 'publisher identity is already bound to different content');
    projection.publishers[publisher.publisherId] = clone(publisher);
    return;
  }
  if (event.type === 'product.registered') {
    const product = event.payload.product;
    assertPublisherReferences(product, projection);
    if (product.abilityType === 'skill') {
      const authorization = event.payload.publicationAuthorization;
      if (!authorization || authorization.decision !== 'allow'
        || authorization.publisherId !== product.publisherId
        || authorization.skillId !== product.skillId
        || authorization.releaseId !== product.releaseId) {
        fail('PUBLICATION_AUTHORIZATION_MISMATCH', 'Skill Product is missing matching publication authority evidence');
      }
    } else if (event.payload.publicationAuthorization !== null) {
      fail('UNEXPECTED_PUBLICATION_AUTHORIZATION', 'Application Product registration must not contain Skill publication evidence');
    }
    const prior = projection.products[product.productId];
    if (prior && prior.productDigest !== product.productDigest) fail('PRODUCT_CONFLICT', 'product identity is already bound to different content');
    projection.products[product.productId] = clone(product);
    return;
  }
  const release = event.payload.applicationRelease;
  const product = projection.products[release.productId];
  if (!product || product.abilityType !== 'application' || product.applicationId !== release.applicationId) {
    fail('APPLICATION_PRODUCT_NOT_REGISTERED', 'Application Release requires its registered Application Product');
  }
  for (const dependency of release.bom) {
    const skillProduct = projection.products[dependency.productId];
    if (!skillProduct || skillProduct.abilityType !== 'skill'
      || skillProduct.skillId !== dependency.skillId || skillProduct.releaseId !== dependency.releaseId) {
      fail('BOM_PRODUCT_MISMATCH', 'Application Release BOM does not match a registered Skill Product');
    }
  }
  const prior = projection.applicationReleases[release.applicationReleaseId];
  if (prior && prior.releaseDigest !== release.releaseDigest) fail('APPLICATION_RELEASE_CONFLICT', 'Application Release identity is already bound to different content');
  const versionKey = `${release.applicationId}\0${release.version}`;
  const locked = projection.applicationVersionLocks[versionKey];
  if (locked && locked !== release.applicationReleaseId) {
    fail('APPLICATION_VERSION_IMMUTABLE', 'applicationId+version is already bound to another immutable release');
  }
  projection.applicationVersionLocks[versionKey] = release.applicationReleaseId;
  projection.applicationReleases[release.applicationReleaseId] = clone(release);
}

function normalizeEvent(input) {
  exactKeys(input, new Set(['schemaVersion', 'type', 'occurredAt', 'payload', 'eventId']), 'market registry event');
  if (input.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `event schemaVersion must be ${SCHEMA_VERSION}`);
  if (!EVENT_TYPES.has(input.type)) fail('UNKNOWN_EVENT_TYPE', `unsupported market registry event type: ${input.type}`);
  let payload;
  if (input.type === 'publisher.registered') {
    exactKeys(input.payload, new Set(['publisher']), 'publisher event payload');
    // This revalidates the stored digest and strips nothing from the internal evidence.
    toPublicMarketValue(input.payload.publisher);
    payload = { publisher: clone(input.payload.publisher) };
  } else if (input.type === 'product.registered') {
    exactKeys(input.payload, new Set(['product', 'publicationAuthorization']), 'product event payload');
    toPublicMarketValue(input.payload.product);
    if (input.payload.product.abilityType === 'skill') {
      const authorization = normalizePublicationAuthorization(input.payload.publicationAuthorization, input.payload.product);
      if (authorization.authorizationDigest !== input.payload.publicationAuthorization.authorizationDigest) {
        fail('PUBLICATION_AUTHORIZATION_TAMPERED', 'publication authorization digest does not match');
      }
      payload = { product: clone(input.payload.product), publicationAuthorization: clone(authorization) };
    } else {
      if (input.payload.publicationAuthorization !== null) fail('UNEXPECTED_PUBLICATION_AUTHORIZATION', 'Application Product must not contain publication evidence');
      payload = { product: clone(input.payload.product), publicationAuthorization: null };
    }
  } else {
    exactKeys(input.payload, new Set(['applicationRelease']), 'Application Release event payload');
    toPublicMarketValue(input.payload.applicationRelease);
    payload = { applicationRelease: clone(input.payload.applicationRelease) };
  }
  const event = createEvent(input.type, input.occurredAt, payload);
  if (input.eventId !== event.eventId) fail('EVENT_ID_MISMATCH', 'market registry eventId does not match its content');
  return event;
}

function replay(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', 'market registry event log is invalid or too large');
  const projection = emptyProjection();
  const ids = new Set();
  let priorTime = Number.NEGATIVE_INFINITY;
  for (const input of events) {
    const event = normalizeEvent(input);
    const eventTime = Date.parse(event.occurredAt);
    if (eventTime < priorTime) fail('EVENT_TIME_REGRESSION', 'market registry event time must be monotonic');
    priorTime = eventTime;
    if (ids.has(event.eventId)) fail('DUPLICATE_EVENT', 'market registry contains a duplicate event');
    ids.add(event.eventId);
    applyEvent(projection, event);
  }
  return projection;
}

function publicProjection(projection) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    publishers: Object.freeze(Object.fromEntries(Object.entries(projection.publishers).map(([id, value]) => [id, toPublicMarketValue(value)]))),
    products: Object.freeze(Object.fromEntries(Object.entries(projection.products).map(([id, value]) => [id, toPublicMarketValue(value)]))),
    applicationReleases: Object.freeze(Object.fromEntries(Object.entries(projection.applicationReleases).map(([id, value]) => [id, toPublicMarketValue(value)]))),
  });
}

export class MarketRegistry {
  constructor(filePath, { faultInjector } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'market registry file path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    this.filePath = systemTempPath(filePath);
    this.faultInjector = faultInjector ?? (() => {});
    assertSafePath(this.filePath);
  }

  #read() {
    assertSafePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return { schemaVersion: SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail('UNSAFE_STORE_PATH', 'market registry target is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'market registry is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'market registry store');
    if (value.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_STORE', 'market registry store schema is unsupported');
    replay(value.events);
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'market registry revision does not match its events');
    return { schemaVersion: SCHEMA_VERSION, revision, events: clone(value.events) };
  }

  #write(value) {
    const parent = path.dirname(this.filePath);
    assertSafePath(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) fail('STORE_TOO_LARGE', 'market registry exceeds the hard size limit');
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.faultInjector('beforeRename', { revision: value.revision });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  #append(event, expectedRevision) {
    assertSafePath(this.filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const releaseLock = acquireLock(this.filePath);
    try {
      const current = this.#read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match the market registry');
      const existing = current.events.find(item => item.eventId === event.eventId);
      if (existing) return { action: 'unchanged', revision: current.revision };
      const events = [...current.events, event];
      replay(events);
      const next = { schemaVersion: SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.#read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'market registry commit could not be verified');
      return { action: 'appended', revision: committed.revision };
    } finally {
      releaseLock();
    }
  }

  snapshot() {
    const state = this.#read();
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, revision: state.revision, eventCount: state.events.length });
  }

  project() {
    return publicProjection(replay(this.#read().events));
  }

  resolvePublisher({ publisherId }) {
    return this.project().publishers[publisherId] ?? null;
  }

  resolveProduct({ productId }) {
    return this.project().products[productId] ?? null;
  }

  resolveOrderProduct(productId) {
    const product = this.project().products[productId];
    return product ? Object.freeze({ productId, status: 'published' }) : null;
  }

  resolveOrderRelease(releaseId) {
    const product = Object.values(this.project().products).find(value => (
      value.abilityType === 'skill' && value.releaseId === releaseId
    ));
    return product ? Object.freeze({ releaseId, productId: product.productId, status: 'published' }) : null;
  }

  resolveApplicationRelease({ applicationReleaseId }) {
    return this.project().applicationReleases[applicationReleaseId] ?? null;
  }

  registerPublisher(input, { trustOptions, expectedRevision } = {}) {
    let publisher;
    try { publisher = createPublisher(input, trustOptions); } catch (cause) { fail('PUBLISHER_REJECTED', cause.message, cause); }
    const event = createEvent('publisher.registered', publisher.createdAt, { publisher });
    return { ...this.#append(event, expectedRevision), publisher: toPublicMarketValue(publisher) };
  }

  registerSkillProduct(input, { resolveRegistryRelease, authorizePublication, expectedRevision } = {}) {
    if (typeof resolveRegistryRelease !== 'function') fail('RELEASE_RESOLVER_REQUIRED', 'resolveRegistryRelease must be a function');
    if (typeof authorizePublication !== 'function') fail('PUBLICATION_AUTHORITY_REQUIRED', 'authorizePublication must be a trusted function');
    const internal = replay(this.#read().events);
    let release;
    try { release = normalizeRelease(resolveRegistryRelease({ skillId: input?.skillId, releaseId: input?.releaseId })); } catch (cause) {
      fail('REGISTRY_RELEASE_REJECTED', 'Skill Product requires a canonical Registry Release', cause);
    }
    let product;
    try { product = createSkillProduct(input, { registryRelease: release }); } catch (cause) { fail('PRODUCT_REJECTED', cause.message, cause); }
    assertPublisherReferences(product, internal);
    let rawAuthorization;
    try { rawAuthorization = authorizePublication({ publisherId: product.publisherId, skillId: product.skillId, releaseId: product.releaseId }); } catch (cause) {
      fail('PUBLICATION_AUTHORITY_FAILED', 'trusted publication authority failed', cause);
    }
    const publicationAuthorization = normalizePublicationAuthorization(rawAuthorization, product);
    const event = createEvent('product.registered', product.createdAt, { product, publicationAuthorization });
    return { ...this.#append(event, expectedRevision), product: toPublicMarketValue(product) };
  }

  registerApplicationProduct(input, { expectedRevision } = {}) {
    const internal = replay(this.#read().events);
    let product;
    try { product = createApplicationProduct(input); } catch (cause) { fail('PRODUCT_REJECTED', cause.message, cause); }
    assertPublisherReferences(product, internal);
    const event = createEvent('product.registered', product.createdAt, { product, publicationAuthorization: null });
    return { ...this.#append(event, expectedRevision), product: toPublicMarketValue(product) };
  }

  publishApplicationRelease(input, { resolveRegistryRelease, expectedRevision } = {}) {
    if (typeof resolveRegistryRelease !== 'function') fail('RELEASE_RESOLVER_REQUIRED', 'resolveRegistryRelease must be a function');
    const internal = replay(this.#read().events);
    const product = internal.products[input?.productId];
    if (!product || product.abilityType !== 'application') fail('APPLICATION_PRODUCT_NOT_REGISTERED', 'Application Product is not registered');
    let applicationRelease;
    try {
      applicationRelease = createApplicationRelease(input, {
        applicationProduct: product,
        resolveRegistryRelease: identity => {
          const resolved = normalizeRelease(resolveRegistryRelease(identity));
          if (resolved.skillId !== identity.skillId || resolved.releaseId !== identity.releaseId) {
            fail('REGISTRY_BINDING_MISMATCH', 'Registry resolver returned a different Skill Release');
          }
          return resolved;
        },
        resolveSkillProduct: identity => internal.products[identity.productId] ?? null,
      });
    } catch (cause) {
      if (cause instanceof MarketRegistryError) throw cause;
      fail('APPLICATION_RELEASE_REJECTED', cause.message, cause);
    }
    const event = createEvent('application_release.published', applicationRelease.publishedAt, { applicationRelease });
    return { ...this.#append(event, expectedRevision), applicationRelease: toPublicMarketValue(applicationRelease) };
  }
}
