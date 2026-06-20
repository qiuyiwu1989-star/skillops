/**
 * Skill Hub · Try API
 *
 * Provides in-browser chat with skills. Proxies to an OpenAI-compatible
 * LLM endpoint, injecting the skill's SKILL.md as the system prompt.
 *
 * Reads config from environment:
 *   PORT              (default 8787)
 *   LLM_API_KEY       (required — set in /etc/skill-api/.env)
 *   LLM_BASE_URL      (default https://api.openai.com/v1)
 *   LLM_MODEL         (default gpt-4o-mini)
 *   SKILLS_DIR        (default ../skill — where SKILL.md files live)
 *   RATE_LIMIT_PER_IP (default 3 — anonymous messages per IP per day)
 *   ALLOW_ORIGIN      (default https://skill.qiuyiwu.com)
 *
 * Endpoints:
 *   GET  /health                       — liveness probe
 *   GET  /skills                       — list available skill slugs
 *   POST /try/:slug                    — chat once (SSE stream response)
 *     body: { messages: [{ role, content }, ...] }
 *   POST /evaluate                     — score a submitted skill (SMS 10-dim, JSON response)
 *     body: { name, content }
 *   GET  /evaluate/remaining           — check eval quota without consuming
 *
 * Run:
 *   node server.js
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEvaluation, recentPublic, leaderboard, hubDataset, discoveredDataset,
  historyForIp, stats as storeStats, sha256, hashIp, initEvalStore,
} from './store.js';
import { initPlatform, handlePlatform } from './platform.js';
import { initStore } from './db.js';
import { coachRewrite, suggestRelations } from './scoring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──
const PORT             = parseInt(process.env.PORT || '8787', 10);
const LLM_API_KEY      = process.env.LLM_API_KEY;
const LLM_BASE_URL     = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL        = process.env.LLM_MODEL || 'gpt-4o-mini';
const SKILLS_DIR       = process.env.SKILLS_DIR || path.resolve(__dirname, '..', 'skill');
const RATE_LIMIT_PER_IP = parseInt(process.env.RATE_LIMIT_PER_IP || '3', 10);
const EVAL_LIMIT_PER_IP = parseInt(process.env.EVAL_LIMIT_PER_IP || '5', 10);
const ALLOW_ORIGINS    = (process.env.ALLOW_ORIGIN || 'https://skill.qiuyiwu.com,https://xiaoneng.qiuyiwu.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ORIGIN     = ALLOW_ORIGINS[0];

if (!LLM_API_KEY) {
  console.error('✗ LLM_API_KEY is not set. Aborting.');
  process.exit(1);
}

// ── Platform (SaaS) config ──
const APP_BASE = process.env.APP_BASE || 'https://xiaoneng.qiuyiwu.com';
const PLATFORM_CFG = {
  githubClientId: process.env.GITHUB_CLIENT_ID || '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  appBase: APP_BASE,
  oauthRedirect: APP_BASE + '/api/auth/github/callback',
  devLoginSecret: process.env.DEV_LOGIN_SECRET || '',
};

console.log(`→ Skill Hub Try API · port ${PORT}`);
console.log(`  LLM: ${LLM_BASE_URL} model=${LLM_MODEL}`);
console.log(`  Skills dir: ${SKILLS_DIR}`);
console.log(`  Rate limit: ${RATE_LIMIT_PER_IP} msg/IP/day`);

// ── In-memory IP throttle (resets at midnight UTC) ──
let ipBucket = new Map();
let bucketDay = new Date().toUTCString().slice(0, 16);

function getRemaining(ip) {
  const today = new Date().toUTCString().slice(0, 16);
  if (today !== bucketDay) {
    ipBucket = new Map();
    bucketDay = today;
  }
  return RATE_LIMIT_PER_IP - (ipBucket.get(ip) || 0);
}
function chargeIp(ip) {
  ipBucket.set(ip, (ipBucket.get(ip) || 0) + 1);
}

// ── Skill loader ──
const skillCache = new Map();
async function loadSkill(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('invalid slug');
  if (skillCache.has(slug)) return skillCache.get(slug);
  const candidates = [
    path.join(SKILLS_DIR, slug, 'SKILL.md'),
    path.join('/opt/skill-api/skills', slug, 'SKILL.md'),  // bundled fallback
    path.join(SKILLS_DIR, '_tools', '_extracted', slug, slug, 'SKILL.md'),
    path.join(SKILLS_DIR, '_tools', '_extracted', slug, 'SKILL.md'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      // Strip frontmatter (--- ... ---) → keep body
      const stripped = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
      skillCache.set(slug, stripped);
      return stripped;
    } catch (e) { /* try next */ }
  }
  throw new Error(`skill not found: ${slug}`);
}

