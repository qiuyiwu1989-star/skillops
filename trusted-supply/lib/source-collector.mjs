import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyLicense, scanSecurity } from './audit.mjs';
import { CandidateStore } from './store.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxRepositories: 20,
  maxSkillFilesPerRepository: 250,
  maxSkillBytes: 512 * 1024,
  maxLicenseBytes: 256 * 1024,
  maxTreeEntries: 50_000,
  maxTreeOutputBytes: 16 * 1024 * 1024,
});

const HARD_LIMITS = Object.freeze({
  maxRepositories: 100,
  maxSkillFilesPerRepository: 1_000,
  maxSkillBytes: 2 * 1024 * 1024,
  maxLicenseBytes: 1024 * 1024,
  maxTreeEntries: 200_000,
  maxTreeOutputBytes: 64 * 1024 * 1024,
});

const LICENSE_BASENAME = /^(?:licen[cs]e|copying)(?:\.(?:md|markdown|txt))?$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export class SourceCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceCollectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SourceCollectionError(code, message);
}

function toPositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail('invalid_limit', `${name} must be a positive integer`);
  return number;
}

export function resolveLimits(input = {}) {
  const limits = {};
  for (const [name, defaultValue] of Object.entries(DEFAULT_LIMITS)) {
    const value = input[name] === undefined ? defaultValue : toPositiveInteger(input[name], name);
    if (value > HARD_LIMITS[name]) fail('limit_exceeds_hard_cap', `${name} exceeds hard cap ${HARD_LIMITS[name]}`);
    limits[name] = value;
  }
  return limits;
}

function readWhitelistInput(input, baseDir) {
  if (typeof input !== 'string') return { value: input, baseDir };
  const filePath = path.resolve(baseDir, input);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail('invalid_whitelist', `cannot read whitelist ${filePath}: ${error.message}`);
  }
  return { value, baseDir: path.dirname(filePath), filePath };
}

function parseWhitelistStructure(input, { baseDir = process.cwd() } = {}) {
  const loaded = readWhitelistInput(input, path.resolve(baseDir));
  const value = loaded.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_whitelist', 'whitelist must be a JSON object');
  if (value.schemaVersion !== 1) fail('invalid_whitelist', 'whitelist schemaVersion must be 1');
  const repositories = value.repositories ?? value.sources;
  if (!Array.isArray(repositories)) fail('invalid_whitelist', 'whitelist repositories must be an array');
  const limits = resolveLimits(value.limits || {});
  if (repositories.length > limits.maxRepositories) {
    fail('repository_limit_exceeded', `whitelist has ${repositories.length} repositories; limit is ${limits.maxRepositories}`);
  }
  return {
    schemaVersion: 1,
    repositories,
    limits,
    filePath: loaded.filePath || null,
    baseDir: loaded.baseDir,
  };
}

export function parseWhitelist(input, { baseDir = process.cwd(), allowLocal = false } = {}) {
  const parsed = parseWhitelistStructure(input, { baseDir });
  return {
    ...parsed,
    repositories: parsed.repositories.map((entry, index) => normalizeRepository({
      entry, index, baseDir: parsed.baseDir, allowLocal,
    }, { checkLocalExists: false })),
  };
}

function normalizePrefix(value) {
  if (typeof value !== 'string') fail('invalid_path_prefix', 'path prefixes must be strings');
  const raw = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!raw) return '';
  if (raw.startsWith('/') || raw.includes('\0') || raw.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('invalid_path_prefix', `unsafe path prefix: ${value}`);
  }
  return raw;
}

function normalizeRef(value) {
  const ref = String(value || 'HEAD');
  if (!SAFE_REF.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) {
    fail('invalid_ref', `unsafe git ref: ${ref}`);
  }
  return ref;
}

function normalizeGithubUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    fail('invalid_source', `invalid GitHub URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('invalid_source', 'only credential-free https://github.com/owner/repo URLs are allowed');
  }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    fail('invalid_source', 'GitHub URL must identify exactly one owner/repository');
  }
  const repo = `${match[1]}/${match[2]}`;
  return { url: `https://github.com/${repo}`, fetchUrl: `https://github.com/${repo}.git`, repo };
}

