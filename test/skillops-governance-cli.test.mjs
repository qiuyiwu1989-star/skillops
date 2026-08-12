import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createPackageManifest } from '../trusted-supply/lib/package.mjs';
import { canonicalDigest, normalizeRelease, sourceId } from '../trusted-supply/lib/registry-identity.mjs';
import { deploySkill } from '../dist-src/skillops/scripts/lib/deploy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist-src', 'skillops', 'scripts', 'skillops.mjs');
const sha = char => `sha256:${char.repeat(64)}`;
const rel = char => `rel_${char.repeat(64)}`;

function context(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-governance-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

function outputJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function releaseId(skillId, version, packageDigest) {
  return `rel_${crypto.createHash('sha256')
    .update(`skillops.release.v1\0${skillId}\0${version}\0${packageDigest}`, 'utf8')
    .digest('hex')}`;
}

function updateRelease(char, version) {
  const skillId = 'qiuyiwu/governance-fixture';
  const packageDigest = sha(char);
  return {
    releaseId: releaseId(skillId, version, packageDigest), skillId, version, status: 'published',
    package: {
      packageDigest, manifestDigest: sha(char === 'a' ? 'c' : 'd'),
      licenseDigest: sha('e'), securityDigest: sha('f'),
    },
    compatibility: { contract: 'skillops/v1', targets: ['codex'] },
    dependencies: [],
    assessmentPolicy: {
      smsSuiteId: 'sms-v1', evalSuiteId: 'eval-v1', runnerId: 'local-v1', reviewPolicyVersion: 'review-v1',
    },
  };
}

function updateInput() {
  const oldRelease = updateRelease('a', '1.0.0');
  const newRelease = updateRelease('b', '1.0.1');
  return {
    oldRelease, newRelease,
    currentLock: {
      skillId: oldRelease.skillId, releaseId: oldRelease.releaseId,
      packageDigest: oldRelease.package.packageDigest, deployedFingerprint: sha('1'),
    },
    targetState: { exists: true, managed: true, currentFingerprint: sha('1') },
    localPolicy: {
      requiredEvidence: [], smsSuiteId: 'sms-v1', evalSuiteId: 'eval-v1',
      runnerId: 'local-v1', reviewPolicyVersion: 'review-v1',
    },
    evidence: {},
  };
}

function coachInput(overrides = {}) {
  return {
    skillId: 'qiuyiwu/governance-fixture', baseReleaseId: rel('a'), basePackageDigest: sha('b'),
    evidence: [{ kind: 'sms_assessment', digest: sha('c') }],
    weakDimensions: [{ key: 'safety', score: 4 }],
    changes: [{ operation: 'replace', path: 'SKILL.md', beforeSha256: sha('d'), afterSha256: sha('e') }],
    generator: { kind: 'rule', name: 'skillops-coach', version: '1.0.0' },
    createdAt: '2026-08-13T03:00:00.000Z',
    ...overrides,
  };
}

function retirementInput(overrides = {}) {
  return {
    skillId: 'qiuyiwu/governance-fixture', releaseIds: [rel('a')],
    dependencies: { deployments: [], compositions: [], projects: [], organizationRefs: [] },
    replacementSkillId: 'qiuyiwu/governance-next', reason: '能力已由新版技能替代',
    ...overrides,
  };
}

function legacyMigrationFixture(t) {
  const dir = context(t);
  const sourceRoot = path.join(dir, 'source');
  const targetRoot = path.join(dir, 'target');
  const sourcePath = path.join(sourceRoot, 'migration-fixture');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(targetRoot);
  const skillId = 'acme/migration-fixture';
  const version = '1.0.0';
  fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), `---\nname: migration-fixture\nid: ${skillId}\nversion: ${version}\n---\n\n仅用于迁移测试，不执行。\n`, 'utf8');
  deploySkill({ id: skillId, name: 'migration-fixture', version, dir: sourcePath }, targetRoot);
  const targetPath = path.join(targetRoot, 'migration-fixture');
  const built = createPackageManifest([{
    path: 'SKILL.md', content: fs.readFileSync(path.join(targetPath, 'SKILL.md')), mediaType: 'text/markdown',
  }]);
  const explicitSourceId = sourceId('fixture', `${skillId}@${version}`);
  const release = normalizeRelease({
    skillId, version,
    package: {
      packageDigest: built.packageDigest,
      manifestDigest: canonicalDigest(built.manifest),
      storageRef: `cas:${built.packageDigest}`,
    },
    compatibility: { contract: 'skill-package.v1', targets: ['codex'] },
    assessmentRefs: ['eval_fixture_001'], reviewRefs: ['review_fixture_001'],
    sourceRefs: [explicitSourceId], publishedAt: '2026-08-13T08:00:00.000Z',
  });
  const planInput = {
    operationId: 'op_cli_migration_001', targetRoot,
    mappings: [{
      legacyKey: skillId,
      installationId: 'inst_cli_migration_001',
      sourceId: explicitSourceId,
      verifiedTargetPackageDigest: built.packageDigest,
      registryResolution: {
        release, status: 'published', registrySourceId: 'regsrc_local_fixture', feedCursor: '42',
      },
      trustSnapshot: {
        policyVersion: 'registry-v1', feedCursor: '42',
        reviewValidUntil: '2026-09-13T00:00:00.000Z',
        evalValidUntil: '2026-09-01T00:00:00.000Z',
        reviewDigest: sha('a'), evalDigest: sha('b'),
      },
    }],
  };
  return {
    dir, targetRoot, planInput,
    legacyPath: path.join(targetRoot, '.skillops', 'lock.json'),
    managedPath: path.join(targetRoot, '.skillops', 'managed-lock-v2.json'),
  };
}

