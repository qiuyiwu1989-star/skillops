import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { collectSkillHub } from '../lib/skillhub-collector.mjs';
import { collectWhitelist } from '../lib/source-collector.mjs';
import { PackageStore } from '../lib/package-store.mjs';
import { CandidateStore } from '../lib/store.mjs';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-package-collectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'store.json');
  return { root, storePath, packageStorePath: `${storePath}.packages` };
}

function skill(name) {
  return `---\nname: ${name}\ndescription: ${name} package collector fixture\n---\n\nFollow the referenced workflow.\n`;
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function responseBytes(value, status = 200) {
  return new Response(value, { status, headers: { 'content-type': 'application/octet-stream' } });
}

function skillHubFetch(definitions) {
  const items = Object.entries(definitions).map(([slug, value]) => ({
    shelf: value.shelf || 'recommended', slug, namespace: { handle: 'fixture' }, category: 'dev-programming',
  }));
  return async input => {
    const url = new URL(input);
    const shelf = url.pathname.match(/^\/api\/v1\/showcase\/(recommended|trending|hot|newest)$/)?.[1];
    if (shelf) return responseJson({ skills: items.filter(item => item.shelf === shelf) });
    const signature = url.pathname.match(/^\/api\/v1\/open\/skills\/([^/]+)\/versions\/([^/]+)\/signature$/);
    if (signature) {
      const value = definitions[decodeURIComponent(signature[1])];
      return responseJson({ signed: true, skill_slug: signature[1], skill_version: signature[2], content_hash: value.contentHash || sha256(value.files['SKILL.md']) });
    }
    const match = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)(?:\/(files|file))?$/);
    if (!match) return responseJson({}, 404);
    const slug = decodeURIComponent(match[1]);
    const operation = match[2];
    const value = definitions[slug];
    if (!value) return responseJson({}, 404);
    if (!operation) return responseJson({
      latestVersion: { version: value.version || '1.0.0' },
      securityReports: { keen: { status: 'benign' }, sanbu: { status: 'benign' } },
      skill: { slug, category: 'dev-programming', labels: { requires_api_key: 'false' } },
    });
    if (operation === 'files') return responseJson({ files: Object.entries(value.files).map(([filePath, content]) => ({
      path: filePath,
      size: Buffer.byteLength(content),
      sha256: value.badHashPath === filePath ? '0'.repeat(64) : sha256(content),
      executable: filePath.endsWith('.sh'),
    })) });
    return responseBytes(value.files[url.searchParams.get('path')] ?? 'missing', value.files[url.searchParams.get('path')] === undefined ? 404 : 200);
  };
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, relativePath, content, mode) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode) fs.chmodSync(target, mode);
}

function createGitFixture(root, files) {
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  runGit(['init', '--initial-branch=main'], repository);
  runGit(['config', 'user.email', 'fixture@example.test'], repository);
  runGit(['config', 'user.name', 'SkillOps fixture'], repository);
  for (const [filePath, value] of Object.entries(files)) write(repository, filePath, value.content ?? value, value.mode);
  runGit(['add', '-A'], repository);
  runGit(['commit', '-m', 'package fixture'], repository);
  return repository;
}

