import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackageManifest } from '../trusted-supply/lib/package.mjs';
import { canonicalDigest, normalizeRelease, sourceId } from '../trusted-supply/lib/registry-identity.mjs';
import { artifactFingerprint, deploySkill } from '../dist-src/skillops/scripts/lib/deploy.mjs';
import {
  ManagedLockMigrationError,
  commitManagedLockMigration,
  createManagedLockMigrationPlan,
} from '../dist-src/skillops/scripts/lib/managed-lock-migration.mjs';

const PLAN_AT = '2026-08-13T08:00:00.000Z';
const COMMIT_AT = '2026-08-13T08:05:00.000Z';
const sha = char => `sha256:${char.repeat(64)}`;

function workspace(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-lock-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetRoot);
  const deployments = [];
  for (let index = 0; index < count; index += 1) {
    const name = `fixture-${index + 1}`;
    const skillId = `acme/${name}`;
    const sourcePath = path.join(sourceRoot, name);
    fs.mkdirSync(sourcePath);
    fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), `---\nname: ${name}\nid: ${skillId}\nversion: 1.0.${index}\n---\n\nNever execute this fixture.\n`);
    deploySkill({ id: skillId, name, version: `1.0.${index}`, dir: sourcePath }, targetRoot);
    const targetPath = path.join(targetRoot, name);
    const content = fs.readFileSync(path.join(targetPath, 'SKILL.md'));
    const built = createPackageManifest([{ path: 'SKILL.md', content, mediaType: 'text/markdown' }]);
    const release = normalizeRelease({
      skillId,
      version: `1.0.${index}`,
      package: {
        packageDigest: built.packageDigest,
        manifestDigest: canonicalDigest(built.manifest),
        storageRef: `cas:${built.packageDigest}`,
      },
      compatibility: { contract: 'skill-package.v1', targets: ['codex'] },
      assessmentRefs: [`eval_${index + 1}`],
      reviewRefs: [`review_${index + 1}`],
      sourceRefs: [sourceId('fixture', `${skillId}@1.0.${index}`)],
      publishedAt: PLAN_AT,
    });
    deployments.push({ name, skillId, sourcePath, targetPath, built, release });
  }
  return { root, sourceRoot, targetRoot, deployments };
}

function mapping(deployment, index = 0, overrides = {}) {
  return {
    legacyKey: deployment.skillId,
    installationId: `inst_migration_fixture_${index + 1}`,
    sourceId: deployment.release.sourceRefs[0],
    verifiedTargetPackageDigest: deployment.built.packageDigest,
    registryResolution: {
      release: deployment.release,
      status: 'published',
      registrySourceId: 'regsrc_local_fixture',
      feedCursor: '42',
    },
    trustSnapshot: {
      policyVersion: 'registry-v1',
      reviewValidUntil: '2026-09-13T00:00:00.000Z',
      evalValidUntil: '2026-09-01T00:00:00.000Z',
      feedCursor: '42',
      reviewDigest: sha('a'),
      evalDigest: sha('b'),
    },
    ...overrides,
  };
}

