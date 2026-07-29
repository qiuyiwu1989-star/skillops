/* scoring.mjs — SMS (Skill Management Standard) scoring engine, extracted for reuse.
 * Used by the GitHub ingest pipeline (and can later back server.js too).
 * Env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
 */
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL    = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_API_KEY  = process.env.LLM_API_KEY || '';

export const SMS_VERSION = 'v2.0';
export const SMS_PILLARS = [
  { key: 'comprehension', zh: '可理解', en: 'COMPREHENSION', q: '人和 agent 能不能搞懂它、知道何时用？' },
  { key: 'execution',     zh: '可执行', en: 'EXECUTION',     q: '它能不能真把活干好、且稳定？' },
  { key: 'engineering',   zh: '可工程', en: 'ENGINEERING',   q: '它能不能进入更大的 agent 系统？' },
  { key: 'trust',         zh: '可信赖与价值', en: 'TRUST & VALUE', q: '敢不敢用、值不值得？' },
];
export const SMS_DIMENSIONS = [
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
const SMS_LADDER = '0 缺失 · 2 雏形（有意识但几乎不可用）· 4 基础（能用但明显不足）· 6 合格（达到可公开门槛）· 8 良好（稳定可靠、少数瑕疵）· 10 卓越（标杆级、可作范例）';

export function tierFor(total) {   // 100-point scale
  if (total >= 86) return 'S';
  if (total >= 76) return 'A';
  if (total >= 64) return 'B';
  if (total >= 50) return 'C';
  return 'D';
}
function clampScore(v) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) n = 0;
  return Math.max(0, Math.min(10, n));   // each dimension 0–10
}
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

export async function runScoring(name, content) {
  const c = String(content || '').slice(0, 16000).trim();
  const nm = (String(name || '').slice(0, 120).trim()) || '(未命名 skill)';
  if (c.length < 40) { const e = new Error('内容太短（至少 40 字）。'); e.code = 'too_short'; throw e; }

  const rubric = SMS_PILLARS.map(p => {
    const dims = SMS_DIMENSIONS.filter(d => d.pillar === p.key).map(d => `   - ${d.key}（${d.zh}）：${d.hint}`).join('\n');
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
  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false, max_tokens: 4000, temperature: 0.2 }),
    });
    if (!upstream.ok) { const t = await upstream.text().catch(() => ''); const e = new Error(t.slice(0, 300) || `upstream ${upstream.status}`); e.code = 'upstream'; throw e; }
    const j = await upstream.json();
    const msg = j.choices?.[0]?.message || {};
    parsed = extractJson(msg.content || msg.reasoning_content || '');
  }
  if (!parsed || !parsed.scores) { const e = new Error('评分引擎返回格式异常。'); e.code = 'parse'; throw e; }

  const dimensions = SMS_DIMENSIONS.map(d => ({
    key: d.key, zh: d.zh, en: d.en, pillar: d.pillar,
    score: clampScore(parsed.scores[d.key]),
    reason: String((parsed.reasons && parsed.reasons[d.key]) || '').slice(0, 80),
  }));
  const total = dimensions.reduce((s, d) => s + d.score, 0);
  const pillars = SMS_PILLARS.map(p => {
    const ds = dimensions.filter(d => d.pillar === p.key);
    return { key: p.key, zh: p.zh, en: p.en, score: ds.reduce((s, d) => s + d.score, 0), max: ds.length * 10 };
  });
  return {
    name: nm, total, max: 100, tier: tierFor(total), dimensions, pillars, smsVersion: SMS_VERSION,
    summary: String(parsed.summary || '').slice(0, 600),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 5).map(s => String(s).slice(0, 120)) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 6).map(s => String(s).slice(0, 200)) : [],
    model: LLM_MODEL,
  };
}

