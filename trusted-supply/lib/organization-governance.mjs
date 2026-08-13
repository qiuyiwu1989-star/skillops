import crypto from 'node:crypto';

import { releaseId as calculateRegistryReleaseId } from './registry-identity.mjs';

export const ORGANIZATION_GOVERNANCE_SCHEMA_VERSION = 1;

const ROLES = new Set(['viewer', 'member', 'reviewer', 'operator', 'org_admin']);
const RELEASE_STATUSES = new Set(['published', 'superseded', 'withdrawn', 'revoked']);
const ALLOWED_POLICY_RELEASE_STATUSES = new Set(['published', 'superseded']);
const EVENT_TYPES = new Set([
  'organization.created', 'organization.updated',
  'project.created', 'project.updated', 'project.retired', 'project.restored',
  'establishment.created', 'establishment.updated', 'establishment.retired', 'establishment.restored',
  'enrollment.created', 'enrollment.updated', 'enrollment.retired', 'enrollment.restored',
  'policy.changed', 'role.bound', 'role.unbound',
]);
const ID = /^[a-z][a-z0-9._:-]{1,127}$/;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_KEY = /(?:principal|reviewer|subjectId|email|path|storageRef|prompt|output|token|secret|password|credential|api[_-]?key|content)/i;

export class OrganizationGovernanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OrganizationGovernanceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrganizationGovernanceError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function text(value, label, { maximum = 512, pattern } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${label} is invalid`);
  }
  return normalized;
}

function identifier(value, label) {
  return text(value, label, { maximum: 128, pattern: ID });
}

function timestamp(value, label) {
  const normalized = text(value, label, { maximum: 128 });
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizedNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TIMESTAMP', 'now must be a valid timestamp');
  return date.toISOString();
}

function trustedEventTime(input, now) {
  const trustedAt = normalizedNow(now);
  if (input !== undefined && timestamp(input, 'event.occurredAt') !== trustedAt) {
    fail('EVENT_TIME_UNTRUSTED', 'event.occurredAt must exactly match trusted now');
  }
  return trustedAt;
}

function number(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    fail('INVALID_NUMBER', `${label} is invalid`);
  }
  return value;
}

function emptyProjection() {
  return {
    schemaVersion: ORGANIZATION_GOVERNANCE_SCHEMA_VERSION,
    throughSequence: 0,
    organizations: {}, projects: {}, establishments: {}, enrollments: {}, policies: {}, roleBindings: {},
    auditEvents: [], operationClaims: {},
  };
}

function defaultPolicy(organizationId) {
  return {
    schemaVersion: 1,
    organizationId,
    minimumSmsScore: 0,
    minimumEvalSuccessRate: 0,
    minimumHumanApprovals: 2,
    requireVersionLock: true,
    allowedReleaseStatuses: ['published'],
  };
}

function normalizePolicy(input, organizationId, previous = defaultPolicy(organizationId)) {
  object(input, 'policy');
  const result = {
    schemaVersion: 1,
    organizationId,
    minimumSmsScore: input.minimumSmsScore === undefined ? previous.minimumSmsScore : number(input.minimumSmsScore, 'policy.minimumSmsScore', { minimum: 0, maximum: 100 }),
    minimumEvalSuccessRate: input.minimumEvalSuccessRate === undefined ? previous.minimumEvalSuccessRate : number(input.minimumEvalSuccessRate, 'policy.minimumEvalSuccessRate', { minimum: 0, maximum: 1 }),
    minimumHumanApprovals: input.minimumHumanApprovals === undefined ? previous.minimumHumanApprovals : number(input.minimumHumanApprovals, 'policy.minimumHumanApprovals', { minimum: 2, maximum: 20, integer: true }),
    requireVersionLock: input.requireVersionLock === undefined ? previous.requireVersionLock : input.requireVersionLock,
    allowedReleaseStatuses: input.allowedReleaseStatuses === undefined ? previous.allowedReleaseStatuses : input.allowedReleaseStatuses,
  };
  if (typeof result.requireVersionLock !== 'boolean') fail('INVALID_POLICY', 'policy.requireVersionLock must be boolean');
  if (!Array.isArray(result.allowedReleaseStatuses) || !result.allowedReleaseStatuses.length) fail('INVALID_POLICY', 'policy.allowedReleaseStatuses must not be empty');
  result.allowedReleaseStatuses = [...new Set(result.allowedReleaseStatuses.map(status => {
    if (!ALLOWED_POLICY_RELEASE_STATUSES.has(status)) fail('INVALID_POLICY', `policy release status is not allowed: ${status}`);
    return status;
  }))].sort();
  return result;
}

function entity(input, kind, organizationId, { capacity = false } = {}) {
  object(input, kind);
  const idName = `${kind}Id`;
  const result = {
    [idName]: identifier(input[idName], `${kind}.${idName}`),
    organizationId,
    name: text(input.name, `${kind}.name`, { maximum: 256 }),
    status: 'active',
  };
  if (input.projectId !== undefined) result.projectId = identifier(input.projectId, `${kind}.projectId`);
  if (capacity) result.capacity = number(input.capacity, `${kind}.capacity`, { minimum: 1, maximum: 100_000, integer: true });
  return result;
}

function bindingId(binding) {
  return `rb_${digest({ organizationId: binding.organizationId, projectId: binding.projectId, principalId: binding.principalId, role: binding.role }).slice(7, 39)}`;
}

function normalizeRoleBinding(input, organizationId) {
  object(input, 'roleBinding');
  const role = text(input.role, 'roleBinding.role', { maximum: 32 });
  if (!ROLES.has(role)) fail('INVALID_ROLE', `unsupported role: ${role}`);
  const result = {
    organizationId,
    principalId: text(input.principalId, 'roleBinding.principalId', { maximum: 256 }),
    role,
    projectId: input.projectId == null ? null : identifier(input.projectId, 'roleBinding.projectId'),
    status: 'active',
  };
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) result.metadata = clone(input.metadata);
  result.roleBindingId = bindingId(result);
  return result;
}

function actorBindings(projection, organizationId, principalId) {
  return Object.values(projection.roleBindings).filter(row => row.organizationId === organizationId && row.principalId === principalId && row.status === 'active');
}

function targetProjectId(projection, event) {
  if (event.payload?.project?.projectId) return event.payload.project.projectId;
  if (event.payload?.establishment?.projectId) return event.payload.establishment.projectId;
  if (event.payload?.roleBinding?.projectId) return event.payload.roleBinding.projectId;
  const establishmentId = event.payload?.enrollment?.establishmentId ?? event.subject?.establishmentId;
  if (establishmentId) return projection.establishments[establishmentId]?.projectId ?? null;
  for (const key of ['projectId', 'establishmentId', 'enrollmentId']) {
    const id = event.subject?.[key];
    if (key === 'projectId' && id) return id;
    if (key === 'establishmentId' && projection.establishments[id]) return projection.establishments[id].projectId ?? null;
    if (key === 'enrollmentId' && projection.enrollments[id]) {
      return projection.establishments[projection.enrollments[id].establishmentId]?.projectId ?? null;
    }
  }
  return null;
}

function authorize(projection, event) {
  if (event.type === 'organization.created') {
    if (projection.organizations[event.organizationId]) fail('ENTITY_EXISTS', 'organization already exists');
    return;
  }
  if (!projection.organizations[event.organizationId]) fail('ORGANIZATION_NOT_FOUND', 'organization does not exist');
  const bindings = actorBindings(projection, event.organizationId, event.actorPrincipalId);
  if (bindings.some(row => row.role === 'org_admin')) return;
  const sensitiveAdmin = event.type.startsWith('organization.') || event.type === 'policy.changed' || event.type.startsWith('role.');
  if (sensitiveAdmin) fail('FORBIDDEN', 'organization administration requires org_admin');
  const projectId = targetProjectId(projection, event);
  const operator = bindings.find(row => row.role === 'operator' && (row.projectId === null || row.projectId === projectId));
  if (operator && (event.type.startsWith('project.') || event.type.startsWith('establishment.') || event.type.startsWith('enrollment.'))) return;
  fail('FORBIDDEN', 'actor is not authorized for this governance action');
}

function requireOwned(map, id, organizationId, label) {
  const value = map[id];
  if (!value || value.organizationId !== organizationId) fail('ENTITY_NOT_FOUND', `${label} does not exist in this organization`);
  return value;
}

function evidenceExpiry(evidence, at) {
  for (const field of ['reviewValidUntil', 'evalValidUntil', 'packageAuditValidUntil', 'licenseValidUntil']) {
    if (!evidence[field] || Date.parse(evidence[field]) <= Date.parse(at)) return field;
  }
  return null;
}

function validateRegistryRelease(input, enrollment, policy, at) {
  const release = object(input, 'registryRelease');
  if (!SKILL_ID.test(enrollment.skillId) || /^cand_/i.test(enrollment.skillId) || enrollment.skillId.split('/').some(part => /^cand_/i.test(part))) {
    fail('CANDIDATE_ID_FORBIDDEN', 'enrollment skillId must not use Candidate identity');
  }
  if (enrollment.releaseId === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', 'enrollment must bind an explicit releaseId');
  if (!RELEASE_ID.test(enrollment.releaseId)) fail('INVALID_RELEASE_ID', 'enrollment releaseId is invalid');
  if (release.skillId !== enrollment.skillId || release.releaseId !== enrollment.releaseId) fail('RELEASE_IDENTITY_MISMATCH', 'Registry Release identity does not match enrollment');
  if (!RELEASE_STATUSES.has(release.status) || release.status !== 'published' || !policy.allowedReleaseStatuses.includes(release.status)) {
    fail('RELEASE_STATUS_BLOCKED', `Registry Release status is blocked: ${release.status}`);
  }
  let calculatedReleaseId;
  try {
    calculatedReleaseId = calculateRegistryReleaseId({
      skillId: release.skillId,
      version: release.version,
      packageDigest: release.packageDigest,
    });
  } catch (error) {
    fail('RELEASE_IDENTITY_INVALID', `Registry Release identity cannot be recomputed: ${error.message}`);
  }
  if (calculatedReleaseId !== release.releaseId) fail('RELEASE_IDENTITY_MISMATCH', 'Registry Release identity cannot be recomputed from skillId, version and packageDigest');
  if (policy.requireVersionLock && release.versionLocked !== true) fail('VERSION_LOCK_REQUIRED', 'organization policy requires an immutable version lock');
  if (Number(release.sms?.total) < policy.minimumSmsScore) fail('SMS_POLICY_NOT_MET', 'Release SMS score does not meet organization policy');
  if (Number(release.eval?.successRate) < policy.minimumEvalSuccessRate) fail('EVAL_POLICY_NOT_MET', 'Release Eval success rate does not meet organization policy');
  if (release.certification?.status !== 'certified' || Number(release.certification?.humanApprovals) < policy.minimumHumanApprovals) {
    fail('CERTIFICATION_REQUIRED', 'Release does not have enough current independent human approvals');
  }
  const evidence = object(release.evidence, 'registryRelease.evidence');
  const expired = evidenceExpiry(evidence, at);
  if (expired) fail('EVIDENCE_EXPIRED', `Release evidence is absent or expired: ${expired}`);
  const publicEvidence = {
    schemaVersion: 1,
    releaseId: release.releaseId,
    skillId: release.skillId,
    status: release.status,
    version: release.version,
    packageDigest: release.packageDigest,
    versionLocked: release.versionLocked,
    smsTotal: release.sms.total,
    evalSuccessRate: release.eval.successRate,
    certificationStatus: release.certification.status,
    humanApprovals: release.certification.humanApprovals,
    evidence: Object.fromEntries(Object.entries(evidence).filter(([key]) => key.endsWith('ValidUntil')).map(([key, value]) => [key, timestamp(value, `registryRelease.evidence.${key}`)])),
  };
  return { snapshot: publicEvidence, evidenceDigest: digest(publicEvidence) };
}

function validatePersistedReleaseEvidence(enrollment, policy, at) {
  const snapshot = object(enrollment.releaseEvidenceSnapshot, 'enrollment.releaseEvidenceSnapshot');
  const assertedDigest = text(enrollment.releaseEvidenceDigest, 'enrollment.releaseEvidenceDigest', { pattern: DIGEST });
  if (digest(snapshot) !== assertedDigest) fail('RELEASE_EVIDENCE_DIGEST_MISMATCH', 'persisted Release evidence snapshot digest does not match');
  const checked = validateRegistryRelease({
    releaseId: snapshot.releaseId,
    skillId: snapshot.skillId,
    version: snapshot.version,
    packageDigest: snapshot.packageDigest,
    status: snapshot.status,
    versionLocked: snapshot.versionLocked,
    sms: { total: snapshot.smsTotal },
    eval: { successRate: snapshot.evalSuccessRate },
    certification: { status: snapshot.certificationStatus, humanApprovals: snapshot.humanApprovals },
    evidence: snapshot.evidence,
  }, enrollment, policy, at);
  if (checked.evidenceDigest !== assertedDigest) fail('RELEASE_EVIDENCE_DIGEST_MISMATCH', 'persisted Release evidence snapshot is not canonical');
  return checked;
}

function normalizeSubject(input, organizationId) {
  object(input, 'event.subject');
  const result = {};
  for (const key of ['organizationId', 'projectId', 'establishmentId', 'enrollmentId', 'roleBindingId']) {
    if (input[key] !== undefined) result[key] = identifier(input[key], `event.subject.${key}`);
  }
  if (result.organizationId && result.organizationId !== organizationId) fail('ORGANIZATION_MISMATCH', 'subject belongs to another organization');
  if (!Object.keys(result).length) fail('INVALID_SUBJECT', 'event subject must identify an entity');
  return result;
}

function normalizeEvent(input, projection, { registryResolver, now, replay = false } = {}) {
  object(input, 'event');
  const schemaVersion = input.schemaVersion ?? ORGANIZATION_GOVERNANCE_SCHEMA_VERSION;
  if (schemaVersion !== ORGANIZATION_GOVERNANCE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported organization governance schema');
  const type = text(input.type, 'event.type', { maximum: 64 });
  if (!EVENT_TYPES.has(type)) fail('UNKNOWN_EVENT_TYPE', `unsupported organization event type: ${type}`);
  const organizationId = identifier(input.organizationId, 'event.organizationId');
  const event = {
    schemaVersion,
    operationId: identifier(input.operationId, 'event.operationId'),
    type,
    occurredAt: replay ? timestamp(input.occurredAt, 'event.occurredAt') : trustedEventTime(input.occurredAt, now),
    actorPrincipalId: text(input.actorPrincipalId, 'event.actorPrincipalId', { maximum: 256 }),
    organizationId,
    subject: normalizeSubject(input.subject, organizationId),
    payload: clone(object(input.payload, 'event.payload')),
  };
  if (type === 'enrollment.created' || type === 'enrollment.updated' || type === 'enrollment.restored') {
    const enrollment = object(event.payload.enrollment, 'event.payload.enrollment');
    if (!replay) {
      if (typeof registryResolver !== 'function') fail('RELEASE_RESOLVER_REQUIRED', 'enrollment governance requires a trusted Registry resolver');
      const requestedSkillId = text(enrollment.skillId, 'enrollment.skillId', { maximum: 128 });
      const requestedReleaseId = text(enrollment.releaseId, 'enrollment.releaseId', { maximum: 80 });
      if (!SKILL_ID.test(requestedSkillId) || /^cand_/i.test(requestedSkillId) || requestedSkillId.split('/').some(part => /^cand_/i.test(part))) {
        fail('CANDIDATE_ID_FORBIDDEN', 'enrollment cannot bind Candidate identity');
      }
      if (requestedReleaseId === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', 'enrollment cannot bind latest');
      if (!RELEASE_ID.test(requestedReleaseId)) fail('INVALID_RELEASE_ID', 'enrollment releaseId is invalid');
      const policy = projection.policies[organizationId] ?? defaultPolicy(organizationId);
      const resolved = registryResolver({ skillId: enrollment.skillId, releaseId: enrollment.releaseId });
      const evidence = validateRegistryRelease(resolved, enrollment, policy, event.occurredAt);
      event.payload.enrollment = { ...enrollment, releaseEvidenceSnapshot: evidence.snapshot, releaseEvidenceDigest: evidence.evidenceDigest };
    } else {
      const policy = projection.policies[organizationId] ?? defaultPolicy(organizationId);
      validatePersistedReleaseEvidence(enrollment, policy, event.occurredAt);
    }
  }
  event.operationDigest = digest({ type, actorPrincipalId: event.actorPrincipalId, organizationId, subject: event.subject, payload: event.payload });
  if (input.operationDigest !== undefined && input.operationDigest !== event.operationDigest) fail('OPERATION_DIGEST_MISMATCH', 'operationDigest does not match event');
  event.eventId = `orgevt_${digest({ ...event, operationDigest: undefined }).slice(7)}`;
  if (input.eventId !== undefined && input.eventId !== event.eventId) fail('EVENT_ID_MISMATCH', 'eventId does not match event');
  return event;
}

function ensureSubject(event, kind, id) {
  if (event.subject[`${kind}Id`] !== id) fail('SUBJECT_MISMATCH', `${kind} subject does not match payload`);
}

function lifecycle(map, id, organizationId, status) {
  const row = requireOwned(map, id, organizationId, 'lifecycle subject');
  row.status = status;
}

function apply(projection, event) {
  const orgId = event.organizationId;
  switch (event.type) {
    case 'organization.created': {
      const organization = entity(event.payload.organization, 'organization', orgId);
      ensureSubject(event, 'organization', organization.organizationId);
      if (organization.organizationId !== orgId) fail('ORGANIZATION_MISMATCH', 'organization payload does not match event');
      projection.organizations[orgId] = organization;
      projection.policies[orgId] = defaultPolicy(orgId);
      const owner = normalizeRoleBinding({ principalId: event.actorPrincipalId, role: 'org_admin' }, orgId);
      projection.roleBindings[owner.roleBindingId] = owner;
      break;
    }
    case 'organization.updated': {
      const previous = requireOwned(projection.organizations, orgId, orgId, 'organization');
      projection.organizations[orgId] = { ...previous, name: text(event.payload.organization?.name, 'organization.name', { maximum: 256 }) };
      break;
    }
    case 'project.created': {
      const row = entity(event.payload.project, 'project', orgId);
      ensureSubject(event, 'project', row.projectId);
      if (projection.projects[row.projectId]) fail('ENTITY_EXISTS', 'project already exists');
      projection.projects[row.projectId] = row;
      break;
    }
    case 'project.updated': {
      const input = object(event.payload.project, 'project');
      const row = requireOwned(projection.projects, input.projectId, orgId, 'project');
      ensureSubject(event, 'project', row.projectId);
      row.name = text(input.name, 'project.name', { maximum: 256 });
      break;
    }
    case 'project.retired': lifecycle(projection.projects, event.subject.projectId, orgId, 'retired'); break;
    case 'project.restored': lifecycle(projection.projects, event.subject.projectId, orgId, 'active'); break;
    case 'establishment.created': {
      const row = entity(event.payload.establishment, 'establishment', orgId, { capacity: true });
      ensureSubject(event, 'establishment', row.establishmentId);
      if (row.projectId) requireOwned(projection.projects, row.projectId, orgId, 'project');
      if (projection.establishments[row.establishmentId]) fail('ENTITY_EXISTS', 'establishment already exists');
      projection.establishments[row.establishmentId] = row;
      break;
    }
    case 'establishment.updated': {
      const input = object(event.payload.establishment, 'establishment');
      const row = requireOwned(projection.establishments, input.establishmentId, orgId, 'establishment');
      ensureSubject(event, 'establishment', row.establishmentId);
      if (input.name !== undefined) row.name = text(input.name, 'establishment.name', { maximum: 256 });
      if (input.capacity !== undefined) row.capacity = number(input.capacity, 'establishment.capacity', { minimum: 1, maximum: 100_000, integer: true });
      break;
    }
    case 'establishment.retired': lifecycle(projection.establishments, event.subject.establishmentId, orgId, 'retired'); break;
    case 'establishment.restored': lifecycle(projection.establishments, event.subject.establishmentId, orgId, 'active'); break;
    case 'enrollment.created':
    case 'enrollment.updated':
    case 'enrollment.restored': {
      const input = object(event.payload.enrollment, 'enrollment');
      const enrollmentId = identifier(input.enrollmentId, 'enrollment.enrollmentId');
      ensureSubject(event, 'enrollment', enrollmentId);
      const establishmentId = identifier(input.establishmentId, 'enrollment.establishmentId');
      requireOwned(projection.establishments, establishmentId, orgId, 'establishment');
      const skillId = text(input.skillId, 'enrollment.skillId', { maximum: 128 });
      const releaseId = text(input.releaseId, 'enrollment.releaseId', { maximum: 80 });
      if (!SKILL_ID.test(skillId) || /^cand_/i.test(skillId) || skillId.split('/').some(part => /^cand_/i.test(part))) fail('CANDIDATE_ID_FORBIDDEN', 'enrollment cannot bind Candidate identity');
      if (releaseId === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', 'enrollment cannot bind latest');
      if (!RELEASE_ID.test(releaseId)) fail('INVALID_RELEASE_ID', 'enrollment releaseId is invalid');
      const previous = projection.enrollments[enrollmentId];
      if (event.type === 'enrollment.created' && previous) fail('ENTITY_EXISTS', 'enrollment already exists');
      projection.enrollments[enrollmentId] = {
        enrollmentId, organizationId: orgId, establishmentId, skillId, releaseId,
        releaseEvidenceDigest: text(input.releaseEvidenceDigest, 'enrollment.releaseEvidenceDigest', { pattern: DIGEST }),
        releaseEvidenceSnapshot: clone(object(input.releaseEvidenceSnapshot, 'enrollment.releaseEvidenceSnapshot')),
        status: 'active',
      };
      break;
    }
    case 'enrollment.retired': lifecycle(projection.enrollments, event.subject.enrollmentId, orgId, 'retired'); break;
    case 'policy.changed':
      projection.policies[orgId] = normalizePolicy(event.payload.policy, orgId, projection.policies[orgId]);
      break;
    case 'role.bound': {
      const row = normalizeRoleBinding(event.payload.roleBinding, orgId);
      if (row.projectId) requireOwned(projection.projects, row.projectId, orgId, 'project');
      projection.roleBindings[row.roleBindingId] = row;
      break;
    }
    case 'role.unbound': {
      const input = object(event.payload.roleBinding, 'roleBinding');
      const row = normalizeRoleBinding(input, orgId);
      const current = requireOwned(projection.roleBindings, row.roleBindingId, orgId, 'role binding');
      current.status = 'inactive';
      break;
    }
    default: fail('UNKNOWN_EVENT_TYPE', `unsupported event type: ${event.type}`);
  }
  projection.throughSequence = event.sequence;
  projection.operationClaims[event.operationId] = { operationDigest: event.operationDigest, eventId: event.eventId, sequence: event.sequence };
  projection.auditEvents.push({
    auditEventId: `audit_${event.eventId.slice(-40)}`,
    sequence: event.sequence,
    eventId: event.eventId,
    operationId: event.operationId,
    organizationId: orgId,
    type: event.type,
    occurredAt: event.occurredAt,
    actorPrincipalId: event.actorPrincipalId,
    actorRole: event.type === 'organization.created' ? 'org_admin' : (actorBindings(projection, orgId, event.actorPrincipalId)[0]?.role ?? 'unknown'),
    subject: clone(event.subject),
    operationDigest: event.operationDigest,
  });
}

/** Rebuild all organization state solely from an append-only governance event log. */
export function replayOrganizationEvents(events) {
  if (!Array.isArray(events)) fail('INVALID_EVENT_LOG', 'events must be an array');
  const projection = emptyProjection();
  for (let index = 0; index < events.length; index += 1) {
    const input = object(events[index], `events[${index}]`);
    if (input.sequence !== index + 1) fail('SEQUENCE_GAP', `event sequence must be ${index + 1}`);
    const event = { ...normalizeEvent(input, projection, { replay: true }), sequence: input.sequence };
    if (index > 0 && Date.parse(event.occurredAt) < Date.parse(events[index - 1].occurredAt)) {
      fail('EVENT_TIME_REGRESSION', 'event occurredAt must not precede the previous event');
    }
    const claim = projection.operationClaims[event.operationId];
    if (claim) fail(claim.operationDigest === event.operationDigest ? 'DUPLICATE_OPERATION' : 'OPERATION_CONFLICT', 'operationId is not unique in persisted log');
    authorize(projection, event);
    apply(projection, event);
  }
  return projection;
}

/** Validate, authorize and append one event without mutating the caller-owned log. */
export function appendOrganizationEvent(events, input, options = {}) {
  const projection = replayOrganizationEvents(events);
  const event = normalizeEvent(input, projection, options);
  const previous = events.at(-1);
  if (previous && Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)) {
    fail('EVENT_TIME_REGRESSION', 'event occurredAt must not precede the previous event');
  }
  const claim = projection.operationClaims[event.operationId];
  if (claim) {
    if (claim.operationDigest !== event.operationDigest) fail('OPERATION_CONFLICT', 'same operationId cannot bind a different operation digest');
    return { action: 'replayed', event: clone(events[claim.sequence - 1]), events: clone(events), projection };
  }
  authorize(projection, event);
  const persisted = Object.freeze({ ...event, sequence: events.length + 1 });
  const nextEvents = [...clone(events), clone(persisted)];
  apply(projection, persisted);
  return { action: 'appended', event: clone(persisted), events: nextEvents, projection };
}

function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) continue;
      if (typeof nested === 'string' && (/^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/.test(nested) || /^cand_/i.test(nested))) continue;
      result[key] = publicValue(nested);
    }
    return result;
  }
  return value;
}

/** Return an organization-isolated internal or privacy-trimmed public projection. */
export function projectOrganizationGovernance(events, { organizationId: inputOrgId, principalId, public: publicProjection = false } = {}) {
  const organizationId = identifier(inputOrgId, 'organizationId');
  const projection = replayOrganizationEvents(events);
  const organization = projection.organizations[organizationId];
  if (!organization) fail('ORGANIZATION_NOT_FOUND', 'organization does not exist');
  const own = rows => Object.fromEntries(Object.entries(rows).filter(([, row]) => row.organizationId === organizationId));
  const roleBindings = own(projection.roleBindings);
  if (!publicProjection && !Object.values(roleBindings).some(row => row.principalId === principalId && row.status === 'active')) {
    fail('FORBIDDEN', 'principal cannot read this organization');
  }
  const auditEvents = projection.auditEvents.filter(row => row.organizationId === organizationId);
  const result = {
    schemaVersion: 1,
    throughSequence: projection.throughSequence,
    organization: clone(organization),
    projects: own(projection.projects),
    establishments: own(projection.establishments),
    enrollments: own(projection.enrollments),
    policy: clone(projection.policies[organizationId]),
    roleBindings,
    auditEvents,
  };
  if (!publicProjection) return result;
  result.roleSummary = Object.fromEntries([...ROLES].sort().map(role => [role, Object.values(roleBindings).filter(row => row.status === 'active' && row.role === role).length]));
  delete result.roleBindings;
  return publicValue(result);
}
