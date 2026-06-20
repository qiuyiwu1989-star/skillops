#!/usr/bin/env node
/* ingest-github.mjs — discover open-source skills on GitHub, score them with SMS, add to the
 * registry as source='github' (kept separate from the curated source='hub' catalog).
 *
 * Pipeline:  search GitHub  →  locate SKILL.md  →  fetch raw  →  SMS score (MIMO)  →  append JSONL
 *
 * Env: GITHUB_TOKEN (optional — 60 req/hr unauth, 5000/hr with token; code-search needs a token)
 *      INGEST_LIMIT (max skills to SCORE this run, default 6 — bounds LLM cost)
 *      DATA_DIR (default /var/lib/skill-api)   + the LLM_* vars used by scoring.mjs
 *
 * Only indexes + scores + links back to the source repo. Does NOT redistribute repo content.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runScoring } from './scoring.mjs';

const DATA_DIR = process.env.DATA_DIR || '/var/lib/skill-api';
const JSONL = path.join(DATA_DIR, 'evaluations.jsonl');
const TOKEN = process.env.GITHUB_TOKEN || '';
const LIMIT = parseInt(process.env.INGEST_LIMIT || '6', 10);
const CURATED = (process.env.INGEST_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);  // "owner/repo,owner/repo" → curated mode
const PER_REPO = parseInt(process.env.INGEST_PER_REPO || '5', 10);  // max SKILL.md indexed per repo
const MIN_SCORE = parseInt(process.env.INGEST_MIN_SCORE || '50', 10);  // skip indexing skills below this SMS score (junk filter)
const TOPICS = (process.env.INGEST_TOPICS || 'claude-skill,claude-skills,agent-skill,claude-code-skill,anthropic-skill').split(',');

const GH = 'https://api.github.com';
const headers = { 'User-Agent': 'skillops-ingest', 'Accept': 'application/vnd.github+json' };
if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gh(url) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get('x-ratelimit-reset');
    throw new Error(`rate-limited (${r.status})${reset ? ', resets ' + new Date(+reset * 1000).toISOString() : ''}`);
  }
  if (!r.ok) throw new Error(`GH ${r.status} ${url}`);
  return r.json();
}

// ---- 1. discover candidate repos ----
async function discoverRepos() {
  const seen = new Map(); // full_name -> repo
  if (CURATED.length) {   // curated mode: only the listed repos (skip topic search)
    for (const fn of CURATED) {
      const [owner, repo] = fn.split('/');
      if (!owner || !repo) continue;
      try {
        const it = await gh(`${GH}/repos/${owner}/${repo}`);
        seen.set(it.full_name, {
          full_name: it.full_name, owner: it.owner.login, repo: it.name,
          branch: it.default_branch || 'main', stars: it.stargazers_count || 0,
          desc: it.description || '', html_url: it.html_url, license: (it.license && it.license.spdx_id) || '',
        });
      } catch (e) { console.warn(`  curated ${fn}: ${e.message}`); }
      await sleep(300);
    }
    return [...seen.values()];
  }
  for (const topic of TOPICS) {
    try {
      const j = await gh(`${GH}/search/repositories?q=topic:${encodeURIComponent(topic.trim())}&sort=stars&order=desc&per_page=15`);
      for (const it of (j.items || [])) {
        if (!seen.has(it.full_name)) seen.set(it.full_name, {
          full_name: it.full_name, owner: it.owner.login, repo: it.name,
          branch: it.default_branch || 'main', stars: it.stargazers_count || 0,
          desc: it.description || '', html_url: it.html_url, license: (it.license && it.license.spdx_id) || '',
        });
      }
      await sleep(1200); // stay under search rate
    } catch (e) { console.warn(`  topic ${topic}: ${e.message}`); }
  }
  // optional: code search (needs token)
  if (TOKEN) {
    try {
      const j = await gh(`${GH}/search/code?q=filename:SKILL.md&per_page=20`);
      for (const it of (j.items || [])) {
        const fn = it.repository.full_name;
        if (!seen.has(fn)) seen.set(fn, {
          full_name: fn, owner: it.repository.owner.login, repo: it.repository.name,
          branch: it.repository.default_branch || 'main', stars: 0, desc: it.repository.description || '',
          html_url: it.repository.html_url, license: '', hintPath: it.path,
        });
      }
    } catch (e) { console.warn(`  code-search: ${e.message}`); }
  }
  return [...seen.values()];
}

// ---- 2. locate SKILL.md path(s) in a repo (up to PER_REPO, shallowest first) ----
async function findSkillFiles(r) {
  if (r.hintPath) return [r.hintPath];
  try {
    const tree = await gh(`${GH}/repos/${r.owner}/${r.repo}/git/trees/${r.branch}?recursive=1`);
    const md = (tree.tree || []).filter(t => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path));
    md.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    return md.slice(0, PER_REPO).map(t => t.path);
  } catch { return []; }
}

async function fetchRaw(r, p) {
  const url = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${p}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'skillops-ingest' } });
  if (!res.ok) return null;
  return res.text();
}

function readExistingGithubKeys() {
  const keys = new Set();
  if (!fs.existsSync(JSONL)) return keys;
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { const o = JSON.parse(t); if (o.source === 'github' && o.slug) keys.add(o.slug); } catch {}
  }
  return keys;
}

const added = [];  // 本轮新增的评估行（用于 supabase 模式下回写云库）
function appendRow(row) { fs.appendFileSync(JSONL, JSON.stringify(row) + '\n', 'utf8'); added.push(row); }

(async function main() {
  console.log(`▶ GitHub skill ingest  (token=${TOKEN ? 'yes' : 'no'}, limit=${LIMIT})`);
  const repos = await discoverRepos();
  console.log(`  discovered ${repos.length} candidate repos`);
  const have = readExistingGithubKeys();

  let scored = 0, skipped = 0, failed = 0;
  // process highest-stars first
  repos.sort((a, b) => b.stars - a.stars);
  for (const r of repos) {
    if (scored >= LIMIT) break;
    const paths = await findSkillFiles(r);
    if (!paths.length) { skipped++; continue; }
    for (const p of paths) {
      if (scored >= LIMIT) break;
      const slug = `gh:${r.full_name}:${p}`;
      if (have.has(slug)) { skipped++; continue; }
      const content = await fetchRaw(r, p);
      if (!content || content.trim().length < 80) { skipped++; continue; }
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const name = (nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : `${r.repo}/${p.replace(/\/SKILL\.md$/i, '').split('/').pop()}`).slice(0, 80);
      try {
        const s = await runScoring(name, content);
        if (s.total < MIN_SCORE) { skipped++; console.log(`  ⤫ skip ${r.full_name}/${name} (${s.total} < ${MIN_SCORE})`); continue; }
        const base = Date.parse('2026-05-30T18:00:00Z');
        appendRow({
          id: crypto.randomBytes(8).toString('hex'), source: 'github', slug,
          name, repo: r.full_name, url: r.html_url, path: p, stars: r.stars, license: r.license,
          total: s.total, max: 100, tier: s.tier,
          dimensions: s.dimensions, summary: s.summary, smsVersion: s.smsVersion,
          ts: base + scored * 1000,
        });
        scored++;
        console.log(`  ✓ ${r.full_name}  ${name} → ${s.total}/100 ${s.tier}`);
      } catch (e) { failed++; console.warn(`  ✗ ${r.full_name}/${p}: ${e.message}`); }
    }
  }
  console.log(`\nDone. scored=${scored} skipped=${skipped} failed=${failed}`);
  await syncToSupabase(added);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// supabase 模式下，文件只是镜像 —— 必须把新增行回写云库，否则线上读不到（内存权威 + 重启从云库拉）。
async function syncToSupabase(rows) {
  if ((process.env.STORE_BACKEND || 'file') !== 'supabase' || !rows.length) return;
  try {
    const { supabaseConfigured, upsertEvaluations } = await import('./supabase-rest.js');
    if (!supabaseConfigured) { console.warn('  ⚠ STORE_BACKEND=supabase 但缺 SUPABASE_URL/KEY，仅写了本地文件'); return; }
    const r = await upsertEvaluations(rows);
    console.log(`  ☁ 已回写云库 evaluations：upsert ${r.upsert} 行（重启 skill-api 生效）`);
  } catch (e) { console.error(`  ✗ 云库回写失败（本地文件已写）：${e.message}`); }
}