function normalizeRepository(wrapper, { checkLocalExists = true } = {}) {
  const { entry, index, baseDir, allowLocal } = wrapper;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_source', `repository ${index + 1} must be an object`);
  const rawPrefixes = entry.paths ?? entry.pathPrefixes ?? (entry.path === undefined ? [''] : [entry.path]);
  if (!Array.isArray(rawPrefixes) || rawPrefixes.length === 0) fail('invalid_path_prefix', 'paths must be a non-empty array');
  const prefixes = [...new Set(rawPrefixes.map(normalizePrefix))];
  const ref = normalizeRef(entry.ref || 'HEAD');
  if (entry.url) {
    return { ...normalizeGithubUrl(entry.url), kind: 'github', ref, prefixes, index };
  }
  if (entry.localPath) {
    if (!allowLocal) fail('invalid_source', 'localPath sources are disabled');
    const localPath = path.resolve(baseDir, String(entry.localPath));
    if (checkLocalExists) {
      let stat;
      try {
        stat = fs.lstatSync(localPath);
      } catch {
        fail('invalid_source', `local git repository does not exist: ${localPath}`);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_source', 'localPath must be a real directory, not a symlink');
    }
    return {
      kind: 'local-git',
      localPath,
      url: pathToFileURL(localPath).href,
      repo: path.basename(localPath),
      ref,
      prefixes,
      index,
    };
  }
  fail('invalid_source', `repository ${index + 1} requires url or localPath`);
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runGit(args, { cwd, maxBuffer = 4 * 1024 * 1024, timeout = 60_000 } = {}) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...args,
  ], {
    cwd,
    env: gitEnvironment(),
    encoding: null,
    maxBuffer,
    timeout,
    windowsHide: true,
  });
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'git_timeout' : 'git_failed';
    fail(code, result.error.message);
  }
  if (result.status !== 0) {
    const message = Buffer.from(result.stderr || '').toString('utf8').trim().slice(0, 1000) || `git exited ${result.status}`;
    fail('git_failed', message);
  }
  return Buffer.from(result.stdout || '');
}