function plan(site, overrides = {}) {
  return createManagedLockMigrationPlan({
    operationId: overrides.operationId ?? 'op_migrate_fixture_001',
    targetRoot: site.targetRoot,
    mappings: overrides.mappings ?? site.deployments.map(mapping),
  }, { now: overrides.now ?? PLAN_AT });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('plans and atomically migrates multiple Legacy entries while preserving Lock v1', t => {
  const site = workspace(t, 2);
  const legacyPath = path.join(site.targetRoot, '.skillops', 'lock.json');
  const legacyBefore = fs.readFileSync(legacyPath, 'utf8');
  const migrationPlan = plan(site);
  assert.equal(migrationPlan.status, 'ready');
  assert.equal(migrationPlan.summary.deploymentCount, 2);
  assert.equal(fs.existsSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json')), false, 'planning must not write');

  const result = commitManagedLockMigration({
    targetRoot: site.targetRoot,
    plan: migrationPlan,
    confirmPlanDigest: migrationPlan.planDigest,
  }, { clock: () => new Date(COMMIT_AT) });
  assert.equal(result.action, 'migrated');
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyBefore, 'v1 is the recoverable unchanged backup');
  const ledger = readJson(result.lockPath);
  assert.equal(Object.keys(ledger.installations).length, 2);
  assert.equal(ledger.migrations.length, 1);
  for (const [index, deployment] of site.deployments.entries()) {
    const lock = ledger.installations[`inst_migration_fixture_${index + 1}`];
    assert.equal(lock.skillId, deployment.skillId);
    assert.equal(lock.releaseId, deployment.release.releaseId);
    assert.equal(lock.packageDigest, deployment.built.packageDigest);
    assert.equal(lock.deployedFingerprint, deployment.built.packageDigest);
    assert.equal(lock.legacyMigration.deployedFingerprint, artifactFingerprint(deployment.targetPath));
  }
});

test('never guesses a Release: missing mappings and a fake-shaped releaseId fail closed', t => {
  const site = workspace(t, 2);
  assert.throws(
    () => plan(site, { mappings: [mapping(site.deployments[0])] }),
    error => error instanceof ManagedLockMigrationError && error.code === 'MAPPING_REQUIRED',
  );
  const good = mapping(site.deployments[0]);
  const fakeRelease = { ...good.registryResolution.release, releaseId: `rel_${'f'.repeat(64)}` };
  assert.throws(
    () => plan(workspace(t), { mappings: [{ ...good, registryResolution: { ...good.registryResolution, release: fakeRelease } }] }),
    error => error instanceof ManagedLockMigrationError && error.code === 'RELEASE_ID_MISMATCH',
  );
});

test('explicit verified target package digest must exactly match Registry package digest', t => {
  const site = workspace(t);
  assert.throws(
    () => plan(site, { mappings: [mapping(site.deployments[0], 0, { verifiedTargetPackageDigest: sha('9') })] }),
    error => error.code === 'TARGET_PACKAGE_MISMATCH',
  );
});

test('a forged verified package declaration cannot substitute for independently hashing target content', t => {
  const site = workspace(t);
  const deployment = site.deployments[0];
  const otherPackage = createPackageManifest([{
    path: 'SKILL.md',
    content: '---\nname: other\nid: acme/fixture-1\nversion: 9.9.9\n---\n\nDifferent package.\n',
  }]);
  const forgedRelease = normalizeRelease({
    ...deployment.release,
    releaseId: undefined,
    version: '9.9.9',
    package: {
      packageDigest: otherPackage.packageDigest,
      manifestDigest: canonicalDigest(otherPackage.manifest),
      storageRef: `cas:${otherPackage.packageDigest}`,
    },
  });
  const base = mapping(deployment);
  assert.throws(
    () => plan(site, { mappings: [{
      ...base,
      verifiedTargetPackageDigest: otherPackage.packageDigest,
      registryResolution: { ...base.registryResolution, release: forgedRelease },
    }] }),
    error => error.code === 'TARGET_PACKAGE_MISMATCH',
  );
});

test('target drift, source drift/missing, withdrawn/revoked and stale evidence block without writes', t => {
  const cases = [
    ['TARGET_DRIFT', site => fs.appendFileSync(path.join(site.deployments[0].targetPath, 'SKILL.md'), '\nlocal target edit\n'), {}],
    ['SOURCE_DRIFT', site => fs.appendFileSync(path.join(site.deployments[0].sourcePath, 'SKILL.md'), '\nsource edit\n'), {}],
    ['SOURCE_MISSING', site => fs.rmSync(site.deployments[0].sourcePath, { recursive: true }), {}],
    ['RELEASE_WITHDRAWN', () => {}, { registryResolution: { status: 'withdrawn' } }],
    ['RELEASE_REVOKED', () => {}, { registryResolution: { status: 'revoked' } }],
    ['EVIDENCE_STALE', () => {}, { trustSnapshot: { reviewValidUntil: '2026-08-12T00:00:00.000Z' } }],
  ];
  for (const [code, mutate, nested] of cases) {
    const site = workspace(t);
    mutate(site);
    const base = mapping(site.deployments[0]);
    const changed = {
      ...base,
      ...(nested.registryResolution ? { registryResolution: { ...base.registryResolution, ...nested.registryResolution } } : {}),
      ...(nested.trustSnapshot ? { trustSnapshot: { ...base.trustSnapshot, ...nested.trustSnapshot } } : {}),
    };
    assert.throws(() => plan(site, { mappings: [changed] }), error => error.code === code, code);
    assert.equal(fs.existsSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json')), false);
  }
});

test('confirmation is mandatory and a pre-commit drift aborts the whole multi-entry migration', t => {
  const site = workspace(t, 2);
  const migrationPlan = plan(site);
  assert.throws(
    () => commitManagedLockMigration({ targetRoot: site.targetRoot, plan: migrationPlan, confirmPlanDigest: sha('0') }),
    error => error.code === 'PLAN_CONFIRMATION_REQUIRED',
  );
  fs.appendFileSync(path.join(site.deployments[1].targetPath, 'SKILL.md'), '\ndrift after plan\n');
  assert.throws(
    () => commitManagedLockMigration({ targetRoot: site.targetRoot, plan: migrationPlan, confirmPlanDigest: migrationPlan.planDigest }),
    error => error.code === 'TARGET_DRIFT',
  );
  assert.equal(fs.existsSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json')), false, 'partial failure must not write any entry');
});

test('atomic ledger failure leaves existing Lock v2 byte-identical and v1 recoverable', t => {
  const site = workspace(t);
  const managedPath = path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json');
  const initial = { schemaVersion: 2, updatedAt: null, installations: {} };
  fs.writeFileSync(managedPath, `${JSON.stringify(initial, null, 2)}\n`);
  const managedBefore = fs.readFileSync(managedPath, 'utf8');
  const legacyBefore = fs.readFileSync(path.join(site.targetRoot, '.skillops', 'lock.json'), 'utf8');
  const migrationPlan = plan(site);
  assert.throws(
    () => commitManagedLockMigration({
      targetRoot: site.targetRoot, plan: migrationPlan, confirmPlanDigest: migrationPlan.planDigest,
    }, {
      clock: () => new Date(COMMIT_AT),
      fault: point => { if (point === 'before-ledger-commit') throw new Error('fixture commit failure'); },
    }),
    error => error.code === 'MIGRATION_COMMIT_FAILED',
  );
  assert.equal(fs.readFileSync(managedPath, 'utf8'), managedBefore);
  assert.equal(fs.readFileSync(path.join(site.targetRoot, '.skillops', 'lock.json'), 'utf8'), legacyBefore);
});

test('same confirmed plan replays idempotently; same operation with another plan conflicts', t => {
  const site = workspace(t);
  const first = plan(site);
  const alternate = plan(site, {
    mappings: [mapping(site.deployments[0], 0, {
      trustSnapshot: { ...mapping(site.deployments[0]).trustSnapshot, policyVersion: 'registry-v2' },
    })],
  });
  commitManagedLockMigration({ targetRoot: site.targetRoot, plan: first, confirmPlanDigest: first.planDigest }, { clock: () => new Date(COMMIT_AT) });
  const beforeReplay = fs.readFileSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json'), 'utf8');
  const replay = commitManagedLockMigration({ targetRoot: site.targetRoot, plan: first, confirmPlanDigest: first.planDigest });
  assert.equal(replay.action, 'unchanged');
  assert.equal(fs.readFileSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json'), 'utf8'), beforeReplay);
  assert.throws(
    () => commitManagedLockMigration({ targetRoot: site.targetRoot, plan: alternate, confirmPlanDigest: alternate.planDigest }),
    error => error.code === 'OPERATION_CONFLICT',
  );
});

test('migration records omit skill bodies and sensitive prompt/output/token fields; implementation has no network/runtime path', t => {
  const site = workspace(t);
  const migrationPlan = plan(site);
  commitManagedLockMigration({ targetRoot: site.targetRoot, plan: migrationPlan, confirmPlanDigest: migrationPlan.planDigest }, { clock: () => new Date(COMMIT_AT) });
  const serialized = fs.readFileSync(path.join(site.targetRoot, '.skillops', 'managed-lock-v2.json'), 'utf8');
  for (const forbidden of ['Never execute this fixture', 'prompt', 'output', 'token']) assert.equal(serialized.includes(forbidden), false);
  const source = fs.readFileSync(new URL('../dist-src/skillops/scripts/lib/managed-lock-migration.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'fetch(', 'http:', 'https:', 'process.env', 'eval(', 'Function(', 'import(']) {
    assert.equal(source.includes(forbidden), false, `migration must not contain ${forbidden}`);
  }
});
