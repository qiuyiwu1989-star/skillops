import crypto from 'node:crypto';

import { validateIdpReceipt } from '../idp-receipt.mjs';

export const PUBLICATION_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const RELEASE_ID = /^(?:rel|apprel)_[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const REVIEW_ROLES = new Set(['rights', 'market']);
const HUMAN_DECISIONS = new Set(['approve', 'request_changes', 'reject']);
const LIFECYCLE_ACTIONS = new Set(['publish', 'withdraw', 'recall', 'appeal']);
const EVENT_TYPES = new Set(['submission.created', 'review.recorded', 'lifecycle.recorded']);

export class PublicationWorkflowError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PublicationWorkflowError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PublicationWorkflowError(code, message, cause);
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

function text(value, label, maximum = 1_000, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${label} is invalid or too long`);
  }
  return normalized;
}

function id(value, label) {
  return text(value, label, 256, SAFE_ID);
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_DIGEST', `${label} must be a canonical SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  if (!Number.isFinite(Date.parse(normalized))) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(Date.parse(normalized)).toISOString();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INTEGER', `${label} must be a positive safe integer`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function trustedNow(value) {
  if (value === undefined) fail('TRUSTED_CLOCK_REQUIRED', 'trusted now capability is required');
  let resolved;
  try { resolved = typeof value === 'function' ? value() : value; } catch (cause) { fail('TRUSTED_CLOCK_FAILED', 'trusted now capability failed', cause); }
  if (resolved instanceof Date) resolved = resolved.toISOString();
  return timestamp(resolved, 'trusted.now');
}

function capability(options, name) {
  if (typeof options?.[name] !== 'function') fail('TRUSTED_CAPABILITY_REQUIRED', `${name} capability is required`);
  return options[name];
}

function invoke(resolver, input, failureCode, label) {
  try { return resolver(input); } catch (cause) { fail(failureCode, `${label} failed`, cause); }
}

function identityFromReceipt(receipt, options, at) {
  let validated;
  try {
    validated = validateIdpReceipt(receipt, {
      trustedProviderVerifiers: options?.trustedProviderVerifiers,
      purpose: 'creator-publication',
      now: at,
    });
  } catch (cause) {
    fail('IDENTITY_NOT_TRUSTED', 'identity receipt is not trusted for creator publication', cause);
  }
  let canonicalSubjectDigest = validated.subjectDigest;
  if (validated.kind === 'human') {
    try {
      const canonicalIdentity = capability(options, 'canonicalHumanResolver')({
        provider: validated.provider,
        subjectDigest: validated.subjectDigest,
        receiptDigest: validated.receiptDigest,
        at,
      });
      canonicalSubjectDigest = canonicalIdentity?.canonicalSubjectDigest;
    } catch (cause) {
      if (cause instanceof PublicationWorkflowError) throw cause;
      fail('CANONICAL_HUMAN_RESOLVER_FAILED', 'trusted canonical human resolver failed', cause);
    }
    if (typeof canonicalSubjectDigest !== 'string' || !DIGEST.test(canonicalSubjectDigest)) {
      fail('CANONICAL_HUMAN_REQUIRED', 'trusted canonical human resolver must return canonicalSubjectDigest');
    }
  }
  const suffix = canonicalSubjectDigest.slice('sha256:'.length);
  return deepFreeze({
    kind: validated.kind === 'human' ? 'human' : 'agent',
    principalId: `human:${suffix}`,
    subjectDigest: canonicalSubjectDigest,
    provider: validated.provider,
    receipt: clone(validated),
  });
}

function assertRepresentative(identity, publisherId, at, options) {
  const resolved = invoke(capability(options, 'publisherRepresentativeResolver'), {
    publisherId, principalId: identity.principalId, subjectDigest: identity.subjectDigest, at,
  }, 'PUBLISHER_REPRESENTATIVE_RESOLVER_FAILED', 'trusted Publisher representative resolver');
  const allowed = resolved === true || (resolved && resolved.decision === 'allow' && resolved.publisherId === publisherId);
  if (!allowed) fail('PUBLISHER_REPRESENTATIVE_REQUIRED', 'identity cannot represent this Publisher');
}

function normalizeSubmissionShape(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'workId', 'publisherId', 'productId', 'releaseId', 'draftRevision',
    'draftDigest', 'marketRegistryRevision', 'licensePolicyDigest', 'evidenceDigest',
    'declarationVersion', 'submitter', 'submittedAt', 'submissionDigest', 'submissionId',
  ]), 'publication submission');
  if (input.schemaVersion !== PUBLICATION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `submission schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  const submitter = object(input.submitter, 'submission.submitter');
  exactKeys(submitter, new Set(['kind', 'principalId', 'subjectDigest', 'provider', 'receipt']), 'submission.submitter');
  const normalizedSubmitter = identityFromReceipt(submitter.receipt, input.__trustOptions, input.submittedAt);
  if (normalizedSubmitter.kind !== 'human') fail('HUMAN_SUBMITTER_REQUIRED', 'publication submitter must be a trusted human');
  if (submitter.principalId !== normalizedSubmitter.principalId || submitter.subjectDigest !== normalizedSubmitter.subjectDigest
    || submitter.provider !== normalizedSubmitter.provider || submitter.kind !== normalizedSubmitter.kind) {
    fail('IDENTITY_BINDING_MISMATCH', 'submission identity does not match its trusted receipt');
  }
  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    workId: id(input.workId, 'submission.workId'),
    publisherId: id(input.publisherId, 'submission.publisherId'),
    productId: text(input.productId, 'submission.productId', 69, PRODUCT_ID),
    releaseId: text(input.releaseId, 'submission.releaseId', 72, RELEASE_ID),
    draftRevision: positiveInteger(input.draftRevision, 'submission.draftRevision'),
    draftDigest: digest(input.draftDigest, 'submission.draftDigest'),
    marketRegistryRevision: digest(input.marketRegistryRevision, 'submission.marketRegistryRevision'),
    licensePolicyDigest: digest(input.licensePolicyDigest, 'submission.licensePolicyDigest'),
    evidenceDigest: digest(input.evidenceDigest, 'submission.evidenceDigest'),
    declarationVersion: id(input.declarationVersion, 'submission.declarationVersion'),
    submitter: normalizedSubmitter,
    submittedAt: timestamp(input.submittedAt, 'submission.submittedAt'),
  };
  const submissionDigest = hash(body);
  const submissionId = `sub_${submissionDigest.slice('sha256:'.length)}`;
  if (input.submissionDigest !== submissionDigest || input.submissionId !== submissionId) fail('SUBMISSION_DIGEST_MISMATCH', 'submission identity does not match its frozen evidence');
  return deepFreeze({ ...body, submissionDigest, submissionId });
}

function bindingOf(value, label) {
  object(value, label);
  return {
    workId: id(value.workId, `${label}.workId`),
    publisherId: id(value.publisherId, `${label}.publisherId`),
    productId: text(value.productId, `${label}.productId`, 69, PRODUCT_ID),
    releaseId: text(value.releaseId, `${label}.releaseId`, 72, RELEASE_ID),
    draftRevision: positiveInteger(value.draftRevision, `${label}.draftRevision`),
    draftDigest: digest(value.draftDigest, `${label}.draftDigest`),
    marketRegistryRevision: digest(value.marketRegistryRevision, `${label}.marketRegistryRevision`),
    licensePolicyDigest: digest(value.licensePolicyDigest, `${label}.licensePolicyDigest`),
    evidenceDigest: digest(value.evidenceDigest, `${label}.evidenceDigest`),
    declarationVersion: id(value.declarationVersion, `${label}.declarationVersion`),
  };
}

function assertBinding(actual, expected, code = 'SUBMISSION_BINDING_MISMATCH') {
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) fail(code, `trusted binding ${key} does not match submission`);
}

export function createPublicationSubmission(input = {}, options = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'workId', 'publisherId', 'productId', 'releaseId', 'draftRevision',
    'draftDigest', 'marketRegistryRevision', 'licensePolicyDigest', 'evidenceDigest',
    'declarationVersion', 'submitterReceipt', 'submittedAt',
  ]), 'publication submission input');
  if (input.schemaVersion !== undefined && input.schemaVersion !== PUBLICATION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `submission schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  const submittedAt = input.submittedAt === undefined ? trustedNow(options.now) : timestamp(input.submittedAt, 'submittedAt');
  if (input.submittedAt !== undefined && submittedAt !== trustedNow(options.now)) fail('UNTRUSTED_EVENT_TIME', 'submittedAt must equal trusted now');
  const submitter = identityFromReceipt(input.submitterReceipt, options, submittedAt);
  if (submitter.kind !== 'human') fail('HUMAN_SUBMITTER_REQUIRED', 'publication submitter must be a trusted human');
  const expected = bindingOf({ ...input, schemaVersion: undefined }, 'submission');
  assertRepresentative(submitter, expected.publisherId, submittedAt, options);

  const draft = invoke(capability(options, 'draftResolver'), {
    workId: expected.workId, draftRevision: expected.draftRevision, draftDigest: expected.draftDigest,
  }, 'DRAFT_RESOLVER_FAILED', 'trusted Draft resolver');
  const draftReleaseId = draft?.target?.releaseId ?? draft?.target?.applicationReleaseId ?? draft?.releaseId;
  if (!draft || draft.workId !== expected.workId || draft.publisherId !== expected.publisherId
    || draft.productId !== expected.productId || draft.draftRevision !== expected.draftRevision
    || draft.draftDigest !== expected.draftDigest || draftReleaseId !== expected.releaseId
    || draft.rightsDeclaration?.statementVersion !== expected.declarationVersion) {
    fail('DRAFT_BINDING_MISMATCH', 'trusted Draft does not match the submitted immutable revision');
  }
  const product = invoke(capability(options, 'productResolver'), expected.productId, 'PRODUCT_RESOLVER_FAILED', 'trusted Product resolver');
  if (!product || product.productId !== expected.productId || product.publisherId !== expected.publisherId) fail('PRODUCT_BINDING_MISMATCH', 'trusted Product does not match Publisher and productId');
  const release = invoke(capability(options, 'releaseResolver'), expected.releaseId, 'RELEASE_RESOLVER_FAILED', 'trusted Release resolver');
  if (!release || release.releaseId !== expected.releaseId || release.productId !== expected.productId) fail('RELEASE_BINDING_MISMATCH', 'trusted Release does not match Product and releaseId');
  const registry = invoke(capability(options, 'marketRegistryRevisionResolver'), undefined, 'MARKET_REGISTRY_RESOLVER_FAILED', 'trusted MarketRegistry revision resolver');
  const currentRevision = typeof registry === 'string' ? registry : registry?.revision;
  if (currentRevision !== expected.marketRegistryRevision) fail('MARKET_REGISTRY_REVISION_MISMATCH', 'submission MarketRegistry revision is not current');

  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    ...expected,
    submitter,
    submittedAt,
  };
  const submissionDigest = hash(body);
  return deepFreeze({ ...body, submissionDigest, submissionId: `sub_${submissionDigest.slice('sha256:'.length)}` });
}

