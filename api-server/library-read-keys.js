import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.env.DATA_DIR || 'data', 'library-read-keys.json');
const copyKey = process.env.API_KEY_COPY_SECRET ? Buffer.from(process.env.API_KEY_COPY_SECRET, 'hex') : null;
const hash = raw => createHash('sha256').update(raw).digest('hex');
export const isLibraryReadKey = raw => typeof raw === 'string' && raw.startsWith('xn_ro_');

function load() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function save(records) {
  const temp = file + '.' + randomBytes(8).toString('hex');
  try {
    writeFileSync(temp, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function view(record) {
  const { id, name, prefix, createdAt } = record;
  return { id, name, prefix, createdAt, scope: 'library_read', copyable: Boolean(copyKey && record.encrypted) };
}

export function libraryOwner() {
  return process.env.PERSONAL_RELEASES_OWNER_ID || null;
}

export function ownerForLibraryKey(raw) {
  if (!/^xn_ro_[a-f0-9]{40}$/.test(raw || '')) return null;
  const owner = libraryOwner();
  const digest = hash(raw);
  return load().some(record => record.ownerId === owner && record.hash === digest) ? owner : null;
}

export function listLibraryKeys(ownerId) {
  return load().filter(record => record.ownerId === ownerId).map(view);
}

export function createLibraryKey(ownerId, name) {
  const key = 'xn_ro_' + randomBytes(20).toString('hex');
  const record = {
    id: randomBytes(16).toString('hex'), ownerId, name, prefix: key.slice(0, 13),
    hash: hash(key), createdAt: new Date().toISOString(),
  };
  if (copyKey) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', copyKey, iv);
    cipher.setAAD(Buffer.from(record.ownerId + ':' + record.id));
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    record.encrypted = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  save([...load(), record]);
  return { ...view(record), key };
}

export function copyLibraryKey(ownerId, id) {
  const record = load().find(item => item.ownerId === ownerId && item.id === id);
  if (!record?.encrypted || !copyKey) return null;
  const data = Buffer.from(record.encrypted, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', copyKey, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(record.ownerId + ':' + record.id));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

export function deleteLibraryKey(ownerId, id) {
  const records = load();
  const remaining = records.filter(item => item.ownerId !== ownerId || item.id !== id);
  if (remaining.length === records.length) return false;
  save(remaining);
  return true;
}