// ── Helpers ──
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function pickOrigin(req) {
  const o = req && req.headers && req.headers.origin;
  // exact allowlist, plus any localhost/127.0.0.1 port for local dev preview
  if (o && (ALLOW_ORIGINS.includes(o) || LOCAL_ORIGIN_RE.test(o))) return o;
  return ALLOW_ORIGIN;
}
function setCors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', pickOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');  // session cookie on cross-origin
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── SSE proxy to LLM ──
async function streamChat(req, res, slug) {
  const ip = getClientIp(req);
  const remaining = getRemaining(ip);
  if (remaining <= 0) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limit', message: '今日免费试用已用完。明日 UTC 0 点重置或联系作者商务合作。' }));
    return;
  }

  let body;
  try { body = await readJson(req); }
  catch { res.writeHead(400).end('bad json'); return; }

  const userMessages = Array.isArray(body.messages) ? body.messages : [];
  if (userMessages.length === 0) { res.writeHead(400).end('no messages'); return; }

  let systemPrompt;
  try { systemPrompt = await loadSkill(slug); }
  catch (e) { res.writeHead(404).end(e.message); return; }

  const llmMessages = [
    { role: 'system', content: systemPrompt + '\n\n注意：你在 skill.qiuyiwu.com 的在线试用模式中运行。回复应该精炼、有方法论结构感，体现 skill 的实际能力。如用户咨询商业合作或集成方案，告诉对方联系 hi@qiuyiwu.com。' },
    ...userMessages.filter(m => m.role && m.content).slice(-10), // last 10 messages, defense in depth
  ];

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': pickOrigin(req),
    'X-Skill-Rate-Remaining': String(remaining - 1),
  });
  chargeIp(ip);

  try {
    const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: llmMessages,
        stream: true,
        max_tokens: 2048,
        temperature: 0.7,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => 'upstream error');
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, msg: errText.slice(0, 500) })}\n\n`);
      res.end();
      return;
    }

    // Pipe upstream SSE → client SSE (passthrough)
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            res.write(`event: done\ndata: {}\n\n`);
            continue;
          }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) {
              res.write(`event: token\ndata: ${JSON.stringify({ t: delta })}\n\n`);
            }
          } catch { /* skip non-json */ }
        }
      }
    }
    res.write(`event: done\ndata: ${JSON.stringify({ remaining: getRemaining(ip) })}\n\n`);
    res.end();
  } catch (e) {
    console.error('upstream err', e.message);
    res.write(`event: error\ndata: ${JSON.stringify({ msg: e.message })}\n\n`);
    res.end();
  }
}

// ── List skills (for /try/ landing) ──
async function listSkills() {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const slugs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      try {
        await fs.access(path.join(SKILLS_DIR, e.name, 'SKILL.md'));
        slugs.push(e.name);
      } catch { /* no SKILL.md, skip */ }
    }
    return slugs;
  } catch (e) {
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  SMS EVALUATE — submit a skill, get a 10-dimension maturity score
// ════════════════════════════════════════════════════════════

// Separate IP bucket for evaluations (heavier than chat)
let evalBucket = new Map();
let evalDay = new Date().toUTCString().slice(0, 16);
function getEvalRemaining(ip) {
  const today = new Date().toUTCString().slice(0, 16);
  if (today !== evalDay) { evalBucket = new Map(); evalDay = today; }
  return EVAL_LIMIT_PER_IP - (evalBucket.get(ip) || 0);
}
function chargeEval(ip) { evalBucket.set(ip, (evalBucket.get(ip) || 0) + 1); }

// SMS v2.0 — 4 pillars × 10 dimensions, each scored 0–5 against anchored rubrics.
const SMS_VERSION = 'v2.0';
const SMS_PILLARS = [
  { key: 'comprehension', zh: '可理解', en: 'COMPREHENSION', q: '人和 agent 能不能搞懂它、知道何时用？' },
  { key: 'execution',     zh: '可执行', en: 'EXECUTION',     q: '它能不能真把活干好、且稳定？' },
  { key: 'engineering',   zh: '可工程', en: 'ENGINEERING',   q: '它能不能进入更大的 agent 系统？' },
  { key: 'trust',         zh: '可信赖与价值', en: 'TRUST & VALUE', q: '敢不敢用、值不值得？' },
];
const SMS_DIMENSIONS = [
  { key: 'clarity',       zh: '清晰度',     en: 'CLARITY',        pillar: 'comprehension', hint: '用途、边界、价值是否一眼可懂；面向中文用户时，中文表达是否清晰自然（本土适配）' },
  { key: 'invocability',  zh: '可调用性',   en: 'INVOCABILITY',   pillar: 'comprehension', hint: '触发设计是否让 agent 在对的时机准确召唤、不漏召/误触；自检：删掉正文只留触发描述，agent 还能否判断何时该调用' },
  { key: 'executability', zh: '可执行性',   en: 'EXECUTABILITY',  pillar: 'execution',     hint: '步骤是否具体到可照做，含判断标准与异常处理，无"凭感觉"的空步' },
  { key: 'stability',     zh: '输出稳定性', en: 'STABILITY',      pillar: 'execution',     hint: '不同输入 / 不同人调用，产出结构是否一致、可预测' },
  { key: 'quality',       zh: '结果质量',   en: 'QUALITY',        pillar: 'execution',     hint: '产出是否达资深从业者水准，沉淀了隐性经验/坑(gotchas)与判断，而非复述常识或套模板' },
  { key: 'reusability',   zh: '可复用性',   en: 'REUSABILITY',    pillar: 'engineering',   hint: '能否抽象迁移到多个场景 / 行业，而非绑死单一任务' },
  { key: 'composability', zh: '可组合性',   en: 'COMPOSABILITY',  pillar: 'engineering',   hint: '输入输出契约是否清晰，可作为更大工作流的一个节点被编排' },
  { key: 'evaluability',  zh: '可评估性',   en: 'EVALUABILITY',   pillar: 'engineering',   hint: '是否有明确成功标准，输出好坏可被测试 / 回归 / 客观判断' },
  { key: 'safety',        zh: '安全性',     en: 'SAFETY',         pillar: 'trust',         hint: '越界 / 注入 / 敏感信息 / 合规风险是否被主动处理；企业可否放心接入' },
  { key: 'business',      zh: '商业价值',   en: 'BUSINESS VALUE', pillar: 'trust',         hint: '是否解决高频、真实、有支付意愿的问题，价值可被量化' },
];
// generic 0–5 anchor ladder (applies to every dimension)
const SMS_LADDER = '0 缺失 · 2 雏形（有意识但几乎不可用）· 4 基础（能用但明显不足）· 6 合格（达到可公开门槛）· 8 良好（稳定可靠、少数瑕疵）· 10 卓越（标杆级、可作范例）';

function tierFor(total) {
  if (total >= 86) return 'S';
  if (total >= 76) return 'A';
  if (total >= 64) return 'B';
  if (total >= 50) return 'C';
  return 'D';
}

function clampScore(v) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) n = 0;
  return Math.max(0, Math.min(10, n));
}

// Extract first balanced {...} JSON object from a possibly-fenced string
function extractJson(text) {
  if (!text) return null;
  let s = text.replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// Core scoring — reusable by the HTTP handler, batch eval, and the seed script.
// Returns { name, total, max, tier, dimensions, summary, strengths, suggestions, model }
// Throws Error with .code ('too_short' | 'upstream' | 'parse') on failure.
async function runScoring(name, content) {
  const c = String(content || '').slice(0, 16000).trim();
  const nm = (String(name || '').slice(0, 120).trim()) || '(未命名 skill)';
  if (c.length < 40) { const e = new Error('内容太短（至少 40 字）。'); e.code = 'too_short'; throw e; }

  // SMS v2 rubric — grouped by the 4 pillars, with per-dimension hints
  const rubric = SMS_PILLARS.map(p => {
    const dims = SMS_DIMENSIONS.filter(d => d.pillar === p.key)
      .map(d => `   - ${d.key}（${d.zh}）：${d.hint}`).join('\n');
    return `【支柱·${p.zh} ${p.en}】核心问题：${p.q}\n${dims}`;
  }).join('\n\n');
  const sysPrompt =
`你是 openclaw-skill-ops 的 SMS（Skill Management Standard · ${SMS_VERSION}）评估引擎。对用户提交的一个 AI Skill（Claude Code Skill / prompt / agent 定义）做专业的成熟度评分。

