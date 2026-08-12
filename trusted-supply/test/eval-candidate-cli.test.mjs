import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CandidateStore } from '../lib/store.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';

const CLI = path.resolve(import.meta.dirname, '../cli.mjs');
const SKILL = '---\nname: eval-cli\ndescription: Evaluate a fixture skill.\n---\n\nReturn deterministic fixture output.\n';

function suite() {
  return {
    schemaVersion: 1,
    suiteId: 'fixture/cli',
    suiteVersion: '1.0.0',
    cases: [
      { id: 'hello', prompt: '输出：你好', assertions: [{ type: 'contains', value: '你好' }] },
      { id: 'concise', prompt: '输出简短答案', assertions: [{ type: 'max_chars', value: 20 }] },
    ],
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v36-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'candidates.json');
  const suitePath = path.join(root, 'cases.json');
  const fixturesPath = path.join(root, 'fixtures.json');
  const packageArtifact = createPackageArtifact({
    sourceVersion: 'v1', collectedAt: '2026-08-13T12:00:00.000Z',
    files: [{ path: 'SKILL.md', content: SKILL, mediaType: 'text/markdown' }],
  });
  fs.writeFileSync(suitePath, JSON.stringify(suite()));
  fs.writeFileSync(fixturesPath, JSON.stringify({ hello: '你好', concise: '简短答案' }));
  const store = new CandidateStore(storePath);
  const candidate = store.ingest({
    source: { kind: 'fixture', repo: 'fixture/eval-cli', path: 'SKILL.md', commit: 'v1', license: 'MIT' },
    content: SKILL, license: 'MIT', package: packageArtifact, catalog: { packageComplete: true },
  });
  store.auditPackage(candidate.id, { status: 'pass', auditor: 'fixture-package-auditor', findings: [] });
  return { root, storePath, suitePath, fixturesPath, store, candidate };
}

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { /* surfaced by assertions */ }
  return { ...result, json };
}

test('eval-suite-validate and fixture eval-run persist canonical append-only evidence', t => {
  const context = workspace(t);
  const checked = run('eval-suite-validate', context.suitePath, '--store', context.storePath);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.json.suiteDigest, /^sha256:[a-f0-9]{64}$/);

  const evaluated = run('eval-run', context.candidate.id, '--suite', context.suitePath,
    '--adapter', 'fixture', '--fixture-results', context.fixturesPath, '--store', context.storePath);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.json.eval.status, 'complete');
  assert.equal(evaluated.json.eval.runner, 'fixture:v1');
  assert.equal(evaluated.json.eval.environment.kind, 'offline-fixture');
  assert.equal(evaluated.json.eval.successRate, 1);
  assert.equal(evaluated.json.evalEvents.length, 1);

  const shown = run('eval-show', context.candidate.id, '--store', context.storePath);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.current.suiteId, 'fixture/cli');
  assert.equal(shown.json.history.length, 1);
  assert.equal(shown.json.history[0].suiteDigest, checked.json.suiteDigest);
});

test('eval-run only accepts the literal fixture adapter and never a path or shell command', t => {
  const context = workspace(t);
  for (const adapter of ['./executor.mjs', 'shell', 'model']) {
    const result = run('eval-run', context.candidate.id, '--suite', context.suitePath,
      '--adapter', adapter, '--fixture-results', context.fixturesPath, '--store', context.storePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture|adapter/i);
  }
});

test('eval-import validates against an explicit suite and rejects a forged summary', t => {
  const context = workspace(t);
  const evaluated = run('eval-run', context.candidate.id, '--suite', context.suitePath,
    '--adapter', 'fixture', '--fixture-results', context.fixturesPath, '--store', context.storePath);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const forgedPath = path.join(context.root, 'forged.json');
  fs.writeFileSync(forgedPath, JSON.stringify({ ...evaluated.json.eval, successRate: 0 }));

  const forged = run('eval-import', context.candidate.id, '--input', forgedPath,
    '--suite', context.suitePath, '--store', context.storePath);
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /success|summary|rate/i);
});

test('package changes clear current Eval while retaining immutable evalEvents', t => {
  const context = workspace(t);
  const evaluated = run('eval-run', context.candidate.id, '--suite', context.suitePath,
    '--adapter', 'fixture', '--fixture-results', context.fixturesPath, '--store', context.storePath);
  assert.equal(evaluated.status, 0, evaluated.stderr);

  const nextPackage = createPackageArtifact({
    sourceVersion: 'v2', collectedAt: '2026-08-13T12:30:00.000Z',
    files: [
      { path: 'SKILL.md', content: SKILL, mediaType: 'text/markdown' },
      { path: 'reference.md', content: 'changed attachment\n', mediaType: 'text/markdown' },
    ],
  });
  context.store.ingest({
    id: context.candidate.id, source: { ...context.candidate.source, commit: 'v2' }, content: SKILL,
    license: 'MIT', package: nextPackage, catalog: { packageComplete: true },
  });
  const refreshed = context.store.get(context.candidate.id);
  assert.deepEqual(refreshed.eval, { status: 'pending' });
  assert.equal(refreshed.evalEvents.length, 1);
  assert.equal(refreshed.evalEvents[0].suiteDigest, normalizeEvalSuite(suite()).suiteDigest);
  assert.throws(() => context.store.update(refreshed.id, candidate => ({ ...candidate, evalEvents: [] })), /append-only/i);
});
