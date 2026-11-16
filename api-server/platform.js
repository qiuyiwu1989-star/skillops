/**
 * 小能 platform router — the SaaS surface on top of the SMS engine.
 *
 *   Auth (GitHub OAuth + sessions):
 *     GET  /auth/github                 → redirect to GitHub authorize
 *     GET  /auth/github/callback        → exchange code, set session, redirect to /dashboard/
 *     GET  /auth/me                     → current user (from session cookie)
 *     POST /auth/logout                 → clear session
 *     POST /auth/dev-login              → dev only (gated by DEV_LOGIN_SECRET env)
 *
 *   Skills (session-authed):
 *     GET    /skills                    → my skills
 *     POST   /skills                    → create { name, description, category, visibility, content }
 *     GET    /skills/:id                → skill + versions + latest content (owner)
 *     PUT    /skills/:id                → update meta
 *     DELETE /skills/:id
 *     POST   /skills/:id/versions       → new version { content, note }
 *     POST   /skills/:id/evaluate       → SMS-score latest version, attach
 *     POST   /skills/import             → import all SKILL.md from a public GitHub repo
 *
 *   API keys (session-authed):
 *     GET /keys · POST /keys · DELETE /keys/:id
 *
 *   Public registry:
 *     GET /registry · GET /registry/:login/:slug
 *
 *   Agent API (Bearer xn_ key):
 *     GET /v1/me/skills                 → my skills manifest
 *     GET /v1/skills/:login/:slug       → skill content (public, or mine via key)
 */

import { readFileSync as readPersonalSkillLinks } from 'node:fs';
import * as db from './db.js';
import * as store from './store.js';
import { handleMcp as mcpHandle } from './mcp-http.js';
import { handleOAuth } from './oauth.js';
import { readPersonalLibrary, readPersonalRelease, readPersonalPluginFile, readPersonalPluginArchive } from './personal-releases.js';
import { personalWorkbench, STORY_ID, STORY_VERSION } from './personal-workbench.js';
import { readClassification, updateClassification } from './library-classification.js';

import { isLibraryReadKey, ownerForLibraryKey, libraryOwner, listLibraryKeys, createLibraryKey, copyLibraryKey, deleteLibraryKey } from './library-read-keys.js';

const ORIGIN = (process.env.APP_ORIGIN || 'https://skillops.tech').replace(/\/+$/, '');

let CFG = {};
let H = {};   // injected helpers: readJson, setCors, runScoring, fetchGithubSkills

export function initPlatform(cfg, helpers) { CFG = cfg; H = helpers; }

// ── cookie helpers ──
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, { maxAge, clear } = {}) {
  const bits = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  bits.push(`Max-Age=${clear ? 0 : (maxAge || 2592000)}`);
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(bits.join('; '));
  res.setHeader('Set-Cookie', arr);
}
function linkedSkillView(skill, account) {
  const view = db.skillView(skill);
  if (account.login !== 'qiuyiwu') return view;
  try {
    const links = JSON.parse(readPersonalSkillLinks('/var/lib/skillops-cn/personal-skill-links.json', 'utf8'));
    const link = links[skill.id];
    if (link && /^[0-9a-f-]{36}$/.test(link.id) && /^\d+\.\d+\.\d+$/.test(link.version)) {
      view.personalCenter = { id: link.id, version: link.version, hash: link.hash };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Personal skill links unavailable');
  }
  return view;
}

function sessionUser(req) { return db.getSessionUser(parseCookies(req).xn_sess); }
function bearer(req) { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7).trim() : null; }

// NOTE: both return true so `return json(...)` / `return redirect(...)` always
// signals "handled" to the caller — prevents fall-through double-writes.
function json(res, code, obj, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); return true; }
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); return true; }

function personalCatalog(native) {
  return readPersonalLibrary(native.map(skill => {
    const version = db.getVersion(skill.latestVersionId);
    return { id: skill.id, name: skill.name, revision: version?.n, versionId: version?.id, content: version?.content };
  }));
}