test('update-assess 从 JSON 文件输出只读更新判断，并拒绝伪造 Release 身份', t => {
  const dir = context(t);
  const input = updateInput();
  input.currentLock.targetPath = '/Users/private/skill';
  input.evidence.privatePrompt = '不得回显的正文';
  const assessed = outputJson(run(dir, 'update-assess', '--input', writeJson(dir, 'update.json', input), '--now', '2026-08-13T00:00:00Z'));
  assert.equal(assessed.status, 'ready');
  assert.equal(assessed.migration.action, 'prepare_atomic_update');
  assert.doesNotMatch(JSON.stringify(assessed), /Users\/private|不得回显的正文/);

  const forged = updateInput();
  forged.newRelease.releaseId = rel('f');
  const rejected = run(dir, 'update-assess', '--input', writeJson(dir, 'forged-update.json', forged));
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '', '治理命令失败时 stdout 必须保持为空，便于机器解析');
  assert.match(rejected.stderr, /RELEASE_ID_MISMATCH|规范身份/);
});

test('performance record/status 使用原子台账且拒绝隐私字段和篡改历史', t => {
  const dir = context(t);
  const ledger = path.join(dir, 'performance.json');
  const event = {
    installationId: 'inst_governance_001', skillId: 'qiuyiwu/governance-fixture', releaseId: rel('a'),
    outcome: 'failure', durationMs: 1700, errorCode: 'ASSERTION_FAILED',
    occurredAt: '2026-08-13T01:02:03Z', environmentDigest: sha('b'), evalPolicyDigest: sha('c'),
  };
  const recorded = outputJson(run(dir, 'performance', 'record', '--ledger', ledger, '--input', writeJson(dir, 'event.json', event)));
  assert.equal(recorded.action, 'recorded');
  assert.equal(recorded.event.durationBucket, '1_to_5s');
  assert.equal(Object.hasOwn(recorded.event, 'durationMs'), false);

  const query = {
    skillId: event.skillId, releaseId: event.releaseId, now: '2026-08-14T00:00:00Z',
    windowDays: 30, minimumSamples: 1, degradedFailureRate: 0.25,
  };
  const status = outputJson(run(dir, 'performance', 'status', '--ledger', ledger, '--input', writeJson(dir, 'query.json', query)));
  assert.equal(status.status, 'degraded');
  assert.equal(status.samples, 1);
  assert.doesNotMatch(JSON.stringify(status), /inst_governance_001/);

  const privateEvent = { ...event, occurredAt: '2026-08-14T01:02:03Z', prompt: 'private prompt' };
  const privateResult = run(dir, 'performance', 'record', '--ledger', ledger, '--input', writeJson(dir, 'private-event.json', privateEvent));
  assert.notEqual(privateResult.status, 0);
  assert.equal(privateResult.stdout, '');
  assert.match(privateResult.stderr, /PRIVATE_FIELD_FORBIDDEN|不允许字段/);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).events.length, 1);

  const tampered = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  tampered.events[0].durationBucket = 'gte_30s';
  fs.writeFileSync(ledger, JSON.stringify(tampered), 'utf8');
  const forgedStatus = run(dir, 'performance', 'status', '--ledger', ledger, '--input', path.join(dir, 'query.json'));
  assert.notEqual(forgedStatus.status, 0);
  assert.match(forgedStatus.stderr, /LEDGER_TAMPERED|摘要不一致/);
});

