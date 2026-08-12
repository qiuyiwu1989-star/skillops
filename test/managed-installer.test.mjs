import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PackageStore } from '../trusted-supply/lib/package-store.mjs';
import { canonicalDigest } from '../trusted-supply/lib/registry-identity.mjs';
import { normalizeRelease, sourceId } from '../trusted-supply/lib/registry-identity.mjs';
import { RegistryStore } from '../trusted-supply/lib/registry-store.mjs';
import { createManagedDistributionPlan } from '../dist-src/skillops/scripts/lib/managed-distribution.mjs';
import {
  RegistryCache,
  createLocalRegistrySource,
  syncRegistry,
} from '../dist-src/skillops/scripts/lib/registry-client.mjs';
import {
  ManagedInstallerError,
  installManagedRelease,
  readManagedInstallLock,
} from '../dist-src/skillops/scripts/lib/managed-installer.mjs';

const NOW = '2026-08-13T08:00:00.000Z';
const sha = value => `sha256:${value.repeat(64)}`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-managed-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    target: path.join(root, 'target'),
    store: new PackageStore(path.join(root, 'cas')),
  };
}

function packageRecord(site, marker = 'v1') {
  return site.store.putFiles([
    { path: 'SKILL.md', content: `---\nname: managed-fixture\ndescription: ${marker}\n---\n\nDo not execute.\n`, mediaType: 'text/markdown' },
    { path: 'references/evidence.md', content: `${marker}\n`, mediaType: 'text/markdown' },
  ], { sourceVersion: marker, collectedAt: NOW });
}

function planFor(record, overrides = {}) {
  return createManagedDistributionPlan({
    operationId: overrides.operationId ?? 'op_managed_install_001',
    action: overrides.action ?? 'install',
    skillId: 'qiuyiwu/managed-fixture',
    releaseId: overrides.releaseId ?? `rel_${'1'.repeat(64)}`,
    version: overrides.version ?? '1.0.0',
    packageDigest: record.packageDigest,
    registrySourceId: 'regsrc_local_fixture',
    releaseStatus: 'published',
    manifest: record.manifest,
    manifestDigest: canonicalDigest(record.manifest),
    trustSnapshot: {
      policyVersion: 'review-v1', reviewValidUntil: '2026-09-13T00:00:00Z', feedCursor: '1',
      reviewDigest: sha('a'), evalDigest: sha('b'),
    },
    targetState: overrides.targetState ?? { exists: false, managed: false },
    currentLock: overrides.currentLock,
  }, { now: NOW });
}

test('installs a verified CAS package only after exact planDigest confirmation and writes Lock v2', t => {
  const site = workspace(t);
  const stored = packageRecord(site).record;
  const plan = planFor(stored);
  const result = installManagedRelease({
    plan, packageStore: site.store, targetRoot: site.target, installationId: 'inst_managed_fixture_001',
    confirmPlanDigest: plan.planDigest,
  }, { clock: () => new Date(NOW) });
  assert.equal(result.action, 'installed');
  assert.equal(fs.readFileSync(path.join(result.targetPath, 'references/evidence.md'), 'utf8'), 'v1\n');
  const ledger = readManagedInstallLock(site.target);
  const lock = ledger.installations.inst_managed_fixture_001;
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.releaseId, plan.subject.releaseId);
  assert.equal(lock.packageDigest, stored.packageDigest);
  assert.equal(lock.planDigest, plan.planDigest);
  assert.equal(installManagedRelease({
    plan, packageStore: site.store, targetRoot: site.target, installationId: 'inst_managed_fixture_001',
    confirmPlanDigest: plan.planDigest,
  }).action, 'unchanged');
});

test('rejects unconfirmed plans, missing CAS content, unknown targets and target drift', t => {
  const site = workspace(t);
  const stored = packageRecord(site).record;
  const plan = planFor(stored);
  const base = { plan, packageStore: site.store, targetRoot: site.target, installationId: 'inst_managed_fixture_001' };
  assert.throws(() => installManagedRelease({ ...base, confirmPlanDigest: sha('0') }), error => error.code === 'PLAN_CONFIRMATION_REQUIRED');

  fs.mkdirSync(site.target, { recursive: true });
  fs.mkdirSync(path.join(site.target, 'managed-fixture'));
  fs.writeFileSync(path.join(site.target, 'managed-fixture', 'SKILL.md'), 'unknown');
  assert.throws(() => installManagedRelease({ ...base, confirmPlanDigest: plan.planDigest }), error => error.code === 'UNKNOWN_TARGET');
  fs.rmSync(path.join(site.target, 'managed-fixture'), { recursive: true, force: true });

  const installed = installManagedRelease({ ...base, confirmPlanDigest: plan.planDigest }, { clock: () => new Date(NOW) });
  fs.appendFileSync(path.join(installed.targetPath, 'SKILL.md'), '\nlocal edit\n');
  assert.throws(() => installManagedRelease({ ...base, confirmPlanDigest: plan.planDigest }), error => error.code === 'TARGET_DRIFT');

  const empty = workspace(t);
  const missingPlan = planFor(stored, { operationId: 'op_missing_cas_001' });
  assert.throws(() => installManagedRelease({
    plan: missingPlan, packageStore: empty.store, targetRoot: empty.target,
    installationId: 'inst_missing_cas_001', confirmPlanDigest: missingPlan.planDigest,
  }), error => error.code === 'PACKAGE_VERIFY_FAILED');

  assert.throws(() => installManagedRelease({
    ...base, targetRoot: site.store.root, confirmPlanDigest: plan.planDigest,
  }), error => error.code === 'TARGET_OVERLAPS_CAS');
});

