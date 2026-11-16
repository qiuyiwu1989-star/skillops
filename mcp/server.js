#!/usr/bin/env node
/* SkillOps MCP · 检索型
 * 把你的私人 SkillOps 技能库接进任何 MCP 客户端（Claude Desktop / Claude Code / Cursor / agent）。
 * 技能跑在你自己的 AI 里 —— 本服务器只「取出技能内容」，不替你执行、不锁定（反 Capafy）。
 * 鉴权：环境变量 SKILLOPS_API_KEY（控制台 → API Key 生成）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.SKILLOPS_API || 'https://skillops.qiuyiwu.com/api';
const KEY = process.env.SKILLOPS_API_KEY || '';

async function api(path, opts = {}) {
  try {
    const r = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY, ...(opts.headers || {}) },
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, j };
  } catch (e) {
    return { ok: false, status: 0, j: { error: 'network', message: String(e && e.message || e) } };
  }
}
const errText = r => (r.j && (r.j.message || r.j.error)) || ('HTTP ' + r.status);
const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });

async function resolveId(query) {
  const q = String(query || '').trim();
  if (/^[a-f0-9]{8,}$/.test(q)) return q;                 // looks like an id
  const r = await api('/v1/me/skills');
  const skills = (r.j && r.j.skills) || [];
  const lc = q.toLowerCase();
  return (skills.find(s => s.name === q || s.slug === q)
       || skills.find(s => (s.name || '').toLowerCase() === lc || (s.slug || '').toLowerCase() === lc)
       || skills.find(s => (s.name || '').toLowerCase().includes(lc))
       || {}).id || null;
}

const server = new McpServer({ name: 'skillops', version: '0.1.0' });

server.tool(
  'list_my_skills',
  '列出我在 SkillOps 上管理的全部技能（名称 / 段位 / 分数 / 简介 / id）。用户提到"我的技能/提示词库"时先调它。',
  {},
  async () => {
    if (!KEY) return fail('未配置 SKILLOPS_API_KEY。到 https://skillops.qiuyiwu.com/dashboard/ → API Key 生成一个，填进 MCP 配置的 env 里。');
    const r = await api('/v1/me/skills');
    if (!r.ok) return fail('拉取失败：' + errText(r));
    const skills = (r.j && r.j.skills) || [];
    if (!skills.length) return text('你的 SkillOps 库还是空的。去控制台建一个，或在对话里捕获。');
    const lines = skills.map(s => `- ${s.name}${s.score != null ? ` [${s.score}/100 ${s.tier || ''}]` : ' [未评分]'} (id: ${s.id})${s.description ? ` — ${s.description}` : ''}`).join('\n');
    return text(`你的技能库（@${r.j.owner} · ${skills.length} 个）：\n${lines}\n\n要用某个？调 get_skill(query="名称或id")。`);
  }
);

server.tool(
  'get_skill',
  '取出某个技能的完整内容（SKILL.md / 提示词正文），拿到后请按它来执行用户当前任务。query 可以是技能名称或 id。',
  { query: z.string().describe('技能名称或 id（如 "jtbd-analyzer" 或 8 位 hex id）') },
  async ({ query }) => {
    if (!KEY) return fail('未配置 SKILLOPS_API_KEY。');
    const id = await resolveId(query);
    if (!id) return fail(`没找到匹配「${query}」的技能。先调 list_my_skills 看看有哪些。`);
    const r = await api('/v1/me/skills/' + id);
    if (!r.ok) return fail('取内容失败：' + errText(r));
    api('/v1/me/skills/' + id + '/invoke', { method: 'POST', body: JSON.stringify({ action: 'mcp' }) }).catch(() => {}); // 真·调用埋点（agent 拉取）
    const c = (r.j && r.j.content) || '';
    if (!c.trim()) return text(`技能「${r.j.name || query}」还没有内容版本。`);
    const sec = (r.j && r.j.sections) || {};
    let extra = '';
    if (sec.examples) extra += `\n\n【示例】\n${sec.examples}`;
    if (sec.references) extra += `\n\n【引用 / 边界（gotchas）】\n${sec.references}`;
    return text(`【技能：${r.j.name || query}${r.j.score != null ? ` · ${r.j.score}/100 ${r.j.tier || ''}` : ''}】\n请把下面的内容当作处理当前任务的方法/系统提示来执行：\n\n${c}${extra}`);
  }
);

server.tool(
  'search_skills',
  '在 SkillOps 技能市场搜公开技能（官方精选 / 社区 / GitHub）。用于发现现成的技能。',
  { q: z.string().describe('关键词，如 "创新分析" / "ppt" / "写作"') },
  async ({ q }) => {
    const r = await api('/public/search?q=' + encodeURIComponent(q));
    if (!r.ok) return fail('搜索失败：' + errText(r));
    const items = (r.j && r.j.items) || [];
    if (!items.length) return text(`市场里没搜到「${q}」相关的技能。`);
    const lines = items.slice(0, 15).map(x => `- [${x.badge}] ${x.name}${x.total != null ? ` (${x.total}/100 ${x.tier || ''})` : ''}${x.repo ? ` · ${x.repo}` : ''}${x.summary ? ` — ${String(x.summary).slice(0, 60)}` : ''}`).join('\n');
    return text(`技能市场搜「${q}」：\n${lines}\n\n（在 skillops.qiuyiwu.com 上可「复制到我的」fork 成你的私有副本再二改。）`);
  }
);

await server.connect(new StdioServerTransport());