function normalizeSubmission(input, options) {
  const copy = clone(input);
  Object.defineProperty(copy, '__trustOptions', { value: options, enumerable: false });
  const submission = normalizeSubmissionShape(copy);
  assertRepresentative(submission.submitter, submission.publisherId, submission.submittedAt, options);
  return submission;
}

function normalizeReviewShape(input, options) {
  exactKeys(input, new Set([
    'schemaVersion', 'submissionId', 'submissionDigest', 'productId', 'releaseId', 'role',
    'decision', 'recommendation', 'reason', 'evidenceDigest', 'reviewer', 'reviewedAt', 'reviewDigest', 'reviewId',
  ]), 'publication review');
  if (input.schemaVersion !== PUBLICATION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `review schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  const reviewedAt = timestamp(input.reviewedAt, 'review.reviewedAt');
  const rawReviewer = object(input.reviewer, 'review.reviewer');
  exactKeys(rawReviewer, new Set(['kind', 'principalId', 'subjectDigest', 'provider', 'receipt']), 'review.reviewer');
  const reviewer = identityFromReceipt(rawReviewer.receipt, options, reviewedAt);
  if (rawReviewer.kind !== reviewer.kind || rawReviewer.principalId !== reviewer.principalId
    || rawReviewer.subjectDigest !== reviewer.subjectDigest || rawReviewer.provider !== reviewer.provider) {
    fail('IDENTITY_BINDING_MISMATCH', 'review identity does not match its trusted receipt');
  }
  const role = text(input.role, 'review.role', 16);
  if (!REVIEW_ROLES.has(role)) fail('INVALID_REVIEW_ROLE', 'review role must be rights or market');
  let decision;
  let recommendation = null;
  if (reviewer.kind === 'human') {
    decision = text(input.decision, 'review.decision', 32);
    if (!HUMAN_DECISIONS.has(decision) || input.recommendation !== null) fail('INVALID_REVIEW_DECISION', 'human review decision is invalid');
  } else {
    if (input.decision !== 'advisory') fail('AGENT_CANNOT_DECIDE', 'Agent review can only be advisory');
    decision = 'advisory';
    recommendation = text(input.recommendation, 'review.recommendation', 32);
    if (!HUMAN_DECISIONS.has(recommendation)) fail('INVALID_RECOMMENDATION', 'Agent recommendation is invalid');
  }
  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    submissionId: text(input.submissionId, 'review.submissionId', 68, /^sub_[a-f0-9]{64}$/),
    submissionDigest: digest(input.submissionDigest, 'review.submissionDigest'),
    productId: text(input.productId, 'review.productId', 69, PRODUCT_ID),
    releaseId: text(input.releaseId, 'review.releaseId', 72, RELEASE_ID),
    role,
    decision,
    recommendation,
    reason: text(input.reason, 'review.reason', 4_000),
    evidenceDigest: digest(input.evidenceDigest, 'review.evidenceDigest'),
    reviewer,
    reviewedAt,
  };
  const reviewDigest = hash(body);
  const reviewId = `pubrev_${reviewDigest.slice('sha256:'.length)}`;
  if (input.reviewDigest !== reviewDigest || input.reviewId !== reviewId) fail('REVIEW_DIGEST_MISMATCH', 'review identity does not match its frozen evidence');
  return deepFreeze({ ...body, reviewDigest, reviewId });
}

export function createPublicationReview(input = {}, options = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'submissionId', 'submissionDigest', 'role', 'decision', 'recommendation',
    'reason', 'evidenceDigest', 'reviewerReceipt', 'reviewedAt',
  ]), 'publication review input');
  const reviewedAt = input.reviewedAt === undefined ? trustedNow(options.now) : timestamp(input.reviewedAt, 'reviewedAt');
  if (input.reviewedAt !== undefined && reviewedAt !== trustedNow(options.now)) fail('UNTRUSTED_EVENT_TIME', 'reviewedAt must equal trusted now');
  const submission = invoke(capability(options, 'submissionResolver'), input.submissionId, 'SUBMISSION_RESOLVER_FAILED', 'trusted Submission resolver');
  if (!submission || submission.submissionId !== input.submissionId || submission.submissionDigest !== input.submissionDigest) {
    fail('SUBMISSION_BINDING_MISMATCH', 'review does not bind the trusted Submission');
  }
  const reviewer = identityFromReceipt(input.reviewerReceipt, options, reviewedAt);
  if (reviewer.subjectDigest === submission.submitter.subjectDigest) fail('SUBMITTER_REVIEW_CONFLICT', 'submitter cannot review their own submission');
  const role = text(input.role, 'review.role', 16);
  if (!REVIEW_ROLES.has(role)) fail('INVALID_REVIEW_ROLE', 'review role must be rights or market');
  const authorized = invoke(capability(options, 'reviewerRoleResolver'), {
    principalId: reviewer.principalId, subjectDigest: reviewer.subjectDigest, role, at: reviewedAt,
  }, 'REVIEWER_ROLE_RESOLVER_FAILED', 'trusted reviewer role resolver');
  if (!(authorized === true || authorized?.decision === 'allow')) fail('REVIEWER_ROLE_REQUIRED', 'reviewer is not authorized for this review role');
  let decision;
  let recommendation = null;
  if (reviewer.kind === 'human') {
    decision = text(input.decision, 'review.decision', 32);
    if (!HUMAN_DECISIONS.has(decision) || input.recommendation !== undefined) fail('INVALID_REVIEW_DECISION', 'human review decision is invalid');
  } else {
    if (input.decision !== undefined && input.decision !== 'advisory') fail('AGENT_CANNOT_DECIDE', 'Agent cannot approve, reject, or request changes');
    decision = 'advisory';
    recommendation = text(input.recommendation, 'review.recommendation', 32);
    if (!HUMAN_DECISIONS.has(recommendation)) fail('INVALID_RECOMMENDATION', 'Agent recommendation is invalid');
  }
  if (input.evidenceDigest !== submission.evidenceDigest) fail('EVIDENCE_BINDING_MISMATCH', 'review evidence does not match Submission');
  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    submissionId: submission.submissionId,
    submissionDigest: submission.submissionDigest,
    productId: submission.productId,
    releaseId: submission.releaseId,
    role,
    decision,
    recommendation,
    reason: text(input.reason, 'review.reason', 4_000),
    evidenceDigest: submission.evidenceDigest,
    reviewer,
    reviewedAt,
  };
  const reviewDigest = hash(body);
  return deepFreeze({ ...body, reviewDigest, reviewId: `pubrev_${reviewDigest.slice('sha256:'.length)}` });
}

function normalizeReview(input, options) {
  const review = normalizeReviewShape(input, options);
  const authorized = invoke(capability(options, 'reviewerRoleResolver'), {
    principalId: review.reviewer.principalId, subjectDigest: review.reviewer.subjectDigest,
    role: review.role, at: review.reviewedAt,
  }, 'REVIEWER_ROLE_RESOLVER_FAILED', 'trusted reviewer role resolver');
  if (!(authorized === true || authorized?.decision === 'allow')) fail('REVIEWER_ROLE_REQUIRED', 'reviewer is not authorized for this review role');
  return review;
}

function normalizeLifecycleShape(input, options) {
  exactKeys(input, new Set([
    'schemaVersion', 'action', 'productId', 'releaseId', 'submissionId', 'submissionDigest',
    'actor', 'reason', 'riskCode', 'remediation', 'appealOfEventId', 'occurredAt',
    'lifecycleDigest', 'lifecycleId',
  ]), 'publication lifecycle event');
  if (input.schemaVersion !== PUBLICATION_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `lifecycle schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  const occurredAt = timestamp(input.occurredAt, 'lifecycle.occurredAt');
  const rawActor = object(input.actor, 'lifecycle.actor');
  exactKeys(rawActor, new Set(['kind', 'principalId', 'subjectDigest', 'provider', 'receipt']), 'lifecycle.actor');
  const actor = identityFromReceipt(rawActor.receipt, options, occurredAt);
  if (actor.kind !== 'human') fail('HUMAN_CONTROL_REQUIRED', 'publication lifecycle action requires a trusted human');
  if (rawActor.kind !== actor.kind || rawActor.principalId !== actor.principalId
    || rawActor.subjectDigest !== actor.subjectDigest || rawActor.provider !== actor.provider) {
    fail('IDENTITY_BINDING_MISMATCH', 'lifecycle actor does not match its trusted receipt');
  }
  const action = text(input.action, 'lifecycle.action', 16);
  if (!LIFECYCLE_ACTIONS.has(action)) fail('INVALID_LIFECYCLE_ACTION', 'unsupported publication lifecycle action');
  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    action,
    productId: text(input.productId, 'lifecycle.productId', 69, PRODUCT_ID),
    releaseId: text(input.releaseId, 'lifecycle.releaseId', 72, RELEASE_ID),
    submissionId: input.submissionId === null ? null : text(input.submissionId, 'lifecycle.submissionId', 68, /^sub_[a-f0-9]{64}$/),
    submissionDigest: input.submissionDigest === null ? null : digest(input.submissionDigest, 'lifecycle.submissionDigest'),
    actor,
    reason: text(input.reason, 'lifecycle.reason', 4_000),
    riskCode: input.riskCode === null ? null : id(input.riskCode, 'lifecycle.riskCode'),
    remediation: input.remediation === null ? null : text(input.remediation, 'lifecycle.remediation', 4_000),
    appealOfEventId: input.appealOfEventId === null ? null : text(input.appealOfEventId, 'lifecycle.appealOfEventId', 71, /^pubevt_[a-f0-9]{64}$/),
    occurredAt,
  };
  if (action === 'publish' && (!body.submissionId || !body.submissionDigest)) fail('SUBMISSION_REQUIRED', 'publish requires a frozen Submission');
  if (action !== 'publish' && (body.submissionId || body.submissionDigest)) fail('UNEXPECTED_SUBMISSION', 'only publish may bind a Submission');
  if (action === 'recall' && (!body.riskCode || !body.remediation)) fail('RECALL_EVIDENCE_REQUIRED', 'recall requires riskCode and remediation');
  if (action !== 'recall' && (body.riskCode || body.remediation)) fail('UNEXPECTED_RECALL_EVIDENCE', 'only recall may carry risk evidence');
  if (action === 'appeal' && !body.appealOfEventId) fail('APPEAL_TARGET_REQUIRED', 'appeal requires a lifecycle target');
  if (action !== 'appeal' && body.appealOfEventId) fail('UNEXPECTED_APPEAL_TARGET', 'only appeal may carry an appeal target');
  const lifecycleDigest = hash(body);
  const lifecycleId = `publife_${lifecycleDigest.slice('sha256:'.length)}`;
  if (input.lifecycleDigest !== lifecycleDigest || input.lifecycleId !== lifecycleId) fail('LIFECYCLE_DIGEST_MISMATCH', 'lifecycle identity does not match its frozen evidence');
  return deepFreeze({ ...body, lifecycleDigest, lifecycleId });
}

