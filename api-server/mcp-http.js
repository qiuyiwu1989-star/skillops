/* mcp-http.js — 手写最小 MCP over Streamable HTTP（JSON-RPC 2.0），零依赖。
 *
 * 把 SkillOps 技能库做成 skillops.qiuyiwu.com 上的「远程 MCP 接口」：
 * 用户在 Claude / Cursor 里填  URL = https://skillops.qiuyiwu.com/api/mcp  +  Authorization: Bearer xn_…  即可接入，
 * 不用 clone、不用装 node。检索型：取技能给"你自己的 AI"执行，不替你跑、不锁定。
 *
 * 支持：initialize / notifications/* / ping / tools/list / tools/call。
 * 工具：list_my_skills · get_skill · search_skills · run_chain。鉴权用 API Key（Bearer）。
 */
const PROTOCOL = '2025-03-26';
const SERVER_INFO = { name: 'skillops', version: '0.1.0' };

const TOOLS = [
  { name: 'list_my_skills', description: '列出我在 SkillOps 上管理的全部技能（名称 / 段位 / 分数 / 简介 / id）。用户提到"我的技能 / 提示词库"时先调它。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_skill', description: '取出某个技能的完整内容（SKILL.md / 提示词正文），拿到后请按它来执行用户当前任务。query 可为技能名称或 id。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '技能名称或 8+ 位 hex id' } }, required: ['query'] } },
  { name: 'search_skills', description: '在 SkillOps 技能市场搜公开技能（官方精选 / 社区 / GitHub 发现），用于发现现成技能。', inputSchema: { type: 'object', properties: { q: { type: 'string', description: '关键词，如 创新 / 写作 / jtbd' } }, required: ['q'] } },
  { name: 'run_chain', description: '运行一条技能链，返回可按步骤执行的完整工作流 prompt。query 可为【已保存的技能链名】，或【起点技能名称/id】（后者按 compose_with 关系现拼）。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '已保存的链名，或起点技能名/id' } }, required: ['query'] } },
];

const text = (t, isErr) => ({ content: [{ type: 'text', text: String(t) }], ...(isErr ? { isError: true } : {}) });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function resolveSkillId(db, user, query) {
  const q = String(query || '').trim();
  if (/^[a-f0-9]{8,}$/.test(q)) { const s = db.getSkill(q); return (s && s.ownerId === user.id) ? q : null; }
  const skills = db.listSkillsByOwner(user.id), lc = q.toLowerCase();
  const hit = skills.find(s => s.name === q || s.slug === q)
    || skills.find(s => (s.name || '').toLowerCase() === lc || (s.slug || '').toLowerCase() === lc)
    || skills.find(s => (s.name || '').toLowerCase().includes(lc));
  return hit ? hit.id : null;
}

async function callTool(name, args, user, { db, store }) {
  if (!user) return text('未授权：请在 MCP 配置里带上 Authorization: Bearer xn_你的key（skillops.qiuyiwu.com/dashboard → API Key 生成）。', true);

  if (name === 'list_my_skills') {
    const skills = db.listSkillsByOwner(user.id).map(s => db.skillView(s));
    if (!skills.length) return text('你的 SkillOps 库还是空的。去 skillops.qiuyiwu.com/dashboard 建一个，或在对话里捕获。');
    const lines = skills.map(s => `- ${s.name}${s.score != null ? ` [${s.score}/100 ${s.tier || ''}]` : ' [未评分]'} (id: ${s.id})${s.description ? ` — ${s.description}` : ''}`).join('\n');
    return text(`你的技能库（@${user.login} · ${skills.length} 个）：\n${lines}\n\n要用某个？调 get_skill(query="名称或id")。`);
  }

  if (name === 'get_skill') {
    const id = resolveSkillId(db, user, args.query);
    if (!id) return text(`没找到匹配「${args.query}」的技能。先调 list_my_skills 看看有哪些。`, true);
    const skill = db.getSkill(id), v = db.getVersion(skill.latestVersionId);
    const c = v ? v.content : '';
    if (!c.trim()) return text(`技能「${skill.name}」还没有内容版本。`);
    db.recordInvocation(id, 'mcp');   // 真·调用埋点（agent 拉取）
    const sec = skill.sections || {}; let extra = '';
    if (sec.examples) extra += `\n\n【示例】\n${sec.examples}`;
    if (sec.references) extra += `\n\n【引用 / 边界（gotchas）】\n${sec.references}`;
    return text(`【技能：${skill.name}${skill.latestScore != null ? ` · ${skill.latestScore}/100 ${skill.latestTier || ''}` : ''}】\n请把下面的内容当作处理当前任务的方法 / 系统提示来执行：\n\n${c}${extra}`);
  }

  if (name === 'search_skills') {
    const q = String(args.q || '').toLowerCase();
    const hub = (await store.hubDataset()).map(x => ({ badge: '官方', name: x.name, total: x.total, tier: x.tier, summary: x.summary }));
    const gh = (await store.discoveredDataset(40)).map(x => ({ badge: 'GitHub', name: x.name, total: x.total, tier: x.tier, repo: x.repo, summary: x.summary }));
    const com = db.listPublicSkills(60).map(s => { const v = db.skillView(s); return { badge: '社区', name: v.name, total: v.score, tier: v.tier, summary: v.description }; });
    let items = [...hub, ...com, ...gh];
    if (q) items = items.filter(x => (x.name || '').toLowerCase().includes(q) || (x.summary || '').toLowerCase().includes(q) || (x.repo || '').toLowerCase().includes(q));
    if (!items.length) return text(`技能市场里没搜到「${args.q}」相关的。`);
    const lines = items.slice(0, 15).map(x => `- [${x.badge}] ${x.name}${x.total != null ? ` (${x.total}/100 ${x.tier || ''})` : ''}${x.repo ? ` · ${x.repo}` : ''}${x.summary ? ` — ${String(x.summary).slice(0, 60)}` : ''}`).join('\n');
    return text(`技能市场搜「${args.q}」：\n${lines}\n\n（在 skillops.qiuyiwu.com 可「复制到我的」fork 成你的私有副本再二改。）`);
  }

  if (name === 'run_chain') {
    const q = String(args.query || '').trim().toLowerCase();
    let steps = [];
    // ① 先匹配「已保存的技能链」（按名 / slug）
    const chain = db.listChainsByOwner(user.id).find(c => (c.name || '').toLowerCase() === q || c.slug === q);
    if (chain) {
      db.recordChainInvocation(chain.id);
      steps = (chain.steps || []).map(sid => { const s = db.getSkill(sid); if (!s || s.ownerId !== user.id) return null; const v = db.getVersion(s.latestVersionId); db.recordInvocation(s.id, 'chain'); return { name: s.name, content: v ? v.content : '' }; }).filter(Boolean);
    } else {
      // ② 否则当起点技能，顺 compose_with 现拼
      const id = resolveSkillId(db, user, args.query);
      if (!id) return text(`没找到名为「${args.query}」的技能链或起点技能。先 list_my_skills，或在控制台保存一条技能链。`, true);
      const seen = new Set(); let cur = db.getSkill(id);
      while (cur && !seen.has(cur.id) && steps.length < 6) {
        seen.add(cur.id);
        const v = db.getVersion(cur.latestVersionId);
        steps.push({ name: cur.name, content: v ? v.content : '' });
        db.recordInvocation(cur.id, 'chain');
        const ids = (cur.relations && cur.relations.composeWith) || [];
        cur = ids.map(i => db.getSkill(i)).find(s => s && s.ownerId === user.id && !seen.has(s.id)) || null;
      }
    }
    if (steps.length < 2) return text(`链只有 1 步 —— 该技能没接 compose_with 下一步，或保存的链不足 2 步。到控制台连关系 / 存链。`, true);
    let out = `# 技能链 · 共 ${steps.length} 步\n# 按步骤依次执行；每步产出作为下一步输入。`;
    steps.forEach((st, i) => { out += `\n\n${'='.repeat(40)}\n## 第 ${i + 1} 步 · ${st.name}\n${i > 0 ? '（输入 = 上一步产出）\n' : ''}\n${st.content || ''}`; });
    return text(out);
  }

  return text(`未知工具：${name}`, true);
}

// 处理一条或一批 JSON-RPC。ctx = { db, store }。返回响应对象（通知返回 null）。
export async function handleMcp(body, user, ctx) {
  const one = async (rpc) => {
    if (!rpc || rpc.jsonrpc !== '2.0') return rpcError((rpc && rpc.id) ?? null, -32600, 'Invalid Request');
    const { id, method, params } = rpc;
    const isNotif = id === undefined || id === null;
    try {
      if (method === 'initialize') return rpcResult(id, { protocolVersion: (params && params.protocolVersion) || PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      if ((method || '').startsWith('notifications/')) return null;
      if (method === 'ping') return rpcResult(id, {});
      if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
      if (method === 'tools/call') return rpcResult(id, await callTool(params && params.name, (params && params.arguments) || {}, user, ctx));
      return isNotif ? null : rpcError(id, -32601, `Method not found: ${method}`);
    } catch (e) { return isNotif ? null : rpcError(id, -32603, 'Internal error: ' + (e && e.message || e)); }
  };
  if (Array.isArray(body)) { const out = []; for (const r of body) { const x = await one(r); if (x) out.push(x); } return out; }
  return one(body);
}