async function unifiedLibrary(ownerId) {
  const native = db.listSkillsByOwner(ownerId);
  const catalog = await personalCatalog(native);
  const personal = [...catalog.skills, ...catalog.plugins];
  const linked = new Set(personal.flatMap(item => item.links.map(link => link.id)));
  const candidates = new Set(personal.flatMap(item => item.candidates.map(candidate => candidate.id)));
  let assignments = {};
  try {
    assignments = readClassification().assignments;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [
    ...native.filter(item => item.status !== 'archived' && !linked.has(item.id)).map(item => {
      const { id, name, description, version, visibility, status, category } = db.skillView(item);
      return { id, name, description, version, visibility, status, kind: 'skill', source: 'skillops',
        category: assignments[id] || category, candidate: candidates.has(id) };
    }),
    ...personal.filter(item => item.state !== 'archived').map(item => {
      const { id, kind, name, description, state, version, packageHash } = item;
      return { id, kind, name, description, state, version, packageHash, source: 'personal_agi',
        category: assignments[kind + '/' + id] || null, candidate: item.candidates.length > 0 };
    }),
  ].map(item => ({ ...item, detailPath: '/api/v1/me/skills/' + item.id }));
}

const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

async function serveUnifiedLibrary(req, res, url, id, raw) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  try {
    const owner = ownerForLibraryKey(raw);
    const user = owner && db.getUser(owner);
    if (!user) return json(res, 401, { error: 'invalid_key' }, privateHeaders);
    if (req.method !== 'GET') return json(res, 403, { error: 'read_only' }, privateHeaders);
    if (!id) {
      const skills = await unifiedLibrary(owner);
      const plugins = skills.filter(item => item.kind === 'plugin').length;
      return json(res, 200, { owner: user.login, total: skills.length, counts: { skills: skills.length - plugins, plugins }, skills }, privateHeaders);
    }

    const version = url.searchParams.get('version');
    const native = db.getSkill(id);
    if (native?.ownerId === owner && native.status !== 'archived') {
      const versions = db.listVersions(id);
      const selected = version ? versions.find(item => String(item.n) === version) : db.getVersion(native.latestVersionId);
      if (!selected) return json(res, 404, { error: 'not_found' }, privateHeaders);
      const { name, description, visibility } = native;
      return json(res, 200, { id, kind: 'skill', name, description, visibility, version: selected.n,
        versions: versions.map(item => ({ version: item.n })), content: selected.content }, privateHeaders);
    }

    const kind = /^[a-f0-9]{64}$/.test(id) ? 'plugin' : /^[a-f0-9-]{36}$/.test(id) ? 'skill' : null;
    if (!kind) return json(res, 404, { error: 'not_found' }, privateHeaders);
    if (version && !(kind === 'plugin' ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/ : /^\d+\.\d+\.\d+$/).test(version)) {
      return json(res, 400, { error: 'invalid_version' }, privateHeaders);
    }
    const release = await readPersonalRelease(kind, id, version, undefined, { includeAssessments: false });
    if (!release?.version || release.state === 'archived') return json(res, 404, { error: 'not_found' }, privateHeaders);
    const { name, state, packageHash, releaseId, versions, files, attachments, content, members } = release;
    return json(res, 200, { id, kind, name, state, packageHash, releaseId, version: release.version,
      versions, files, attachments, content, members }, privateHeaders);
  } catch {
    return json(res, 502, { error: 'library_unavailable' }, privateHeaders);
  }
}

