import { canonicalDigest, normalizeRelease, normalizeSkillId } from './registry-identity.mjs';

const SCHEMA = 'zaowuyun.ability.skill.v1';
const MODES = new Set(['dry-run', 'staging-mock']);
const ACTIONS = Object.freeze({
  'release.published': 'upsert',
  'listing.upserted': 'upsert',
  'release.withdrawn': 'withdraw',
  'listing.withdrawn': 'withdraw',
  'release.superseded': 'supersede',
  'release.revoked': 'revoke',
});
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const EVENT_ID = /^evt_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_KEY = /(?:candidate|storageRef|localPath|absolutePath|reviewer|principal|prompt|output|token|apiKey|credential|privateUrl)/i;

export class ZaowuyunAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZaowuyunAdapterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ZaowuyunAdapterError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('INVALID_TEXT', `${label} is invalid or too long`);
  return normalized;
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(parsed)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.startsWith('file://'));
}

function safeValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(typeof item === 'string' && (/^cand_/i.test(item) || isAbsolutePath(item))))
      .map(safeValue);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) continue;
      if (typeof nested === 'string' && (/^cand_/i.test(nested) || isAbsolutePath(nested))) continue;
      result[key] = safeValue(nested);
    }
    return result;
  }
  return value;
}

function assertSafe(value, label = 'projection') {
  if (findPrivateData(value)) fail('PRIVATE_DATA_FORBIDDEN', `${label} contains private Registry data`);
}

function findPrivateData(value) {
  if (Array.isArray(value)) return value.some(findPrivateData);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, nested]) => PRIVATE_KEY.test(key) || findPrivateData(nested));
  }
  return typeof value === 'string' && (/^cand_/i.test(value) || isAbsolutePath(value));
}

function normalizeEvent(input) {
  const event = object(input, 'event');
  if (event.schemaVersion !== 1) fail('UNSUPPORTED_REGISTRY_SCHEMA', 'Registry event schemaVersion must be 1');
  if (!ACTIONS[event.type]) fail('UNSUPPORTED_REGISTRY_EVENT', `unsupported Registry event type: ${event.type}`);
  if (!EVENT_ID.test(event.eventId ?? '')) fail('INVALID_EVENT_ID', 'eventId must be a generated Registry event ID');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) fail('INVALID_SEQUENCE', 'event sequence must be a positive integer');
  const payload = object(event.payload, 'event.payload');
  if (!DIGEST.test(event.payloadDigest ?? '') || canonicalDigest(payload) !== event.payloadDigest) {
    fail('REGISTRY_PAYLOAD_DIGEST_MISMATCH', 'Registry payloadDigest does not match event payload');
  }
  return event;
}

function eventReleaseId(event) {
  const result = event.subject?.releaseId ?? event.payload?.releaseId ?? event.payload?.release?.releaseId;
  if (!RELEASE_ID.test(result ?? '')) fail('INVALID_RELEASE_ID', 'Registry event must identify a Release');
  return result;
}

function releaseFor(event, options) {
  const source = options.release ?? event.payload.release;
  if (!source) fail('RELEASE_REQUIRED', 'a complete Registry Release is required to build the projection');
  let release;
  try {
    release = normalizeRelease(source);
  } catch (error) {
    fail(error.code ?? 'INVALID_RELEASE', error.message);
  }
  if (release.releaseId !== eventReleaseId(event)) fail('RELEASE_ID_MISMATCH', 'Release does not match Registry event subject');
  const eventSkillId = event.subject?.skillId ?? event.payload?.skillId;
  if (eventSkillId && release.skillId !== normalizeSkillId(eventSkillId)) fail('SKILL_ID_MISMATCH', 'Release does not match Registry event skillId');
  if (event.type === 'release.published' && event.payload.release) {
    const eventRelease = safeValue(event.payload.release);
    const expectedRelease = safeValue(release);
    if (canonicalDigest(eventRelease) !== canonicalDigest(expectedRelease)) {
      fail('REGISTRY_RELEASE_MISMATCH', 'Registry publication payload does not match the supplied immutable Release');
    }
  }
  return release;
}

function localized(value, locale, fallback = '') {
  if (typeof value === 'string') return value.normalize('NFC').trim();
  if (!value || typeof value !== 'object') return fallback;
  const result = value[locale] ?? value['zh-CN'] ?? value.original ?? Object.values(value).find(item => typeof item === 'string');
  return typeof result === 'string' ? result.normalize('NFC').trim() : fallback;
}

function displayFor(event, options) {
  const listing = options.listing ?? event.payload;
  const titleZh = localized(listing?.title, 'zh-CN', '未命名技能');
  const descriptionZh = localized(listing?.description, 'zh-CN', '暂无中文说明');
  const category = localized(listing?.category, 'zh-CN', '其他');
  return { titleZh, descriptionZh, category };
}

