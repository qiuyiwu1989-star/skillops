import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSkillArchive, SkillArchiveError } from '../lib/skill-archive.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const body = Buffer.from(value);
    const crc = crc32(body);
    const local = Buffer.alloc(30 + filename.length + body.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    filename.copy(local, 30); body.copy(local, 30 + filename.length); locals.push(local);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46); centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function fixture(t, entries) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'fixture.skill');
  fs.writeFileSync(target, storedZip(entries));
  return target;
}

const skill = '---\nname: safe-skill\ndescription: Safe skill archive.\n---\n\n# Safe\n';

test('reads a bounded root skill document without extracting files', t => {
  const target = fixture(t, [['safe-skill/SKILL.md', skill], ['safe-skill/references/guide.md', '# Guide']]);
  const result = readSkillArchive(target);
  assert.equal(result.rootName, 'safe-skill');
  assert.equal(result.skillDocument, skill);
  assert.equal(result.fileCount, 2);
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'safe-skill')), false);
});

test('rejects traversal, multiple roots, duplicate paths and symlink archive files', t => {
  assert.throws(() => readSkillArchive(fixture(t, [['safe-skill/SKILL.md', skill], ['../secret', 'x']])), error => error instanceof SkillArchiveError && error.code === 'UNSAFE_PATH');
  assert.throws(() => readSkillArchive(fixture(t, [['safe-skill/SKILL.md', skill], ['other/file.md', 'x']])), error => error.code === 'UNSAFE_ARCHIVE');
  assert.throws(() => readSkillArchive(fixture(t, [['safe-skill/SKILL.md', skill], ['SAFE-SKILL/skill.md', skill]])), error => error.code === 'DUPLICATE_PATH');
  const real = fixture(t, [['safe-skill/SKILL.md', skill]]);
  const linked = path.join(path.dirname(real), 'linked.skill');
  fs.symlinkSync(real, linked);
  assert.throws(() => readSkillArchive(linked), error => error.code === 'UNSAFE_ARCHIVE');
});

test('rejects oversized files before publishing content', t => {
  const target = fixture(t, [['safe-skill/SKILL.md', `${skill}${'x'.repeat(512)}`]]);
  assert.throws(() => readSkillArchive(target, { limits: { maxFileBytes: 128 } }), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
});
