#!/usr/bin/env node
/* migrate-scores-100.mjs — one-off: scale stored skill scores from /50 to /100 (×2).
 *
 * Run with skill-api STOPPED (store.js / db.js cache in memory), AFTER reseed-hub
 * (so hub rows are already /100 and get skipped here; only github + user rows remain).
 *
 * Covers:
 *   1. platform.json   — every account skill version's sms block
 *   2. evaluations.jsonl — every public/github/user row (hub rows already /100)
 *
 * Idempotent: only scales records whose max === 50 (or missing). Safe to re-run.
 *
 * Env: DATA_DIR (default /var/lib/skill-api)
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/var/lib/skill-api';
const PLATFORM = path.join(DATA_DIR, 'platform.json');
const JSONL = path.join(DATA_DIR, 'evaluations.jsonl');

function scaleSms(s) {
  // returns true if it scaled
  if (!s || typeof s.total !== 'number') return false;
  if (s.max != null && s.max !== 50) return false;   // already /100 or odd scale → skip
  s.total = Math.round(s.total * 2);
  s.max = 100;
  if (Array.isArray(s.dimensions)) s.dimensions.forEach(d => { if (typeof d.score === 'number') d.score = Math.round(d.score * 2); });
  return true;
}

// ── 1. platform.json (account skill versions) ──
let pv = 0;
if (fs.existsSync(PLATFORM)) {
  const db = JSON.parse(fs.readFileSync(PLATFORM, 'utf8'));
  for (const v of Object.values(db.versions || {})) {
    if (scaleSms(v.sms)) pv++;
  }
  const tmp = PLATFORM + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, PLATFORM);
}

// ── 2. evaluations.jsonl (hub already reseeded to /100; scale the rest) ──
let ev = 0, kept = 0;
if (fs.existsSync(JSONL)) {
  const out = [];
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { out.push(t); kept++; continue; }
    // row itself carries total/max/dimensions (it's the sms result shape)
    if (scaleSms(r)) ev++;
    out.push(JSON.stringify(r));
  }
  const tmp = JSONL + '.tmp';
  fs.writeFileSync(tmp, out.join('\n') + '\n');
  fs.renameSync(tmp, JSONL);
}

console.log(`✓ migrate-scores-100: platform versions ×2 = ${pv} · evaluations rows ×2 = ${ev} (unparsed kept: ${kept})`);
