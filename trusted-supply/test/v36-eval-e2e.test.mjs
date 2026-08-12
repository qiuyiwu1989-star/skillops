import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CandidateStore } from '../lib/store.mjs';
import { PackageStore } from '../lib/package-store.mjs';
import { auditPackageFiles } from '../lib/package-audit.mjs';
import { applyAudit } from '../lib/candidate.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const SKILL = `---
name: eval-fixture
description: Produce a concise evidence-backed decision.
---

Return the supplied decision and do not invent evidence.
`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v36-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDirectory = path.join(root, 'package');
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, 'SKILL.md'), SKILL);
  fs.writeFileSync(path.join(packageDirectory, 'reference.md'), 'Approved evidence only.\n');
  return {
    root,
    packageDirectory,
    packageStore: new PackageStore(path.join(root, 'cas')),
    store: new CandidateStore(path.join(root, 'candidates.json')),
  };
}

function suite() {
  return {
    schemaVersion: 1,
    suiteId: 'fixture/decision',
    suiteVersion: '1.0.0',
    cases: [
      { id: 'approve', prompt: '请输出：批准', assertions: [{ type: 'contains', value: '批准' }] },
      { id: 'no-fabrication', prompt: '请输出：证据不足', assertions: [{ type: 'not_contains', value: '虚构' }] },
    ],
  };
}

test('offline fixture eval reaches append-only candidate evidence and listing without becoming a runtime', async t => {
  const [{ normalizeEvalSuite }, { runEvalSuite }, { createFixtureEvalAdapter }] = await Promise.all([
    import('../lib/eval-suite.mjs'), import('../lib/eval-runner.mjs'), import('../lib/eval-fixture-adapter.mjs'),
  ]);
  const site = workspace(t);
  const stored = site.packageStore.importDirectory(site.packageDirectory, { sourceVersion: 'v1' });
  let candidate = site.store.ingest({
    source: { kind: 'fixture', repo: 'fixture/eval', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: SKILL,
    license: 'MIT',
    package: stored.artifact,
    catalog: { packageComplete: true },
    sms: completeSmsInput(82),
  });
  const packageAudit = auditPackageFiles(site.packageStore.readFiles(stored.artifact.packageDigest), stored.artifact);
  candidate = site.store.auditPackage(candidate.id, { ...packageAudit, auditor: 'fixture-package-auditor' });
  candidate = site.store.update(candidate.id, value => applyAudit(value));

  const normalized = normalizeEvalSuite(suite());
  const result = await runEvalSuite({
    suite: normalized,
    packageDigest: candidate.artifact.package.packageDigest,
    packageAudit,
    executor: createFixtureEvalAdapter({ approve: '批准', 'no-fabrication': '证据不足' }),
  });
  const evaluated = site.store.recordEval(candidate.id, result);

  assert.equal(evaluated.eval.status, 'complete');
  assert.equal(evaluated.eval.successRate, 1);
  assert.equal(evaluated.evalEvents.length, 1);
  assert.equal(evaluated.eval.basedOnPackageDigest, candidate.artifact.package.packageDigest);
  assert.equal(evaluated.eval.suiteDigest, normalized.suiteDigest);

  site.store.assessSms(candidate.id, completeSmsInput(82));
  site.store.audit(candidate.id);
  site.store.review(candidate.id, {
    decision: 'approve', reviewer: 'independent-human', reason: 'Package, SMS, Eval, and trust evidence passed.',
  });
  const listing = site.store.listing(candidate.id);
  assert.equal(listing.eval.status, 'complete');
  assert.equal(listing.eval.successRate, 1);
  assert.notEqual(listing.eval, listing.sms);
});

test('package changes stale current Eval while preserving immutable Eval history', async t => {
  const [{ normalizeEvalSuite }, { runEvalSuite }, { createFixtureEvalAdapter }] = await Promise.all([
    import('../lib/eval-suite.mjs'), import('../lib/eval-runner.mjs'), import('../lib/eval-fixture-adapter.mjs'),
  ]);
  const site = workspace(t);
  const first = site.packageStore.importDirectory(site.packageDirectory, { sourceVersion: 'v1' });
  const candidate = site.store.ingest({
    source: { kind: 'fixture', repo: 'fixture/eval-stale', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: SKILL, license: 'MIT', package: first.artifact, catalog: { packageComplete: true }, sms: completeSmsInput(82),
  });
  const result = await runEvalSuite({
    suite: normalizeEvalSuite(suite()),
    packageDigest: candidate.artifact.package.packageDigest,
    packageAudit: auditPackageFiles(site.packageStore.readFiles(first.artifact.packageDigest), first.artifact),
    executor: createFixtureEvalAdapter({ approve: '批准', 'no-fabrication': '证据不足' }),
  });
  site.store.recordEval(candidate.id, result);

  fs.writeFileSync(path.join(site.packageDirectory, 'reference.md'), 'Updated approved evidence.\n');
  const second = site.packageStore.importDirectory(site.packageDirectory, { sourceVersion: 'v2' });
  site.store.ingest({
    id: candidate.id,
    source: { ...candidate.source, commit: 'v2' },
    content: SKILL,
    license: 'MIT',
    package: second.artifact,
    catalog: { packageComplete: true },
  });
  const refreshed = site.store.get(candidate.id);
  assert.deepEqual(refreshed.eval, { status: 'pending' });
  assert.equal(refreshed.evalEvents.length, 1);
  assert.equal(refreshed.evalEvents[0].suiteDigest, result.suiteDigest);
});

test('forged success rate, wrong package digest, and unsupported adapter fail closed', async t => {
  const [{ normalizeEvalSuite }, { validateEvalResult }, { runEvalSuite }, { createFixtureEvalAdapter }] = await Promise.all([
    import('../lib/eval-suite.mjs'), import('../lib/eval-result.mjs'), import('../lib/eval-runner.mjs'), import('../lib/eval-fixture-adapter.mjs'),
  ]);
  const site = workspace(t);
  const stored = site.packageStore.importDirectory(site.packageDirectory, { sourceVersion: 'v1' });
  const normalized = normalizeEvalSuite(suite());
  const packageAudit = auditPackageFiles(site.packageStore.readFiles(stored.artifact.packageDigest), stored.artifact);
  const result = await runEvalSuite({
    suite: normalized,
    packageDigest: stored.artifact.packageDigest,
    packageAudit,
    executor: createFixtureEvalAdapter({ approve: '批准', 'no-fabrication': '证据不足' }),
  });
  assert.throws(() => validateEvalResult({ ...result, successRate: 0.25 }, {
    packageDigest: stored.artifact.packageDigest, suite: normalized,
  }), /success|rate|summary/i);
  assert.throws(() => validateEvalResult(result, {
    packageDigest: `sha256:${'0'.repeat(64)}`, suite: normalized,
  }), /package|digest/i);
  await assert.rejects(() => runEvalSuite({
    suite: normalized,
    packageDigest: stored.artifact.packageDigest,
    packageAudit,
    executor: null,
  }), /executor/i);
});

test('ingest cannot bypass recordEval with caller-supplied complete evidence', t => {
  const site = workspace(t);
  const stored = site.packageStore.importDirectory(site.packageDirectory, { sourceVersion: 'v1' });
  assert.throws(() => site.store.ingest({
    source: { kind: 'fixture', repo: 'fixture/eval-bypass', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: SKILL,
    license: 'MIT',
    package: stored.artifact,
    eval: {
      status: 'complete',
      basedOnPackageDigest: stored.artifact.packageDigest,
      successRate: 1,
    },
  }), /recordEval/i);
  assert.equal(site.store.list().length, 0);
});
