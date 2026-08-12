import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acceptCoachProposal, createCoachProposal } from '../dist-src/skillops/scripts/lib/coach-proposal.mjs';
import { PerformanceLedger } from '../dist-src/skillops/scripts/lib/performance-ledger.mjs';
import { RetirementStore, planRetirement } from '../dist-src/skillops/scripts/lib/retirement.mjs';
import { createUpdateAssessment } from '../dist-src/skillops/scripts/lib/update-policy.mjs';

const sha = char => `sha256:${char.repeat(64)}`;
const NOW = '2026-08-20T00:00:00.000Z';

function releaseId(skillId, version, packageDigest) {
  return `rel_${crypto.createHash('sha256').update(`skillops.release.v1\0${skillId}\0${version}\0${packageDigest}`).digest('hex')}`;
}

function release(version, packageChar) {
  const skillId = 'qiuyiwu/lifecycle-fixture';
  const packageDigest = sha(packageChar);
  return {
    schemaVersion: 1, skillId, releaseId: releaseId(skillId, version, packageDigest), version, status: 'published',
    package: { packageDigest, manifestDigest: sha('a'), licenseDigest: sha('b'), securityDigest: sha('c') },
    compatibility: { contract: 'skillops/v1', targets: ['codex'] }, dependencies: [],
    assessmentPolicy: {
      smsSuiteId: 'sms-v2', evalSuiteId: 'eval-v3', runnerId: 'local-runner-v1', reviewPolicyVersion: 'review-v2',
    },
  };
}

function proof(kind, target, overrides = {}) {
  return {
    status: kind === 'review' ? 'certified' : 'passed', releaseId: target.releaseId,
    packageDigest: target.package.packageDigest, digest: sha(kind === 'eval' ? 'e' : 'f'),
    validUntil: '2026-09-20T00:00:00Z', ...overrides,
  };
}

test('degradation creates only a digest-bound Coach request and a new package still requires fresh Eval and review', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-hrd-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldRelease = release('1.0.0', '1');
  const ledger = new PerformanceLedger(path.join(root, 'performance.json'));
  for (let index = 0; index < 12; index += 1) ledger.append({
    installationId: 'inst_lifecycle_fixture_001', skillId: oldRelease.skillId, releaseId: oldRelease.releaseId,
    outcome: index < 4 ? 'failure' : 'success', durationMs: 1_200,
    ...(index < 4 ? { errorCode: 'EVAL_REGRESSION' } : {}),
    occurredAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    environmentDigest: sha('8'), evalPolicyDigest: sha('9'),
  });
  const performance = ledger.summarize({
    skillId: oldRelease.skillId, releaseId: oldRelease.releaseId, now: NOW, minimumSamples: 10,
  });
  assert.equal(performance.status, 'degraded');

  const proposal = createCoachProposal({
    skillId: oldRelease.skillId, baseReleaseId: oldRelease.releaseId,
    basePackageDigest: oldRelease.package.packageDigest,
    evidence: [{ kind: 'performance_summary', digest: sha('7') }],
    weakDimensions: [{ key: 'evaluability', score: 4 }],
    changes: [{ operation: 'replace', path: 'SKILL.md', beforeSha256: sha('5'), afterSha256: sha('6') }],
    generator: { kind: 'rule', name: 'local-coach', version: '1.0.0' }, createdAt: NOW,
  });
  const request = acceptCoachProposal(proposal, {
    acceptedBy: 'principal_owner_001', acceptedAt: NOW, sourceRevision: 'rev_local_002',
    expectedProposalDigest: proposal.proposalDigest,
  });
  assert.equal(request.mutatesSource, false);
  assert.deepEqual(request.requiredPipeline.map(item => item.stage), ['package', 'audit', 'sms', 'eval', 'review', 'registry']);

  const nextRelease = release('1.0.1', '2');
  const commonEvidence = {
    packageAudit: proof('packageAudit', nextRelease), license: proof('license', nextRelease),
    security: proof('security', nextRelease), sms: proof('sms', nextRelease, { suiteId: 'sms-v2' }),
    eval: proof('eval', oldRelease, { suiteId: 'eval-v3', runnerId: 'local-runner-v1' }),
    review: proof('review', oldRelease, { policyVersion: 'review-v2' }),
  };
  const assessment = createUpdateAssessment({
    oldRelease, newRelease: nextRelease,
    currentLock: {
      skillId: oldRelease.skillId, releaseId: oldRelease.releaseId,
      packageDigest: oldRelease.package.packageDigest, deployedFingerprint: sha('4'),
    },
    targetState: { exists: true, managed: true, deployedFingerprint: sha('4'), currentFingerprint: sha('4') },
    localPolicy: {
      requiredEvidence: ['packageAudit', 'license', 'security', 'sms', 'eval', 'review'],
      smsSuiteId: 'sms-v2', evalSuiteId: 'eval-v3', runnerId: 'local-runner-v1', reviewPolicyVersion: 'review-v2',
    },
    evidence: commonEvidence,
  }, { now: NOW });
  assert.equal(assessment.status, 'reassessment_required');
  assert.deepEqual(assessment.requiredReassessments.map(item => item.kind).sort(), ['eval', 'review']);
  assert.equal(assessment.migration.preserveCurrentLockOnFailure, true);
  const serialized = JSON.stringify({ performance, proposal, request, assessment });
  for (const secret of ['principal_owner_001', 'prompt', 'output', '/Users/', 'SKILL.md']) {
    if (secret === 'SKILL.md') continue;
    assert.equal(serialized.includes(secret), false);
  }
});

test('retirement remains a separate reversible HR decision after dependencies are known', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-hrd-retire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = release('1.0.0', '1');
  const plan = planRetirement({
    skillId: current.skillId, releaseIds: [current.releaseId], reason: '长期绩效未改善，转入可恢复退役',
    replacementSkillId: 'qiuyiwu/lifecycle-successor',
    dependencies: { deployments: [], compositions: [], projects: [], organizationRefs: [] },
  }, { now: NOW });
  const store = new RetirementStore(path.join(root, 'retirement.json'));
  const retired = store.retire(plan, {
    confirmPlanDigest: plan.planDigest, actor: 'principal_owner_001', at: NOW,
  });
  assert.equal(retired.status.state, 'retired');
  assert.equal(retired.status.releaseLifecycle, 'unchanged');
  assert.equal(retired.status.existingLocks, 'preserved_for_explanation');
  const restored = store.restore(current.skillId, {
    actor: 'principal_owner_001', reason: '恢复后重新走全量验证', at: '2026-08-21T00:00:00Z',
  });
  assert.equal(restored.status.state, 'active_pending_revalidation');
  assert.equal(restored.status.allowsNewDeployments, false);
  assert.equal(JSON.stringify(store.read()).includes('principal_owner_001'), false);
});
