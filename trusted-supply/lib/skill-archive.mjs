import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const DEFAULT_SKILL_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 8 * 1024 * 1024,
  maxEntries: 512,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxDepth: 12,
  maxCompressionRatio: 200,
});

export class SkillArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillArchiveError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillArchiveError(code, message);
}

function limits(input = {}) {
  const resolved = { ...DEFAULT_SKILL_ARCHIVE_LIMITS, ...input };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_LIMITS', `${key} must be a positive integer`);
  }
  return resolved;
}

function safeName(value, maximumDepth) {
  if (!Buffer.from(value, 'utf8').equals(Buffer.from(value.normalize('NFC'), 'utf8'))) fail('UNSAFE_PATH', 'archive path must use NFC');
  const name = value.normalize('NFC');
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail('UNSAFE_PATH', 'archive path is unsafe');
  const directory = name.endsWith('/');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || parts.length > maximumDepth) fail('UNSAFE_PATH', 'archive path is unsafe');
  return { name: parts.join('/') + (directory ? '/' : ''), directory };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  fail('INVALID_ARCHIVE', 'ZIP end record is missing');
}

function extractEntry(buffer, entry, archiveLimits) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL) fail('INVALID_ARCHIVE', 'local file header is invalid');
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < 0 || end > buffer.length) fail('INVALID_ARCHIVE', 'compressed data is out of bounds');
  const compressed = buffer.subarray(start, end);
  let content;
  if (entry.method === 0) content = Buffer.from(compressed);
  else if (entry.method === 8) {
    try { content = zlib.inflateRawSync(compressed, { maxOutputLength: archiveLimits.maxFileBytes }); }
    catch { fail('INVALID_ARCHIVE', 'deflated entry is invalid or exceeds limits'); }
  } else fail('UNSUPPORTED_COMPRESSION', `ZIP method ${entry.method} is not supported`);
  if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) fail('INTEGRITY_MISMATCH', 'archive entry integrity mismatch');
  return content;
}

export function readSkillArchive(filePath, options = {}) {
  const archiveLimits = limits(options.limits);
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > archiveLimits.maxArchiveBytes) fail('UNSAFE_ARCHIVE', 'skill archive must be a bounded regular file');
  const buffer = fs.readFileSync(absolute);
  const eocd = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount < 1 || entryCount > archiveLimits.maxEntries) fail('INVALID_ARCHIVE', 'multi-disk or oversized ZIP is not supported');
  if (centralOffset + centralSize > eocd || centralOffset < 0) fail('INVALID_ARCHIVE', 'central directory is out of bounds');

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL) fail('INVALID_ARCHIVE', 'central directory entry is invalid');
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || flags & 1) fail('INVALID_ARCHIVE', 'encrypted or truncated ZIP entry is not supported');
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const normalized = safeName(rawName, archiveLimits.maxDepth);
    const identity = normalized.name.toLocaleLowerCase('en-US');
    if (names.has(identity)) fail('DUPLICATE_PATH', 'archive contains duplicate or case-colliding paths');
    names.add(identity);
    const host = versionMadeBy >>> 8;
    const mode = externalAttributes >>> 16;
    const fileType = mode & 0o170000;
    if (host === 3 && fileType && fileType !== 0o100000 && fileType !== 0o040000) fail('UNSAFE_FILE_TYPE', 'archive contains a symlink or special file');
    if (!normalized.directory) {
      if (uncompressedSize > archiveLimits.maxFileBytes) fail('ARCHIVE_LIMIT_EXCEEDED', 'archive file exceeds size limit');
      if (uncompressedSize > 0 && compressedSize === 0) fail('INVALID_ARCHIVE', 'archive compression metadata is invalid');
      if (compressedSize > 0 && uncompressedSize / compressedSize > archiveLimits.maxCompressionRatio) fail('ARCHIVE_LIMIT_EXCEEDED', 'archive compression ratio exceeds limit');
      totalBytes += uncompressedSize;
      if (totalBytes > archiveLimits.maxTotalBytes) fail('ARCHIVE_LIMIT_EXCEEDED', 'archive total size exceeds limit');
      entries.push({ name: normalized.name, method, crc, compressedSize, uncompressedSize, localOffset });
    }
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) fail('INVALID_ARCHIVE', 'central directory size mismatch');
  const skillEntries = entries.filter(entry => entry.name.split('/').length === 2 && entry.name.endsWith('/SKILL.md'));
  if (skillEntries.length !== 1) fail('SKILL_DOCUMENT_MISSING', 'archive must contain exactly one root SKILL.md');
  const skillEntry = skillEntries[0];
  const rootName = skillEntry.name.split('/')[0];
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(rootName)) fail('INVALID_SKILL_ROOT', 'skill root directory is invalid');
  if (entries.some(entry => !entry.name.startsWith(`${rootName}/`))) fail('UNSAFE_ARCHIVE', 'all files must belong to the skill root directory');
  const content = extractEntry(buffer, skillEntry, archiveLimits);
  if (content.includes(0) || !Buffer.from(content.toString('utf8'), 'utf8').equals(content)) fail('INVALID_SKILL_DOCUMENT', 'SKILL.md must be valid UTF-8 text');
  return Object.freeze({
    rootName,
    skillDocument: content.toString('utf8'),
    fileCount: entries.length,
    totalBytes,
    archiveBytes: buffer.length,
  });
}