test('SkillHub collector downloads and verifies every package file before ingest', async t => {
  const site = workspace(t);
  const files = {
    'SKILL.md': skill('complete-package'),
    LICENSE: 'MIT License\nPermission is hereby granted, free of charge.\n',
    'scripts/run.sh': '#!/bin/sh\nprintf safe\n',
    'references/guide.md': '# Guide\n\nUse supplied evidence.\n',
  };
  const report = await collectSkillHub({
    storePath: site.storePath,
    shelves: ['recommended'],
    limit: 1,
    fetchImpl: skillHubFetch({ 'complete-package': { files } }),
  });
  const candidate = new CandidateStore(site.storePath).list()[0];

  assert.equal(report.stats.ingested, 1);
  assert.equal(candidate.status, 'discovered');
  assert.equal(candidate.audit, null);
  assert.equal(candidate.reviewEvents.length, 0);
  assert.match(report.candidates[0].package.packageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.candidates[0].package.fileCount, 4);
  assert.match(candidate.artifact.package?.packageDigest || report.candidates[0].package.packageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(candidate.artifact.package, 'CandidateStore must retain the collector package artifact');
  assert.deepEqual(candidate.artifact.package.manifest.map(file => file.path), [
    'LICENSE', 'SKILL.md', 'references/guide.md', 'scripts/run.sh',
  ]);
  assert.equal(candidate.artifact.package.manifest.find(file => file.path === 'scripts/run.sh').executable, true);
  const packages = new PackageStore(site.packageStorePath);
  assert.equal(packages.has(candidate.artifact.package.packageDigest), true);
  assert.deepEqual(packages.readFiles(candidate.artifact.package.packageDigest).map(file => file.path), [
    'LICENSE', 'SKILL.md', 'references/guide.md', 'scripts/run.sh',
  ]);
  assert.equal(JSON.stringify(report).includes(site.packageStorePath), false, 'report must not expose the CAS path');
});

test('SkillHub package hash failure is isolated and never partially ingested', async t => {
  const site = workspace(t);
  const report = await collectSkillHub({
    storePath: site.storePath,
    shelves: ['recommended'],
    limit: 2,
    fetchImpl: skillHubFetch({
      healthy: { files: { 'SKILL.md': skill('healthy'), LICENSE: 'MIT\n', 'references/a.md': 'safe\n' } },
      tampered: { files: { 'SKILL.md': skill('tampered'), LICENSE: 'MIT\n', 'scripts/run.js': 'safe();\n' }, badHashPath: 'scripts/run.js' },
    }),
  });
  const candidates = new CandidateStore(site.storePath).list();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source.repo, '@fixture/healthy');
  assert.equal(report.stats.ingested, 1);
  assert.equal(report.stats.failed, 1);
  assert.ok(report.errors.some(error => error.skill === '@fixture/tampered' && error.code === 'integrity_mismatch'));
});

test('whitelist git snapshots collect only each SKILL.md directory as its complete package', async t => {
  const site = workspace(t);
  const repository = createGitFixture(site.root, {
    LICENSE: 'MIT\n',
    'skills/alpha/SKILL.md': skill('alpha'),
    'skills/alpha/scripts/run.sh': { content: '#!/bin/sh\nprintf safe\n', mode: 0o755 },
    'skills/alpha/references/guide.md': '# Alpha guide\n',
    'skills/beta/SKILL.md': skill('beta'),
    'skills/beta/assets/prompt.txt': 'Beta only\n',
  });
  const report = collectWhitelist({
    whitelist: { schemaVersion: 1, repositories: [{ localPath: repository, paths: ['skills'] }] },
    storePath: site.storePath,
    baseDir: site.root,
    allowLocal: true,
  });
  const candidates = new CandidateStore(site.storePath).list().sort((a, b) => a.source.path.localeCompare(b.source.path));

  assert.equal(report.stats.skills.ingested, 2);
  assert.deepEqual(report.repositories[0].candidates.map(candidate => candidate.package.fileCount), [3, 2]);
  assert.ok(candidates.every(candidate => candidate.artifact.package), 'CandidateStore must retain each package artifact');
  assert.deepEqual(candidates[0].artifact.package.manifest.map(file => file.path), [
    'SKILL.md', 'references/guide.md', 'scripts/run.sh',
  ]);
  assert.deepEqual(candidates[1].artifact.package.manifest.map(file => file.path), [
    'SKILL.md', 'assets/prompt.txt',
  ]);
  assert.equal(candidates[0].artifact.package.manifest.find(file => file.path === 'scripts/run.sh').executable, true);
  assert.ok(candidates.every(candidate => candidate.status === 'discovered' && candidate.audit === null));
  const packages = new PackageStore(site.packageStorePath);
  assert.ok(candidates.every(candidate => packages.verify(candidate.artifact.package.packageDigest)));
  assert.equal(fs.readdirSync(path.join(site.packageStorePath, 'sha256')).length, 2);
});