SMS 把"一个 skill 是否成熟到可被团队/agent 系统长期依赖"拆成 4 支柱、10 个维度，每维 0–10 分，总分 100：

${rubric}

每个维度的 0–10 锚点标尺（统一适用）：
${SMS_LADDER}

评分铁律：
1. 严格、有区分度，绝不所有维度都打高分。按锚点对号入座。
2. 参考总分分档：S 旗舰 86–100 · A 稳定可用 76–85 · B 公开门槛 64–75 · C 概念 50–63 · D 待重写 <50。
3. 信息不足以判断某维度时，给保守低分，并在理由里说明"内容未体现"。
4. 本土适配：若 skill 面向中文用户，中文表达是否清晰自然计入"清晰度"；是否声明国内可用/数据合规计入"安全性"。
5. 反模式必须扣分：模糊触发、虚构案例、机械套模板、无失效边界、无法测试、忽略成本、面向中文用户却表达生硬、复述模型已知常识而无 gotchas/隐性经验。

只输出一个 JSON 对象，不要任何额外文字、解释或 markdown 代码块。严格用这个结构：
{
  "scores": { "clarity": 0, "invocability": 0, "executability": 0, "stability": 0, "quality": 0, "reusability": 0, "composability": 0, "evaluability": 0, "safety": 0, "business": 0 },
  "reasons": { "clarity": "一句话理由（中文，≤30字）", "invocability": "...", "executability": "...", "stability": "...", "quality": "...", "reusability": "...", "composability": "...", "evaluability": "...", "safety": "...", "business": "..." },
  "summary": "2–3 句总体评价（中文）",
  "strengths": ["亮点1", "亮点2"],
  "suggestions": ["可执行改进建议1", "建议2", "建议3"]
}`;

  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: `Skill 名称：${nm}\n\n以下是 skill 的完整内容：\n\n${c}` },
  ];
  // mimo-v2.5 is a reasoning model — it spends tokens on reasoning before the JSON,
  // so give generous headroom and retry once if the JSON comes back truncated/unparseable.
  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, max_tokens: 4000, temperature: 0.2 }),
    });
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      const e = new Error(t.slice(0, 300) || `upstream ${upstream.status}`); e.code = 'upstream'; e.status = upstream.status; throw e;
    }
    const j = await upstream.json();
    const msg = j.choices?.[0]?.message || {};
    const raw = msg.content || msg.reasoning_content || '';
    parsed = extractJson(raw);
  }
  if (!parsed || !parsed.scores) { const e = new Error('评分引擎返回格式异常。'); e.code = 'parse'; throw e; }

  const dimensions = SMS_DIMENSIONS.map(d => ({
    key: d.key, zh: d.zh, en: d.en, pillar: d.pillar,
    score: clampScore(parsed.scores[d.key]),
    reason: String((parsed.reasons && parsed.reasons[d.key]) || '').slice(0, 80),
  }));
  const total = dimensions.reduce((s, d) => s + d.score, 0);
  // per-pillar subtotals (SMS v2)
  const pillars = SMS_PILLARS.map(p => {
    const ds = dimensions.filter(d => d.pillar === p.key);
    return { key: p.key, zh: p.zh, en: p.en, score: ds.reduce((s, d) => s + d.score, 0), max: ds.length * 10 };
  });
  return {
    name: nm, total, max: 100, tier: tierFor(total), dimensions, pillars,
    smsVersion: SMS_VERSION,
    summary: String(parsed.summary || '').slice(0, 600),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 5).map(s => String(s).slice(0, 120)) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 6).map(s => String(s).slice(0, 200)) : [],
    model: LLM_MODEL,
  };
}

async function evaluateSkill(req, res) {
  setCors(res, req);
  const ip = getClientIp(req);
  if (getEvalRemaining(ip) <= 0) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limit', message: `今日免费评估额度（${EVAL_LIMIT_PER_IP} 次）已用完，UTC 0 点重置。` }));
    return;
  }

  let body;
  try { body = await readJson(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_json' })); return; }

  const content = String(body.content || '');
  const name = String(body.name || '');
  const isPublic = body.public === true;

  let result;
  try {
    result = await runScoring(name, content);
  } catch (e) {
    const status = e.code === 'too_short' ? 400 : 502;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.code || 'error', message: e.message }));
    return;
  }

  chargeEval(ip);

  // Persist (content itself is NOT stored — only a hash)
  let stored;
  try {
    stored = await appendEvaluation({
      ts: new Date().toISOString(),
      source: 'user',
      public: isPublic,
      name: result.name,
      total: result.total, max: result.max, tier: result.tier,
      dimensions: result.dimensions,
      summary: result.summary, strengths: result.strengths, suggestions: result.suggestions,
      contentHash: sha256(content.slice(0, 16000)),
      ipHash: hashIp(ip),
      model: result.model,
    });
  } catch (e) { /* persistence is best-effort; never block the response */ }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    id: stored?.id,
    ...result,
    public: isPublic,
    remaining: getEvalRemaining(ip),
    limit: EVAL_LIMIT_PER_IP,
  }));
}

// ════════════════════════════════════════════════════════════
//  BATCH EVALUATE — point at a public GitHub repo, score every SKILL.md
// ════════════════════════════════════════════════════════════

const MAX_BATCH_SKILLS = parseInt(process.env.MAX_BATCH_SKILLS || '5', 10);
const BATCH_LIMIT_PER_IP = parseInt(process.env.BATCH_LIMIT_PER_IP || '2', 10);
let batchBucket = new Map();
let batchDay = new Date().toUTCString().slice(0, 16);
function getBatchRemaining(ip) {
  const today = new Date().toUTCString().slice(0, 16);
  if (today !== batchDay) { batchBucket = new Map(); batchDay = today; }
  return BATCH_LIMIT_PER_IP - (batchBucket.get(ip) || 0);
}
function chargeBatch(ip) { batchBucket.set(ip, (batchBucket.get(ip) || 0) + 1); }

const GH_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/;        // owner / repo segment
async function ghFetch(url, asJson) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'xiaoneng-skill-ops', 'Accept': asJson ? 'application/vnd.github+json' : 'text/plain' }, signal: ctrl.signal });
    if (!r.ok) { const e = new Error(`github ${r.status}`); e.status = r.status; throw e; }
    return asJson ? r.json() : r.text();
  } finally { clearTimeout(to); }
}

// SSRF-safe: only api.github.com / raw.githubusercontent.com, validated owner/repo.
async function fetchGithubSkills(owner, repo) {
  if (!GH_RE.test(owner) || !GH_RE.test(repo)) { const e = new Error('仓库格式无效'); e.code = 'bad_repo'; throw e; }
  const meta = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`, true);
  const branch = meta.default_branch || 'main';
  const tree = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, true);
  const paths = (tree.tree || [])
    .filter(n => n.type === 'blob' && /(^|\/)SKILL\.md$/i.test(n.path))
    .map(n => n.path)
    .slice(0, MAX_BATCH_SKILLS);
  if (paths.length === 0) { const e = new Error('该仓库未找到任何 SKILL.md'); e.code = 'no_skills'; throw e; }

  const out = [];
  for (const p of paths) {
    try {
      const raw = await ghFetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${p.split('/').map(encodeURIComponent).join('/')}`, false);
      const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')).split('/').pop() : repo;
      out.push({ name: dir, path: p, content: body });
    } catch { /* skip unreadable file */ }
  }
  return { branch, skills: out };
}

async function evaluateBatch(req, res) {
  setCors(res, req);
  const ip = getClientIp(req);
  if (getBatchRemaining(ip) <= 0) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limit', message: `今日批量评估额度（${BATCH_LIMIT_PER_IP} 次）已用完，UTC 0 点重置。` }));
    return;
  }

  let body;
  try { body = await readJson(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_json' })); return; }

  // Accept either { repo: "owner/name" } / a github URL, or { owner, repo }
  let owner = String(body.owner || '').trim();
  let repo = String(body.repo || '').trim();
  if (!owner && repo) {
    const m = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (m.length >= 2) { owner = m[0]; repo = m[1]; }
    else { repo = ''; }
  }
  if (!owner || !repo) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_repo', message: '请提供 owner/repo 或完整 GitHub 仓库链接。' }));
    return;
  }

  let discovered;
  try {
    discovered = await fetchGithubSkills(owner, repo);
  } catch (e) {
    const status = e.code === 'no_skills' ? 404 : (e.code === 'bad_repo' ? 400 : 502);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.code || 'github', message: e.message }));
    return;
  }

  chargeBatch(ip);

  // Score with limited concurrency (stay under nginx 120s read timeout)
  const CONC = 3;
  const items = discovered.skills;
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      try {
        const r = await runScoring(it.name, it.content);
        results[i] = { ok: true, path: it.path, ...r };
        appendEvaluation({
          ts: new Date().toISOString(), source: 'batch', public: false,
          name: r.name, repo: `${owner}/${repo}`, slugPath: it.path,
          total: r.total, max: r.max, tier: r.tier, dimensions: r.dimensions,
          summary: r.summary, strengths: r.strengths, suggestions: r.suggestions,
          contentHash: sha256(it.content.slice(0, 16000)), ipHash: hashIp(ip), model: r.model,
        }).catch(() => {});
      } catch (e) {
        results[i] = { ok: false, path: it.path, name: it.name, error: e.code || 'error', message: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, worker));

  const scored = results.filter(r => r && r.ok);
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + r.total, 0) / scored.length * 10) / 10 : 0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    repo: `${owner}/${repo}`,
    branch: discovered.branch,
    found: items.length,
    scored: scored.length,
    avg,
    cap: MAX_BATCH_SKILLS,
    results,
    remaining: getBatchRemaining(ip),
    limit: BATCH_LIMIT_PER_IP,
  }));
}

// ── Wire the platform (SaaS) router with shared helpers ──
initPlatform(PLATFORM_CFG, { readJson, setCors, runScoring, coachRewrite, suggestRelations, fetchGithubSkills, getClientIp, loadSkill });

// ── Router ──
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res, req);
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Platform (SaaS) routes: /auth /app /registry /v1
  try { if (await handlePlatform(req, res, url)) return; }
  catch (e) {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'platform', message: e.message })); }
    else { try { res.end(); } catch {} }
    return;
  }

  if (url.pathname === '/health') {
    setCors(res, req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: LLM_MODEL, time: Date.now() }));
    return;
  }

  if (url.pathname === '/skills') {
    setCors(res, req);
    const slugs = await listSkills();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills: slugs }));
    return;
  }

  // POST /evaluate — submit a skill, get SMS 10-dimension score
  if (url.pathname === '/evaluate' && req.method === 'POST') {
    return evaluateSkill(req, res);
  }

  // GET /evaluate/remaining — check eval quota without consuming
  if (url.pathname === '/evaluate/remaining' && req.method === 'GET') {
    setCors(res, req);
    const ip = getClientIp(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      remaining: getEvalRemaining(ip), limit: EVAL_LIMIT_PER_IP,
      batchRemaining: getBatchRemaining(ip), batchLimit: BATCH_LIMIT_PER_IP,
    }));
    return;
  }

  // POST /evaluate-batch — score every SKILL.md in a public GitHub repo
  if (url.pathname === '/evaluate-batch' && req.method === 'POST') {
    return evaluateBatch(req, res);
  }

  // GET /evaluations/recent — public feed
  if (url.pathname === '/evaluations/recent' && req.method === 'GET') {
    setCors(res, req);
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20);
    const items = await recentPublic(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // GET /evaluations/leaderboard — top public/hub scores
  if (url.pathname === '/evaluations/leaderboard' && req.method === 'GET') {
    setCors(res, req);
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20);
    const items = await leaderboard(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // GET /evaluations/hub — the Skill Hub's own skills, real SMS scores
  if (url.pathname === '/evaluations/hub' && req.method === 'GET') {
    setCors(res, req);
    const items = await hubDataset();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // GET /evaluations/discovered — open-source skills crawled from GitHub, SMS-scored
  if (url.pathname === '/evaluations/discovered' && req.method === 'GET') {
    setCors(res, req);
    const items = await discoveredDataset(60);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // GET /evaluations/mine — this IP's own recent evaluations
  if (url.pathname === '/evaluations/mine' && req.method === 'GET') {
    setCors(res, req);
    const items = await historyForIp(hashIp(getClientIp(req)), 20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
    return;
  }

  // GET /evaluations/stats
  if (url.pathname === '/evaluations/stats' && req.method === 'GET') {
    setCors(res, req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await storeStats()));
    return;
  }

  // POST /try/:slug
  const tryMatch = url.pathname.match(/^\/try\/([a-z0-9-]+)\/?$/);
  if (tryMatch && req.method === 'POST') {
    setCors(res, req);
    return streamChat(req, res, tryMatch[1]);
  }

  // GET /try/:slug/remaining — check quota without consuming
  const remMatch = url.pathname.match(/^\/try\/([a-z0-9-]+)\/remaining\/?$/);
  if (remMatch && req.method === 'GET') {
    setCors(res, req);
    const ip = getClientIp(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ remaining: getRemaining(ip), limit: RATE_LIMIT_PER_IP }));
    return;
  }

  res.writeHead(404).end('not found');
});

// 启动前先把存储后端就绪（supabase 模式：跨境批量拉进内存；file 模式：本地读）
await Promise.all([
  initStore().catch(e => console.warn('[store] initStore:', e.message)),
  initEvalStore().catch(e => console.warn('[store] initEvalStore:', e.message)),
]);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✓ listening on http://127.0.0.1:${PORT} · store=${process.env.STORE_BACKEND === 'supabase' ? 'supabase' : 'file'}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
