import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPackageArtifact,
  createPackageManifest,
  normalizePackageManifest,
  normalizePackagePath,
  packageDigest,
  validatePackageArtifact,
} from '../lib/package.mjs';

const FILES = [
  { path: 'SKILL.md', content: '# Safe skill\n', mediaType: 'text/markdown' },
  { path: 'scripts/run.mjs', content: 'export const ok = true;\n', mediaType: 'text/javascript', executable: true },
  { path: 'references/说明.md', content: '仅供参考。\n', mediaType: 'text/markdown' },
];

test('manifest and package digest are stable across input order', () => {
  const first = createPackageManifest(FILES);
  const second = createPackageManifest([...FILES].reverse());
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.packageDigest, second.packageDigest);
  assert.deepEqual(first.manifest.map(row => row.path), ['SKILL.md', 'references/说明.md', 'scripts/run.mjs']);
  assert.match(first.packageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.fileCount, 3);
});
test('canonical paths normalize Unicode NFC and reject traversal and platform aliases', () => {
  assert.equal(normalizePackagePath('references/cafe\u0301.md'), 'references/café.md');
  for (const unsafe of ['', '/SKILL.md', '../SKILL.md', 'a/../SKILL.md', './SKILL.md', 'a//b', 'C:/SKILL.md', 'a\\b', 'a\0b']) {
    assert.throws(() => normalizePackagePath(unsafe), /path/i, unsafe);
  }
});

test('manifest rejects duplicate, Unicode aliases, and case-insensitive conflicts', () => {
  const base = createPackageManifest([FILES[0]]).manifest[0];
  assert.throws(() => normalizePackageManifest([base, base]), /duplicate/i);
  assert.throws(() => createPackageManifest([
    FILES[0],
    { path: 'A.md', content: 'a' },
    { path: 'a.md', content: 'b' },
  ]), /conflict/i);
  assert.throws(() => createPackageManifest([
    FILES[0],
    { path: 'references/café.md', content: 'a' },
    { path: 'references/cafe\u0301.md', content: 'b' },
  ]), /duplicate/i);
});

test('file declarations fail closed on hash and size mismatch', () => {
  assert.throws(() => createPackageManifest([{ ...FILES[0], sha256: '0'.repeat(64) }]), /hash|sha256/i);
  assert.throws(() => createPackageManifest([{ ...FILES[0], size: 999 }]), /size/i);
});

test('hard limits apply to count, per-file bytes, total bytes, depth, path and manifest', () => {
  assert.throws(() => createPackageManifest(FILES.slice(0, 2), { limits: { maxFiles: 1 } }), /file count|more than/i);
  assert.throws(() => createPackageManifest([{ path: 'SKILL.md', content: '12' }], { limits: { maxFileBytes: 1 } }), /file size/i);
  assert.throws(() => createPackageManifest(FILES.slice(0, 2), { limits: { maxTotalBytes: 14 } }), /total size/i);
  assert.throws(() => createPackageManifest([FILES[0], { path: 'a/b/c', content: '' }], { limits: { maxDepth: 2 } }), /depth/i);
  assert.throws(() => createPackageManifest(FILES, { limits: { maxPathBytes: 9 } }), /path length/i);
  assert.throws(() => createPackageManifest(FILES, { limits: { maxManifestBytes: 10 } }), /manifest/i);
});

test('a valid package artifact binds metadata to the canonical manifest', () => {
  const artifact = createPackageArtifact({
    files: FILES,
    sourceVersion: 'skillhub:@maker/safe@1.2.0',
    collectedAt: '2026-08-13T00:00:00Z',
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.storageRef, `cas:${artifact.packageDigest}`);
  assert.equal(artifact.collectedAt, '2026-08-13T00:00:00.000Z');
  assert.deepEqual(validatePackageArtifact(artifact), artifact);

  const tampered = structuredClone(artifact);
  tampered.manifest[0].sha256 = '0'.repeat(64);
  assert.throws(() => validatePackageArtifact(tampered), /digest/i);
  assert.throws(() => validatePackageArtifact({ ...artifact, fileCount: 99 }), /fileCount/i);
  assert.throws(() => validatePackageArtifact({ ...artifact, totalBytes: 99 }), /totalBytes/i);
  assert.throws(() => validatePackageArtifact({ ...artifact, storageRef: 'cas:sha256:' + '0'.repeat(64) }), /storageRef/i);
  assert.equal(packageDigest(artifact.manifest), artifact.packageDigest);
});

test('root SKILL.md is mandatory', () => {
  assert.throws(() => createPackageManifest([{ path: 'references/a.md', content: 'x' }]), /SKILL\.md/i);
});
