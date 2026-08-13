import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrganizationGovernanceError,
  appendOrganizationEvent,
  projectOrganizationGovernance,
  replayOrganizationEvents,
} from '../lib/organization-governance.mjs';
import { releaseId } from '../lib/registry-identity.mjs';

const NOW = '2026-08-13T00:00:00.000Z';
const sha = char => `sha256:${char.repeat(64)}`;
const rel = char => `rel_${char.repeat(64)}`;

function release(overrides = {}) {
  const version = overrides.version ?? '1.0.0';
  const packageDigest = overrides.packageDigest ?? sha('a');
  const skillId = overrides.skillId ?? 'qiuyiwu/humanizer';
  return {
    releaseId: releaseId({ skillId, version, packageDigest }),
    skillId,
    version,
    packageDigest,
    status: 'published',
    versionLocked: true,
    sms: { total: 82, tier: 'A' },
    eval: { successRate: 1 },
    certification: { status: 'certified', humanApprovals: 2 },
    evidence: {
      reviewValidUntil: '2026-09-13T00:00:00.000Z',
      evalValidUntil: '2026-09-13T00:00:00.000Z',
      packageAuditValidUntil: '2026-09-13T00:00:00.000Z',
      licenseValidUntil: '2026-09-13T00:00:00.000Z',
    },
    ...overrides,
  };
}

function add(events, input, options = {}) {
  return appendOrganizationEvent(events, {
    schemaVersion: 1,
    occurredAt: NOW,
    actorPrincipalId: 'principal:owner-a',
    organizationId: 'org_yongle',
    ...input,
  }, { now: NOW, ...options });
}

const resolver = value => () => structuredClone(value);

function bootstrap() {
  return add([], {
    operationId: 'op_create_org_a',
    type: 'organization.created',
    subject: { organizationId: 'org_yongle' },
    payload: { organization: { organizationId: 'org_yongle', name: '永乐教育训练营' } },
  }).events;
}

test('organization, project, establishment, policy, role binding and audit are event projections', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_project_a', type: 'project.created', subject: { projectId: 'project_camp' },
    payload: { project: { projectId: 'project_camp', name: '首期训练营' } },
  }).events;
  events = add(events, {
    operationId: 'op_est_a', type: 'establishment.created', subject: { establishmentId: 'est_content' },
    payload: { establishment: { establishmentId: 'est_content', projectId: 'project_camp', name: '内容生产能力编制', capacity: 3 } },
  }).events;
  events = add(events, {
    operationId: 'op_policy_a', type: 'policy.changed', subject: { organizationId: 'org_yongle' },
    payload: { policy: { minimumSmsScore: 75, minimumEvalSuccessRate: 0.9, minimumHumanApprovals: 2, requireVersionLock: true, allowedReleaseStatuses: ['published'] } },
  }).events;
  events = add(events, {
    operationId: 'op_role_a', type: 'role.bound', subject: { organizationId: 'org_yongle' },
    payload: { roleBinding: { principalId: 'principal:operator-a', role: 'operator', projectId: 'project_camp' } },
  }).events;

  const projection = replayOrganizationEvents(events);
  assert.equal(projection.organizations.org_yongle.name, '永乐教育训练营');
  assert.equal(projection.projects.project_camp.organizationId, 'org_yongle');
  assert.equal(projection.establishments.est_content.capacity, 3);
  assert.equal(projection.policies.org_yongle.minimumSmsScore, 75);
  assert.ok(Object.values(projection.roleBindings).some(row => row.role === 'operator'));
  assert.equal(projection.auditEvents.length, events.length);
});

test('enrollment binds an explicit Registry skillId and releaseId', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_est_a', type: 'establishment.created', subject: { establishmentId: 'est_content' },
    payload: { establishment: { establishmentId: 'est_content', name: '内容能力', capacity: 1 } },
  }).events;
  const registryRelease = release();
  const appended = add(events, {
    operationId: 'op_enroll_a', type: 'enrollment.created', subject: { enrollmentId: 'enrollment_humanizer' },
    payload: { enrollment: { enrollmentId: 'enrollment_humanizer', establishmentId: 'est_content', skillId: registryRelease.skillId, releaseId: registryRelease.releaseId } },
  }, { registryResolver: resolver(registryRelease) });
  const enrollment = appended.projection.enrollments.enrollment_humanizer;
  assert.equal(enrollment.skillId, 'qiuyiwu/humanizer');
  assert.equal(enrollment.releaseId, registryRelease.releaseId);
  assert.equal(enrollment.status, 'active');
  assert.match(enrollment.releaseEvidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(enrollment.releaseEvidenceSnapshot.releaseId, registryRelease.releaseId);
});

