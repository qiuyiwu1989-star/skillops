#!/usr/bin/env node
/**
 * reseed-hub-from-catalog.mjs
 *
 * Single source of truth = the published catalog (skills.json).
 * Rewrites the `source:'hub'` rows in evaluations.jsonl so that the
 * /demo, /registry and the SMS audit baseline all show EXACTLY the same
 * scores users see on the skill detail pages. User-submitted (public)
 * rows are preserved untouched.
 *
 * Why not re-run the LLM engine? The bundled SKILL.md files are summaries,
 * not full content, so a live re-score under-rates deep skills (e.g. the
 * 19/D zheng-gang artifact). The curated catalog scores are the calibrated
 * baseline — this script makes every surface agree on them.
 *
 * Env: SKILLS_DIR (default /var/www/html/skill), DATA_DIR (default /var/lib/skill-api)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKILLS_DIR = process.env.SKILLS_DIR || '/var/www/html/skill';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/skill-api';
const CATALOG = path.join(SKILLS_DIR, 'skills.json');
const JSONL = path.join(DATA_DIR, 'evaluations.jsonl');

function tierFor(score) {
  if (score >= 86) return 'S';
  if (score >= 76) return 'A';
  if (score >= 64) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// 1. read catalog
const raw = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const skills = Array.isArray(raw) ? raw : (raw.skills || Object.values(raw)[0]);
const published = skills.filter(s => typeof s.sms_score === 'number');

// 2. read existing jsonl, keep everything that isn't a hub row
let kept = [];
if (fs.existsSync(JSONL)) {
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r.source !== 'hub') kept.push(r);
    } catch { /* skip corrupt */ }
  }
}

// 3. build fresh hub rows straight from the catalog
const base = Date.parse('2026-05-30T00:00:00Z');
const hubRows = published.map((s, i) => {
  const total = s.sms_score;
  const tier = s.tier || tierFor(total);
  return {
    id: crypto.randomBytes(8).toString('hex'),
    source: 'hub',
    slug: s.id,
    name: s.name,
    category: s.category || 'strategy',
    total,
    max: 100,
    tier,
    summary: s.summary || s.description || '',
    dimensions: [],            // curated baseline — per-dim breakdown not published
    smsVersion: 'v1.0',
    ts: base + i * 1000,
  };
});

// 4. write back: preserved non-hub rows first, then the canonical hub set
const all = [...kept, ...hubRows];
const out = all.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(JSONL, out, 'utf8');

const avg = (hubRows.reduce((x, r) => x + r.total, 0) / hubRows.length).toFixed(1);
const dist = {};
hubRows.forEach(r => { dist[r.tier] = (dist[r.tier] || 0) + 1; });
console.log(`✓ reseeded hub from catalog`);
console.log(`  kept non-hub rows : ${kept.length}`);
console.log(`  hub rows written  : ${hubRows.length}`);
console.log(`  avg score         : ${avg} / 100`);
console.log(`  tier dist         : ${JSON.stringify(dist)}`);

// 5. supabase 模式：文件只是镜像，必须把「全量」对账进云库（删掉旧 hub 行的旧 id + 写入新行）。
if ((process.env.STORE_BACKEND || 'file') === 'supabase') {
  try {
    const { supabaseConfigured, reconcileEvaluations } = await import('./supabase-rest.js');
    if (!supabaseConfigured) { console.warn('  ⚠ STORE_BACKEND=supabase 但缺 SUPABASE_URL/KEY，仅写了本地文件'); }
    else {
      const r = await reconcileEvaluations(all);
      console.log(`  ☁ 已对账云库 evaluations：upsert ${r.upsert} / 删除 ${r.remove}（重启 skill-api 生效）`);
    }
  } catch (e) { console.error(`  ✗ 云库对账失败（本地文件已写）：${e.message}`); }
}