test('coach propose/accept 绑定摘要，接受结果不泄露原 principal', t => {
  const dir = context(t);
  const proposal = outputJson(run(dir, 'coach', 'propose', '--input', writeJson(dir, 'coach-input.json', coachInput())));
  const proposalFile = writeJson(dir, 'proposal.json', proposal);
  const principal = 'principal_owner_001';
  const acceptance = {
    acceptedBy: principal, acceptedAt: '2026-08-13T04:00:00Z', sourceRevision: 'rev_local_002',
    expectedProposalDigest: proposal.proposalDigest,
  };
  const accepted = outputJson(run(dir, 'coach', 'accept', '--proposal', proposalFile, '--input', writeJson(dir, 'accept.json', acceptance)));
  assert.equal(accepted.action, 'source_revision.requested');
  assert.equal(accepted.mutatesSource, false);
  assert.equal(accepted.executesSkill, false);
  assert.match(accepted.acceptedByDigest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(accepted), new RegExp(principal));

  const stale = { ...acceptance, expectedProposalDigest: sha('0') };
  const rejected = run(dir, 'coach', 'accept', '--proposal', proposalFile, '--input', writeJson(dir, 'stale.json', stale));
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /PROPOSAL_CONFIRMATION_MISMATCH|确认摘要/);

  const privateProposal = run(dir, 'coach', 'propose', '--input', writeJson(dir, 'private-coach.json', coachInput({ prompt: '秘密正文' })));
  assert.notEqual(privateProposal.status, 0);
  assert.match(privateProposal.stderr, /PRIVATE_FIELD_FORBIDDEN|私密或正文/);
});

test('retire 要求计划确认、防伪造、保留 Release，并可追加恢复', t => {
  const dir = context(t);
  const ledger = path.join(dir, 'retirement.json');
  const plan = outputJson(run(dir, 'retire', 'plan', '--input', writeJson(dir, 'retire-input.json', retirementInput()), '--now', '2026-08-13T08:00:00Z'));
  assert.equal(plan.status, 'ready');
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.lifecycleBoundary.releaseStatusUnchanged, true);
  const planFile = writeJson(dir, 'plan.json', plan);

  const missing = run(dir, 'retire', 'apply', '--ledger', ledger, '--plan', planFile, '--actor', 'principal_reviewer_01');
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /CLI_ARGUMENT_REQUIRED|缺少 --confirm/);
  assert.equal(fs.existsSync(ledger), false);

  const forged = structuredClone(plan);
  forged.reason = '被篡改的理由';
  const forgedResult = run(dir, 'retire', 'apply', '--ledger', ledger, '--plan', writeJson(dir, 'forged-plan.json', forged), '--confirm', plan.planDigest, '--actor', 'principal_reviewer_01');
  assert.notEqual(forgedResult.status, 0);
  assert.match(forgedResult.stderr, /PLAN_TAMPERED|摘要不一致/);
  assert.equal(fs.existsSync(ledger), false);

  const actor = 'principal_reviewer_01';
  const applied = outputJson(run(dir, 'retire', 'apply', '--ledger', ledger, '--plan', planFile, '--confirm', plan.planDigest, '--actor', actor, '--at', '2026-08-13T09:00:00Z'));
  assert.equal(applied.status.state, 'retired');
  assert.equal(applied.status.allowsNewDeployments, false);
  assert.equal(applied.status.releaseLifecycle, 'unchanged');
  assert.doesNotMatch(JSON.stringify(applied), new RegExp(actor));
  assert.doesNotMatch(fs.readFileSync(ledger, 'utf8'), new RegExp(actor));

  const status = outputJson(run(dir, 'retire', 'status', '--ledger', ledger, '--skill', 'qiuyiwu/governance-fixture'));
  assert.equal(status.state, 'retired');
  assert.deepEqual(status.releaseIds, [rel('a')]);

  const restored = outputJson(run(dir, 'retire', 'restore', '--ledger', ledger, '--skill', 'qiuyiwu/governance-fixture', '--actor', 'principal_reviewer_02', '--reason', '业务需要重新启用并重新评估', '--at', '2026-08-14T09:00:00Z'));
  assert.equal(restored.status.state, 'active_pending_revalidation');
  assert.equal(restored.status.allowsNewDeployments, false);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).events.length, 2);
});

