import path from 'node:path';

import { scanSecurity } from './audit.mjs';
import { createPackageManifest, validatePackageArtifact } from './package.mjs';

const TEXT_MEDIA_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
  'image/svg+xml',
]);

const TEXT_EXTENSIONS = new Set([
  '.bash', '.c', '.cc', '.cfg', '.conf', '.cpp', '.css', '.csv', '.go',
  '.h', '.hpp', '.htm', '.html', '.ini', '.java', '.js', '.json', '.jsx',
  '.md', '.markdown', '.mjs', '.cjs', '.php', '.pl', '.py', '.rb', '.rs',
  '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

export class PackageAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageAuditError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackageAuditError(code, message);
}

function timestamp(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_clock', 'clock must produce a valid timestamp');
  return date.toISOString();
}

function bytes(value, filePath) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail('missing_file_content', `${filePath} content must be a string, Buffer, or Uint8Array`);
}

function declaredText(file) {
  const mediaType = String(file.mediaType || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)) return true;
  return file.executable === true || TEXT_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase());
}

function readableText(file) {
  if (!declaredText(file)) return null;
  const content = bytes(file.content, file.path);
  if (content.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function sameManifest(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
    && entry.size === right[index].size
    && entry.sha256 === right[index].sha256
    && entry.mediaType === right[index].mediaType
    && entry.executable === right[index].executable
  ));
}

export function auditPackageFiles(files, packageArtifact, { clock } = {}) {
  const artifact = validatePackageArtifact(packageArtifact);
  const built = createPackageManifest(files);
  if (built.packageDigest !== artifact.packageDigest) {
    fail('package_digest_mismatch', 'package files do not match the declared package digest');
  }
  if (!sameManifest(built.manifest, artifact.manifest)) {
    fail('package_manifest_mismatch', 'package files do not match the declared canonical manifest');
  }

  const findings = [];
  let filesScanned = 0;
  const skippedBinary = [];
  for (const file of built.files) {
    const text = readableText(file);
    if (text === null) {
      skippedBinary.push(file.path);
      continue;
    }
    filesScanned++;
    const result = scanSecurity(text);
    for (const finding of result.findings) findings.push({ path: file.path, ...finding });
  }
  const status = findings.some(finding => finding.severity === 'block')
    ? 'block'
    : findings.some(finding => finding.severity === 'review') ? 'review' : 'pass';
  return {
    schemaVersion: 1,
    status,
    basedOnPackageDigest: artifact.packageDigest,
    checkedAt: timestamp(clock),
    filesScanned,
    filesExamined: built.fileCount,
    skippedBinary,
    findings,
  };
}

export function isPackageAuditCurrent(packageArtifact, packageAudit) {
  if (!packageArtifact || !packageAudit) return false;
  try {
    const artifact = validatePackageArtifact(packageArtifact);
    return ['pass', 'review', 'block'].includes(packageAudit.status)
      && packageAudit.basedOnPackageDigest === artifact.packageDigest;
  } catch {
    return false;
  }
}
