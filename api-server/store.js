/**
 * Skill Hub · evaluation store
 *
 * Dependency-free JSONL append store (Node 18 compatible — no native sqlite).
 * One JSON object per line in <DATA_DIR>/evaluations.jsonl.
 *
 * Privacy:
 *   - Full skill content is NEVER persisted (only a sha256 hash, for dedup).
 *   - Client IP is stored only as a salted hash.
 *   - Public feed / leaderboard expose only entries flagged { public: true }.
 *   - "hub" canonical entries (Qiu's own skills) are always public.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { supabaseConfigured, sbSelectAll, sbUpsert } from './supabase-rest.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'evaluations.jsonl');
const SALT = process.env.HASH_SALT || 'skill-hub-default-salt';

// backend: file (默认) | supabase（内存缓存 + 写穿透）。evaluations 表：少量索引列 + data jsonb 兜底。
const BACKEND = (process.env.STORE_BACKEND === 'supabase' && supabaseConfigured) ? 'supabase' : 'file';
let _evals = null, _evalDegraded = false;   // supabase 模式的内存缓存
const coerceTs = v => { if (v == null || v === '') return null; if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString(); if (/^\d+$/.test(String(v))) { const n = Number(v); return new Date(n > 1e12 ? n : n * 1000).toISOString(); } return v; };
const evalToRow = r => ({ id: r.id, source: r.source || null, slug: r.slug || r.slugPath || r.path || null, name: r.name || null, repo: r.repo || null, total: r.total ?? null, max: r.max || 100, tier: r.tier || null, public: !!(r.public || r.source === 'hub'), ts: coerceTs(r.ts), data: r });

// 启动一次：supabase 模式批量拉 evaluations 进内存缓存。在 server 监听前 await。
export async function initEvalStore() {
  if (BACKEND !== 'supabase') return;
  try { _evals = (await sbSelectAll('evaluations')).map(row => row.data).filter(Boolean).sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))); console.log('[store] evaluations(supabase) loaded ' + _evals.length); }
  catch (e) { _evalDegraded = true; _evals = null; console.warn('[store] evaluations 启动加载失败，降级本地文件：' + e.message); }
}

let ready = false;
async function ensure() {
  if (ready) return;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(FILE); } catch { await fsp.writeFile(FILE, ''); }
  ready = true;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
export function hashIp(ip) {
  return crypto.createHash('sha256').update(SALT + '|' + String(ip)).digest('hex').slice(0, 16);
}

// Append one evaluation record. Returns the stored record (with id).
export async function appendEvaluation(rec) {
  await ensure();
  const id = crypto.randomBytes(8).toString('hex');
  const row = { id, ...rec };
  await fsp.appendFile(FILE, JSON.stringify(row) + '\n', 'utf8');   // 本地镜像：永远写
  if (BACKEND === 'supabase' && !_evalDegraded) {
    if (_evals) _evals.push(row);   // 内存缓存（newest last）
    sbUpsert('evaluations', [evalToRow(row)]).catch(e => console.warn('[store] eval 写穿透失败：' + e.message));
  }
  return row;
}

// Read all records (small scale — a few thousand lines max). Newest last.
export async function readAll() {
  if (BACKEND === 'supabase' && !_evalDegraded && _evals) return _evals.slice();   // 内存缓存，零跨境
  await ensure();
  let raw = '';
  try { raw = await fsp.readFile(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Public feed — newest public (or hub) entries, trimmed to safe fields.
export async function recentPublic(limit = 20) {
  const all = await readAll();
  return all
    .filter(r => r.public || r.source === 'hub')
    .slice(-limit)
    .reverse()
    .map(publicView);
}

// Leaderboard — highest-scoring public (or hub) entries, deduped by name.
export async function leaderboard(limit = 20) {
  const all = await readAll().then(rows => rows.filter(r => r.public || r.source === 'hub'));
  const best = new Map(); // name → record
  for (const r of all) {
    const key = (r.name || '').toLowerCase().trim() + '|' + (r.source || 'user');
    const prev = best.get(key);
    if (!prev || r.total > prev.total) best.set(key, r);
  }
  return [...best.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(publicView);
}

// Hub canonical dataset — the Skill Hub's own skills (source==='hub'), latest per slug.
export async function hubDataset() {
  const all = await readAll();
  const byslug = new Map();
  for (const r of all) {
    if (r.source !== 'hub') continue;
    byslug.set(r.slug || r.name, r); // later overwrites earlier → latest wins
  }
  return [...byslug.values()].sort((a, b) => b.total - a.total).map(hubView);
}

// Discovered dataset — open-source skills crawled from GitHub (source==='github'), latest per slug.
export async function discoveredDataset(limit = 60) {
  const all = await readAll();
  const byslug = new Map();
  for (const r of all) {
    if (r.source !== 'github') continue;
    byslug.set(r.slug || r.repo, r);
  }
  return [...byslug.values()].sort((a, b) => b.total - a.total).slice(0, limit).map(githubView);
}
function githubView(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, repo: r.repo, url: r.url, stars: r.stars || 0,
    license: r.license || '', path: r.path || '', smsVersion: r.smsVersion || '',
    total: r.total, max: r.max || 100, tier: r.tier, ts: r.ts, summary: r.summary || '',
    dimensions: (r.dimensions || []).map(d => ({ key: d.key, zh: d.zh, score: d.score, pillar: d.pillar, reason: d.reason })),
  };
}

// Per-IP history (the submitter's own recent evaluations).
export async function historyForIp(ipHash, limit = 20) {
  const all = await readAll();
  return all
    .filter(r => r.ipHash === ipHash)
    .slice(-limit)
    .reverse()
    .map(r => ({ ...publicView(r), suggestions: r.suggestions || [] }));
}

export async function stats() {
  const all = await readAll();
  const pub = all.filter(r => r.public || r.source === 'hub');
  const total = all.length;
  const avg = pub.length ? Math.round(pub.reduce((s, r) => s + r.total, 0) / pub.length * 10) / 10 : 0;
  const tiers = {};
  for (const r of pub) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
  return { totalEvaluations: total, publicCount: pub.length, avgScore: avg, tierDist: tiers };
}

// ── views (whitelist fields exposed to clients) ──
function publicView(r) {
  return {
    id: r.id, name: r.name, total: r.total, max: r.max || 50, tier: r.tier,
    source: r.source || 'user', ts: r.ts,
    dimensions: (r.dimensions || []).map(d => ({ key: d.key, zh: d.zh, en: d.en, score: d.score })),
  };
}
function hubView(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, total: r.total, max: r.max || 50, tier: r.tier,
    category: r.category || '', ts: r.ts,
    dimensions: (r.dimensions || []).map(d => ({ key: d.key, zh: d.zh, en: d.en, score: d.score, reason: d.reason })),
    summary: r.summary || '',
  };
}
