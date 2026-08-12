import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist-src', 'skillops', 'scripts', 'skillops.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v31-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(home, cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

function makeSkill(dir, { id = 'acme/research', version = '1.0.0', body = 'Follow the research workflow.' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: research\ndescription: Reliable research workflow\nid: ${id}\nversion: ${version}\n---\n\n${body}\n`, 'utf8');
}

function setupVault(t) {
  const base = tempDir(t);
  const home = path.join(base, 'home');
  const vault = path.join(base, 'vault');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  makeSkill(path.join(vault, 'research'));
  assert.equal(run(home, base, 'init', '--namespace', 'acme').status, 0);
  assert.equal(run(home, base, 'vault', 'add', vault, '--name', 'fixture').status, 0);
  assert.equal(run(home, base, 'scan').status, 0);
  return { base, home, vault, project, source: path.join(vault, 'research') };
}

test('deploy writes a lockfile and is idempotent', (t) => {
  const ctx = setupVault(t);
  const first = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const lockFile = path.join(ctx.project, '.skillops', 'lock.json');
  assert.ok(fs.existsSync(lockFile), 'deploy must write .skillops/lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.equal(Object.keys(lock.deployments).length, 1);
  assert.equal(lock.deployments['acme/research'].skillId, 'acme/research');
  assert.equal(lock.deployments['acme/research'].targetPath, path.join(ctx.project, 'research'));
  const before = fs.readFileSync(lockFile, 'utf8');

  const second = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), before, 'repeat deploy must be a zero-write no-op');
});

test('deploy refuses to overwrite an unknown target', (t) => {
  const ctx = setupVault(t);
  const occupied = path.join(ctx.project, 'research');
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'SKILL.md'), 'unmanaged content\n', 'utf8');

  const result = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.notEqual(result.status, 0, 'an unmanaged destination must not be overwritten');
  assert.equal(fs.readFileSync(path.join(occupied, 'SKILL.md'), 'utf8'), 'unmanaged content\n');
});

test('status reports source drift after a deployed skill changes', (t) => {
  const ctx = setupVault(t);
  const deployed = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.equal(deployed.status, 0, deployed.stderr || deployed.stdout);

  makeSkill(ctx.source, { version: '1.1.0', body: 'Follow the improved research workflow with citations.' });
  const status = run(ctx.home, ctx.base, 'status', '--to', ctx.project);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /source-drift/i);
});

test('deploy refuses to overwrite a locally modified managed target', (t) => {
  const ctx = setupVault(t);
  assert.equal(run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project).status, 0);
  const targetFile = path.join(ctx.project, 'research', 'SKILL.md');
  fs.appendFileSync(targetFile, '\nLocal modification.\n', 'utf8');

  makeSkill(ctx.source, { version: '1.1.0', body: 'A source-side update.' });
  const result = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /target-drift|本地修改|拒绝覆盖/i);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /Local modification/);
});

test('status reports a missing deployed target', (t) => {
  const ctx = setupVault(t);
  assert.equal(run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project).status, 0);
  fs.rmSync(path.join(ctx.project, 'research'), { recursive: true });

  const result = run(ctx.home, ctx.base, 'status', '--to', ctx.project);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /target-missing/i);
});

test('deploy safely updates a clean managed target when the source changes', (t) => {
  const ctx = setupVault(t);
  assert.equal(run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project).status, 0);

  makeSkill(ctx.source, { version: '1.1.0', body: 'A source-side update.' });
  const result = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /升级完成/);
  assert.match(fs.readFileSync(path.join(ctx.project, 'research', 'SKILL.md'), 'utf8'), /source-side update/);

  const status = run(ctx.home, ctx.base, 'status', '--to', ctx.project);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /漂移 0/);
});

test('deploy rejects symbolic links in a skill artifact', (t) => {
  const ctx = setupVault(t);
  fs.symlinkSync('/tmp/outside-skillops-fixture', path.join(ctx.source, 'outside-link'));

  const result = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', ctx.project);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /符号链接|symbolic link/i);
  assert.equal(fs.existsSync(path.join(ctx.project, 'research')), false);
});

test('deploy rejects a target root that is not a directory', (t) => {
  const ctx = setupVault(t);
  const targetFile = path.join(ctx.base, 'not-a-directory');
  fs.writeFileSync(targetFile, 'occupied\n', 'utf8');

  const result = run(ctx.home, ctx.base, 'deploy', 'acme/research', '--to', targetFile);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /不是普通目录|not.*directory/i);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'occupied\n');
});

test('legacy CLI entry forwards to the single source and existing inventory commands still work', (t) => {
  const ctx = setupVault(t);
  const legacy = path.join(ROOT, 'cli', 'skillops.mjs');
  const listed = spawnSync(process.execPath, [legacy, 'ls'], {
    cwd: ctx.base,
    env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /acme\/research/);

  const help = spawnSync(process.execPath, [legacy, 'help'], {
    cwd: ctx.base,
    env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /deploy <技能>/);
});
