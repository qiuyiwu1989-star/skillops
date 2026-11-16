import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.env.DATA_DIR || 'data', 'library-classification.json');

export function readClassification() {
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  return { ...data, reviewed: data.reviewed || {} };
}

export function updateClassification(key, category, expected) {
  // Re-read after any upstream existence check to serialize updates to the same entry.
  const data = readClassification();
  if (!data.categories.some(item => item.id === category)) return { status: 400 };
  const current = Object.hasOwn(data.assignments, key) ? data.assignments[key] : null;
  if (expected !== current && current !== category) return { status: 409, current };
  data.assignments[key] = category;
  data.reviewed[key] = new Date().toISOString();
  const temp = FILE + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temp, FILE);
  } finally {
    rmSync(temp, { force: true });
  }
  return { status: 200, category, reviewedAt: data.reviewed[key] };
}