export function createPublicationLifecycleEvent(input = {}, options = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'action', 'productId', 'releaseId', 'submissionId', 'submissionDigest',
    'actorReceipt', 'reason', 'riskCode', 'remediation', 'appealOfEventId', 'occurredAt',
  ]), 'publication lifecycle input');
  const occurredAt = input.occurredAt === undefined ? trustedNow(options.now) : timestamp(input.occurredAt, 'occurredAt');
  if (input.occurredAt !== undefined && occurredAt !== trustedNow(options.now)) fail('UNTRUSTED_EVENT_TIME', 'occurredAt must equal trusted now');
  const actor = identityFromReceipt(input.actorReceipt, options, occurredAt);
  if (actor.kind !== 'human') fail('HUMAN_CONTROL_REQUIRED', 'publication lifecycle action requires a trusted human');
  const action = text(input.action, 'lifecycle.action', 16);
  if (!LIFECYCLE_ACTIONS.has(action)) fail('INVALID_LIFECYCLE_ACTION', 'unsupported publication lifecycle action');
  const authorized = invoke(capability(options, 'lifecycleActorResolver'), {
    principalId: actor.principalId, subjectDigest: actor.subjectDigest, action,
    productId: input.productId, releaseId: input.releaseId, at: occurredAt,
  }, 'LIFECYCLE_ACTOR_RESOLVER_FAILED', 'trusted lifecycle actor resolver');
  if (!(authorized === true || authorized?.decision === 'allow')) fail('LIFECYCLE_ACTOR_REQUIRED', 'actor is not authorized for this lifecycle action');
  if (action === 'publish') {
    const current = invoke(capability(options, 'publicationItemResolver'), {
      productId: input.productId, releaseId: input.releaseId,
    }, 'PUBLICATION_ITEM_RESOLVER_FAILED', 'trusted Publication item resolver');
    if (!current || current.status !== 'approved' || current.submission?.submissionId !== input.submissionId
      || current.submission?.submissionDigest !== input.submissionDigest) {
      fail('CURRENT_APPROVAL_REQUIRED', 'publish requires the current doubly approved Submission');
    }
    if (!currentBindingMatches(current.submission, capability(options, 'currentBindingResolver'))) {
      fail('SUBMISSION_STALE', 'publish Submission no longer matches current Draft/Product/Release/Registry evidence');
    }
  }
  const body = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    action,
    productId: input.productId,
    releaseId: input.releaseId,
    submissionId: input.submissionId ?? null,
    submissionDigest: input.submissionDigest ?? null,
    actor,
    reason: input.reason,
    riskCode: input.riskCode ?? null,
    remediation: input.remediation ?? null,
    appealOfEventId: input.appealOfEventId ?? null,
    occurredAt,
  };
  const lifecycleDigest = hash(body);
  const event = normalizeLifecycleShape({ ...body, lifecycleDigest, lifecycleId: `publife_${lifecycleDigest.slice('sha256:'.length)}` }, options);
  return event;
}