test('whitelist rejects a symlinked package before writing any candidate', t => {
  const site = workspace(t);
  const repository = createGitFixture(site.root, {
    LICENSE: 'MIT\n',
    'skills/linked/SKILL.md': skill('linked'),
    'skills/linked/references/guide.md': '# Safe guide\n',
  });
  fs.symlinkSync('../../../outside-secret', path.join(repository, 'skills/linked/assets-link'));
  runGit(['add', '-A'], repository);
  runGit(['commit', '-m', 'unsafe symlink fixture'], repository);

  const report = collectWhitelist({
    whitelist: { schemaVersion: 1, repositories: [{ localPath: repository, paths: ['skills'] }] },
    storePath: site.storePath,
    baseDir: site.root,
    allowLocal: true,
  });

  assert.equal(report.stats.repositories.failed, 1);
  assert.ok(report.errors.some(error => error.code === 'symbolic_link_rejected'));
  assert.equal(new CandidateStore(site.storePath).list().length, 0);
});

test('repeated SkillHub sync reuses one CAS package and persists the CAS artifact on the candidate', async t => {
  const site = workspace(t);
  const definition = { repeatable: { files: {
    'SKILL.md': skill('repeatable'), LICENSE: 'MIT\n', 'references/a.md': 'safe\n',
  } } };
  const options = {
    storePath: site.storePath,
    packageStorePath: site.packageStorePath,
    shelves: ['recommended'],
    limit: 1,
    fetchImpl: skillHubFetch(definition),
    clock: () => new Date('2026-08-13T13:00:00.000Z'),
  };
  const first = await collectSkillHub(options);
  const second = await collectSkillHub(options);
  const candidate = new CandidateStore(site.storePath).list()[0];
  const packages = new PackageStore(site.packageStorePath);

  assert.equal(first.candidates[0].package.storageAction, 'stored');
  assert.equal(second.candidates[0].package.storageAction, 'unchanged');
  assert.equal(first.candidates[0].package.packageDigest, second.candidates[0].package.packageDigest);
  assert.equal(candidate.artifact.package.packageDigest, first.candidates[0].package.packageDigest);
  assert.equal(fs.readdirSync(path.join(site.packageStorePath, 'sha256')).length, 1);
  assert.equal(packages.readFiles(candidate.artifact.package.packageDigest).length, 3);
});

test('CAS publication failure prevents both collectors from writing candidates', async t => {
  const skillHub = workspace(t);
  fs.writeFileSync(skillHub.packageStorePath, 'occupied');
  const hubReport = await collectSkillHub({
    storePath: skillHub.storePath,
    packageStorePath: skillHub.packageStorePath,
    shelves: ['recommended'],
    limit: 1,
    fetchImpl: skillHubFetch({ blocked: { files: { 'SKILL.md': skill('blocked'), LICENSE: 'MIT\n' } } }),
  });
  assert.equal(hubReport.stats.failed, 1);
  assert.equal(new CandidateStore(skillHub.storePath).list().length, 0);

  const whitelist = workspace(t);
  const repository = createGitFixture(whitelist.root, {
    LICENSE: 'MIT\n', 'skills/blocked/SKILL.md': skill('blocked'), 'skills/blocked/a.txt': 'safe\n',
  });
  fs.writeFileSync(whitelist.packageStorePath, 'occupied');
  const sourceReport = collectWhitelist({
    whitelist: { schemaVersion: 1, repositories: [{ localPath: repository, paths: ['skills'] }] },
    storePath: whitelist.storePath,
    packageStorePath: whitelist.packageStorePath,
    baseDir: whitelist.root,
    allowLocal: true,
  });
  assert.equal(sourceReport.stats.repositories.failed, 1);
  assert.equal(new CandidateStore(whitelist.storePath).list().length, 0);
});

test('SkillHub rejects unsafe package paths before downloading or ingesting', async t => {
  const site = workspace(t);
  const baseFetch = skillHubFetch({ unsafe: { files: { 'SKILL.md': skill('unsafe'), LICENSE: 'MIT\n' } } });
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/v1/skills/unsafe/files') return responseJson({ files: [
      { path: 'SKILL.md', size: Buffer.byteLength(skill('unsafe')), sha256: sha256(skill('unsafe')) },
      { path: '../secret', size: 4, sha256: sha256('nope') },
    ] });
    return baseFetch(input);
  };

  const report = await collectSkillHub({
    storePath: site.storePath,
    shelves: ['recommended'],
    limit: 1,
    fetchImpl,
  });

  assert.equal(report.stats.failed, 1);
  assert.ok(report.errors.some(error => error.code === 'unsafe_file_path'));
  assert.equal(new CandidateStore(site.storePath).list().length, 0);
});
