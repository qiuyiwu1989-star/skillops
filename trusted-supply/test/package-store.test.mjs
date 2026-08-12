import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PackageStore } from '../lib/package-store.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# Safe\n');
  fs.writeFileSync(path.join(source, 'scripts', 'run.mjs'), 'export default true;\n', { mode: 0o755 });
  return { root, source, store: new PackageStore(path.join(root, 'cas')) };
}

test('directory import atomically stores and verifies a complete package', t => {
  const ctx = workspace(t);
  const result = ctx.store.importDirectory(ctx.source, {
    sourceVersion: 'fixture@1', collectedAt: '2026-08-13T01:00:00Z',
  });
  assert.equal(result.action, 'stored');
  assert.equal(result.artifact.fileCount, 2);
  assert.equal(result.artifact.storageRef, `cas:${result.artifact.packageDigest}`);
  assert.deepEqual(ctx.store.verify(result.artifact.packageDigest), result.record);
  const entry = result.record.manifest.find(row => row.path === 'scripts/run.mjs');
  assert.equal(entry.executable, true);
});

test('repeated imports are idempotent with one content-addressed package', t => {
  const ctx = workspace(t);
  const first = ctx.store.importDirectory(ctx.source, { sourceVersion: 'fixture@1' });
  const second = ctx.store.importDirectory(ctx.source, { sourceVersion: 'fixture@1' });
  assert.equal(first.action, 'stored');
  assert.equal(second.action, 'unchanged');
  assert.equal(first.artifact.packageDigest, second.artifact.packageDigest);
  assert.equal(fs.readdirSync(path.join(ctx.store.root, 'sha256')).length, 1);
});

test('directory import rejects symbolic and hard links without publishing CAS content', t => {
  const symlink = workspace(t);
  fs.symlinkSync('../SKILL.md', path.join(symlink.source, 'scripts', 'alias'));
  assert.throws(() => symlink.store.importDirectory(symlink.source, { sourceVersion: 'fixture@1' }), /symbolic link/i);
  assert.equal(fs.existsSync(path.join(symlink.store.root, 'sha256')), false);

  const hardlink = workspace(t);
  fs.linkSync(path.join(hardlink.source, 'SKILL.md'), path.join(hardlink.source, 'COPY.md'));
  assert.throws(() => hardlink.store.importDirectory(hardlink.source, { sourceVersion: 'fixture@1' }), /hard-linked/i);
  assert.equal(fs.existsSync(path.join(hardlink.store.root, 'sha256')), false);
});

test('directory import rejects special files without publishing a package', { skip: process.platform === 'win32' }, t => {
  const ctx = workspace(t);
  const fifo = path.join(ctx.source, 'channel');
  const result = makeFifo(fifo);
  if (!result) return t.skip('mkfifo is unavailable');
  assert.throws(() => ctx.store.importDirectory(ctx.source, { sourceVersion: 'fixture@1' }), /unsupported file type/i);
  assert.equal(fs.existsSync(path.join(ctx.store.root, 'sha256')), false);
});

function makeFifo(filePath) {
  return spawnSync('mkfifo', [filePath], { stdio: 'ignore' }).status === 0;
}

test('putFiles rejects declared upstream hash mismatch before CAS mutation', t => {
  const ctx = workspace(t);
  assert.throws(() => ctx.store.putFiles([
    { path: 'SKILL.md', content: '# Safe\n', sha256: '0'.repeat(64) },
  ], { sourceVersion: 'fixture@1' }), /sha256|hash/i);
  assert.equal(fs.existsSync(path.join(ctx.store.root, 'sha256')), false);
});

test('verification detects missing, additional and modified files bidirectionally', t => {
  for (const mutation of ['missing', 'additional', 'modified']) {
    const ctx = workspace(t);
    const stored = ctx.store.importDirectory(ctx.source, { sourceVersion: `fixture@${mutation}` });
    const payload = path.join(stored.path, 'files');
    if (mutation === 'missing') fs.rmSync(path.join(payload, 'scripts', 'run.mjs'));
    if (mutation === 'additional') fs.writeFileSync(path.join(payload, 'extra.txt'), 'extra');
    if (mutation === 'modified') fs.appendFileSync(path.join(payload, 'SKILL.md'), 'tampered');
    assert.throws(() => ctx.store.verify(stored.artifact.packageDigest), /CAS|digest|file/i, mutation);
  }
});

test('storage setup failure leaves no published digest', t => {
  const ctx = workspace(t);
  fs.mkdirSync(ctx.store.root, { recursive: true });
  fs.writeFileSync(path.join(ctx.store.root, 'sha256'), 'occupied');
  assert.throws(() => ctx.store.importDirectory(ctx.source, { sourceVersion: 'fixture@1' }));
  assert.equal(fs.readFileSync(path.join(ctx.store.root, 'sha256'), 'utf8'), 'occupied');
});