function normalizeLifecycle(input, options) {
  const event = normalizeLifecycleShape(input, options);
  const authorized = invoke(capability(options, 'lifecycleActorResolver'), {
    principalId: event.actor.principalId, subjectDigest: event.actor.subjectDigest,
    action: event.action, productId: event.productId, releaseId: event.releaseId, at: event.occurredAt,
  }, 'LIFECYCLE_ACTOR_RESOLVER_FAILED', 'trusted lifecycle actor resolver');
  if (!(authorized === true || authorized?.decision === 'allow')) fail('LIFECYCLE_ACTOR_REQUIRED', 'actor is not authorized for this lifecycle action');
  return event;
}

function createEvent(type, payload, occurredAt) {
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported publication event type: ${type}`);
  const body = { schemaVersion: PUBLICATION_SCHEMA_VERSION, type, occurredAt, payload: clone(payload) };
  return deepFreeze({ ...body, eventId: `pubevt_${hash(body).slice('sha256:'.length)}` });
}

export function createPublicationEvent(type, payload, options = {}) {
  let normalized;
  if (type === 'submission.created') normalized = normalizeSubmission(payload, options);
  else if (type === 'review.recorded') normalized = normalizeReview(payload, options);
  else if (type === 'lifecycle.recorded') normalized = normalizeLifecycle(payload, options);
  else fail('UNKNOWN_EVENT_TYPE', `unsupported publication event type: ${type}`);
  return createEvent(type, normalized, type === 'submission.created' ? normalized.submittedAt : type === 'review.recorded' ? normalized.reviewedAt : normalized.occurredAt);
}

function normalizeEvent(input, options) {
  exactKeys(input, new Set(['schemaVersion', 'type', 'occurredAt', 'payload', 'eventId']), 'publication event');
  if (input.schemaVersion !== PUBLICATION_SCHEMA_VERSION || !EVENT_TYPES.has(input.type)) fail('UNKNOWN_EVENT_TYPE', 'publication event schema or type is unsupported');
  const event = createPublicationEvent(input.type, input.payload, options);
  if (event.occurredAt !== timestamp(input.occurredAt, 'event.occurredAt') || event.eventId !== input.eventId) {
    fail('EVENT_ID_MISMATCH', 'publication event identity does not match content');
  }
  return event;
}

function itemKey(productId, releaseId) {
  return `${productId}\0${releaseId}`;
}

function approvalState(reviews, submission) {
  const relevant = reviews.filter(review => review.submissionId === submission.submissionId);
  const humans = relevant.filter(review => review.reviewer.kind === 'human');
  const latestByRole = new Map();
  for (const review of humans) latestByRole.set(review.role, review);
  const blocker = [...latestByRole.values()].find(review => review.decision === 'reject' || review.decision === 'request_changes');
  if (blocker) {
    return { status: blocker.decision === 'reject' ? 'rejected' : 'changes_requested', reviewGaps: [], approvals: [] };
  }
  const rights = latestByRole.get('rights');
  const market = latestByRole.get('market');
  const gaps = [];
  if (rights?.decision !== 'approve') gaps.push('rights_approval_required');
  if (market?.decision !== 'approve') gaps.push('market_approval_required');
  if (rights?.decision === 'approve' && market?.decision === 'approve' && rights.reviewer.subjectDigest === market.reviewer.subjectDigest) {
    gaps.push('independent_humans_required');
  }
  return {
    status: gaps.length ? 'pending' : 'approved',
    reviewGaps: gaps,
    approvals: gaps.length ? [] : [rights, market],
  };
}

function nextAction(status) {
  return {
    pending: 'complete_reviews', approved: 'publish', changes_requested: 'revise_draft', rejected: 'appeal_or_resubmit',
    published: 'manage_publication', withdrawn: 'appeal_or_resubmit', recalled: 'appeal_or_resubmit', appealed: 'await_appeal_decision',
  }[status] ?? 'resubmit';
}

function safeSubmission(submission) {
  const value = clone(submission);
  delete value.submitter;
  return value;
}

export function replayPublicationEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length > 100_000) fail('EVENT_LIMIT_EXCEEDED', 'publication event log is invalid or too large');
  const projection = { schemaVersion: PUBLICATION_SCHEMA_VERSION, items: {}, submissions: {}, reviews: {}, lifecycleEvents: {}, eventCount: 0 };
  const eventIds = new Set();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const raw of events) {
    const event = normalizeEvent(raw, options);
    const eventTime = Date.parse(event.occurredAt);
    if (eventTime < previousTime) fail('EVENT_TIME_REGRESSION', 'publication event time must be monotonic');
    previousTime = eventTime;
    if (eventIds.has(event.eventId)) fail('DUPLICATE_EVENT', 'publication event log contains a duplicate event');
    eventIds.add(event.eventId);
    projection.eventCount += 1;
    if (event.type === 'submission.created') {
      const submission = event.payload;
      const key = itemKey(submission.productId, submission.releaseId);
      const prior = projection.submissions[submission.submissionId];
      if (prior && prior.submissionDigest !== submission.submissionDigest) fail('SUBMISSION_CONFLICT', 'submissionId is already bound to different content');
      projection.submissions[submission.submissionId] = clone(submission);
      const old = projection.items[key];
      projection.items[key] = {
        productId: submission.productId, releaseId: submission.releaseId, status: 'pending',
        enforcementStatus: old?.enforcementStatus ?? 'withdrawn',
        submission: clone(submission), reviews: [], reviewGaps: ['rights_approval_required', 'market_approval_required'],
        nextAction: 'complete_reviews', timeline: [...(old?.timeline ?? []), { eventId: event.eventId, type: event.type, at: event.occurredAt }],
        appeals: [...(old?.appeals ?? [])],
      };
    } else if (event.type === 'review.recorded') {
      const review = event.payload;
      const submission = projection.submissions[review.submissionId];
      if (!submission || submission.submissionDigest !== review.submissionDigest
        || submission.productId !== review.productId || submission.releaseId !== review.releaseId
        || submission.evidenceDigest !== review.evidenceDigest) fail('SUBMISSION_BINDING_MISMATCH', 'review Submission binding is invalid');
      if (review.reviewer.subjectDigest === submission.submitter.subjectDigest) fail('SUBMITTER_REVIEW_CONFLICT', 'submitter cannot review their own Submission');
      const key = itemKey(review.productId, review.releaseId);
      const item = projection.items[key];
      if (!item || item.submission.submissionId !== review.submissionId) fail('SUBMISSION_NOT_CURRENT', 'review only applies to the current Submission');
      if (item.status !== 'pending') fail('REVIEW_CLOSED', 'the current Submission is no longer open for review');
      projection.reviews[review.reviewId] = clone(review);
      item.reviews.push(clone(review));
      item.timeline.push({ eventId: event.eventId, type: event.type, at: event.occurredAt, role: review.role, decision: review.decision });
      const approval = approvalState(item.reviews, item.submission);
      item.status = approval.status;
      item.reviewGaps = approval.reviewGaps;
      item.nextAction = nextAction(item.status);
    } else {
      const lifecycle = event.payload;
      const key = itemKey(lifecycle.productId, lifecycle.releaseId);
      const item = projection.items[key];
      if (!item) fail('PUBLICATION_ITEM_REQUIRED', 'lifecycle action requires a current publication item');
      if (lifecycle.action === 'publish') {
        if (item.status !== 'approved' || item.submission.submissionId !== lifecycle.submissionId
          || item.submission.submissionDigest !== lifecycle.submissionDigest) fail('CURRENT_APPROVAL_REQUIRED', 'publish requires the current doubly approved Submission');
        item.status = 'published';
        item.enforcementStatus = 'published';
      } else if (lifecycle.action === 'withdraw') {
        if (item.status !== 'published') fail('INVALID_LIFECYCLE_TRANSITION', 'only a published item can be withdrawn');
        item.status = 'withdrawn';
        item.enforcementStatus = 'withdrawn';
      } else if (lifecycle.action === 'recall') {
        if (!['published', 'withdrawn'].includes(item.status)) fail('INVALID_LIFECYCLE_TRANSITION', 'only published or withdrawn items can be recalled');
        item.status = 'recalled';
        item.enforcementStatus = 'recalled';
      } else {
        const target = projection.lifecycleEvents[lifecycle.appealOfEventId]
          ?? item.timeline.find(entry => entry.eventId === lifecycle.appealOfEventId && entry.decision === 'reject');
        if (!target || !(target.decision === 'reject' || ['withdraw', 'recall'].includes(target.action))) {
          fail('INVALID_APPEAL_TARGET', 'appeal must target a reject, withdraw, or recall event');
        }
        if (!['rejected', 'withdrawn', 'recalled'].includes(item.status)) fail('INVALID_LIFECYCLE_TRANSITION', 'only rejected, withdrawn or recalled items can be appealed');
        item.status = 'appealed';
        item.appeals.push({ lifecycleId: lifecycle.lifecycleId, appealOfEventId: lifecycle.appealOfEventId, reason: lifecycle.reason, occurredAt: lifecycle.occurredAt, status: 'pending' });
      }
      projection.lifecycleEvents[event.eventId] = clone(lifecycle);
      item.timeline.push({ eventId: event.eventId, type: event.type, at: event.occurredAt, action: lifecycle.action });
      item.reviewGaps = [];
      item.nextAction = nextAction(item.status);
    }
  }
  return deepFreeze(projection);
}

function currentBindingMatches(submission, resolver) {
  if (typeof resolver !== 'function') return false;
  try {
    const current = bindingOf(resolver({ productId: submission.productId, releaseId: submission.releaseId }), 'currentBinding');
    assertBinding(current, bindingOf(submission, 'submission'), 'SUBMISSION_STALE');
    return true;
  } catch {
    return false;
  }
}

export function createPublicationResolver(projectionInput, { currentBindingResolver } = {}) {
  const projection = object(projectionInput, 'publication projection');
  const resolveItem = (productId, releaseId) => projection.items?.[itemKey(productId, releaseId)] ?? null;
  const effective = item => {
    if (!item) return null;
    if (item.enforcementStatus === 'recalled') return 'recalled';
    if (!currentBindingMatches(item.submission, currentBindingResolver)) return 'withdrawn';
    return item.enforcementStatus;
  };
  return deepFreeze({
    resolveOrderProduct(productId) {
      const published = Object.values(projection.items ?? {}).find(item => (
        item.productId === productId && item.status === 'published' && effective(item) === 'published'
      ));
      return published ? deepFreeze({ productId, status: 'published' }) : null;
    },
    resolveOrderRelease(releaseId) {
      const item = Object.values(projection.items ?? {}).find(candidate => (
        candidate.releaseId === releaseId && candidate.status === 'published' && effective(candidate) === 'published'
      ));
      return item ? deepFreeze({ releaseId, productId: item.productId, status: 'published' }) : null;
    },
    resolveAccessRelease(releaseId) {
      const item = Object.values(projection.items ?? {}).find(candidate => candidate.releaseId === releaseId);
      if (!item) return null;
      return deepFreeze({ releaseId, productId: item.productId, status: effective(item) });
    },
    resolveItem,
  });
}

export function toPublicPublicationProjection(projectionInput, { currentBindingResolver } = {}) {
  const projection = object(projectionInput, 'publication projection');
  const items = {};
  for (const item of Object.values(projection.items ?? {})) {
    const wasPublished = item.timeline?.some(entry => entry.type === 'lifecycle.recorded' && entry.action === 'publish');
    if (!wasPublished || !['published', 'withdrawn', 'recalled', 'appealed'].includes(item.status)
      || !currentBindingMatches(item.submission, currentBindingResolver)) continue;
    items[itemKey(item.productId, item.releaseId)] = deepFreeze({
      productId: item.productId,
      releaseId: item.releaseId,
      status: item.status,
      enforcementStatus: item.enforcementStatus,
      submission: safeSubmission(item.submission),
      reviewGaps: clone(item.reviewGaps),
      nextAction: item.nextAction,
      timeline: clone(item.timeline),
      appeals: clone(item.appeals),
    });
  }
  const publicValue = { schemaVersion: PUBLICATION_SCHEMA_VERSION, items, eventCount: projection.eventCount };
  const serialized = JSON.stringify(publicValue).toLowerCase();
  for (const forbidden of ['candidate', 'storageRef', 'localPath', 'prompt', 'output', 'token', 'secret', 'receipt', 'subjectDigest', 'principalId']) {
    if (serialized.includes(forbidden.toLowerCase())) fail('PRIVATE_VALUE', `public publication projection contains forbidden ${forbidden}`);
  }
  return deepFreeze(publicValue);
}