// ── main handler · returns true if it handled the request ──
export async function handlePlatform(req, res, url) {
  const p = url.pathname;
  if (!/^\/(auth|app|registry|v1|public|mcp|oauth|\.well-known)(\/|$)/.test(p)) return false;

  H.setCors(res, req);

  // ════════════ OAuth 2.1（给远程 MCP 用：discovery / register / authorize / token）════════════
  if (p.startsWith('/oauth/') || p.startsWith('/.well-known/oauth')) {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const handled = await handleOAuth(req, res, url, { db, json, readJson: H.readJson, getSessionUser: db.getSessionUser });
    if (handled) return true;
  }

  // ════════════ 远程 MCP 接口（Streamable HTTP · JSON-RPC）════════════
  if (p === '/mcp' || p === '/mcp/') {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const wwwAuth = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`;
    const unauth = () => { res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuth }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized — connect via OAuth, or send Authorization: Bearer xn_…' } })); return true; };
    if (req.method === 'GET') return unauth();   // no SSE; also advertises OAuth
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }), true;
    const user = db.userForApiKey(bearer(req) || '');
    if (!user) return unauth();
    const body = await H.readJson(req).catch(() => null);
    if (body == null) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), true;
    const resp = await mcpHandle(body, user, { db, store });
    return json(res, 200, resp ?? {}), true;
  }

  // ════════════ AUTH ════════════
  if (p === '/auth/github' && req.method === 'GET') {
    if (!CFG.githubClientId) return json(res, 500, { error: 'oauth_not_configured', message: 'GitHub OAuth 未配置（缺 GITHUB_CLIENT_ID）。' });
    const state = db.sha256(Math.random() + ':' + Date.now()).slice(0, 24);
    setCookie(res, 'xn_oauth_state', state, { maxAge: 600 });
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', CFG.githubClientId);
    u.searchParams.set('redirect_uri', CFG.oauthRedirect);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    return redirect(res, u.toString()), true;
  }

  if (p === '/auth/github/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req).xn_oauth_state;
    if (!code || !state || state !== cookieState) return redirect(res, CFG.appBase + '/dashboard/?err=oauth_state'), true;
    try {
      const tokRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CFG.githubClientId, client_secret: CFG.githubClientSecret, code, redirect_uri: CFG.oauthRedirect }),
      });
      const tok = await tokRes.json();
      if (!tok.access_token) return redirect(res, CFG.appBase + '/dashboard/?err=oauth_token'), true;
      const ghHeaders = { 'Authorization': `Bearer ${tok.access_token}`, 'User-Agent': 'xiaoneng', 'Accept': 'application/vnd.github+json' };
      const me = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
      let email = me.email;
      if (!email) { try { const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json(); email = (emails.find(e => e.primary) || emails[0] || {}).email || ''; } catch {} }
      const user = db.upsertGithubUser({ githubId: me.id, login: me.login, name: me.name, avatar: me.avatar_url, email });
      const token = db.createSession(user.id);
      setCookie(res, 'xn_sess', token);
      setCookie(res, 'xn_oauth_state', '', { clear: true });
      return redirect(res, CFG.appBase + '/dashboard/'), true;
    } catch (e) {
      return redirect(res, CFG.appBase + '/dashboard/?err=oauth_fail'), true;
    }
  }

  if (p === '/auth/me' && req.method === 'GET') {
    const u = sessionUser(req);
    return json(res, 200, { user: u ? { id: u.id, login: u.login, name: u.name, avatar: u.avatar, anon: !!u.anon } : null }), true;
  }

  // passwordless: create a cloud account on first save. Returns one-time account key.
  if (p === '/auth/account' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    const { user, key } = db.createAnonAccount(b.login);
    const token = db.createSession(user.id);
    setCookie(res, 'xn_sess', token);
    return json(res, 200, { ok: true, user: { id: user.id, login: user.login }, accountKey: key, note: '这是你的账号 key —— 换设备登录时用它，请妥善保存，只显示这一次。' }), true;
  }

  // passwordless: log in with an account key
  if (p === '/auth/login-key' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    const u = db.getUserByAccountKey(String(b.key || '').trim());
    if (!u) return json(res, 403, { error: 'bad_key', message: '账号 key 无效。' }), true;
    const token = db.createSession(u.id);
    setCookie(res, 'xn_sess', token);
    return json(res, 200, { ok: true, user: { id: u.id, login: u.login } }), true;
  }

  if (p === '/auth/logout' && req.method === 'POST') {
    deleteOwnSession(req);
    setCookie(res, 'xn_sess', '', { clear: true });
    return json(res, 200, { ok: true }), true;
  }

  // dev login — only active when DEV_LOGIN_SECRET env is set
  if (p === '/auth/dev-login' && req.method === 'POST') {
    if (!CFG.devLoginSecret) return json(res, 404, { error: 'not_found' }), true;
    const body = await H.readJson(req).catch(() => ({}));
    if (body.secret !== CFG.devLoginSecret) return json(res, 403, { error: 'forbidden' }), true;
    const u = db.createDevUser(body.login || 'devuser');
    const token = db.createSession(u.id);
    setCookie(res, 'xn_sess', token);
    return json(res, 200, { ok: true, user: { id: u.id, login: u.login }, token }), true;
  }

  // ════════════ AGENT API (Bearer key) ════════════
  const scopedSkill = p.match(/^\/v1\/me\/skills(?:\/([a-f0-9-]+))?$/);
  const rawKey = bearer(req);
  if (scopedSkill && isLibraryReadKey(rawKey)) {
    return serveUnifiedLibrary(req, res, url, scopedSkill[1], rawKey);
  }
  if (p === '/v1/me/skills' && req.method === 'GET') {
    const u = db.userForApiKey(bearer(req) || '');
    if (!u) return json(res, 401, { error: 'invalid_key' }), true;
    const items = db.listSkillsByOwner(u.id).map(s => db.skillView(s));
    return json(res, 200, { owner: u.login, skills: items }), true;
  }
  // ── API-key authed: capture a new skill (browser extension「存进库」) ──
  if (p === '/v1/me/skills' && req.method === 'POST') {
    const u = db.userForApiKey(bearer(req) || '');
    if (!u) return json(res, 401, { error: 'invalid_key' }), true;
    const b = await H.readJson(req).catch(() => ({}));
    if (!String(b.name || '').trim()) return json(res, 400, { error: 'name_required' }), true;
    const s = db.createSkill({ ownerId: u.id, name: String(b.name).slice(0, 120), description: String(b.description || '').slice(0, 500), category: b.category, visibility: 'private', source: b.source || 'capture', content: String(b.content || ''), note: b.note || 'captured via extension' });
    return json(res, 200, { skill: db.skillView(s) }), true;
  }
  // ── API-key authed: my single skill (content) / add version / invoke ──
  const v1sm = p.match(/^\/v1\/me\/skills\/([a-f0-9]+)(\/(versions|invoke))?$/);
  if (v1sm) {
    const u = db.userForApiKey(bearer(req) || '');
    if (!u) return json(res, 401, { error: 'invalid_key' }), true;
    const skill = db.getSkill(v1sm[1]);
    if (!skill || skill.ownerId !== u.id) return json(res, 404, { error: 'not_found' }), true;
    const sub = v1sm[3];
    if (!sub && req.method === 'GET') {
      const v = db.getVersion(skill.latestVersionId);
      return json(res, 200, { ...db.skillView(skill), content: v ? v.content : '' }), true;
    }
    if (sub === 'versions' && req.method === 'POST') {
      const b = await H.readJson(req).catch(() => ({}));
      if (!String(b.content || '').trim()) return json(res, 400, { error: 'content_required' }), true;
      const v = db.addVersion(skill.id, String(b.content), String(b.note || 'ext edit').slice(0, 120));
      return json(res, 200, { version: { id: v.id, n: v.n }, skill: db.skillView(db.getSkill(skill.id)) }), true;
    }
    if (sub === 'invoke' && req.method === 'POST') {
      const b = await H.readJson(req).catch(() => ({}));
      return json(res, 200, { ok: true, invocations: db.recordInvocation(skill.id, b.action || 'api') }), true;
    }
  }

  const v1m = p.match(/^\/v1\/skills\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (v1m && req.method === 'GET') {
    const [, login, slug] = v1m;
    const s = db.getPublicSkillByLoginSlug(login, slug);
    if (!s) return json(res, 404, { error: 'not_found' }), true;
    if (s.visibility !== 'public') {
      const u = db.userForApiKey(bearer(req) || '');
      if (!u || u.id !== s.ownerId) return json(res, 403, { error: 'private' }), true;
    }
    const v = db.getVersion(s.latestVersionId);
    return json(res, 200, { ...db.skillView(s, { withOwner: true }), content: v ? v.content : '', sms: v ? v.sms : null }), true;
  }

  // ════════════ PUBLIC REGISTRY ════════════
  if (p === '/registry' && req.method === 'GET') {
    return json(res, 200, { items: db.listPublicSkills(100).map(s => db.skillView(s, { withOwner: true })) }), true;
  }
  const regm = p.match(/^\/registry\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (regm && req.method === 'GET') {
    const [, login, slug] = regm;
    const s = db.getPublicSkillByLoginSlug(login, slug);
    if (!s || s.visibility !== 'public') return json(res, 404, { error: 'not_found' }), true;
    const v = db.getVersion(s.latestVersionId);
    return json(res, 200, { ...db.skillView(s, { withOwner: true }), content: v ? v.content : '', sms: v ? v.sms : null }), true;
  }
  // by-id public skill (robust regardless of handle) — powers the standalone public skill page /u/?id=
  const pubm = p.match(/^\/public\/skills\/([a-f0-9]+)$/);
  if (pubm && req.method === 'GET') {
    const s = db.getSkill(pubm[1]);
    if (!s || s.visibility !== 'public') return json(res, 404, { error: 'not_found' }), true;
    const v = db.getVersion(s.latestVersionId);
    return json(res, 200, { ...db.skillView(s, { withOwner: true }), content: v ? v.content : '', sms: v ? v.sms : null }), true;
  }

  // ════════════ MARKETPLACE SEARCH (public) ════════════
  // unified search across the official hub catalog + community public skills + discovered GitHub skills
  if (p === '/public/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const hub = (await store.hubDataset()).map(r => ({ kind: 'hub', ref: r.slug, name: r.name, total: r.total, max: r.max || 100, tier: r.tier, category: r.category || '', summary: r.summary || '', badge: '官方', forkable: true }));
    const reg = db.listPublicSkills(60).map(s => { const u = db.getUser(s.ownerId); return { kind: 'registry', ref: s.id, name: s.name, total: s.latestScore, max: 100, tier: s.latestTier, category: s.category || '', summary: s.description || '', login: u ? u.login : '', slug: s.slug, badge: '社区', forkable: true }; });
    const gh = (await store.discoveredDataset(40)).map(r => ({ kind: 'github', ref: r.repo, name: r.name, total: r.total, max: r.max || 100, tier: r.tier, repo: r.repo, url: r.url, stars: r.stars || 0, summary: r.summary || '', badge: 'GitHub', forkable: true }));
    let all = [...hub, ...reg, ...gh];
    if (q) all = all.filter(x => ((x.name || '') + ' ' + (x.summary || '') + ' ' + (x.repo || '') + ' ' + (x.category || '')).toLowerCase().includes(q));
    all.sort((a, b) => (b.total || 0) - (a.total || 0));
    return json(res, 200, { items: all.slice(0, 40), q, total: all.length }), true;
  }

  // ════════════ SESSION-AUTHED (skills + keys) ════════════
  const me = sessionUser(req);
  if (!me) return json(res, 401, { error: 'auth_required', message: '请先登录。' }), true;

  // ── account: set handle (used in public skill URLs) ──
  if (p === '/app/handle' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    const u = db.renameLogin(me.id, b.login);
    if (!u) return json(res, 409, { error: 'taken', message: '这个用户名已被占用，换一个。' }), true;
    return json(res, 200, { ok: true, login: u.login }), true;
  }

  // ── keys ──
  if (p === '/app/keys' && req.method === 'GET') return json(res, 200, { keys: [...db.listApiKeys(me.id), ...(me.id === libraryOwner() ? listLibraryKeys(me.id) : [])], libraryReadAvailable: me.id === libraryOwner() }), true;
  if (p === '/app/keys' && req.method === 'POST') {
    const body = await H.readJson(req).catch(() => ({}));
    if (body.scope === 'library_read') {
      if (me.id !== libraryOwner() || req.headers.origin !== ORIGIN) {
        return json(res, 403, { error: 'forbidden' }, privateHeaders);
      }
      res.removeHeader('Access-Control-Allow-Origin');
      res.removeHeader('Access-Control-Allow-Credentials');
      return json(res, 200, createLibraryKey(me.id, String(body.name || 'library-reader').slice(0, 60)), privateHeaders);
    }
    const { record, raw } = db.createApiKey(me.id, String(body.name || 'default').slice(0, 60));
    return json(res, 200, { id: record.id, name: record.name, prefix: record.prefix, key: raw, copyable: Boolean(record.encryptedKey) }, { 'Cache-Control': 'no-store' });
  }
  const keyCopy = p.match(/^\/app\/keys\/([a-f0-9]+)\/copy$/);
  if (keyCopy && req.method === 'POST') {
    const headers = { 'Cache-Control': 'no-store' };
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') return json(res, 403, { error: 'same_origin_required' }, headers);
    try {
      const key = db.getApiKeyForCopy(me.id, keyCopy[1]) ||
        (me.id === libraryOwner() && req.headers.origin === ORIGIN ? copyLibraryKey(me.id, keyCopy[1]) : null);
      return key ? json(res, 200, { key }, headers)
        : json(res, 404, { error: 'key_not_copyable' }, headers);
    } catch {
      return json(res, 503, { error: 'key_copy_unavailable' }, headers);
    }
  }
  const keym = p.match(/^\/app\/keys\/([a-f0-9]+)$/);
  if (keym && req.method === 'DELETE') return json(res, 200, { ok: db.deleteApiKey(me.id, keym[1]) ||
    (me.id === libraryOwner() && req.headers.origin === ORIGIN && deleteLibraryKey(me.id, keym[1])) }), true;

  // ── chains（命名 / 保存技能链）──
  if (p === '/app/chains' && req.method === 'GET') {
    const chains = db.listChainsByOwner(me.id).map(c => {
      const cv = db.chainView(c);
      cv.stepNames = cv.steps.map(sid => { const s = db.getSkill(sid); return (s && s.ownerId === me.id) ? s.name : '(已删除)'; });
      return cv;
    });
    return json(res, 200, { chains }), true;
  }
  if (p === '/app/chains' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    if (!String(b.name || '').trim() || !Array.isArray(b.steps) || b.steps.length < 2) return json(res, 400, { error: 'bad', message: '技能链需要名称 + 至少 2 步。' }), true;
    const c = db.createChain({ ownerId: me.id, name: String(b.name).slice(0, 80), steps: b.steps });
    return json(res, 200, { chain: db.chainView(c) }), true;
  }
  const cm = p.match(/^\/app\/chains\/([a-f0-9]+)(\/assemble)?$/);
  if (cm) {
    const c = db.getChain(cm[1]);
    if (!c || c.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    if (cm[2] === '/assemble' && req.method === 'GET') {
      const steps = (c.steps || []).map(sid => { const s = db.getSkill(sid); if (!s || s.ownerId !== me.id) return null; const v = db.getVersion(s.latestVersionId); db.recordInvocation(s.id, 'chain'); return { name: s.name, content: v ? v.content : '' }; }).filter(Boolean);
      db.recordChainInvocation(c.id);
      return json(res, 200, { name: c.name, steps }), true;
    }
    if (!cm[2] && req.method === 'PUT') { const b = await H.readJson(req).catch(() => ({})); return json(res, 200, { chain: db.chainView(db.updateChain(c.id, b)) }), true; }
    if (!cm[2] && req.method === 'DELETE') return json(res, 200, { ok: db.deleteChain(c.id) }), true;
  }

  if (p === '/app/library-classification' && ['GET','PUT'].includes(req.method)) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    if (!process.env.PERSONAL_RELEASES_OWNER_ID || me.id !== process.env.PERSONAL_RELEASES_OWNER_ID) {
      return json(res, 404, { message: '分类库不可用。' }, headers);
    }
    try {
      if (req.method === 'GET') return json(res, 200, readClassification(), headers);
      if (req.headers.origin !== ORIGIN) return json(res, 403, { message: '请从 SkillOps 控制台提交。' }, headers);
      const {key,category,expected} = await H.readJson(req).catch(() => ({})) || {};
      if (typeof key !== 'string' || typeof category !== 'string') {
        return json(res, 400, { message: '请选择技能和分类。' }, headers);
      }
      if (/^[a-f0-9]{16}$/.test(key)) {
        if (db.getSkill(key)?.ownerId !== me.id) return json(res, 404, { message: '技能不存在。' }, headers);
      } else {
        const asset = key.match(/^(skill)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$|^(plugin)\/([a-f0-9]{64})$/);
        if (!asset) return json(res, 400, { message: '技能标识无效。' }, headers);
        if (!Object.hasOwn(readClassification().assignments,key) &&
            !await readPersonalRelease(asset[1] || asset[3], asset[2] || asset[4])) {
          return json(res, 404, { message: '技能不存在。' }, headers);
        }
      }
      const result = updateClassification(key,category,expected);
      if (result.status === 409) return json(res, 409, { message: '该条目的分类已变化，请刷新后再改。' }, headers);
      if (result.status === 400) return json(res, 400, { message: '分类无效。' }, headers);
      return json(res, 200, { category: result.category, reviewedAt: result.reviewedAt }, headers);
    } catch {
      return json(res, 502, { message: '暂时无法更新分类。' }, headers);
    }
  }

  const workbench = p.match(/^\/app\/personal-workbench\/(storytelling|[a-f0-9-]{36})(?:\/(score|train|edit|trial|publish))?$/);
  if (workbench) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    if (!process.env.PERSONAL_RELEASES_OWNER_ID || me.id !== process.env.PERSONAL_RELEASES_OWNER_ID) {
      return json(res, 404, { message: '工作台不可用。' }, headers);
    }
    const [,target,action] = workbench;
    if (req.method !== (action ? 'POST' : 'GET')) return json(res, 405, { message: '请求方法无效。' }, headers);
    if (action && req.headers.origin !== ORIGIN) return json(res, 403, { message: '请从 SkillOps 控制台提交。' }, headers);
    const body = action ? await H.readJson(req).catch(() => null) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { message: '请求内容无效。' }, headers);
    const story = target === 'storytelling';
    const result = await personalWorkbench(story ? STORY_ID : target,
      story ? STORY_VERSION : url.searchParams.get('version') || '', action, body, H);
    return json(res, result.status, result.data, headers);
  }

  const personalRelease = p.match(/^\/app\/personal-releases\/(storytelling|product-management|(?<skill>skill)\/(?<skillId>[a-f0-9-]{36})|(?<plugin>plugin)\/(?<pluginId>[a-f0-9]{64})(?:\/(?<action>file|download))?)$/);
  if ((p === '/app/personal-library' || personalRelease) && req.method === 'GET') {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    if (!process.env.PERSONAL_RELEASES_OWNER_ID || me.id !== process.env.PERSONAL_RELEASES_OWNER_ID) {
      return json(res, 404, { error: 'not_found' }, headers);
    }
    try {
      if (!personalRelease) return json(res, 200, await personalCatalog(db.listSkillsByOwner(me.id)), headers);
      const { skill, skillId, plugin, pluginId, action } = personalRelease.groups;
      const version = url.searchParams.get('version');
      if (version && !(plugin ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/ : /^\d+\.\d+\.\d+$/).test(version)) {
        return json(res, 400, { error: 'invalid_version' }, headers);
      }
      if (action === 'download') {
        const hash = url.searchParams.get('hash') || '';
        if (!version || !/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error: 'invalid_package' }, headers);
        const archive = await readPersonalPluginArchive(pluginId, version, hash);
        if (!archive) return json(res, 404, { error: 'not_found' }, headers);
        const bytes = Buffer.from(await archive.arrayBuffer());
        res.writeHead(200, { ...headers, 'Content-Type': 'application/zip',
          'Content-Disposition': archive.headers.get('content-disposition') || 'attachment; filename="skillops-plugin.zip"',
          'X-Package-Hash': hash, 'X-Archive-SHA256': archive.headers.get('x-archive-sha256') || '',
          'Content-Length': bytes.length });
        res.end(bytes);
        return true;
      }
      const data = action === 'file'
        ? await readPersonalPluginFile(pluginId, version || '', url.searchParams.get('path') || '')
        : await readPersonalRelease(skill || plugin || personalRelease[1], skillId || pluginId, version);
      return data ? json(res, 200, data, headers) : json(res, 404, { error: 'not_found' }, headers);
    } catch {
      return json(res, 502, { error: 'personal_release_unavailable' }, headers);
    }
  }

  // ── skills ──
  if (p === '/app/skills' && req.method === 'GET') {
    return json(res, 200, { skills: db.listSkillsByOwner(me.id).map(s => linkedSkillView(s, me)) }), true;
  }
  if (p === '/app/skills' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    if (!String(b.name || '').trim()) return json(res, 400, { error: 'name_required' }), true;
    const s = db.createSkill({
      ownerId: me.id, name: String(b.name).slice(0, 120), description: String(b.description || '').slice(0, 500),
      category: b.category, visibility: b.visibility, source: 'manual', content: String(b.content || ''), note: 'created',
    });
    return json(res, 200, { skill: db.skillView(s) }), true;
  }
  if (p === '/app/skills/import' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    let owner = '', repo = String(b.repo || '').trim();
    const m = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (m.length >= 2) { owner = m[0]; repo = m[1]; } else return json(res, 400, { error: 'bad_repo', message: '请提供 owner/repo 或 GitHub 链接。' }), true;
    let found;
    try { found = await H.fetchGithubSkills(owner, repo); }
    catch (e) { return json(res, e.code === 'no_skills' ? 404 : 502, { error: e.code || 'github', message: e.message }), true; }
    const created = [];
    for (const sk of found.skills) {
      const s = db.createSkill({ ownerId: me.id, name: sk.name, description: `imported from ${owner}/${repo}`, source: 'github', repo: `${owner}/${repo}`, visibility: 'private', content: sk.content, note: `import @ ${found.branch}` });
      created.push(db.skillView(s));
    }
    return json(res, 200, { repo: `${owner}/${repo}`, imported: created.length, skills: created }), true;
  }

  // ── fork a marketplace skill into my account (copy content as a private fork) ──
  if (p === '/app/skills/fork' && req.method === 'POST') {
    const b = await H.readJson(req).catch(() => ({}));
    const kind = b.kind, ref = String(b.ref || '');
    let name = '', desc = '', cat = 'strategy', content = '', lineage = '';
    if (kind === 'hub') {
      try { content = H.loadSkill ? await H.loadSkill(ref) : ''; } catch { content = ''; }
      if (!content.trim()) return json(res, 404, { error: 'not_found', message: '找不到这个官方 skill 的内容。' }), true;
      const meta = (await store.hubDataset()).find(x => x.slug === ref) || {};
      name = meta.name || ref; cat = meta.category || 'strategy'; desc = meta.summary || ''; lineage = 'fork 自 官方 ' + name;
    } else if (kind === 'registry') {
      const src = db.getSkill(ref);
      if (!src || src.visibility !== 'public') return json(res, 404, { error: 'not_found' }), true;
      const v = db.getVersion(src.latestVersionId);
      content = v ? v.content : ''; name = src.name; cat = src.category; desc = src.description;
      const ou = db.getUser(src.ownerId); lineage = 'fork 自 @' + ((ou && ou.login) || '?') + '/' + src.slug;
    } else if (kind === 'github') {
      // single discovered skill: ref = "owner/repo", b.path = the specific SKILL.md
      const parts = ref.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').split('/').filter(Boolean);
      if (parts.length < 2) return json(res, 400, { error: 'bad_repo', message: 'GitHub 来源缺少 owner/repo。' }), true;
      const owner = parts[0], gRepo = parts[1];
      let found;
      try { found = await H.fetchGithubSkills(owner, gRepo); }
      catch (e) { return json(res, e.code === 'no_skills' ? 404 : 502, { error: e.code || 'github', message: e.message }), true; }
      const wantPath = String(b.path || '').trim();
      const pick = (wantPath && found.skills.find(s => s.path === wantPath)) || found.skills[0];
      if (!pick || !String(pick.content || '').trim()) return json(res, 404, { error: 'no_skills', message: '这个仓库里没找到可复制的 SKILL.md。' }), true;
      content = pick.content; name = pick.name; cat = b.category || 'strategy';
      desc = `源自 GitHub ${owner}/${gRepo}`;
      lineage = `fork 自 GitHub ${owner}/${gRepo}${wantPath ? (' · ' + wantPath) : ''}`;
    } else {
      return json(res, 400, { error: 'bad_kind', message: '未知来源。' }), true;
    }
    if (!content.trim()) return json(res, 400, { error: 'empty', message: '源 skill 没有可复制的内容。' }), true;
    const s = db.createSkill({ ownerId: me.id, name, description: desc, category: cat, visibility: 'private', source: 'fork', repo: lineage, content, note: lineage });
    return json(res, 200, { skill: db.skillView(s), lineage }), true;
  }

  // ── record an invocation (复制到任何 AI / 注入) — retention signal, owner only ──
  const invm = p.match(/^\/app\/skills\/([a-f0-9]+)\/invoke$/);
  if (invm && req.method === 'POST') {
    const skill = db.getSkill(invm[1]);
    if (!skill || skill.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    const b = await H.readJson(req).catch(() => ({}));
    const n = db.recordInvocation(skill.id, b.action || 'copy');
    return json(res, 200, { ok: true, invocations: n, invocationsBy: (db.getSkill(skill.id) || {}).invocationsBy || {} }), true;
  }

  // POST /app/skills/:id/suggest-relations — 小能读内容，推荐 compose_with / depend_on（人在环，前端确认才落库）
  const srm = p.match(/^\/app\/skills\/([a-f0-9]+)\/suggest-relations$/);
  if (srm && req.method === 'POST') {
    const skill = db.getSkill(srm[1]);
    if (!skill || skill.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    const others = db.listSkillsByOwner(me.id).filter(s => s.id !== skill.id && s.status !== 'archived')
      .map(s => ({ id: s.id, name: s.name, description: s.description, category: s.category }));
    if (!others.length) return json(res, 200, { composeWith: [], dependsOn: [] }), true;
    const v = db.getVersion(skill.latestVersionId);
    let sug;
    try { sug = await H.suggestRelations({ name: skill.name, description: skill.description, content: v ? v.content : '' }, others); }
    catch (e) { return json(res, 502, { error: e.code || 'error', message: e.message || '推荐失败，稍后再试' }), true; }
    return json(res, 200, sug), true;
  }

  // GET /app/skills/:id/chain — 顺着 compose_with 边把技能拼成一条线性工作流（含各步内容）
  const chm = p.match(/^\/app\/skills\/([a-f0-9]+)\/chain$/);
  if (chm && req.method === 'GET') {
    const start = db.getSkill(chm[1]);
    if (!start || start.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    const steps = [], seen = new Set();
    let cur = start;
    while (cur && !seen.has(cur.id) && steps.length < 6) {
      seen.add(cur.id);
      const v = db.getVersion(cur.latestVersionId);
      steps.push({ id: cur.id, name: cur.name, content: v ? v.content : '' });
      const ids = (cur.relations && cur.relations.composeWith) || [];
      cur = ids.map(id => db.getSkill(id)).find(s => s && s.ownerId === me.id && !seen.has(s.id)) || null;
    }
    return json(res, 200, { steps }), true;
  }

  // GET a specific version's full content (for view / diff / rollback)
  const vm = p.match(/^\/app\/skills\/([a-f0-9]+)\/versions\/([a-f0-9]+)$/);
  if (vm && req.method === 'GET') {
    const skill = db.getSkill(vm[1]);
    if (!skill || skill.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    const v = db.getVersion(vm[2]);
    if (!v || v.skillId !== skill.id) return json(res, 404, { error: 'version_not_found' }), true;
    return json(res, 200, { id: v.id, n: v.n, note: v.note, content: v.content, sms: v.sms || null, createdAt: v.createdAt }), true;
  }

  const sm = p.match(/^\/app\/skills\/([a-f0-9]+)(\/(versions|evaluate|coach))?$/);
  if (sm) {
    const skill = db.getSkill(sm[1]);
    if (!skill || skill.ownerId !== me.id) return json(res, 404, { error: 'not_found' }), true;
    const sub = sm[3];

    if (!sub && req.method === 'GET') {
      const v = db.getVersion(skill.latestVersionId);
      return json(res, 200, { skill: linkedSkillView(skill, me), content: v ? v.content : '', latestSms: v ? v.sms || null : null, versions: db.listVersions(skill.id).map(x => ({ id: x.id, n: x.n, note: x.note, sms: x.sms ? { total: x.sms.total, tier: x.sms.tier } : null, createdAt: x.createdAt })) }), true;
    }
    if (!sub && req.method === 'PUT') {
      const b = await H.readJson(req).catch(() => ({}));
      return json(res, 200, { skill: db.skillView(db.updateSkillMeta(skill.id, b)) }), true;
    }
    if (!sub && req.method === 'DELETE') return json(res, 200, { ok: db.deleteSkill(skill.id) }), true;

    if (sub === 'versions' && req.method === 'POST') {
      const b = await H.readJson(req).catch(() => ({}));
      if (!String(b.content || '').trim()) return json(res, 400, { error: 'content_required' }), true;
      const v = db.addVersion(skill.id, String(b.content), String(b.note || '').slice(0, 120));
      return json(res, 200, { version: { id: v.id, n: v.n, note: v.note }, skill: db.skillView(db.getSkill(skill.id)) }), true;
    }
    if (sub === 'evaluate' && req.method === 'POST') {
      const v = db.getVersion(skill.latestVersionId);
      if (!v || !v.content.trim()) return json(res, 400, { error: 'empty', message: '该 skill 还没有内容版本。' }), true;
      let r;
      try { r = await H.runScoring(skill.name, v.content); }
      catch (e) { return json(res, e.code === 'too_short' ? 400 : 502, { error: e.code || 'error', message: e.message }), true; }
      const sms = { total: r.total, max: r.max, tier: r.tier, dimensions: r.dimensions, summary: r.summary, strengths: r.strengths, suggestions: r.suggestions, model: r.model, at: new Date().toISOString() };
      db.attachScore(v.id, sms);
      return json(res, 200, { skill: db.skillView(db.getSkill(skill.id)), sms }), true;
    }

    // POST /app/skills/:id/coach — skill-coach (M·05 培训): rewrite to lift weak dims
    if (sub === 'coach' && req.method === 'POST') {
      const cb = await H.readJson(req).catch(() => ({}));
      const strategy = ['tier', 'structure', 'dimension', 'polish'].includes(cb.strategy) ? cb.strategy : 'tier';
      const dim = cb.dim || null;
      const v = db.getVersion(skill.latestVersionId);
      if (!v || !v.content.trim()) return json(res, 400, { error: 'empty', message: '该 skill 还没有内容版本。' }), true;
      // need current dimensions — use latest score, else score now
      let sms = v.sms;
      if (!sms || !Array.isArray(sms.dimensions) || !sms.dimensions.length) {
        try {
          const r = await H.runScoring(skill.name, v.content);
          sms = { total: r.total, max: r.max, tier: r.tier, dimensions: r.dimensions, summary: r.summary, strengths: r.strengths, suggestions: r.suggestions, model: r.model, at: new Date().toISOString() };
          db.attachScore(v.id, sms);
        } catch (e) { return json(res, e.code === 'too_short' ? 400 : 502, { error: e.code || 'error', message: e.message }), true; }
      }
      const weak = (sms.dimensions || []).slice().sort((a, b) => a.score - b.score).slice(0, 3)
        .map(d => ({ key: d.key, zh: d.zh, score: d.score, reason: d.reason || '' }));
      let coached;
      try { coached = await H.coachRewrite(skill.name, v.content, weak, 'B', strategy, dim); }
      catch (e) { return json(res, e.code === 'too_short' ? 400 : 502, { error: e.code || 'error', message: e.message }), true; }
      return json(res, 200, {
        currentTotal: sms.total, currentTier: sms.tier, strategy,
        weak, fixes: coached.fixes, rewritten: coached.rewritten,
      }), true;
    }
  }

  return json(res, 404, { error: 'not_found' }), true;
}

function deleteOwnSession(req) {
  const t = parseCookies(req).xn_sess;
  if (t) db.deleteSession(t);
}
