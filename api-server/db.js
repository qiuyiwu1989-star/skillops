/**
 * 小能 platform DB — dependency-free structured store.
 *
 * Single JSON document persisted atomically (temp + rename) on every mutation.
 * In-memory collections + indexes; rebuilt on load. Adequate for MVP scale
 * (tens of thousands of rows). Migrate to Postgres when scale demands.
 *
 * Collections: users, sessions, skills, versions, apiKeys
 *
 * Privacy/security:
 *   - API keys stored only as sha256 hash (+ short display prefix).
 *   - Sessions are opaque random tokens.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { supabaseConfigured, loadCollection, syncCollection, snapshotOf, COLLECTIONS } from './supabase-rest.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'platform.json');
const TMP = FILE + '.tmp';

// backend: file (默认) | supabase（跨境内存权威 + 写穿透，见 supabase-rest.js）
const BACKEND = (process.env.STORE_BACKEND === 'supabase' && supabaseConfigured) ? 'supabase' : 'file';

const EMPTY = { users: {}, sessions: {}, skills: {}, versions: {}, apiKeys: {}, chains: {} };
let db = null;

// ── write-through 同步状态（仅 supabase 模式）──
let _snap = null, _syncTimer = null, _syncing = false, _dirty = false, _fail = 0, _degraded = false;

function load() {
  if (db) return db;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(EMPTY)) if (!db[k]) db[k] = {};
  } catch { db = JSON.parse(JSON.stringify(EMPTY)); }
  return db;
}

// 启动一次：supabase 模式批量拉全部表进内存 + 建快照 + 写本地镜像；file 模式即原 load()。
// 在 server 监听前 await 调用。
export async function initStore() {
  if (BACKEND !== 'supabase') { load(); console.log('[store] backend=file'); return db; }
  try {
    const next = {};
    for (const name of Object.keys(COLLECTIONS)) next[name] = await loadCollection(name);
    for (const k of Object.keys(EMPTY)) if (!next[k]) next[k] = {};
    db = next;
    _snap = {}; for (const name of Object.keys(COLLECTIONS)) _snap[name] = snapshotOf(db[name]);
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch {}
    console.log('[store] backend=supabase · loaded ' + Object.entries(db).map(([k, v]) => k + '=' + Object.keys(v).length).join(' '));
  } catch (e) {
    _degraded = true; load();  // 跨境抖/未就绪 → 回落本地镜像，关写穿透，不宕；重启恢复
    console.warn('[store] supabase 启动加载失败，降级为本地镜像（写穿透已关，修复后重启）：' + e.message);
  }
  return db;
}

function persist() {
  fs.writeFileSync(TMP, JSON.stringify(db));   // 本地镜像 / 冷备：永远写
  fs.renameSync(TMP, FILE);
  if (BACKEND === 'supabase' && !_degraded) scheduleSync(400);
}
function scheduleSync(delay) {
  _dirty = true;
  if (_syncTimer) return;
  _syncTimer = setTimeout(runSync, delay || 400);
}
async function runSync() {
  _syncTimer = null;
  if (_syncing) { scheduleSync(400); return; }
  _syncing = true; _dirty = false;
  try {
    for (const name of Object.keys(COLLECTIONS)) _snap[name] = await syncCollection(name, db[name], _snap[name]);
    _fail = 0;
  } catch (e) {
    _dirty = true; _fail++;
    console.warn(`[store] 写穿透失败(第${_fail}次)，将重试：${e.message}`);
  } finally {
    _syncing = false;
    if (_dirty) scheduleSync(Math.min(400 * 2 ** _fail, 30000));  // 失败退避，最长 30s
  }
}
function id(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function now() { return new Date().toISOString(); }
export function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

// ── users ──
export function upsertGithubUser({ githubId, login, name, avatar, email }) {
  load();
  let u = Object.values(db.users).find(x => x.githubId === String(githubId));
  if (u) {
    u.login = login; u.name = name || u.name; u.avatar = avatar || u.avatar; u.email = email || u.email;
  } else {
    u = { id: id(), githubId: String(githubId), login, name: name || login, avatar: avatar || '', email: email || '', createdAt: now() };
    db.users[u.id] = u;
  }
  persist();
  return u;
}
export function getUser(uid) { load(); return db.users[uid] || null; }

// dev/testing only — create a local user without OAuth
export function createDevUser(login) {
  load();
  const u = { id: id(), githubId: 'dev:' + login, login, name: login, avatar: '', email: '', dev: true, createdAt: now() };
  db.users[u.id] = u; persist(); return u;
}

// passwordless account — created on first "save to cloud". Returns a one-time
// account key (the only credential). No email/password/OAuth required.
function uniqueLogin(base) {
  let h = base, i = 2;
  while (Object.values(db.users).some(u => u.login === h)) h = base + '-' + (i++);
  return h;
}
export function createAnonAccount(desiredLogin) {
  load();
  const key = 'xn_acct_' + id(20);
  const base = (String(desiredLogin || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 24)) || ('u-' + id(3));
  const u = { id: id(), githubId: null, accountKeyHash: sha256(key), login: uniqueLogin(base), name: base, avatar: '', email: '', anon: true, createdAt: now() };
  db.users[u.id] = u; persist();
  return { user: u, key };
}
export function getUserByAccountKey(key) {
  load();
  if (!key) return null;
  const h = sha256(key);
  return Object.values(db.users).find(u => u.accountKeyHash === h) || null;
}
export function renameLogin(uid, login) {
  load();
  const u = db.users[uid]; if (!u) return null;
  const clean = String(login || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 24);
  if (!clean) return u;
  if (Object.values(db.users).some(x => x.login === clean && x.id !== uid)) return null; // taken
  u.login = clean; persist(); return u;
}

// ── sessions ──
export function createSession(userId, days = 30) {
  load();
  const token = id(24);
  const exp = new Date(Date.now() + days * 864e5).toISOString();
  db.sessions[token] = { token, userId, createdAt: now(), expiresAt: exp };
  persist();
  return token;
}
export function getSessionUser(token) {
  load();
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expiresAt < now()) { delete db.sessions[token]; persist(); return null; }
  return db.users[s.userId] || null;
}
export function deleteSession(token) { load(); if (db.sessions[token]) { delete db.sessions[token]; persist(); } }

// ── skills ──
export function listSkillsByOwner(ownerId) {
  load();
  return Object.values(db.skills).filter(s => s.ownerId === ownerId).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
export function listPublicSkills(limit = 100) {
  load();
  return Object.values(db.skills).filter(s => s.visibility === 'public')
    .sort((a, b) => (b.latestScore || 0) - (a.latestScore || 0)).slice(0, limit);
}
export function getSkill(skillId) { load(); return db.skills[skillId] || null; }
export function getSkillByOwnerSlug(ownerId, slug) {
  load();
  return Object.values(db.skills).find(s => s.ownerId === ownerId && s.slug === slug) || null;
}
export function getPublicSkillByLoginSlug(login, slug) {
  load();
  const owner = Object.values(db.users).find(u => u.login === login);
  if (!owner) return null;
  const s = Object.values(db.skills).find(x => x.ownerId === owner.id && x.slug === slug);
  return s || null;
}

function uniqueSlug(ownerId, base) {
  let slug = slugify(base), i = 2;
  while (getSkillByOwnerSlug(ownerId, slug)) slug = slugify(base) + '-' + (i++);
  return slug;
}

// optional structured skill sections (Anthropic examples/ + references/) — additive, non-breaking
function normSections(x) {
  return {
    examples: String((x && x.examples) || '').slice(0, 8000),
    references: String((x && x.references) || '').slice(0, 8000),
  };
}
// free-form tags / collections — additive grouping primitive
function normTags(x) {
  if (!Array.isArray(x)) return [];
  const seen = new Set(), out = [];
  for (const t of x) {
    const v = String(t || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= 12) break;
  }
  return out;
}
// skill graph edges — compose_with / depend_on (SkillNet-style). Each is a list of the owner's skill ids.
function normRelations(x) {
  const pick = a => Array.isArray(a)
    ? [...new Set(a.map(s => String(s)).filter(s => /^[a-z0-9_]{4,40}$/i.test(s)))].slice(0, 12)
    : [];
  return { composeWith: pick(x && x.composeWith), dependsOn: pick(x && x.dependsOn) };
}
export function createSkill({ ownerId, name, description, category, visibility, source, repo, content, note, sections, tags, relations }) {
  load();
  const sid = id();
  const slug = uniqueSlug(ownerId, name);
  const skill = {
    id: sid, ownerId, slug, name: name || slug, description: description || '', category: category || 'strategy',
    visibility: visibility === 'public' ? 'public' : 'private',
    source: source || 'manual', repo: repo || '',
    sections: normSections(sections),
    tags: normTags(tags), status: 'active', relations: normRelations(relations),
    latestVersionId: null, latestN: 0, latestScore: null, latestTier: null,
    createdAt: now(), updatedAt: now(),
  };
  db.skills[sid] = skill;
  persist();
  if (content && content.trim()) addVersion(sid, content, note || 'initial');
  return db.skills[sid];
}

export function updateSkillMeta(skillId, { name, description, category, visibility, sections, tags, status, relations }) {
  load();
  const s = db.skills[skillId]; if (!s) return null;
  if (name !== undefined) s.name = name;
  if (description !== undefined) s.description = description;
  if (category !== undefined) s.category = category;
  if (visibility !== undefined) s.visibility = visibility === 'public' ? 'public' : 'private';
  if (sections !== undefined) s.sections = normSections(sections);
  if (tags !== undefined) s.tags = normTags(tags);
  if (status !== undefined) s.status = status === 'archived' ? 'archived' : 'active';
  if (relations !== undefined) s.relations = normRelations(relations);
  s.updatedAt = now();
  persist();
  return s;
}

export function deleteSkill(skillId) {
  load();
  if (!db.skills[skillId]) return false;
  delete db.skills[skillId];
  for (const v of Object.values(db.versions)) if (v.skillId === skillId) delete db.versions[v.id];
  persist();
  return true;
}

// ── versions ──
export function addVersion(skillId, content, note) {
  load();
  const s = db.skills[skillId]; if (!s) return null;
  const n = (s.latestN || 0) + 1;
  const vid = id();
  db.versions[vid] = { id: vid, skillId, n, content: String(content || ''), note: note || '', sms: null, createdAt: now() };
  s.latestVersionId = vid; s.latestN = n; s.updatedAt = now();
  persist();
  return db.versions[vid];
}
export function getVersion(vid) { load(); return db.versions[vid] || null; }
export function listVersions(skillId) {
  load();
  return Object.values(db.versions).filter(v => v.skillId === skillId).sort((a, b) => b.n - a.n);
}
export function attachScore(versionId, sms) {
  load();
  const v = db.versions[versionId]; if (!v) return null;
  v.sms = sms;
  const s = db.skills[v.skillId];
  if (s && s.latestVersionId === versionId) { s.latestScore = sms.total; s.latestTier = sms.tier; s.updatedAt = now(); }
  persist();
  return v;
}

// ── api keys ──
export function createApiKey(ownerId, name) {
  load();
  const raw = 'xn_' + id(20);                 // shown once
  const prefix = raw.slice(0, 10);
  const k = { id: id(), ownerId, name: name || 'default', keyHash: sha256(raw), prefix, createdAt: now(), lastUsedAt: null };
  db.apiKeys[k.id] = k;
  persist();
  return { record: k, raw };
}
export function listApiKeys(ownerId) {
  load();
  return Object.values(db.apiKeys).filter(k => k.ownerId === ownerId)
    .map(k => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
}
export function deleteApiKey(ownerId, keyId) {
  load();
  const k = db.apiKeys[keyId];
  if (!k || k.ownerId !== ownerId) return false;
  delete db.apiKeys[keyId]; persist(); return true;
}
export function userForApiKey(raw) {
  load();
  const h = sha256(raw);
  const k = Object.values(db.apiKeys).find(x => x.keyHash === h);
  if (!k) return null;
  k.lastUsedAt = now(); persist();
  return db.users[k.ownerId] || null;
}

// ── chains（命名 / 保存技能链：有序 skill id 列表，可复用工作流）──
function normSteps(a) { return Array.isArray(a) ? a.map(s => String(s)).filter(s => /^[a-z0-9_]{4,40}$/i.test(s)).slice(0, 10) : []; }
export function listChainsByOwner(ownerId) { load(); return Object.values(db.chains).filter(c => c.ownerId === ownerId).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); }
export function getChain(cid) { load(); return db.chains[cid] || null; }
export function createChain({ ownerId, name, steps }) {
  load();
  const cid = id();
  const c = { id: cid, ownerId, name: name || '未命名链', slug: slugify(name), steps: normSteps(steps), invocations: 0, createdAt: now(), updatedAt: now() };
  db.chains[cid] = c; persist(); return c;
}
export function updateChain(cid, { name, steps }) {
  load(); const c = db.chains[cid]; if (!c) return null;
  if (name !== undefined) c.name = name;
  if (steps !== undefined) c.steps = normSteps(steps);
  c.updatedAt = now(); persist(); return c;
}
export function deleteChain(cid) { load(); if (!db.chains[cid]) return false; delete db.chains[cid]; persist(); return true; }
export function recordChainInvocation(cid) { load(); const c = db.chains[cid]; if (!c) return null; c.invocations = (c.invocations || 0) + 1; c.updatedAt = now(); persist(); return c.invocations; }
export function chainView(c) { if (!c) return null; return { id: c.id, name: c.name, slug: c.slug, steps: c.steps || [], invocations: c.invocations || 0, createdAt: c.createdAt, updatedAt: c.updatedAt }; }

// ── public views ──
// record an invocation (copy-to-AI / inject) — the retention signal
// action: copy(软) | inject(插件) | mcp | api(硬·真调用)。默认 copy。
export function recordInvocation(skillId, action) {
  load();
  const s = db.skills[skillId];
  if (!s) return null;
  s.invocations = (s.invocations || 0) + 1;
  const a = String(action || 'copy').toLowerCase();
  const allow = ['copy', 'inject', 'mcp', 'api', 'chain'];
  s.invocationsBy = s.invocationsBy || {};
  const key = allow.includes(a) ? a : 'copy';
  s.invocationsBy[key] = (s.invocationsBy[key] || 0) + 1;
  s.lastInvokedAt = now();
  persist();
  return s.invocations;
}
export function skillView(s, { withOwner = false } = {}) {
  if (!s) return null;
  const out = {
    id: s.id, slug: s.slug, name: s.name, description: s.description, category: s.category,
    visibility: s.visibility, source: s.source, repo: s.repo,
    version: s.latestN, score: s.latestScore, tier: s.latestTier,
    invocations: s.invocations || 0, invocationsBy: s.invocationsBy || {}, lastInvokedAt: s.lastInvokedAt || null,
    sections: s.sections || { examples: '', references: '' },
    tags: s.tags || [], status: s.status || 'active',
    relations: s.relations || { composeWith: [], dependsOn: [] },
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
  if (withOwner) { const u = getUser(s.ownerId); out.owner = u ? { login: u.login, name: u.name } : null; }
  return out;
}

export function stats() {
  load();
  return {
    users: Object.keys(db.users).length,
    skills: Object.keys(db.skills).length,
    publicSkills: Object.values(db.skills).filter(s => s.visibility === 'public').length,
    versions: Object.keys(db.versions).length,
  };
}