function resolveSnapshot(repository) {
  if (repository.kind === 'local-git') {
    const commit = runGit(['-C', repository.localPath, 'rev-parse', '--verify', `${repository.ref}^{commit}`]).toString('utf8').trim();
    return { gitDir: repository.localPath, commit, cleanup: () => {} };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-source-'));
  try {
    runGit(['init', '--bare', '--quiet', tempDir]);
    runGit(['-C', tempDir, 'fetch', '--quiet', '--depth=1', '--no-tags', repository.fetchUrl, repository.ref], { timeout: 120_000 });
    const commit = runGit(['-C', tempDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']).toString('utf8').trim();
    return { gitDir: tempDir, commit, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function validateTreePath(filePath) {
  if (!filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.includes('\0') || filePath.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('unsafe_tree_path', `repository contains unsafe path: ${filePath}`);
  }
}

function listTree(snapshot, limits) {
  const buffer = runGit(['-C', snapshot.gitDir, 'ls-tree', '-r', '-z', '--full-tree', snapshot.commit], {
    maxBuffer: limits.maxTreeOutputBytes,
  });
  const records = buffer.toString('utf8').split('\0').filter(Boolean);
  if (records.length > limits.maxTreeEntries) fail('tree_limit_exceeded', `repository tree has ${records.length} entries; limit is ${limits.maxTreeEntries}`);
  return records.map(record => {
    const tab = record.indexOf('\t');
    const metadata = record.slice(0, tab).split(' ');
    const filePath = record.slice(tab + 1);
    if (tab < 0 || metadata.length !== 3) fail('invalid_git_tree', 'unexpected git ls-tree output');
    validateTreePath(filePath);
    return { mode: metadata[0], type: metadata[1], object: metadata[2], path: filePath };
  });
}

function matchesPrefix(filePath, prefixes) {
  return prefixes.some(prefix => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`));
}

function objectSize(snapshot, object) {
  const raw = runGit(['-C', snapshot.gitDir, 'cat-file', '-s', object], { maxBuffer: 1024 }).toString('utf8').trim();
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) fail('invalid_git_object', `invalid object size: ${raw}`);
  return size;
}

function readObject(snapshot, entry, maxBytes, label) {
  if (entry.type !== 'blob') fail('invalid_git_object', `${label} is not a blob: ${entry.path}`);
  if (entry.mode === '120000') fail('symbolic_link_rejected', `${label} is a symbolic link: ${entry.path}`);
  const size = objectSize(snapshot, entry.object);
  if (size > maxBytes) fail('file_size_limit_exceeded', `${entry.path} is ${size} bytes; limit is ${maxBytes}`);
  const content = runGit(['-C', snapshot.gitDir, 'cat-file', 'blob', entry.object], { maxBuffer: maxBytes + 1 });
  if (content.includes(0)) fail('binary_file_rejected', `${label} contains NUL bytes: ${entry.path}`);
  return content.toString('utf8');
}

function licensePriority(licensePath, skillPath) {
  const licenseDir = path.posix.dirname(licensePath) === '.' ? '' : path.posix.dirname(licensePath);
  const skillDir = path.posix.dirname(skillPath) === '.' ? '' : path.posix.dirname(skillPath);
  if (licenseDir && !(skillDir === licenseDir || skillDir.startsWith(`${licenseDir}/`))) return -1;
  return licenseDir.split('/').filter(Boolean).length;
}

function findLicenseEntry(entries, skillPath) {
  return entries
    .filter(entry => LICENSE_BASENAME.test(path.posix.basename(entry.path)))
    .map(entry => ({ entry, priority: licensePriority(entry.path, skillPath) }))
    .filter(item => item.priority >= 0)
    .sort((a, b) => b.priority - a.priority || a.entry.path.localeCompare(b.entry.path))[0]?.entry || null;
}

function detectedLicense(snapshot, entries, skillPath, limits, cache) {
  const entry = findLicenseEntry(entries, skillPath);
  if (!entry) return { value: null, sourcePath: null, assessment: classifyLicense(null) };
  if (!cache.has(entry.object)) cache.set(entry.object, readObject(snapshot, entry, limits.maxLicenseBytes, 'license'));
  const raw = cache.get(entry.object);
  const assessment = classifyLicense(raw);
  let value = assessment.spdx;
  if (assessment.status === 'blocked') value = raw.slice(0, 4096);
  return { value, sourcePath: entry.path, assessment };
}

function sourceUrl(repository, commit, skillPath) {
  if (repository.kind !== 'github') return repository.url;
  const encodedPath = skillPath.split('/').map(encodeURIComponent).join('/');
  return `${repository.url}/blob/${commit}/${encodedPath}`;
}

function scanRepository(repository, limits) {
  if (repository.kind === 'local-git') {
    let stat;
    try {
      stat = fs.lstatSync(repository.localPath);
    } catch {
      fail('invalid_source', `local git repository does not exist: ${repository.localPath}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_source', 'localPath must be a real directory, not a symlink');
  }
  const snapshot = resolveSnapshot(repository);
  try {
    const entries = listTree(snapshot, limits);
    const symbolicLink = entries.find(entry => entry.mode === '120000');
    if (symbolicLink) fail('symbolic_link_rejected', `repository contains a symbolic link: ${symbolicLink.path}`);
    const skills = entries.filter(entry => path.posix.basename(entry.path) === 'SKILL.md' && matchesPrefix(entry.path, repository.prefixes));
    if (skills.length === 0) fail('no_skills_found', 'repository snapshot contains no matching SKILL.md');
    if (skills.length > limits.maxSkillFilesPerRepository) {
      fail('skill_file_limit_exceeded', `repository has ${skills.length} matching SKILL.md files; limit is ${limits.maxSkillFilesPerRepository}`);
    }
    const licenseCache = new Map();
    const artifacts = skills.map(entry => {
      const content = readObject(snapshot, entry, limits.maxSkillBytes, 'SKILL.md');
      const license = detectedLicense(snapshot, entries, entry.path, limits, licenseCache);
      return {
        path: entry.path,
        content,
        license,
        security: scanSecurity(content),
      };
    });
    return { commit: snapshot.commit, artifacts };
  } finally {
    snapshot.cleanup();
  }
}

function increment(counter, key) {
  const normalized = key || 'unknown';
  counter[normalized] = (counter[normalized] || 0) + 1;
}

function serializeError(error, repository, index) {
  return {
    repository: repository?.repo || repository?.url || repository?.localPath || `entry:${index + 1}`,
    code: error.code || 'collection_failed',
    message: error.message,
  };
}

export function collectWhitelist({
  whitelist,
  storePath,
  reportPath,
  baseDir = process.cwd(),
  limits: limitOverrides,
  allowLocal = false,
  clock,
} = {}) {
  if (!storePath) fail('invalid_store', 'storePath is required');
  // The JSON envelope is a batch-level contract, while individual source validity is
  // repository-scoped. Keep strict parseWhitelist() for validation callers, but isolate
  // source errors here so one bad entry does not suppress valid repositories.
  const parsed = parseWhitelistStructure(whitelist, { baseDir });
  const limits = limitOverrides ? resolveLimits({ ...parsed.limits, ...limitOverrides }) : parsed.limits;
  const store = new CandidateStore(path.resolve(baseDir, storePath));
  const generatedAt = (clock ? clock() : new Date()).toISOString();
  const report = {
    schemaVersion: 1,
    generatedAt,
    limits,
    stats: {
      repositories: { requested: parsed.repositories.length, succeeded: 0, failed: 0 },
      skills: { discovered: 0, ingested: 0 },
      statuses: {},
      licenses: {},
      security: {},
      duplicates: 0,
    },
    repositories: [],
    errors: [],
  };
  const ingestedIds = [];
  for (const [index, entry] of parsed.repositories.entries()) {
    let repository;
    try {
      repository = normalizeRepository({ entry, index, baseDir: parsed.baseDir, allowLocal }, { checkLocalExists: false });
      const scanned = scanRepository(repository, limits);
      const candidates = [];
      // Ingestion starts only after every artifact in this repository has passed snapshot validation.
      for (const artifact of scanned.artifacts) {
        report.stats.skills.discovered++;
        const candidate = store.ingest({
          source: {
            kind: repository.kind,
            url: sourceUrl(repository, scanned.commit, artifact.path),
            repo: repository.repo,
            path: artifact.path,
            commit: scanned.commit,
            license: artifact.license.value,
          },
          content: artifact.content,
          license: artifact.license.value,
          sms: { status: 'pending' },
        }, { clock });
        ingestedIds.push(candidate.id);
        report.stats.skills.ingested++;
        increment(report.stats.statuses, candidate.status);
        increment(report.stats.licenses, artifact.license.assessment.status);
        increment(report.stats.security, artifact.security.status);
        candidates.push({
          id: candidate.id,
          path: artifact.path,
          status: candidate.status,
          license: artifact.license.assessment,
          licenseSourcePath: artifact.license.sourcePath,
          security: artifact.security,
        });
      }
      report.stats.repositories.succeeded++;
      report.repositories.push({
        source: repository.repo,
        kind: repository.kind,
        url: repository.url,
        ref: repository.ref,
        commit: scanned.commit,
        status: 'collected',
        candidates,
      });
    } catch (error) {
      report.stats.repositories.failed++;
      const serialized = serializeError(error, repository || entry, index);
      report.errors.push(serialized);
      report.repositories.push({
        source: repository?.repo || repository?.url || repository?.localPath || entry?.url || entry?.localPath || `entry:${index + 1}`,
        status: 'failed',
        error: serialized,
      });
    }
  }
  for (const id of new Set(ingestedIds)) {
    const candidate = store.get(id);
    report.stats.duplicates += candidate?.duplicates?.length || 0;
  }
  if (reportPath) {
    const absoluteReportPath = path.resolve(baseDir, reportPath);
    fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
    const tempPath = `${absoluteReportPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, absoluteReportPath);
  }
  return report;
}

export const SOURCE_COLLECTION_DEFAULT_LIMITS = DEFAULT_LIMITS;
export const SOURCE_COLLECTION_HARD_LIMITS = HARD_LIMITS;