test('candidate, latest, withdrawn, revoked and expired evidence fail closed', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_est_a', type: 'establishment.created', subject: { establishmentId: 'est_content' },
    payload: { establishment: { establishmentId: 'est_content', name: '内容能力', capacity: 1 } },
  }).events;
  const good = release();
  const enrollment = (id, skillId = 'qiuyiwu/humanizer', explicitReleaseId = good.releaseId) => ({
    operationId: `op_enrollment_${id}`,
    type: 'enrollment.created', subject: { enrollmentId: `enrollment_${id}` },
    payload: { enrollment: { enrollmentId: `enrollment_${id}`, establishmentId: 'est_content', skillId, releaseId: explicitReleaseId } },
  });
  for (const [event, registryRelease, code] of [
    [enrollment('candidate', 'cand_bad/value'), good, 'CANDIDATE_ID_FORBIDDEN'],
    [enrollment('latest', 'qiuyiwu/humanizer', 'latest'), good, 'MUTABLE_RELEASE_FORBIDDEN'],
    [enrollment('withdrawn'), { ...good, status: 'withdrawn' }, 'RELEASE_STATUS_BLOCKED'],
    [enrollment('revoked'), { ...good, status: 'revoked' }, 'RELEASE_STATUS_BLOCKED'],
    [enrollment('expired'), { ...good, evidence: { ...good.evidence, reviewValidUntil: '2026-08-12T00:00:00.000Z' } }, 'EVIDENCE_EXPIRED'],
    [enrollment('forged'), { ...good, releaseId: rel('f') }, 'RELEASE_IDENTITY_MISMATCH'],
  ]) {
    assert.throws(() => add(events, event, { registryResolver: resolver(registryRelease) }), error => error instanceof OrganizationGovernanceError && error.code === code);
  }
});

test('caller-owned Release claims are rejected without a trusted resolver', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_est_resolver', type: 'establishment.created', subject: { establishmentId: 'est_resolver' },
    payload: { establishment: { establishmentId: 'est_resolver', name: '可信解析边界', capacity: 1 } },
  }).events;
  const claimed = release();
  assert.throws(() => add(events, {
    operationId: 'op_direct_claim', type: 'enrollment.created', subject: { enrollmentId: 'enrollment_direct' },
    payload: { enrollment: { enrollmentId: 'enrollment_direct', establishmentId: 'est_resolver', skillId: claimed.skillId, releaseId: claimed.releaseId } },
  }, { registryRelease: claimed }), error => error.code === 'RELEASE_RESOLVER_REQUIRED');
});

test('backdated append is rejected and cannot revive expired evidence', () => {
  const events = bootstrap();
  assert.throws(() => add(events, {
    occurredAt: '2026-08-12T00:00:00.000Z', operationId: 'op_backdated', type: 'project.created',
    subject: { projectId: 'project_backdated' }, payload: { project: { projectId: 'project_backdated', name: '倒签项目' } },
  }), error => error.code === 'EVENT_TIME_UNTRUSTED');
});

test('replay detects tampered persisted Release evidence snapshot', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_est_tamper', type: 'establishment.created', subject: { establishmentId: 'est_tamper' },
    payload: { establishment: { establishmentId: 'est_tamper', name: '防篡改编制', capacity: 1 } },
  }).events;
  const trusted = release();
  events = add(events, {
    operationId: 'op_enroll_tamper', type: 'enrollment.created', subject: { enrollmentId: 'enrollment_tamper' },
    payload: { enrollment: { enrollmentId: 'enrollment_tamper', establishmentId: 'est_tamper', skillId: trusted.skillId, releaseId: trusted.releaseId } },
  }, { registryResolver: resolver(trusted) }).events;
  const tampered = structuredClone(events);
  tampered[2].payload.enrollment.releaseEvidenceSnapshot.smsTotal = 100;
  assert.throws(() => replayOrganizationEvents(tampered), error => error.code === 'RELEASE_EVIDENCE_DIGEST_MISMATCH');
});