test('lock commit failure restores the previous target and leaves the old Lock v2 unchanged', t => {
  const site = workspace(t);
  const first = packageRecord(site, 'v1').record;
  const firstPlan = planFor(first);
  const installed = installManagedRelease({
    plan: firstPlan, packageStore: site.store, targetRoot: site.target, installationId: 'inst_managed_fixture_001',
    confirmPlanDigest: firstPlan.planDigest,
  }, { clock: () => new Date(NOW) });
  const oldLedger = readManagedInstallLock(site.target);

  const second = packageRecord(site, 'v2').record;
  const currentLock = oldLedger.installations.inst_managed_fixture_001;
  const updatePlan = planFor(second, {
    action: 'update', operationId: 'op_managed_update_001', version: '1.1.0', releaseId: `rel_${'2'.repeat(64)}`,
    currentLock,
    targetState: {
      exists: true, managed: true,
      deployedFingerprint: currentLock.deployedFingerprint,
      currentFingerprint: currentLock.deployedFingerprint,
    },
  });
  assert.throws(() => installManagedRelease({
    plan: updatePlan, packageStore: site.store, targetRoot: site.target, installationId: 'inst_managed_fixture_001',
    confirmPlanDigest: updatePlan.planDigest,
  }, {
    clock: () => new Date('2026-08-13T09:00:00Z'),
    fault: point => { if (point === 'before-lock-commit') throw new Error('fixture lock failure'); },
  }), error => error instanceof ManagedInstallerError && error.code === 'INSTALL_FAILED');
  assert.equal(fs.readFileSync(path.join(installed.targetPath, 'references/evidence.md'), 'utf8'), 'v1\n');
  assert.deepEqual(readManagedInstallLock(site.target), oldLedger);
});

test('managed installer has no runtime, network, shell, dynamic import or script execution path', () => {
  const source = fs.readFileSync(new URL('../dist-src/skillops/scripts/lib/managed-installer.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'fetch(', 'http:', 'https:', 'process.env', 'eval(', 'Function(', 'import(']) {
    assert.equal(source.includes(forbidden), false, `installer must not contain ${forbidden}`);
  }
});

test('verified Registry cache resolves an explicit Release into a confirmed atomic CAS install', t => {
  const site = workspace(t);
  const stored = packageRecord(site, 'registry-v1').record;
  const release = normalizeRelease({
    skillId: 'qiuyiwu/managed-fixture', version: '1.0.0',
    package: {
      packageDigest: stored.packageDigest,
      manifestDigest: canonicalDigest(stored.manifest),
      storageRef: `cas:${stored.packageDigest}`,
    },
    compatibility: { contract: 'skill-package.v1', targets: ['codex'] },
    assessmentRefs: ['eval_fixture', 'sms_fixture'], reviewRefs: ['review_fixture'],
    sourceRefs: [sourceId('fixture', 'registry-managed-fixture@1')], publishedAt: NOW,
  });
  const registry = new RegistryStore(path.join(site.root, 'registry.json'));
  registry.append({
    type: 'release.published', subject: { skillId: release.skillId, releaseId: release.releaseId },
    payload: { release }, occurredAt: NOW, actorRef: 'role:publisher',
    reasonCode: 'certified', policyVersion: 'registry-v1',
  });
  const source = createLocalRegistrySource(registry, { coordinate: 'fixture://managed-registry' });
  const cache = new RegistryCache(path.join(site.root, 'registry-cache.json'), { sourceId: source.sourceId });
  syncRegistry({ cache, source });
  const resolved = cache.resolveRelease(release.releaseId);
  const plan = createManagedDistributionPlan({
    operationId: 'op_registry_managed_install_001', action: 'install',
    skillId: resolved.release.skillId, releaseId: resolved.release.releaseId,
    version: resolved.release.version, packageDigest: resolved.release.package.packageDigest,
    registrySourceId: resolved.registrySourceId, releaseStatus: resolved.status,
    manifest: stored.manifest, manifestDigest: resolved.release.package.manifestDigest,
    trustSnapshot: {
      policyVersion: 'registry-v1', reviewValidUntil: '2026-09-13T00:00:00Z',
      feedCursor: resolved.feedCursor, reviewDigest: sha('a'), evalDigest: sha('b'),
    },
    targetState: { exists: false, managed: false },
  }, { now: NOW });
  const installed = installManagedRelease({
    plan, packageStore: site.store, targetRoot: site.target,
    installationId: 'inst_registry_managed_001', confirmPlanDigest: plan.planDigest,
  }, { clock: () => new Date(NOW) });
  assert.equal(installed.releaseId, release.releaseId);
  assert.equal(installed.packageDigest, stored.packageDigest);
  assert.equal(JSON.stringify(readManagedInstallLock(site.target)).includes('cand_'), false);
});
