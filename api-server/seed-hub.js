/**
 * Seed the Skill Hub's own skills into the evaluation store as canonical
 * `source: 'hub'` records — real SMS scores computed by the live engine.
 *
 * Reuses runScoring via a child import of the scoring logic. Run on the server:
 *   sudo systemctl stop skill-api   # not required, but avoids port noise
 *   cd /opt/skill-api && node --env-file=/etc/skill-api/.env seed-hub.js
 *
 * Or while the service is up (it only needs LLM_API_KEY + DATA_DIR in env):
 *   set -a; . /etc/skill-api/.env; set +a; node seed-hub.js
 *
 * Idempotent-ish: appends fresh records; hubDataset() keeps the latest per slug.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { appendEvaluation, sha256 } from './store.js';

const SKILLS_DIR = process.env.SKILLS_DIR || '/opt/skill-api/skills';
const LLM_API_KEY  = process.env.LLM_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL    = process.env.LLM_MODEL || 'gpt-4o-mini';

if (!LLM_API_KEY) { console.error('✗ LLM_API_KEY not set'); process.exit(1); }

// ── SMS v2 rubric (kept in sync with server.js) ──
const SMS_VERSION = 'v2.0';
const SMS_PILLARS = [
  { key: 'comprehension', zh: '可理解', en: 'COMPREHENSION', q: '人和 agent 能不能搞懂它、知道何时用？' },
  { key: 'execution',     zh: '可执行', en: 'EXECUTION',     q: '它能不能真把活干好、且稳定？' },
  { key: 'engineering',   zh: '可工程', en: 'ENGINEERING',   q: '它能不能进入更大的 agent 系统？' },
  { key: 'trust',         zh: '可信赖与价值', en: 'TRUST & VALUE', q: '敢不敢用、值不值得？' },
];
const SMS_DIMENSIONS = [
  { key: 'clarity', zh: '清晰度', en: 'CLARITY', pillar: 'comprehension', hint: '用途、边界、价值是否一眼可懂；面向中文用户时中文表达是否清晰自然' },
  { key: 'invocability', zh: '可调用性', en: 'INVOCABILITY', pillar: 'comprehension', hint: '触发设计是否让 agent 在对的时机准确召唤，不漏召 / 误触' },
  { key: 'executability', zh: '可执行性', en: 'EXECUTABILITY', pillar: 'execution', hint: '步骤是否具体到可照做，含判断标准与异常处理' },
  { key: 'stability', zh: '输出稳定性', en: 'STABILITY', pillar: 'execution', hint: '不同输入 / 不同人调用，产出结构是否一致可预测' },
  { key: 'quality', zh: '结果质量', en: 'QUALITY', pillar: 'execution', hint: '产出是否达资深从业者水准，有洞察非模板' },
  { key: 'reusability', zh: '可复用性', en: 'REUSABILITY', pillar: 'engineering', hint: '能否抽象迁移到多个场景 / 行业' },
  { key: 'composability', zh: '可组合性', en: 'COMPOSABILITY', pillar: 'engineering', hint: '输入输出契约是否清晰，可被编排进更大工作流' },
  { key: 'evaluability', zh: '可评估性', en: 'EVALUABILITY', pillar: 'engineering', hint: '是否有成功标准，输出可被测试 / 回归 / 客观判断' },
  { key: 'safety', zh: '安全性', en: 'SAFETY', pillar: 'trust', hint: '越界 / 注入 / 敏感信息 / 合规风险是否被主动处理' },
  { key: 'business', zh: '商业价值', en: 'BUSINESS VALUE', pillar: 'trust', hint: '是否解决高频、真实、有支付意愿的问题' },
];
const SMS_LADDER = '0 缺失 · 1 雏形 · 2 基础 · 3 合格(公开门槛) · 4 良好 · 5 卓越(标杆)';
const tierFor = (t) => t >= 86 ? 'S' : t >= 76 ? 'A' : t >= 64 ? 'B' : t >= 50 ? 'C' : 'D';
const clamp = (v) => { let n = Math.round(Number(v)); if (!Number.isFinite(n)) n = 0; return Math.max(0, Math.min(10, n)); };
function extractJson(text) {
  if (!text) return null;
  let s = text.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{'); if (a < 0) return null;
  let d = 0;
  for (let i = a; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (d === 0) { try { return JSON.parse(s.slice(a, i + 1)); } catch { return null; } } } }
  return null;
}

async function score(name, content) {
  const rubric = SMS_PILLARS.map(p => {
    const dims = SMS_DIMENSIONS.filter(d => d.pillar === p.key).map(d => `   - ${d.key}（${d.zh}）：${d.hint}`).join('\n');
    return `【支柱·${p.zh}】${p.q}\n${dims}`;
  }).join('\n\n');
  const sys = `你是 openclaw-skill-ops 的 SMS（${SMS_VERSION}）评估引擎。对一个 AI Skill 做 4 支柱 / 10 维成熟度评分（每维 0–10，总分 100）。\n\n${rubric}\n\n0–10 锚点：${SMS_LADDER}\n严格、有区分度，按锚点对号入座；反模式（模糊触发/虚构案例/套模板/无边界/无法测试/忽略成本）扣分。只输出 JSON：{"scores":{...10 keys...},"reasons":{...},"summary":"...","strengths":[...],"suggestions":[...]}`;
  const messages = [ { role: 'system', content: sys }, { role: 'user', content: `Skill 名称：${name}\n\n内容：\n\n${content.slice(0, 16000)}` } ];
  let parsed = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, stream: false, max_tokens: 4000, temperature: 0.2, messages }),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const msg = j.choices?.[0]?.message || {};
    parsed = extractJson(msg.content || msg.reasoning_content || '');
  }
  if (!parsed || !parsed.scores) throw new Error('parse failed (3 attempts)');
  const dims = SMS_DIMENSIONS.map(d => ({ key: d.key, zh: d.zh, en: d.en, score: clamp(parsed.scores[d.key]), reason: String((parsed.reasons && parsed.reasons[d.key]) || '').slice(0, 80) }));
  const total = dims.reduce((s, d) => s + d.score, 0);
  return { total, max: 100, tier: tierFor(total), dimensions: dims, summary: String(parsed.summary || '').slice(0, 600) };
}

// Map slug → category (mirrors llms.txt grouping; falls back to 'strategy')
const CAT = {
  innolab: 'strategy', 'zheng-gang-innovation-toolkit': 'strategy', 'zheng-gang-perspective': 'strategy',
  'paradigm-shift-analysis': 'strategy', 'hao-sheji-agent': 'strategy', 'ai-opportunity-map': 'strategy',
  'agentceo-management-kernel': 'strategy', 'insight-framework': 'strategy', 'lengjing-insight': 'strategy',
  'luedong-ai-writer': 'writing', 'book-press-agent': 'writing', 'chinese-article-editor': 'writing',
  'artist-painter-skill': 'design', 'ip-creative-director': 'design', 'y3k-avatar-generator': 'design',
  'ppt-design-master': 'presentation', 'qiuqiu-teacher': 'presentation', 'frontend-slides': 'presentation', 'html-ppt-demo': 'presentation',
  'skill-deployer': 'meta', 'qiuyiwu-deployer': 'meta',
};

async function main() {
  const only = (process.env.SEED_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  let slugs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    try { await fs.access(path.join(SKILLS_DIR, e.name, 'SKILL.md')); slugs.push(e.name); } catch {}
  }
  if (only.length) slugs = slugs.filter(s => only.includes(s));
  console.log(`→ seeding ${slugs.length} hub skills · model=${LLM_MODEL}${only.length ? ' (filtered)' : ''}`);

  let ok = 0;
  for (const slug of slugs) {
    try {
      const raw = await fs.readFile(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
      const content = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
      const r = await score(slug, content);
      await appendEvaluation({
        ts: new Date().toISOString(), source: 'hub', public: true,
        slug, name: slug, category: CAT[slug] || 'strategy',
        total: r.total, max: r.max, tier: r.tier, dimensions: r.dimensions, summary: r.summary,
        contentHash: sha256(content.slice(0, 16000)), model: LLM_MODEL,
      });
      ok++;
      console.log(`  ✓ ${slug.padEnd(34)} ${r.total}/100 ${r.tier}`);
    } catch (e) {
      console.log(`  ✗ ${slug.padEnd(34)} ${e.message}`);
    }
  }
  console.log(`done: ${ok}/${slugs.length} scored`);
}
main().catch(e => { console.error(e); process.exit(1); });