test('organization roles authorize sensitive actions and project-scoped roles stay scoped', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_project_a', type: 'project.created', subject: { projectId: 'project_a' },
    payload: { project: { projectId: 'project_a', name: '项目 A' } },
  }).events;
  events = add(events, {
    operationId: 'op_project_b', type: 'project.created', subject: { projectId: 'project_b' },
    payload: { project: { projectId: 'project_b', name: '项目 B' } },
  }).events;
  events = add(events, {
    operationId: 'op_viewer', type: 'role.bound', subject: { organizationId: 'org_yongle' },
    payload: { roleBinding: { principalId: 'principal:viewer', role: 'viewer' } },
  }).events;
  events = add(events, {
    operationId: 'op_operator', type: 'role.bound', subject: { organizationId: 'org_yongle' },
    payload: { roleBinding: { principalId: 'principal:operator', role: 'operator', projectId: 'project_a' } },
  }).events;
  events = add(events, {
    operationId: 'op_reviewer', type: 'role.bound', subject: { organizationId: 'org_yongle' },
    payload: { roleBinding: { principalId: 'principal:reviewer', role: 'reviewer' } },
  }).events;

  assert.throws(() => add(events, {
    actorPrincipalId: 'principal:viewer', operationId: 'op_bad_policy', type: 'policy.changed',
    subject: { organizationId: 'org_yongle' }, payload: { policy: { minimumSmsScore: 90 } },
  }), error => error.code === 'FORBIDDEN');
  assert.throws(() => add(events, {
    actorPrincipalId: 'principal:operator', operationId: 'op_cross_project', type: 'establishment.created',
    subject: { establishmentId: 'est_b' }, payload: { establishment: { establishmentId: 'est_b', projectId: 'project_b', name: '越权编制', capacity: 1 } },
  }), error => error.code === 'FORBIDDEN');
  assert.throws(() => add(events, {
    actorPrincipalId: 'principal:reviewer', operationId: 'op_self_upgrade', type: 'role.bound',
    subject: { organizationId: 'org_yongle' }, payload: { roleBinding: { principalId: 'principal:reviewer', role: 'org_admin' } },
  }), error => error.code === 'FORBIDDEN');
  assert.equal(add(events, {
    actorPrincipalId: 'principal:operator', operationId: 'op_same_project', type: 'establishment.created',
    subject: { establishmentId: 'est_a' }, payload: { establishment: { establishmentId: 'est_a', projectId: 'project_a', name: '合法编制', capacity: 1 } },
  }).action, 'appended');
});

test('organizations are isolated in internal and public projections', () => {
  let events = bootstrap();
  events = appendOrganizationEvent(events, {
    schemaVersion: 1, occurredAt: NOW, actorPrincipalId: 'principal:owner-b', organizationId: 'org_other',
    operationId: 'op_create_org_b', type: 'organization.created', subject: { organizationId: 'org_other' },
    payload: { organization: { organizationId: 'org_other', name: '其他组织' } },
  }, { now: NOW }).events;
  assert.equal(projectOrganizationGovernance(events, { organizationId: 'org_yongle', principalId: 'principal:owner-a' }).organization.name, '永乐教育训练营');
  assert.throws(() => projectOrganizationGovernance(events, { organizationId: 'org_other', principalId: 'principal:owner-a' }), error => error.code === 'FORBIDDEN');
});

test('same operation and digest replay idempotently; changed digest conflicts', () => {
  const events = bootstrap();
  const input = {
    operationId: 'op_project_idempotent', type: 'project.created', subject: { projectId: 'project_camp' },
    payload: { project: { projectId: 'project_camp', name: '首期训练营' } },
  };
  const first = add(events, input);
  assert.equal(add(first.events, input).action, 'replayed');
  assert.throws(() => add(first.events, { ...input, payload: { project: { projectId: 'project_camp', name: '篡改名称' } } }), error => error.code === 'OPERATION_CONFLICT');
  assert.equal(replayOrganizationEvents(first.events).auditEvents.length, 2);
});

test('public projection removes principals and sensitive payloads', () => {
  let events = bootstrap();
  events = add(events, {
    operationId: 'op_member', type: 'role.bound', subject: { organizationId: 'org_yongle' },
    payload: { roleBinding: { principalId: 'principal:private-member', role: 'member', metadata: { prompt: 'secret prompt', output: 'secret output', token: 'secret-token', path: '/private/path' } } },
  }).events;
  const projected = projectOrganizationGovernance(events, { organizationId: 'org_yongle', public: true });
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['principal:', 'secret prompt', 'secret output', 'secret-token', '/private/path']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(projected.roleSummary.member, 1);
  assert.ok(projected.auditEvents.every(row => row.actorRole && !('actorPrincipalId' in row)));
});
