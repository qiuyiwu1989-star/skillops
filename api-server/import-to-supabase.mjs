#!/usr/bin/env node
/* import-to-supabase.mjs — one-time: SkillOps 文件存储 → 自托管 Supabase(skillops schema)
 *
 * 零依赖：用原生 fetch 打 PostgREST REST。幂等（按主键 upsert），可重跑。
 * 只读本地文件、只写 skillops schema —— 不碰其它 schema / 共享库。
 *
 * 用法（在 SkillOps 服务器上跑，凭据进环境、不入库不入日志）：
 *   # 1) 先干跑（只读 + 连通自检，不写库）：
 *   SUPABASE_URL=https://sb.ai.zaowuyun.com SERVICE_ROLE_KEY=*** node import-to-supabase.mjs
 *   # 2) 确认无误后真正导入：
 *   APPLY=yes SUPABASE_URL=... SERVICE_ROLE_KEY=*** node import-to-supabase.mjs
 *
 * Env: SUPABASE_URL, SERVICE_ROLE_KEY, DATA_DIR(=/var/lib/skill-api), APPLY(=yes 才写)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/skill-api';
const APPLY = process.env.APPLY === 'yes';
const SCHEMA = 'skillops';

if (!URL || !KEY) { console.error('✗ 需要 SUPABASE_URL 和 SERVICE_ROLE_KEY'); process.exit(1); }

const H = (write) => ({
  apikey: KEY,
  Authorization: 'Bearer ' + KEY,
  'Content-Type': 'application/json',
  [write ? 'Content-Profile' : 'Accept-Profile']: SCHEMA,
});

async function upsert(table, rows) {
  if (!rows.length) return { table, sent: 0 };
  if (!APPLY) return { table, sent: rows.length, dry: true };
  const BATCH = 500;
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const r = await fetch(`${URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...H(true), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`${table} upsert ${r.status}: ${(await r.text()).slice(0, 300)}`);
    sent += chunk.length;
  }
  return { table, sent };
}

async function countRemote(table) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=id`, {
    headers: { ...H(false), Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) return `(${r.status})`;
  const cr = r.headers.get('content-range') || '';
  return cr.split('/')[1] || '?';
}

// ── readers ──
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const platform = (() => {
  const f = path.join(DATA_DIR, 'platform.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { users:{}, sessions:{}, skills:{}, versions:{}, apiKeys:{} }; }
})();
const vals = o => Object.values(o || {});

// ── field maps (camelCase → snake_case, exactly matching 0001-skillops-schema.sql) ──
const mUser = u => ({ id:u.id, github_id:u.githubId||null, login:u.login, name:u.name||null, avatar:u.avatar||null, email:u.email||null, account_key_hash:u.accountKeyHash||null, anon:!!u.anon, dev:!!u.dev, created_at:u.createdAt||null });
const mSession = s => ({ token:s.token, user_id:s.userId, created_at:s.createdAt||null, expires_at:s.expiresAt });
const mSkill = s => ({ id:s.id, owner_id:s.ownerId, slug:s.slug, name:s.name, description:s.description||'', category:s.category||'strategy', visibility:s.visibility||'private', source:s.source||'manual', repo:s.repo||'', sections:s.sections||{examples:'',references:''}, tags:s.tags||[], status:s.status||'active', relations:s.relations||{composeWith:[],dependsOn:[]}, latest_version_id:s.latestVersionId||null, latest_n:s.latestN||0, latest_score:s.latestScore??null, latest_tier:s.latestTier||null, invocations:s.invocations||0, last_invoked_at:s.lastInvokedAt||null, created_at:s.createdAt||null, updated_at:s.updatedAt||null });
const mVersion = v => ({ id:v.id, skill_id:v.skillId, n:v.n, content:v.content||'', note:v.note||'', sms:v.sms||null, created_at:v.createdAt||null });
const mKey = k => ({ id:k.id, owner_id:k.ownerId, name:k.name||'default', key_hash:k.keyHash, prefix:k.prefix||null, created_at:k.createdAt||null, last_used_at:k.lastUsedAt||null });
const coerceTs = v => { if (v == null || v === '') return null; if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString(); if (/^\d+$/.test(String(v))) { const n = Number(v); return new Date(n > 1e12 ? n : n * 1000).toISOString(); } return v; };
const mEval = r => { const id = r.id || crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0,16);
  return { id, source:r.source||null, slug:r.slug||r.slugPath||r.path||null, name:r.name||null, repo:r.repo||null, total:r.total??null, max:r.max||100, tier:r.tier||null, public:!!(r.public||r.source==='hub'), ts:coerceTs(r.ts), data:r }; };

(async function main() {
  console.log(`▶ import → ${URL} (schema=${SCHEMA}) · ${APPLY ? 'APPLY(写库)' : 'DRY-RUN(只读自检，不写)'}`);

  // connectivity self-check
  const probe = await fetch(`${URL}/rest/v1/users?select=id&limit=1`, { headers: H(false) });
  if (!probe.ok) { console.error(`✗ 连不通 / schema 未暴露：${probe.status} ${(await probe.text()).slice(0,200)}\n  → 确认 schema 已建 + PGRST_DB_SCHEMAS 含 skillops + 已 reload`); process.exit(1); }
  console.log('  ✓ PostgREST 可达，skillops.users 可见');

  // FK 顺序：users → skills → versions → api_keys → sessions → evaluations
  const plan = [
    ['users',       vals(platform.users).map(mUser)],
    ['skills',      vals(platform.skills).map(mSkill)],
    ['versions',    vals(platform.versions).map(mVersion)],
    ['api_keys',    vals(platform.apiKeys).map(mKey)],
    ['sessions',    vals(platform.sessions).map(mSession)],
    ['evaluations', readJsonl(path.join(DATA_DIR, 'evaluations.jsonl')).map(mEval)],
  ];

  for (const [table, rows] of plan) {
    try { const r = await upsert(table, rows); console.log(`  ${r.dry ? '·' : '✓'} ${table.padEnd(12)} 源 ${rows.length}${r.dry ? ' (dry, 未写)' : ' → 已写'}`); }
    catch (e) { console.error(`  ✗ ${table}: ${e.message}`); process.exit(1); }
  }

  if (APPLY) {
    console.log('\n— 远端行数校验 —');
    for (const [table, rows] of plan) console.log(`  ${table.padEnd(12)} 源 ${String(rows.length).padStart(5)} | 远端 ${await countRemote(table)}`);
  } else {
    console.log('\n  这是 DRY-RUN。确认源行数无误后，加 APPLY=yes 重跑即真正导入。');
  }
  console.log('Done.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