function trustFor(release, input = {}) {
  const sms = input.sms ?? {};
  const evaluation = input.eval ?? {};
  const review = input.review ?? {};
  const smsRef = sms.ref ?? release.assessmentRefs.find(item => /^sms_/i.test(item)) ?? null;
  const evalRef = evaluation.ref ?? release.assessmentRefs.find(item => /^eval_/i.test(item)) ?? null;
  const reviewRefs = Array.isArray(review.refs) ? review.refs : [...release.reviewRefs];
  if (smsRef !== null && !release.assessmentRefs.includes(smsRef)) {
    fail('UNBOUND_EVIDENCE_REF', 'SMS evidence reference is not bound to the Release');
  }
  if (evalRef !== null && !release.assessmentRefs.includes(evalRef)) {
    fail('UNBOUND_EVIDENCE_REF', 'Eval evidence reference is not bound to the Release');
  }
  if (!Array.isArray(reviewRefs) || reviewRefs.some(ref => !release.reviewRefs.includes(ref))) {
    fail('UNBOUND_EVIDENCE_REF', 'review evidence references must be bound to the Release');
  }
  return safeValue({
    packageDigest: release.package.packageDigest,
    sms: {
      ref: smsRef,
      status: sms.status ?? 'referenced',
      ...(Number.isFinite(sms.total) ? { total: sms.total } : {}),
      ...(typeof sms.tier === 'string' ? { tier: sms.tier } : {}),
    },
    eval: {
      ref: evalRef,
      status: evaluation.status ?? 'referenced',
      ...(Number.isFinite(evaluation.successRate) ? { successRate: evaluation.successRate } : {}),
    },
    review: {
      refs: reviewRefs,
      status: review.status ?? 'referenced',
      ...(typeof review.validUntil === 'string' ? { validUntil: timestamp(review.validUntil, 'trust.review.validUntil') } : {}),
    },
  });
}

function lifecycle(event, release) {
  const action = ACTIONS[event.type];
  const status = action === 'upsert' ? 'eligible'
    : action === 'withdraw' ? 'withdrawn'
      : action === 'supersede' ? 'superseded' : 'revoked';
  const relations = [];
  if (action === 'supersede') {
    const successorReleaseId = event.payload.successorReleaseId;
    if (!RELEASE_ID.test(successorReleaseId ?? '')) fail('INVALID_SUCCESSOR_RELEASE_ID', 'supersede event must identify a successor Release');
    relations.push({ relation: 'superseded-by', abilityType: 'skill', skillId: release.skillId, releaseId: successorReleaseId });
  }
  return { action, status, relations };
}

function projectionBody(envelope) {
  const { projectionId: _projectionId, payloadDigest: _payloadDigest, ...body } = envelope;
  return body;
}

export function recomputeZaowuyunIdempotencyKey(envelope) {
  const eventId = envelope?.sourceEvent?.eventId;
  if (!EVENT_ID.test(eventId ?? '')) fail('INVALID_EVENT_ID', 'sourceEvent.eventId is invalid');
  return `${eventId}:zaowuyun-staging:v1`;
}

export function recomputeZaowuyunProjectionId(envelope) {
  const body = projectionBody(envelope);
  delete body.idempotencyKey;
  return `zyproj_${canonicalDigest(body).slice('sha256:'.length)}`;
}

export function recomputeZaowuyunPayloadDigest(envelope) {
  const { payloadDigest: _payloadDigest, ...body } = envelope;
  return canonicalDigest(body);
}

export function createZaowuyunEnvelope(eventInput, options = {}) {
  const event = normalizeEvent(eventInput);
  const mode = options.mode ?? 'dry-run';
  if (!MODES.has(mode)) fail('MODE_FORBIDDEN', 'only dry-run and explicit staging-mock modes are allowed');
  const release = releaseFor(event, options);
  const state = lifecycle(event, release);
  const envelope = {
    schema: SCHEMA,
    mode,
    action: state.action,
    subject: { abilityType: 'skill', skillId: release.skillId, releaseId: release.releaseId },
    display: displayFor(event, options),
    trust: trustFor(release, options.trust),
    distribution: {
      status: state.status,
      manifestRef: `registry://releases/${release.releaseId}/manifest`,
    },
    relations: state.relations,
    sourceEvent: { eventId: event.eventId, sequence: event.sequence },
  };
  envelope.idempotencyKey = recomputeZaowuyunIdempotencyKey(envelope);
  envelope.projectionId = recomputeZaowuyunProjectionId(envelope);
  envelope.payloadDigest = recomputeZaowuyunPayloadDigest(envelope);
  assertSafe(envelope);
  return Object.freeze(envelope);
}

