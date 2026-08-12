import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPackageArtifact,
  createPackageManifest,
  normalizePackageManifest,
  normalizePackagePath,
  packageDigest,
  resolvePackageLimits,
} from './package.mjs';

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;
const RECORD_FILE = 'manifest.json';
const PAYLOAD_DIR = 'files';

export class PackageStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackageStoreError(code, message);
}

function digestHex(value) {
  if (typeof value !== 'string') fail('invalid_digest', 'package digest must be a string');
  const match = value.toLowerCase().match(DIGEST_PATTERN);
  if (!match) fail('invalid_digest', 'package digest must be sha256:<64 hexadecimal characters>');
  return match[1];
}

function mediaType(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  const known = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
    '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx',
    '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.css': 'text/css',
    '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
  };
  return known[extension] || 'application/octet-stream';
}

function ensureRealDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    fail('directory_unavailable', `${label} cannot be read: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_directory', `${label} must be a real directory`);
}

function ensureStoreDirectory(directory, label) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureRealDirectory(directory, label);
}

function scanDirectory(root, limits) {
  ensureRealDirectory(root, 'package directory');
  const files = [];
  let totalBytes = 0;
  const walk = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizePackagePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, { limits });
      const before = fs.lstatSync(absolute);
      if (before.isSymbolicLink()) fail('symbolic_link_rejected', `symbolic link rejected: ${relative}`);
      if (before.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!before.isFile()) fail('special_file_rejected', `unsupported file type rejected: ${relative}`);
      if (before.nlink !== 1) fail('hard_link_rejected', `hard-linked file rejected: ${relative}`);
      if (before.size > limits.maxFileBytes) fail('file_size_limit_exceeded', `${relative} exceeds maximum file size ${limits.maxFileBytes}`);
      totalBytes += before.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        fail('total_size_limit_exceeded', `package exceeds maximum total size ${limits.maxTotalBytes}`);
      }
      const content = fs.readFileSync(absolute);
      const after = fs.lstatSync(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
        || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || content.byteLength !== before.size) {
        fail('source_changed_during_import', `${relative} changed while the package was being imported`);
      }
      files.push({
        path: relative,
        content,
        mediaType: mediaType(relative),
        executable: Boolean(before.mode & 0o111),
      });
      if (files.length > limits.maxFiles) fail('file_count_limit_exceeded', `package contains more than ${limits.maxFiles} files`);
    }
  };
  walk(root);
  return files;
}

function recordFromBuilt(built) {
  return {
    schemaVersion: 1,
    packageDigest: built.packageDigest,
    manifest: built.manifest,
    fileCount: built.fileCount,
    totalBytes: built.totalBytes,
  };
}

function normalizeRecord(input, limits) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1) {
    fail('invalid_cas_record', 'unsupported CAS manifest record');
  }
  const manifest = normalizePackageManifest(input.manifest, { limits });
  const digest = packageDigest(manifest, { limits });
  const bytes = manifest.reduce((sum, entry) => sum + entry.size, 0);
  if (input.packageDigest !== digest || input.fileCount !== manifest.length || input.totalBytes !== bytes) {
    fail('invalid_cas_record', 'CAS manifest metadata does not match its canonical manifest');
  }
  return { schemaVersion: 1, packageDigest: digest, manifest, fileCount: manifest.length, totalBytes: bytes };
}

function atomicJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function copyFiles(stage, files) {
  const payload = path.join(stage, PAYLOAD_DIR);
  fs.mkdirSync(payload, { mode: 0o700 });
  for (const file of files) {
    const destination = path.join(payload, ...file.path.split('/'));
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, file.content, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
}

function filesFromCas(record, casDirectory, limits) {
  const payload = path.join(casDirectory, PAYLOAD_DIR);
  ensureRealDirectory(payload, 'CAS payload');
  const scanned = scanDirectory(payload, limits);
  const expectedByPath = new Map(record.manifest.map(entry => [entry.path, entry]));
  const built = createPackageManifest(scanned.map(file => ({
    ...file,
    mediaType: expectedByPath.get(file.path)?.mediaType ?? file.mediaType,
  })), { limits });
  if (built.packageDigest !== record.packageDigest) fail('cas_digest_mismatch', 'CAS payload digest does not match its manifest');
  if (built.manifest.length !== record.manifest.length) fail('cas_file_set_mismatch', 'CAS payload file set does not match its manifest');
  for (let index = 0; index < record.manifest.length; index++) {
    if (JSON.stringify(built.manifest[index]) !== JSON.stringify(record.manifest[index])) {
      fail('cas_file_mismatch', `CAS payload does not match manifest at ${record.manifest[index].path}`);
    }
  }
  return built.files;
}

export class PackageStore {
  constructor(root, { limits } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('package store root is required');
    this.root = path.resolve(root);
    this.limits = resolvePackageLimits(limits);
  }

  pathForDigest(digest) {
    return path.join(this.root, 'sha256', digestHex(digest));
  }

  has(digest) {
    return fs.existsSync(this.pathForDigest(digest));
  }

  get(digest) {
    const directory = this.pathForDigest(digest);
    ensureRealDirectory(directory, 'CAS package');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(directory, RECORD_FILE), 'utf8'));
    } catch (error) {
      fail('invalid_cas_record', `CAS manifest cannot be read: ${error.message}`);
    }
    const record = normalizeRecord(parsed, this.limits);
    if (record.packageDigest !== `sha256:${digestHex(digest)}`) fail('cas_path_mismatch', 'CAS directory does not match package digest');
    return record;
  }

  verify(digest) {
    const record = this.get(digest);
    filesFromCas(record, this.pathForDigest(digest), this.limits);
    return record;
  }

  readFiles(digest) {
    const record = this.verify(digest);
    return filesFromCas(record, this.pathForDigest(digest), this.limits).map(file => ({
      ...file,
      content: Buffer.from(file.content),
    }));
  }

  putFiles(files, { sourceVersion, basedOnSourceVersion, collectedAt } = {}) {
    const built = createPackageManifest(files, { limits: this.limits });
    const artifact = createPackageArtifact({
      files: built.files,
      sourceVersion: basedOnSourceVersion ?? sourceVersion,
      collectedAt,
    }, { limits: this.limits });
    const destination = this.pathForDigest(built.packageDigest);
    ensureStoreDirectory(this.root, 'package store root');
    ensureStoreDirectory(path.join(this.root, 'sha256'), 'CAS digest directory');
    ensureStoreDirectory(path.join(this.root, '.staging'), 'CAS staging directory');
    if (fs.existsSync(destination)) {
      this.verify(built.packageDigest);
      return { action: 'unchanged', artifact, record: this.get(built.packageDigest), path: destination };
    }
    const stage = fs.mkdtempSync(path.join(this.root, '.staging', `package-${process.pid}-`));
    try {
      copyFiles(stage, built.files);
      atomicJson(path.join(stage, RECORD_FILE), recordFromBuilt(built));
      const stagedRecord = normalizeRecord(JSON.parse(fs.readFileSync(path.join(stage, RECORD_FILE), 'utf8')), this.limits);
      filesFromCas(stagedRecord, stage, this.limits);
      try {
        fs.renameSync(stage, destination);
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
        this.verify(built.packageDigest);
        return { action: 'unchanged', artifact, record: this.get(built.packageDigest), path: destination };
      }
      const record = this.verify(built.packageDigest);
      return { action: 'stored', artifact, record, path: destination };
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort staging cleanup */ }
    }
  }

  importDirectory(directory, metadata = {}) {
    const absolute = path.resolve(directory);
    const files = scanDirectory(absolute, this.limits);
    return this.putFiles(files, metadata);
  }
}

export function createTemporaryPackageStore({ limits } = {}) {
  return new PackageStore(fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-package-cas-')), { limits });
}
