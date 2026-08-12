import crypto from 'node:crypto';

export const REVIEW_POLICY_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const HUMAN_DECISIONS = new Set(['approve', 'reject', 'request_changes']);
const LIFECYCLE_ACTIONS = new Set(['withdraw', 'recall', 'appeal']);

export class ReviewPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewPolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReviewPolicyError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_structure', `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('unknown_field', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function text(value, label, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_text', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('invalid_text', `${label} is invalid or too long`);
  return normalized;
}

function id(value, label) {
  const normalized = text(value, label, 256);
  if (!ID.test(normalized)) fail('invalid_id', `${label} contains unsupported characters`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('invalid_timestamp', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function clockTimestamp(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_clock', 'clock must return a valid time');
  return date.toISOString();
}

function digest(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('invalid_digest', `${label} must be sha256:<64 lowercase hexadecimal characters>`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function boolean(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== 'boolean') fail('invalid_boolean', `${label} must be boolean`);
  return resolved;
}

function positiveInteger(value, fallback, label, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    fail('invalid_integer', `${label} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

export function createReviewPolicy(input = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'policyId', 'policyVersion', 'minimumIndependentHumanApprovals',
    'approvalValidityDays', 'trustedIdentityProviders', 'requirePackage', 'requireSms',
    'requireEval', 'disallowSubmitterApproval', 'policyDigest',
  ]), 'policy');
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_POLICY_SCHEMA_VERSION) {
    fail('unsupported_schema', `policy schemaVersion must be ${REVIEW_POLICY_SCHEMA_VERSION}`);
  }
  const providers = input.trustedIdentityProviders;
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 50) {
    fail('invalid_identity_providers', 'trustedIdentityProviders must be a non-empty array within limits');
  }
  const trustedIdentityProviders = [...new Set(providers.map((value, index) => id(value, `trustedIdentityProviders[${index}]`)))].sort();
  if (trustedIdentityProviders.length !== providers.length) fail('duplicate_identity_provider', 'trustedIdentityProviders must not contain duplicates');
  const policy = {
    schemaVersion: REVIEW_POLICY_SCHEMA_VERSION,
    policyId: id(input.policyId, 'policyId'),
    policyVersion: id(input.policyVersion, 'policyVersion'),
    minimumIndependentHumanApprovals: positiveInteger(input.minimumIndependentHumanApprovals, 2, 'minimumIndependentHumanApprovals', 10),
    approvalValidityDays: positiveInteger(input.approvalValidityDays, 90, 'approvalValidityDays', 365),
    trustedIdentityProviders,
    requirePackage: boolean(input.requirePackage, true, 'requirePackage'),
    requireSms: boolean(input.requireSms, true, 'requireSms'),
    requireEval: boolean(input.requireEval, true, 'requireEval'),
    disallowSubmitterApproval: boolean(input.disallowSubmitterApproval, true, 'disallowSubmitterApproval'),
  };
  if (policy.minimumIndependentHumanApprovals < 2) fail('four_eyes_required', 'minimumIndependentHumanApprovals must be at least 2');
  const policyDigest = sha256(policy);
  if (input.policyDigest !== undefined && input.policyDigest !== policyDigest) fail('policy_digest_mismatch', 'policyDigest does not match policy content');
  return Object.freeze({ ...policy, policyDigest });
}

export function createReviewEvidenceSnapshot(input = {}, { policy: policyInput } = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'contentFingerprint', 'packageDigest', 'licenseDigest', 'smsDigest',
    'evalDigest', 'policyDigest', 'evidenceDigest',
  ]), 'evidence snapshot');
  const policy = createReviewPolicy(policyInput);
  if (input.schemaVersion !== undefined && input.schemaVersion !== REVIEW_POLICY_SCHEMA_VERSION) {
    fail('unsupported_schema', `evidence schemaVersion must be ${REVIEW_POLICY_SCHEMA_VERSION}`);
  }
  const packageDigest = digest(input.packageDigest, 'packageDigest', !policy.requirePackage);
  const smsDigest = digest(input.smsDigest, 'smsDigest', !policy.requireSms);
  const evalDigest = digest(input.evalDigest, 'evalDigest', !policy.requireEval);
  if (policy.requirePackage && !packageDigest) fail('package_required', 'policy requires current package evidence');
  if (policy.requireSms && !smsDigest) fail('sms_required', 'policy requires current SMS evidence');
  if (policy.requireEval && !evalDigest) fail('eval_required', 'policy requires current Eval evidence');
  const snapshot = {
    schemaVersion: REVIEW_POLICY_SCHEMA_VERSION,
    contentFingerprint: digest(input.contentFingerprint, 'contentFingerprint'),
    packageDigest,
    licenseDigest: digest(input.licenseDigest, 'licenseDigest'),
    smsDigest,
    evalDigest,
    policyDigest: policy.policyDigest,
  };
  if (input.policyDigest !== undefined && input.policyDigest !== policy.policyDigest) fail('policy_digest_mismatch', 'snapshot policyDigest is stale');
  const evidenceDigest = sha256(snapshot);
  if (input.evidenceDigest !== undefined && input.evidenceDigest !== evidenceDigest) fail('evidence_digest_mismatch', 'evidenceDigest does not match evidence content');
  return Object.freeze({ ...snapshot, evidenceDigest });
}

function normalizeReviewer(input, policy, at) {
  exactKeys(input, new Set(['kind', 'principalId', 'subject', 'provider', 'displayName', 'verification']), 'reviewer');
  const kind = text(input.kind, 'reviewer.kind', 32);
  if (kind !== 'human' && kind !== 'agent') fail('invalid_reviewer_kind', 'reviewer.kind must be human or agent');
  const reviewer = {
    kind,
    principalId: id(input.principalId, 'reviewer.principalId'),
    subject: id(input.subject, 'reviewer.subject'),
    provider: id(input.provider, 'reviewer.provider'),
    displayName: input.displayName === undefined ? null : text(input.displayName, 'reviewer.displayName', 256),
  };
  exactKeys(input.verification, new Set(['status', 'verifiedAt', 'expiresAt', 'reference']), 'reviewer.verification');
  const expectedStatus = kind === 'human' ? 'verified' : 'service';
  if (input.verification.status !== expectedStatus) fail('identity_not_verified', `${kind} reviewer verification status must be ${expectedStatus}`);
  const verifiedAt = timestamp(input.verification.verifiedAt, 'reviewer.verification.verifiedAt');
  const expiresAt = input.verification.expiresAt == null ? null : timestamp(input.verification.expiresAt, 'reviewer.verification.expiresAt');
  if (Date.parse(verifiedAt) > Date.parse(at) || (expiresAt && Date.parse(expiresAt) <= Date.parse(at))) {
    fail('identity_not_current', 'reviewer identity verification is not current at attestation time');
  }
  if (kind === 'human' && !policy.trustedIdentityProviders.includes(reviewer.provider)) {
    fail('untrusted_identity_provider', 'human reviewer provider is not trusted by the current policy');
  }
  reviewer.verification = {
    status: expectedStatus,
    verifiedAt,
    expiresAt,
    reference: text(input.verification.reference, 'reviewer.verification.reference', 512),
  };
  return Object.freeze(reviewer);
}

function evidence(snapshotInput, policy) {
  return createReviewEvidenceSnapshot(snapshotInput, { policy });
}

export function createReviewAttestation(input = {}, { policy: policyInput, snapshot: snapshotInput, clock } = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'type', 'decision', 'recommendation', 'reviewer', 'reason', 'at',
    'validUntil', 'basedOnEvidenceDigest', 'basedOnPolicyDigest',
  ]), 'review attestation');
  const policy = createReviewPolicy(policyInput);
  const snapshot = evidence(snapshotInput, policy);
  const at = input.at === undefined ? clockTimestamp(clock) : timestamp(input.at, 'at');
  const reviewer = normalizeReviewer(input.reviewer, policy, at);
  const type = input.type ?? (reviewer.kind === 'human' ? 'human_review' : 'agent_assisted');
  if ((reviewer.kind === 'human' && type !== 'human_review') || (reviewer.kind === 'agent' && type !== 'agent_assisted')) {
    fail('reviewer_type_mismatch', 'attestation type must match reviewer kind');
  }
  let decision;
  let recommendation = null;
  let validUntil = null;
  if (type === 'human_review') {
    decision = text(input.decision, 'decision', 32);
    if (!HUMAN_DECISIONS.has(decision)) fail('invalid_decision', 'human decision is unsupported');
    if (input.recommendation !== undefined) fail('invalid_recommendation', 'human review must not contain an agent recommendation');
    if (decision === 'approve') {
      const maximum = Date.parse(at) + policy.approvalValidityDays * 86_400_000;
      validUntil = input.validUntil === undefined ? new Date(maximum).toISOString() : timestamp(input.validUntil, 'validUntil');
      if (Date.parse(validUntil) <= Date.parse(at) || Date.parse(validUntil) > maximum) {
        fail('invalid_validity', 'approval validity must be positive and within policy approvalValidityDays');
      }
    } else if (input.validUntil !== undefined) {
      fail('invalid_validity', 'only approvals have validUntil');
    }
  } else {
    if (input.decision !== undefined && input.decision !== 'advisory') fail('agent_cannot_decide', 'agent-assisted review cannot approve, reject, or request changes');
    decision = 'advisory';
    recommendation = text(input.recommendation, 'recommendation', 32);
    if (!['approve', 'reject', 'request_changes'].includes(recommendation)) fail('invalid_recommendation', 'agent recommendation is unsupported');
    if (input.validUntil !== undefined) fail('agent_cannot_decide', 'agent-assisted review cannot create approval validity');
  }
  if (input.basedOnEvidenceDigest !== undefined && input.basedOnEvidenceDigest !== snapshot.evidenceDigest) {
    fail('evidence_digest_mismatch', 'attestation does not match the supplied evidence snapshot');
  }
  if (input.basedOnPolicyDigest !== undefined && input.basedOnPolicyDigest !== policy.policyDigest) {
    fail('policy_digest_mismatch', 'attestation does not match the current policy');
  }
  const body = {
    schemaVersion: REVIEW_POLICY_SCHEMA_VERSION,
    type,
    decision,
    recommendation,
    reviewer,
    reason: text(input.reason, 'reason', 4_000),
    at,
    validUntil,
    basedOnEvidenceDigest: snapshot.evidenceDigest,
    basedOnPolicyDigest: policy.policyDigest,
    evidenceSnapshot: snapshot,
  };
  return Object.freeze({
    ...body,
    id: `review_attestation_${sha256(body).slice(-24)}`,
  });
}

export function createReviewLifecycleEvent(input = {}, { policy: policyInput, snapshot: snapshotInput, clock } = {}) {
  exactKeys(input, new Set(['schemaVersion', 'action', 'actor', 'reason', 'at']), 'review lifecycle event');
  const policy = createReviewPolicy(policyInput);
  const snapshot = evidence(snapshotInput, policy);
  const at = input.at === undefined ? clockTimestamp(clock) : timestamp(input.at, 'at');
  const actor = normalizeReviewer(input.actor, policy, at);
  if (actor.kind !== 'human') fail('human_control_required', 'review lifecycle controls require a verified human actor');
  const action = text(input.action, 'action', 32);
  if (!LIFECYCLE_ACTIONS.has(action)) fail('invalid_lifecycle_action', 'review lifecycle action is unsupported');
  const body = {
    schemaVersion: REVIEW_POLICY_SCHEMA_VERSION,
    action,
    actor,
    reason: text(input.reason, 'reason', 4_000),
    at,
    basedOnEvidenceDigest: snapshot.evidenceDigest,
    basedOnPolicyDigest: policy.policyDigest,
  };
  return Object.freeze({ ...body, id: `review_lifecycle_${sha256(body).slice(-24)}` });
}

function validatedCurrentAttestation(event, policy, snapshot) {
  try {
    if (!event?.id || event.basedOnEvidenceDigest !== snapshot.evidenceDigest || event.basedOnPolicyDigest !== policy.policyDigest) return null;
    const validated = createReviewAttestation({
      schemaVersion: event.schemaVersion,
      type: event.type,
      decision: event.decision,
      ...(event.recommendation == null ? {} : { recommendation: event.recommendation }),
      reviewer: event.reviewer,
      reason: event.reason,
      at: event.at,
      ...(event.validUntil == null ? {} : { validUntil: event.validUntil }),
      basedOnEvidenceDigest: event.basedOnEvidenceDigest,
      basedOnPolicyDigest: event.basedOnPolicyDigest,
    }, { policy, snapshot });
    return event.id === validated.id ? validated : null;
  } catch {
    return null;
  }
}

function validatedCurrentLifecycleEvent(event, policy, snapshot) {
  try {
    if (!event?.id || event.basedOnEvidenceDigest !== snapshot.evidenceDigest || event.basedOnPolicyDigest !== policy.policyDigest) return null;
    const validated = createReviewLifecycleEvent({
      schemaVersion: event.schemaVersion,
      action: event.action,
      actor: event.actor,
      reason: event.reason,
      at: event.at,
    }, { policy, snapshot });
    return event.id === validated.id ? validated : null;
  } catch {
    return null;
  }
}

const CHANGE_FIELDS = Object.freeze([
  ['contentFingerprint', 'content_changed'],
  ['packageDigest', 'package_changed'],
  ['licenseDigest', 'license_changed'],
  ['smsDigest', 'sms_changed'],
  ['evalDigest', 'eval_changed'],
  ['policyDigest', 'policy_changed'],
]);

export function reviewEvidenceChanges(previous, current) {
  object(previous, 'previous evidence snapshot');
  object(current, 'current evidence snapshot');
  return CHANGE_FIELDS.filter(([field]) => previous[field] !== current[field]).map(([, reason]) => reason);
}

export function evaluateReviewCertification({
  policy: policyInput,
  snapshot: snapshotInput,
  attestations = [],
  lifecycleEvents = [],
  submitterPrincipalId = null,
  conflictedPrincipalIds = [],
  now,
} = {}) {
  const policy = createReviewPolicy(policyInput);
  const snapshot = evidence(snapshotInput, policy);
  if (!Array.isArray(attestations) || !Array.isArray(lifecycleEvents)) fail('invalid_events', 'attestations and lifecycleEvents must be arrays');
  const evaluatedAt = now === undefined ? clockTimestamp() : timestamp(now instanceof Date ? now.toISOString() : now, 'now');
  const conflicts = new Set(conflictedPrincipalIds.map((value, index) => id(value, `conflictedPrincipalIds[${index}]`)));
  if (policy.disallowSubmitterApproval && submitterPrincipalId != null) conflicts.add(id(submitterPrincipalId, 'submitterPrincipalId'));

  const applicableControls = lifecycleEvents
    .map(event => validatedCurrentLifecycleEvent(event, policy, snapshot))
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const terminalControl = [...applicableControls].reverse().find(event => event.action === 'recall' || event.action === 'withdraw');
  if (terminalControl) {
    return Object.freeze({
      status: terminalControl.action === 'recall' ? 'recalled' : 'withdrawn',
      reasons: [`review_${terminalControl.action}`],
      approvals: [], requiredApprovals: policy.minimumIndependentHumanApprovals,
      validUntil: null, evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
    });
  }

  const matchingHuman = attestations
    .map(event => validatedCurrentAttestation(event, policy, snapshot))
    .filter(event => event?.type === 'human_review' && event?.reviewer?.kind === 'human')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestBlock = [...matchingHuman].reverse().find(event => event.decision === 'reject' || event.decision === 'request_changes');
  const afterBlock = latestBlock ? matchingHuman.filter(event => Date.parse(event.at) > Date.parse(latestBlock.at)) : matchingHuman;
  const latestApprovalByPrincipal = new Map();
  for (const event of afterBlock) {
    if (event.decision === 'approve' && !conflicts.has(event.reviewer.principalId)) {
      latestApprovalByPrincipal.set(event.reviewer.principalId, event);
    }
  }
  const allApprovals = [...latestApprovalByPrincipal.values()];
  const activeApprovals = allApprovals.filter(event => event.validUntil && Date.parse(event.validUntil) > Date.parse(evaluatedAt));
  const requiredApprovals = policy.minimumIndependentHumanApprovals;
  if (activeApprovals.length >= requiredApprovals) {
    const approvals = activeApprovals.slice(-requiredApprovals);
    return Object.freeze({
      status: 'certified', reasons: [], approvals: Object.freeze(approvals), requiredApprovals,
      validUntil: approvals.map(event => event.validUntil).sort()[0],
      evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
    });
  }
  if (latestBlock && allApprovals.length < requiredApprovals) {
    return Object.freeze({
      status: latestBlock.decision === 'reject' ? 'rejected' : 'changes_requested',
      reasons: [latestBlock.decision === 'reject' ? 'human_rejected' : 'human_requested_changes'],
      approvals: Object.freeze(activeApprovals), requiredApprovals, validUntil: null,
      evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
    });
  }
  if (allApprovals.length >= requiredApprovals) {
    return Object.freeze({
      status: 'expired', reasons: ['approval_expired'], approvals: Object.freeze(activeApprovals), requiredApprovals,
      validUntil: null, evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
    });
  }
  const priorHumanApprovals = attestations.filter(event => event?.type === 'human_review' && event?.decision === 'approve');
  const staleReasons = [...new Set(priorHumanApprovals.flatMap(event => {
    if (!event.evidenceSnapshot) return event.basedOnPolicyDigest !== policy.policyDigest ? ['policy_changed'] : ['evidence_changed'];
    return reviewEvidenceChanges(event.evidenceSnapshot, snapshot);
  }))];
  if (staleReasons.length) {
    return Object.freeze({
      status: 'stale', reasons: Object.freeze(staleReasons), approvals: Object.freeze(activeApprovals), requiredApprovals,
      validUntil: null, evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
    });
  }
  const reasons = [];
  if (conflicts.size && matchingHuman.some(event => conflicts.has(event.reviewer.principalId))) reasons.push('conflicted_reviewer_excluded');
  reasons.push('four_eyes_incomplete');
  return Object.freeze({
    status: 'pending', reasons: Object.freeze(reasons), approvals: Object.freeze(activeApprovals), requiredApprovals,
    validUntil: null, evaluatedAt, evidenceDigest: snapshot.evidenceDigest, policyDigest: policy.policyDigest,
  });
}