export function validateZaowuyunEnvelope(input) {
  const envelope = object(input, 'envelope');
  exactKeys(envelope, new Set([
    'schema', 'projectionId', 'idempotencyKey', 'mode', 'action', 'subject', 'display',
    'trust', 'distribution', 'relations', 'sourceEvent', 'payloadDigest',
  ]), 'envelope');
  if (envelope.schema !== SCHEMA) fail('UNSUPPORTED_SCHEMA', `envelope schema must be ${SCHEMA}`);
  if (!MODES.has(envelope.mode)) fail('MODE_FORBIDDEN', 'only dry-run and explicit staging-mock modes are allowed');
  if (!Object.values(ACTIONS).includes(envelope.action)) fail('INVALID_ACTION', 'envelope action is unsupported');
  exactKeys(envelope.subject, new Set(['abilityType', 'skillId', 'releaseId']), 'envelope.subject');
  if (envelope.subject.abilityType !== 'skill') fail('INVALID_SUBJECT', 'abilityType must be skill');
  normalizeSkillId(envelope.subject.skillId);
  if (!RELEASE_ID.test(envelope.subject.releaseId ?? '')) fail('INVALID_RELEASE_ID', 'subject.releaseId is invalid');
  exactKeys(envelope.display, new Set(['titleZh', 'descriptionZh', 'category']), 'envelope.display');
  text(envelope.display.titleZh, 'envelope.display.titleZh');
  text(envelope.display.descriptionZh, 'envelope.display.descriptionZh');
  text(envelope.display.category, 'envelope.display.category');
  exactKeys(envelope.trust, new Set(['packageDigest', 'sms', 'eval', 'review']), 'envelope.trust');
  if (!DIGEST.test(envelope.trust.packageDigest ?? '')) fail('INVALID_PACKAGE_DIGEST', 'trust.packageDigest is invalid');
  exactKeys(envelope.trust.sms, new Set(['ref', 'status', 'total', 'tier']), 'envelope.trust.sms');
  exactKeys(envelope.trust.eval, new Set(['ref', 'status', 'successRate']), 'envelope.trust.eval');
  exactKeys(envelope.trust.review, new Set(['refs', 'status', 'validUntil']), 'envelope.trust.review');
  exactKeys(envelope.distribution, new Set(['status', 'manifestRef']), 'envelope.distribution');
  if (envelope.distribution.manifestRef !== `registry://releases/${envelope.subject.releaseId}/manifest`) {
    fail('MANIFEST_REF_MISMATCH', 'distribution manifestRef must be bound to subject.releaseId');
  }
  exactKeys(envelope.sourceEvent, new Set(['eventId', 'sequence']), 'envelope.sourceEvent');
  if (!Array.isArray(envelope.relations)) fail('INVALID_RELATIONS', 'relations must be an array');
  for (const relation of envelope.relations) {
    exactKeys(relation, new Set(['relation', 'abilityType', 'skillId', 'releaseId']), 'envelope.relations[]');
  }
  if (envelope.idempotencyKey !== recomputeZaowuyunIdempotencyKey(envelope)) fail('IDEMPOTENCY_KEY_MISMATCH', 'idempotencyKey is not canonical');
  if (envelope.projectionId !== recomputeZaowuyunProjectionId(envelope)) fail('PROJECTION_ID_MISMATCH', 'projectionId does not match projection content');
  if (envelope.payloadDigest !== recomputeZaowuyunPayloadDigest(envelope)) fail('PAYLOAD_DIGEST_MISMATCH', 'payloadDigest does not match envelope content');
  assertSafe(envelope);
  return clone(envelope);
}

export class ZaowuyunMockTransport {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock;
    this.receipts = new Map();
  }

  send(input) {
    const key = input?.idempotencyKey;
    const previous = typeof key === 'string' ? this.receipts.get(key) : null;
    if (previous && previous.payloadDigest !== input.payloadDigest) {
      fail('IDEMPOTENCY_CONFLICT', 'idempotencyKey is already bound to another payload digest');
    }
    const envelope = validateZaowuyunEnvelope(input);
    if (envelope.mode !== 'staging-mock') fail('MODE_FORBIDDEN', 'mock transport only accepts explicit staging-mock envelopes');
    if (previous) return clone(previous);
    const receivedAt = timestamp(this.clock(), 'receivedAt');
    const receipt = Object.freeze({
      projectionId: envelope.projectionId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'accepted',
      remoteRef: `mock://${envelope.projectionId}`,
      receivedAt,
      payloadDigest: envelope.payloadDigest,
    });
    this.receipts.set(envelope.idempotencyKey, receipt);
    return clone(receipt);
  }
}
