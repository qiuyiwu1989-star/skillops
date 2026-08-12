import crypto from 'node:crypto';
import path from 'node:path';

export const PACKAGE_SCHEMA_VERSION = 1;

export const DEFAULT_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDepth: 16,
  maxPathBytes: 1_024,
  maxManifestBytes: 2 * 1024 * 1024,
});

const HARD_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 4_096,
  maxManifestBytes: 16 * 1024 * 1024,
});

const SHA256_HEX = /^[a-f0-9]{64}$/;
const PACKAGE_DIGEST = /^sha256:([a-f0-9]{64})$/;

export class PackageValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackageValidationError(code, message);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_limit', `${name} must be a positive integer`);
  if (value > maximum) fail('limit_exceeds_hard_cap', `${name} exceeds hard cap ${maximum}`);
  return value;
}

export function resolvePackageLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_limits', 'limits must be an object');
  return Object.fromEntries(Object.entries(DEFAULT_PACKAGE_LIMITS).map(([name, fallback]) => [
    name,
    positiveInteger(input[name] ?? fallback, name, HARD_PACKAGE_LIMITS[name]),
  ]));
}

export function normalizePackagePath(value, { limits } = {}) {
  const resolved = resolvePackageLimits(limits);
  if (typeof value !== 'string') fail('unsafe_path', 'package path must be a string');
  const normalized = value.normalize('NFC');
  if (!normalized || normalized.includes('\0') || normalized.includes('\\')) {
    fail('unsafe_path', `unsafe package path: ${JSON.stringify(value)}`);
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    fail('unsafe_path', `package path must be relative: ${JSON.stringify(value)}`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail('unsafe_path', `package path contains an unsafe segment: ${JSON.stringify(value)}`);
  }
  if (parts.length > resolved.maxDepth) fail('path_depth_limit_exceeded', `${normalized} exceeds maximum depth ${resolved.maxDepth}`);
  if (Buffer.byteLength(normalized, 'utf8') > resolved.maxPathBytes) {
    fail('path_length_limit_exceeded', `${normalized} exceeds maximum path length ${resolved.maxPathBytes}`);
  }
  return normalized;
}

function normalizeSha256(value, label = 'sha256') {
  if (typeof value !== 'string' || !SHA256_HEX.test(value.toLowerCase())) fail('invalid_hash', `${label} must be 64 hexadecimal characters`);
  return value.toLowerCase();
}

function normalizeMediaType(value) {
  if (value === undefined || value === null || value === '') return 'application/octet-stream';
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) fail('invalid_media_type', 'mediaType must be a non-empty single-line string');
  return value.trim().toLowerCase();
}

function normalizeExecutable(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('invalid_executable', 'executable must be a boolean');
  return value;
}

function collisionKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function assertManifestCollection(entries, limits) {
  if (!Array.isArray(entries)) fail('invalid_manifest', 'manifest must be an array');
  if (entries.length < 1) fail('missing_skill_file', 'package must contain root SKILL.md');
  if (entries.length > limits.maxFiles) fail('file_count_limit_exceeded', `package contains more than ${limits.maxFiles} files`);
}

function normalizeManifestEntry(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_manifest_entry', 'manifest entry must be an object');
  const packagePath = normalizePackagePath(value.path, { limits });
  if (!Number.isSafeInteger(value.size) || value.size < 0) fail('invalid_file_size', `${packagePath} size must be a non-negative safe integer`);
  if (value.size > limits.maxFileBytes) fail('file_size_limit_exceeded', `${packagePath} exceeds maximum file size ${limits.maxFileBytes}`);
  return {
    path: packagePath,
    size: value.size,
    sha256: normalizeSha256(value.sha256, `${packagePath} sha256`),
    mediaType: normalizeMediaType(value.mediaType),
    executable: normalizeExecutable(value.executable),
  };
}

export function normalizePackageManifest(input, { limits: limitInput } = {}) {
  const limits = resolvePackageLimits(limitInput);
  assertManifestCollection(input, limits);
  const seen = new Set();
  const folded = new Map();
  let totalBytes = 0;
  const manifest = input.map(value => {
    const entry = normalizeManifestEntry(value, limits);
    if (seen.has(entry.path)) fail('duplicate_path', `duplicate package path: ${entry.path}`);
    seen.add(entry.path);
    const fold = collisionKey(entry.path);
    const previous = folded.get(fold);
    if (previous && previous !== entry.path) fail('case_path_conflict', `case-insensitive path conflict: ${previous} and ${entry.path}`);
    folded.set(fold, entry.path);
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      fail('total_size_limit_exceeded', `package exceeds maximum total size ${limits.maxTotalBytes}`);
    }
    return entry;
  }).sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
  if (!seen.has('SKILL.md')) fail('missing_skill_file', 'package must contain root SKILL.md');
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > limits.maxManifestBytes) {
    fail('manifest_size_limit_exceeded', `manifest exceeds maximum size ${limits.maxManifestBytes}`);
  }
  return manifest;
}