// ── skill-coach (M·05 培训): rewrite a SKILL.md to lift its weak SMS dimensions ──
// weakDims: [{ key, zh, score }] (the lowest-scoring dims). Returns { rewritten, fixes }.
// strategy: tier(冲段位·默认) | structure(补结构) | dimension(定向单维, 配 dimKey) | polish(保守润色)
const COACH_STRATEGIES = {
  tier:      '【策略：冲段位】聚焦最弱的 2–3 维，用最小必要改动跨到下一段位；尽量保留原结构与语气。',
  structure: '【策略：补结构】重点补全这些结构件：examples（好例 + 坏例对照）、gotchas / 边界条件、明确的成功标准（让输出可评估）、触发自检（删掉正文只留触发词，agent 还能否判断何时调用）。这些结构缺失通常是主要扣分点。',
  dimension: '【策略：定向单维】集中火力只提升指定的那一维，其它维度尽量不动、不改写。',
  polish:    '【策略：保守润色】只改善表达清晰度、措辞、格式与可读性；不改方法论、不改结构、严格保持作者原有的语气与风格。适合已不错、只想轻量打磨的 skill。',
};
export async function coachRewrite(name, content, weakDims, targetTier = 'B', strategy = 'tier', dimKey = null) {
  const c = String(content || '').slice(0, 16000).trim();
  const nm = (String(name || '').slice(0, 120).trim()) || '(未命名 skill)';
  if (c.length < 40) { const e = new Error('内容太短，无法培训。'); e.code = 'too_short'; throw e; }
  const dimHint = k => (SMS_DIMENSIONS.find(d => d.key === k) || {}).hint || '';
  let stratHint = COACH_STRATEGIES[strategy] || COACH_STRATEGIES.tier;
  if (strategy === 'dimension' && dimKey) { const dz = (SMS_DIMENSIONS.find(d => d.key === dimKey) || {}).zh || dimKey; stratHint += `\n→ 指定维度：【${dz}】（${dimHint(dimKey)}）`; }
  const weakList = (weakDims || []).map(d => `- ${d.zh}（${d.key}）当前 ${d.score}/10 —— 要点：${dimHint(d.key)}`).join('\n');
  const sys =
`你是 openclaw-skill-ops 的 skill-coach（技能培训引擎）。给定一个 AI Skill 及其 SMS 评级里最薄弱的几个维度，重写它的 SKILL.md，针对性补强这些维度，目标段位 ${targetTier} 以上。

铁律：
1. 保留原 skill 的意图、领域与核心能力，绝不编造它不具备的功能。
2. 针对薄弱维度对症下药：清晰度→重写一句话用途与边界；可调用性→补全触发词表+反例；可执行性→把流程拆成带编号的确定步骤；输出稳定性→显式定义输出格式/schema；结果质量→加验收标准与好/坏示例；可评估性→给明确成功标准；安全性→标注禁用/需确认动作。
3. 中文 skill 用清晰自然的中文。
4. 不要为了凑分塞无意义内容。

本次培训策略（优先遵循）：
${stratHint}

只输出重写后的**完整 Markdown 正文**，不要任何解释、不要 \`\`\` 代码围栏。`;
  const user = `Skill 名称：${nm}\n\n最薄弱的维度：\n${weakList}\n\n以下是当前内容：\n\n${c}`;
  const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false, max_tokens: 4000, temperature: 0.3 }),
  });
  if (!upstream.ok) { const t = await upstream.text().catch(() => ''); const e = new Error(t.slice(0, 300) || `upstream ${upstream.status}`); e.code = 'upstream'; throw e; }
  const j = await upstream.json();
  const msg = j.choices?.[0]?.message || {};
  let out = String(msg.content || msg.reasoning_content || '').trim();
  out = out.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  if (out.length < 40) { const e = new Error('培训引擎返回为空。'); e.code = 'parse'; throw e; }
  const fixes = (weakDims || []).map(d => ({ key: d.key, zh: d.zh, score: d.score, hint: dimHint(d.key) }));
  return { rewritten: out, fixes };
}

// ── 技能图：让小能从内容推荐 compose_with / depend_on 关系（人在环，用户确认才落库）──
// target: { name, description, content }; candidates: [{ id, name, description, category }]
// 返回 { composeWith:[{id,name,reason}], dependsOn:[{id,name,reason}] }，id 必在候选内。
export async function suggestRelations(target, candidates) {
  const cands = (candidates || []).slice(0, 40);
  if (!cands.length) return { composeWith: [], dependsOn: [] };
  const sys =
`你是 SkillOps 的技能图助手。给定一个「目标技能」和用户库里的「候选技能」，判断目标与各候选之间是否成立这两种关系：
- compose_with（可组合）：能串成工作流，一个的产出可作为另一个的输入。
- depend_on（依赖）：目标技能需要先有 / 基于该候选才成立（有方向）。
只在关系**明显成立**时推荐，宁缺毋滥（没有就返回空数组）。每条给一句中文理由（≤30字）。
只输出 JSON，不要解释、不要代码围栏：
{"composeWith":[{"id":"候选id","reason":"…"}],"dependsOn":[{"id":"候选id","reason":"…"}]}
id 必须来自候选列表。`;
  const list = cands.map(c => `- id=${c.id} | ${c.name}（${c.category || ''}）：${String(c.description || '').slice(0, 60)}`).join('\n');
  const user = `目标技能：${String(target.name || '').slice(0, 120)}\n简介：${String(target.description || '').slice(0, 200)}\n内容摘要：\n${String(target.content || '').slice(0, 1200)}\n\n候选技能：\n${list}`;
  let parsed = null;
  try {
    const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false, max_tokens: 1200, temperature: 0.2 }),
    });
    if (!upstream.ok) { const e = new Error(`upstream ${upstream.status}`); e.code = 'upstream'; throw e; }
    const j = await upstream.json();
    parsed = extractJson(j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.reasoning_content || '');
  } catch (e) { if (e.code === 'upstream') throw e; }
  const byId = Object.fromEntries(cands.map(c => [c.id, c]));
  const clean = arr => (Array.isArray(arr) ? arr : []).filter(x => x && byId[x.id]).slice(0, 8)
    .map(x => ({ id: x.id, name: byId[x.id].name, reason: String(x.reason || '').slice(0, 40) }));
  return { composeWith: clean(parsed && parsed.composeWith), dependsOn: clean(parsed && parsed.dependsOn) };
}
