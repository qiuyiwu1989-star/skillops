/* oauth.js — 最小 OAuth 2.1 授权服务器（给远程 MCP 用），零依赖。
 *
 * 目的：让 Claude.ai 网页版 Custom Connector 免填 header 直连 skillops.tech 的 MCP。
 * 标准流程：discovery → 动态注册(DCR) → /authorize(同意页, 需登录 skillops.tech) → /token(PKCE 校验) → 拿 access_token。
 * access_token = 给该用户签发的 SkillOps API Key（复用 db.createApiKey），所以 /mcp 鉴权沿用 userForApiKey。
 * 授权码：内存存、5 分钟、单次、绑 PKCE challenge + redirect_uri + userId。注册：无状态（PKCE 保安全）。
 *
 * 安全：仅 S256 PKCE；授权码单次+短时；同意必须由已登录用户(session)发起→token 绑对账号；redirect_uri 须 https。
 */
import crypto from 'node:crypto';

const ORIGIN = (process.env.APP_ORIGIN || 'https://skillops.tech').replace(/\/+$/, '');
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = s => crypto.createHash('sha256').update(s).digest();

// 授权码：code -> { userId, challenge, redirectUri, clientId, exp }
const CODES = new Map();
function gc() { const now = Date.now(); for (const [k, v] of CODES) if (v.exp < now) CODES.delete(k); }

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── discovery 文档 ──
export function oauthMetadata(p) {
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
    return { resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ['header'] };
  }
  if (p === '/.well-known/oauth-authorization-server') {
    return {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      scopes_supported: ['skillops'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  }
  return null;
}

// 主处理器。返回 true 表示已处理。ctx = { db, json, readJson, getSessionUser }
export async function handleOAuth(req, res, url, ctx) {
  const p = url.pathname, { db, json, readJson, getSessionUser } = ctx;
  const send = (code, type, body, headers = {}) => { res.writeHead(code, { 'Content-Type': type, ...headers }); res.end(body); return true; };

  // discovery
  const meta = oauthMetadata(p);
  if (meta) return json(res, 200, meta), true;

  // 动态注册（无状态：回一个 client_id；PKCE 负责安全）
  if (p === '/oauth/register' && req.method === 'POST') {
    const b = parseBody(await readBody(req), req.headers['content-type']);
    return json(res, 201, {
      client_id: 'mcp-' + crypto.randomBytes(8).toString('hex'),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: b.redirect_uris || [], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'],
    }), true;
  }

  // 同意页（GET）/ 批准（POST）
  if (p === '/oauth/authorize') {
    const q = url.searchParams;
    const params = {
      client_id: q.get('client_id') || '', redirect_uri: q.get('redirect_uri') || '',
      state: q.get('state') || '', code_challenge: q.get('code_challenge') || '',
      code_challenge_method: q.get('code_challenge_method') || '', response_type: q.get('response_type') || 'code',
    };
    const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)xn_sess=([^;]+)/);
    const user = cookie ? getSessionUser(decodeURIComponent(cookie[1])) : null;

    if (req.method === 'GET') {
      if (!/^https:\/\//i.test(params.redirect_uri)) return send(400, 'text/html; charset=utf-8', page('参数错误', '<p>redirect_uri 必须是 https。</p>'));
      if (params.code_challenge_method !== 'S256') return send(400, 'text/html; charset=utf-8', page('不支持', '<p>仅支持 PKCE S256。</p>'));
      if (!user) {
        const back = encodeURIComponent(ORIGIN + '/api/oauth/authorize' + url.search);
        return send(200, 'text/html; charset=utf-8', page('请先登录', `<p>授权前需要先登录 SkillOps。</p><p><a class="btn" href="/dashboard/?return=${back}">去登录 →</a></p><p class="hint">登录后回到此页即可授权。</p>`));
      }
      const app = appName(params.redirect_uri);
      const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      return send(200, 'text/html; charset=utf-8', page('授权访问', `
        <p><b>${esc(app)}</b> 请求访问你的 SkillOps 技能库（账号 <b>@${esc(user.login)}</b>）。</p>
        <p class="hint">授权后它能：列出 / 取用你的技能、搜索市场、运行技能链。技能仍跑在你自己的 AI 里，可随时在控制台「API Key」撤销。</p>
        <form method="POST" action="/api/oauth/authorize">${hidden}
          <div class="row"><button class="btn primary" name="approve" value="1">授权</button><button class="btn" name="approve" value="0">拒绝</button></div>
        </form>`));
    }

    if (req.method === 'POST') {
      const f = parseBody(await readBody(req), req.headers['content-type']);
      const rd = f.redirect_uri || '';
      if (!user) return send(401, 'text/html; charset=utf-8', page('未登录', '<p>会话已过期，请重新登录后再授权。</p>'));
      if (!/^https:\/\//i.test(rd)) return send(400, 'text/html; charset=utf-8', page('参数错误', '<p>redirect_uri 无效。</p>'));
      if (f.approve !== '1') { const u = new URL(rd); u.searchParams.set('error', 'access_denied'); if (f.state) u.searchParams.set('state', f.state); return send(302, 'text/html', '', { Location: u.toString() }); }
      gc();
      const code = crypto.randomBytes(24).toString('hex');
      CODES.set(code, { userId: user.id, challenge: f.code_challenge, redirectUri: rd, clientId: f.client_id, exp: Date.now() + 5 * 60 * 1000 });
      const u = new URL(rd); u.searchParams.set('code', code); if (f.state) u.searchParams.set('state', f.state);
      return send(302, 'text/html', '', { Location: u.toString() });
    }
  }

  // token 交换
  if (p === '/oauth/token' && req.method === 'POST') {
    const f = parseBody(await readBody(req), req.headers['content-type']);
    if (f.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' }), true;
    gc();
    const rec = CODES.get(f.code || '');
    if (!rec) return json(res, 400, { error: 'invalid_grant', error_description: '授权码无效或已过期' }), true;
    CODES.delete(f.code);   // 单次
    if (rec.exp < Date.now()) return json(res, 400, { error: 'invalid_grant', error_description: '授权码过期' }), true;
    if (rec.redirectUri !== (f.redirect_uri || '')) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri 不匹配' }), true;
    if (b64url(sha256(f.code_verifier || '')) !== rec.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE 校验失败' }), true;
    const { raw } = db.createApiKey(rec.userId, 'oauth · ' + appName(rec.redirectUri));
    return json(res, 200, { access_token: raw, token_type: 'Bearer', scope: 'skillops' }), true;
  }

  return false;
}

// ── helpers ──
function readBody(req) { return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); }); }
function parseBody(raw, ctype) {
  raw = raw || '';
  if ((ctype || '').includes('application/json') || raw.trim().startsWith('{')) { try { return JSON.parse(raw); } catch { return {}; } }
  const o = {};
  for (const pair of raw.split('&')) { if (!pair) continue; const i = pair.indexOf('='); const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' ')); const v = decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' ')); o[k] = v; }
  return o;
}
function appName(redirectUri) { try { return new URL(redirectUri).hostname.replace(/^www\./, ''); } catch { return '某个 MCP 客户端'; } }
function page(title, inner) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · SkillOps</title>
<style>body{font-family:"Space Grotesk","Noto Sans SC",system-ui,sans-serif;background:#fbfaf6;color:#161616;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:440px;width:100%;border:1px solid rgba(22,22,22,.14);border-radius:14px;padding:32px;background:#fff}
h1{font-size:22px;font-weight:500;letter-spacing:-.02em;margin:0 0 8px}.brand{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.18em;color:#e2522a;margin-bottom:18px}
p{font-size:14px;line-height:1.7;color:rgba(22,22,22,.72);margin:0 0 12px}.hint{font-size:12px;color:rgba(22,22,22,.55)}
.row{display:flex;gap:10px;margin-top:20px}.btn{font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:11px 22px;border-radius:999px;border:1px solid rgba(22,22,22,.2);background:transparent;color:rgba(22,22,22,.7);cursor:pointer;text-decoration:none;display:inline-block}
.btn.primary{background:#e2522a;color:#fff;border-color:#e2522a}b{color:#161616;font-weight:600}</style></head>
<body><div class="card"><div class="brand">SKILLOPS · 授权</div><h1>${esc(title)}</h1>${inner}</div></body></html>`;
}