export function packageDigest(manifest, options = {}) {
  const normalized = normalizePackageManifest(manifest, options);
  const hash = crypto.createHash('sha256');
  for (const entry of normalized) {
    hash.update(JSON.stringify([entry.path, entry.size, entry.sha256, entry.executable]));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function contentBuffer(content, label) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (Buffer.isBuffer(content)) return Buffer.from(content);
  if (content instanceof Uint8Array) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  fail('missing_file_content', `${label} content must be a string, Buffer, or Uint8Array`);
}

export function createPackageManifest(files, { limits: limitInput } = {}) {
  const limits = resolvePackageLimits(limitInput);
  if (!Array.isArray(files)) fail('invalid_files', 'files must be an array');
  if (files.length > limits.maxFiles) fail('file_count_limit_exceeded', `package contains more than ${limits.maxFiles} files`);
  let runningTotal = 0;
  const materialized = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail('invalid_file', 'file must be an object');
    const packagePath = normalizePackagePath(file.path, { limits });
    const content = contentBuffer(file.content, packagePath);
    if (content.byteLength > limits.maxFileBytes) fail('file_size_limit_exceeded', `${packagePath} exceeds maximum file size ${limits.maxFileBytes}`);
    runningTotal += content.byteLength;
    if (!Number.isSafeInteger(runningTotal) || runningTotal > limits.maxTotalBytes) {
      fail('total_size_limit_exceeded', `package exceeds maximum total size ${limits.maxTotalBytes}`);
    }
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    if (file.size !== undefined && file.size !== content.byteLength) fail('file_size_mismatch', `${packagePath} size does not match content`);
    if (file.sha256 !== undefined && normalizeSha256(file.sha256, `${packagePath} sha256`) !== digest) {
      fail('file_hash_mismatch', `${packagePath} sha256 does not match content`);
    }
    return {
      path: packagePath,
      size: content.byteLength,
      sha256: digest,
      mediaType: normalizeMediaType(file.mediaType),
      executable: normalizeExecutable(file.executable),
      content,
    };
  });
  const manifest = normalizePackageManifest(materialized, { limits });
  const byPath = new Map(materialized.map(file => [file.path, file]));
  const normalizedFiles = manifest.map(entry => ({ ...entry, content: byPath.get(entry.path).content }));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.size, 0);
  return { manifest, files: normalizedFiles, fileCount: manifest.length, totalBytes, packageDigest: packageDigest(manifest, { limits }) };
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_package_metadata', `${label} must be a non-empty string`);
  return value.trim();
}

function timestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('invalid_package_metadata', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

export function createPackageArtifact({ files, sourceVersion, basedOnSourceVersion, collectedAt, storageRef } = {}, options = {}) {
  const built = createPackageManifest(files, options);
  const version = requiredText(basedOnSourceVersion ?? sourceVersion, 'basedOnSourceVersion');
  const at = collectedAt === undefined ? new Date().toISOString() : timestamp(collectedAt, 'collectedAt');
  const expectedStorageRef = `cas:${built.packageDigest}`;
  if (storageRef !== undefined && storageRef !== expectedStorageRef) fail('invalid_storage_ref', `storageRef must be ${expectedStorageRef}`);
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    packageDigest: built.packageDigest,
    manifest: built.manifest,
    fileCount: built.fileCount,
    totalBytes: built.totalBytes,
    storageRef: expectedStorageRef,
    collectedAt: at,
    basedOnSourceVersion: version,
  };
}

export function validatePackageArtifact(input, { limits: limitInput } = {}) {
  const limits = resolvePackageLimits(limitInput);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_package', 'package artifact must be an object');
  if (input.schemaVersion !== PACKAGE_SCHEMA_VERSION) fail('unsupported_package_schema', `package schemaVersion must be ${PACKAGE_SCHEMA_VERSION}`);
  const manifest = normalizePackageManifest(input.manifest, { limits });
  const calculatedDigest = packageDigest(manifest, { limits });
  const digestMatch = typeof input.packageDigest === 'string' ? input.packageDigest.toLowerCase().match(PACKAGE_DIGEST) : null;
  if (!digestMatch) fail('invalid_package_digest', 'packageDigest must be sha256:<64 hexadecimal characters>');
  if (input.packageDigest.toLowerCase() !== calculatedDigest) fail('package_digest_mismatch', 'packageDigest does not match canonical manifest');
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.size, 0);
  if (input.fileCount !== manifest.length) fail('file_count_mismatch', 'fileCount does not match manifest');
  if (input.totalBytes !== totalBytes) fail('total_bytes_mismatch', 'totalBytes does not match manifest');
  const storageRef = `cas:${calculatedDigest}`;
  if (input.storageRef !== storageRef) fail('invalid_storage_ref', `storageRef must be ${storageRef}`);
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    packageDigest: calculatedDigest,
    manifest,
    fileCount: manifest.length,
    totalBytes,
    storageRef,
    collectedAt: timestamp(input.collectedAt, 'collectedAt'),
    basedOnSourceVersion: requiredText(input.basedOnSourceVersion, 'basedOnSourceVersion'),
  };
}

export function isPackageArtifact(value) {
  try {
    validatePackageArtifact(value);
    return true;
  } catch {
    return false;
  }
}
