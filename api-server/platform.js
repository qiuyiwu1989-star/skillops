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

import * as db from './db.js';
import * as store from './store.js';
import { handleMcp as mcpHandle } from './mcp-http.js';
import { handleOAuth } from './oauth.js';

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
function sessionUser(req) { return db.getSessionUser(parseCookies(req).xn_sess); }
function bearer(req) { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7).trim() : null; }

// NOTE: both return true so `return json(...)` / `return redirect(...)` always
// signals "handled" to the caller — prevents fall-through double-writes.
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); return true; }
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); return true; }

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
  if (p === '/app/keys' && req.method === 'GET') return json(res, 200, { keys: db.listApiKeys(me.id) }), true;
  if (p === '/app/keys' && req.method === 'POST') {
    const body = await H.readJson(req).catch(() => ({}));
    const { record, raw } = db.createApiKey(me.id, String(body.name || 'default').slice(0, 60));
    return json(res, 200, { id: record.id, name: record.name, prefix: record.prefix, key: raw, note: '请立即复制保存，key 只显示这一次。' }), true;
  }
  const keym = p.match(/^\/app\/keys\/([a-f0-9]+)$/);
  if (keym && req.method === 'DELETE') return json(res, 200, { ok: db.deleteApiKey(me.id, keym[1]) }), true;

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

  // ── skills ──
  if (p === '/app/skills' && req.method === 'GET') {
    return json(res, 200, { skills: db.listSkillsByOwner(me.id).map(s => db.skillView(s)) }), true;
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
      return json(res, 200, { skill: db.skillView(skill), content: v ? v.content : '', latestSms: v ? v.sms || null : null, versions: db.listVersions(skill.id).map(x => ({ id: x.id, n: x.n, note: x.note, sms: x.sms ? { total: x.sms.total, tier: x.sms.tier } : null, createdAt: x.createdAt })) }), true;
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