test('retire plan 在依赖范围不明时阻断且不给确认摘要', t => {
  const dir = context(t);
  const input = retirementInput({
    dependencies: { deployments: [], compositions: [], projects: [] },
  });
  const plan = outputJson(run(dir, 'retire', 'plan', '--input', writeJson(dir, 'blocked-retire.json', input), '--now', '2026-08-13T08:00:00Z'));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.planDigest, null);
  assert.deepEqual(plan.requiredConfirmations, []);
});

test('未知顶层命令继续显示帮助，不改变旧 CLI 的兼容行为', t => {
  const dir = context(t);
  const result = run(dir, 'unknown-governance-command');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skillops.*AI 技能的人事部/);
  assert.match(result.stdout, /deploy <技能>/);
});

test('lock-migrate 仅按显式 Registry mapping 规划，并确认后原子创建 v2 且保留 v1', t => {
  const site = legacyMigrationFixture(t);
  const legacyBefore = fs.readFileSync(site.legacyPath, 'utf8');
  const plan = outputJson(run(
    site.dir, 'lock-migrate', 'plan', '--input', writeJson(site.dir, 'lock-plan-input.json', site.planInput),
    '--now', '2026-08-13T08:00:00.000Z',
  ));
  assert.equal(plan.status, 'ready');
  assert.equal(plan.summary.deploymentCount, 1);
  assert.equal(fs.existsSync(site.managedPath), false, 'plan 必须只读');

  const wrongApply = {
    targetRoot: site.targetRoot, plan, confirmPlanDigest: sha('0'),
  };
  const rejected = run(site.dir, 'lock-migrate', 'apply', '--input', writeJson(site.dir, 'wrong-lock-apply.json', wrongApply), '--at', '2026-08-13T08:05:00.000Z');
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /PLAN_CONFIRMATION_REQUIRED|确认值必须等于/);
  assert.equal(fs.existsSync(site.managedPath), false, '错误确认不得写 v2');
  assert.equal(fs.readFileSync(site.legacyPath, 'utf8'), legacyBefore);

  const applied = outputJson(run(
    site.dir, 'lock-migrate', 'apply', '--input', writeJson(site.dir, 'lock-apply.json', {
      targetRoot: site.targetRoot, plan, confirmPlanDigest: plan.planDigest,
    }), '--at', '2026-08-13T08:05:00.000Z',
  ));
  assert.equal(applied.action, 'migrated');
  assert.equal(fs.readFileSync(site.legacyPath, 'utf8'), legacyBefore, 'Legacy Lock v1 必须逐字节保留');
  const managed = JSON.parse(fs.readFileSync(site.managedPath, 'utf8'));
  assert.equal(managed.updatedAt, '2026-08-13T08:05:00.000Z');
  assert.equal(managed.installations.inst_cli_migration_001.skillId, 'acme/migration-fixture');
  assert.equal(managed.migrations[0].planDigest, plan.planDigest);
});

test('lock-migrate 缺少显式 mapping 时失败，不猜测 Release 且零写入', t => {
  const site = legacyMigrationFixture(t);
  const input = { ...site.planInput, mappings: [] };
  const result = run(site.dir, 'lock-migrate', 'plan', '--input', writeJson(site.dir, 'missing-mapping.json', input));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /MAPPING_REQUIRED|必须提供 Registry 映射/);
  assert.equal(fs.existsSync(site.managedPath), false);
});
