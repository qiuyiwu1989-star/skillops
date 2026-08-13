import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../registry-identity.mjs';
import {
  CREATOR_WORKSPACE_SCHEMA_VERSION,
  CreatorWorkspaceError,
  createCreatorWorkspace,
  createDraftRevision,
  normalizeCreatorWorkspace,
  normalizeDraftRevision,
} from './creator-workspace.mjs';

const MAX_EVENTS = 100_000;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const EMPTY_REVISION = canonicalDigest({ schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, events: [] });
const EVENT_TYPES = new Set(['workspace.created', 'draft.saved']);

export class CreatorWorkspaceStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CreatorWorkspaceStoreError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new CreatorWorkspaceStoreError(code, message, cause);
}

function clone(value) { return structuredClone(value); }

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
    if (stat.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'creator workspace path must not contain symbolic links');
    if (current === filePath ? !stat.isFile() : !stat.isDirectory()) {
      fail('UNSAFE_STORE_PATH', 'creator workspace path is not a safe regular-file path');
    }
  }
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch (cause) {
    if (cause?.code === 'EEXIST') fail('STORE_BUSY', 'creator workspace store is locked by another writer');
    throw cause;
  }
  return () => {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  };
}

function revisionFor(events) {
  return canonicalDigest({ schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, events });
}

function createEvent(type, occurredAt, payload) {
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported creator event type: ${type}`);
  const body = { schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, type, occurredAt: timestamp(occurredAt, 'event.occurredAt'), payload: clone(payload) };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_EVENT_BYTES) fail('EVENT_TOO_LARGE', 'creator event exceeds the hard size limit');
  return Object.freeze({ ...body, eventId: `crevt_${canonicalDigest(body).slice('sha256:'.length)}` });
}

function normalizeEvent(input) {
  exactKeys(input, new Set(['schemaVersion', 'type', 'occurredAt', 'payload', 'eventId']), 'creatorEvent');
  if (input.schemaVersion !== CREATOR_WORKSPACE_SCHEMA_VERSION || !EVENT_TYPES.has(input.type)) fail('UNKNOWN_EVENT_TYPE', 'creator event is unsupported');
  let payload;
  try {
    if (input.type === 'workspace.created') {
      exactKeys(input.payload, new Set(['workspace']), 'workspace event payload');
      payload = { workspace: normalizeCreatorWorkspace(input.payload.workspace) };
    } else {
      exactKeys(input.payload, new Set(['draft']), 'draft event payload');
      payload = { draft: normalizeDraftRevision(input.payload.draft) };
    }
  } catch (cause) {
    if (cause instanceof CreatorWorkspaceError) fail('INVALID_EVENT_PAYLOAD', cause.message, cause);
    throw cause;
  }
  const event = createEvent(input.type, input.occurredAt, payload);
  if (input.eventId !== event.eventId) fail('EVENT_ID_MISMATCH', 'creator eventId does not match its content');
  return event;
}

function emptyProjection() {
  return {
    schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION,
    workspaces: {},
    drafts: {},
    identityLocks: {},
  };
}

function applyEvent(projection, event) {
  if (event.type === 'workspace.created') {
    const workspace = event.payload.workspace;
    const identity = `${workspace.publisherId}\0${workspace.abilityType}\0${workspace.productKey}`;
    const locked = projection.identityLocks[identity];
    if (locked && locked !== workspace.workId) fail('PRODUCT_KEY_CONFLICT', 'Publisher already has another work for this abilityType and productKey');
    const prior = projection.workspaces[workspace.workId];
    if (prior && prior.workspaceDigest !== workspace.workspaceDigest) fail('WORKSPACE_CONFLICT', 'workId is bound to different immutable content');
    projection.identityLocks[identity] = workspace.workId;
    projection.workspaces[workspace.workId] = clone(workspace);
    projection.drafts[workspace.workId] ??= [];
    return;
  }
  const draft = event.payload.draft;
  const workspace = projection.workspaces[draft.workId];
  if (!workspace) fail('WORKSPACE_REQUIRED', 'draft requires its previously created workspace');
  for (const key of ['publisherId', 'productId', 'abilityType', 'productKey']) {
    if (draft[key] !== workspace[key]) fail('DRAFT_WORKSPACE_MISMATCH', `draft ${key} does not match its workspace`);
  }
  const history = projection.drafts[draft.workId] ?? [];
  const expectedRevision = history.length + 1;
  if (draft.draftRevision !== expectedRevision) fail('DRAFT_SEQUENCE_GAP', `draftRevision must be ${expectedRevision}`);
  if (history.length && Date.parse(draft.savedAt) < Date.parse(history.at(-1).savedAt)) fail('DRAFT_TIME_REGRESSION', 'draft savedAt must be monotonic');
  history.push(clone(draft));
  projection.drafts[draft.workId] = history;
}

export function replayCreatorWorkspaceEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('EVENT_LIMIT_EXCEEDED', 'creator event log is invalid or too large');
  const projection = emptyProjection();
  const ids = new Set();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const input of events) {
    const event = normalizeEvent(input);
    const eventTime = Date.parse(event.occurredAt);
    if (eventTime < previousTime) fail('EVENT_TIME_REGRESSION', 'creator event time must be monotonic');
    previousTime = eventTime;
    if (ids.has(event.eventId)) fail('DUPLICATE_EVENT', 'creator event log contains a duplicate event');
    ids.add(event.eventId);
    applyEvent(projection, event);
  }
  return projection;
}

function creatorProjection(projection, publisherId) {
  const workspaces = Object.values(projection.workspaces).filter(workspace => workspace.publisherId === publisherId);
  const works = workspaces.map(workspace => {
    const history = projection.drafts[workspace.workId] ?? [];
    const current = history.at(-1) ?? null;
    return {
      workId: workspace.workId,
      productId: workspace.productId,
      abilityType: workspace.abilityType,
      productKey: workspace.productKey,
      titleZh: current?.metadata.titleZh ?? null,
      summaryZh: current?.metadata.summaryZh ?? null,
      currentDraftRevision: current?.draftRevision ?? 0,
      currentDraftDigest: current?.draftDigest ?? null,
      target: current ? clone(current.target) : null,
      status: 'draft',
      visibility: 'private',
      reviewGaps: ['not_submitted'],
      nextAction: current ? '提交发布审核' : '完善作品草稿',
      updatedAt: current?.savedAt ?? workspace.createdAt,
      timeline: history.map(draft => ({
        draftRevision: draft.draftRevision,
        draftDigest: draft.draftDigest,
        savedAt: draft.savedAt,
        titleZh: draft.metadata.titleZh,
      })),
      rightsDeclaration: current ? clone(current.rightsDeclaration) : null,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.workId.localeCompare(right.workId));
  return Object.freeze({
    schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION,
    publisherId,
    summary: Object.freeze({ works: works.length, drafts: works.filter(work => work.status === 'draft').length }),
    works: Object.freeze(works.map(work => Object.freeze(work))),
  });
}

export class CreatorWorkspaceStore {
  constructor(filePath, { faultInjector, creatorProjectionAuthorizer } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) fail('STORE_PATH_REQUIRED', 'creator workspace store path is required');
    if (faultInjector !== undefined && typeof faultInjector !== 'function') fail('INVALID_OPTIONS', 'faultInjector must be a function');
    if (creatorProjectionAuthorizer !== undefined && typeof creatorProjectionAuthorizer !== 'function') {
      fail('INVALID_OPTIONS', 'creatorProjectionAuthorizer must be a trusted function');
    }
    this.filePath = systemTempPath(filePath);
    this.faultInjector = faultInjector ?? (() => {});
    this.creatorProjectionAuthorizer = creatorProjectionAuthorizer ?? null;
    assertSafePath(this.filePath);
  }

  read() {
    assertSafePath(this.filePath);
    if (!fs.existsSync(this.filePath)) return { schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, revision: EMPTY_REVISION, events: [] };
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail('UNSAFE_STORE_PATH', 'creator workspace store is unsafe or too large');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', 'creator workspace store is not valid JSON', cause); }
    exactKeys(value, new Set(['schemaVersion', 'revision', 'events']), 'creatorWorkspaceStore');
    if (value.schemaVersion !== CREATOR_WORKSPACE_SCHEMA_VERSION || !Array.isArray(value.events)) fail('UNSUPPORTED_STORE', 'creator workspace store schema is unsupported');
    replayCreatorWorkspaceEvents(value.events);
    const revision = revisionFor(value.events);
    if (revision !== value.revision) fail('REVISION_MISMATCH', 'creator workspace revision does not match its events');
    return { schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, revision, events: clone(value.events) };
  }

  #write(value) {
    const parent = path.dirname(this.filePath);
    assertSafePath(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertSafePath(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) fail('STORE_TOO_LARGE', 'creator workspace store exceeds the hard size limit');
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
      const current = this.read();
      if (expectedRevision !== current.revision) fail('REVISION_CONFLICT', 'expectedRevision does not match the creator workspace store');
      const existing = current.events.find(item => item.eventId === event.eventId);
      if (existing) return { action: 'unchanged', event: clone(existing), revision: current.revision };
      const events = [...current.events, event];
      replayCreatorWorkspaceEvents(events);
      const next = { schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, revision: revisionFor(events), events };
      this.#write(next);
      const committed = this.read();
      if (committed.revision !== next.revision) fail('COMMIT_VERIFICATION_FAILED', 'creator workspace commit could not be verified');
      return { action: 'appended', event: clone(event), revision: committed.revision };
    } finally {
      releaseLock();
    }
  }

  snapshot() {
    const value = this.read();
    return Object.freeze({ schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, revision: value.revision, eventCount: value.events.length });
  }

  createWorkspace(input, { expectedRevision, resolvePublisher, resolveProduct } = {}) {
    let workspace;
    try { workspace = createCreatorWorkspace(input, { resolvePublisher, resolveProduct }); } catch (cause) {
      fail('WORKSPACE_REJECTED', cause.message, cause);
    }
    const event = createEvent('workspace.created', workspace.createdAt, { workspace });
    return { ...this.#append(event, expectedRevision), workspace: clone(workspace) };
  }

  saveDraft(input, {
    expectedRevision, resolvePublisher, resolveProduct, resolveRegistryRelease, resolveApplicationRelease,
  } = {}) {
    const projection = replayCreatorWorkspaceEvents(this.read().events);
    const workspace = projection.workspaces[input?.workId];
    if (!workspace) fail('WORKSPACE_NOT_FOUND', 'draft workspace was not found');
    const history = projection.drafts[workspace.workId] ?? [];
    let draft;
    try {
      const trustedOptions = {
        workspace,
        resolvePublisher,
        resolveProduct,
        resolveRegistryRelease,
        resolveApplicationRelease,
      };
      if (history.length) {
        const replayCandidate = createDraftRevision(input, {
          ...trustedOptions,
          previousDraft: history.at(-2) ?? null,
        });
        if (replayCandidate.draftDigest === history.at(-1).draftDigest) {
          const replayEvent = createEvent('draft.saved', replayCandidate.savedAt, { draft: replayCandidate });
          return { ...this.#append(replayEvent, expectedRevision), draft: clone(replayCandidate) };
        }
      }
      draft = createDraftRevision(input, {
        ...trustedOptions,
        previousDraft: history.at(-1) ?? null,
      });
    } catch (cause) {
      fail('DRAFT_REJECTED', cause.message, cause);
    }
    const event = createEvent('draft.saved', draft.savedAt, { draft });
    return { ...this.#append(event, expectedRevision), draft: clone(draft) };
  }

  projectCreator({ publisherId } = {}) {
    if (typeof publisherId !== 'string' || !/^pub_[a-f0-9]{64}$/.test(publisherId)) fail('INVALID_PUBLISHER_ID', 'publisherId is invalid');
    if (typeof this.creatorProjectionAuthorizer !== 'function') {
      fail('CREATOR_PROJECTION_AUTHORITY_REQUIRED', 'creator projection requires a trusted authorizer');
    }
    let authorization;
    try { authorization = this.creatorProjectionAuthorizer(Object.freeze({ publisherId })); } catch (cause) {
      fail('CREATOR_PROJECTION_AUTHORITY_FAILED', 'creator projection authorization failed', cause);
    }
    const allowed = authorization === true
      || (authorization && typeof authorization === 'object' && !Array.isArray(authorization)
        && authorization.decision === 'allow' && authorization.publisherId === publisherId);
    if (!allowed) fail('CREATOR_PROJECTION_FORBIDDEN', 'creator projection access was denied');
    return creatorProjection(replayCreatorWorkspaceEvents(this.read().events), publisherId);
  }

  projectPublic() {
    return Object.freeze({ schemaVersion: CREATOR_WORKSPACE_SCHEMA_VERSION, works: Object.freeze([]) });
  }
}
