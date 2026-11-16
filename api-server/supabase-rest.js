/* supabase-rest.js — 零依赖 PostgREST 客户端 + 字段映射 + 差异同步
 *
 * 跨境架构（国外 app ↔ 国内 Supabase sb.ai.zaowuyun.com）：
 *   - 连接：原生 fetch 打 PostgREST(HTTPS)，service_role，Content-Profile: skillops。
 *   - db.js/store.js 仍是「内存权威」；本模块只做「启动批量拉」+「写穿透差异同步」。
 *   - 读永远走内存(零跨境)；写先改内存再异步穿透(跨境只落低频写)。
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (后端用，绕 RLS)
 */
const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const REST_URL = (process.env.SUPABASE_REST_URL || (URL ? URL + '/rest/v1' : '')).replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '';
const SCHEMA = process.env.SUPABASE_SCHEMA || 'skillops';

export const supabaseConfigured = !!(REST_URL && KEY);

const H = (write) => ({
  apikey: KEY,
  Authorization: 'Bearer ' + KEY,
  'Content-Type': 'application/json',
  [write ? 'Content-Profile' : 'Accept-Profile']: SCHEMA,
});

export async function sbSelectAll(table) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const r = await fetch(`${REST_URL}/${table}?select=*`, {
      headers: { ...H(false), Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok) throw new Error(`select ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function sbUpsert(table, rows) {
  if (!rows.length) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = await fetch(`${REST_URL}/${table}`, {
      method: 'POST',
      headers: { ...H(true), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

export async function sbDelete(table, idField, ids) {
  if (!ids.length) return;
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const list = ids.slice(i, i + BATCH).map(encodeURIComponent).join(',');
    const r = await fetch(`${REST_URL}/${table}?${idField}=in.(${list})`, {
      method: 'DELETE',
      headers: { ...H(true), Prefer: 'return=minimal' },
    });
    if (!r.ok) throw new Error(`delete ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

// ── 字段映射：内存(camelCase) ↔ DB(snake_case)，每集合双向 ──
// 每条： { table, key(内存对象的键字段), to(camel→snake), from(snake→camel) }
export const COLLECTIONS = {
  users: {
    table: 'users', key: 'id',
    to: u => ({ id:u.id, github_id:u.githubId??null, login:u.login, name:u.name??null, avatar:u.avatar??null, email:u.email??null, account_key_hash:u.accountKeyHash??null, anon:!!u.anon, dev:!!u.dev, created_at:u.createdAt??null }),
    from: r => ({ id:r.id, githubId:r.github_id||undefined, login:r.login, name:r.name||'', avatar:r.avatar||'', email:r.email||'', accountKeyHash:r.account_key_hash||undefined, anon:!!r.anon, dev:!!r.dev, createdAt:r.created_at }),
  },
  sessions: {
    table: 'sessions', key: 'token',
    to: s => ({ token:s.token, user_id:s.userId, created_at:s.createdAt??null, expires_at:s.expiresAt }),
    from: r => ({ token:r.token, userId:r.user_id, createdAt:r.created_at, expiresAt:r.expires_at }),
  },
  skills: {
    table: 'skills', key: 'id',
    to: s => ({ id:s.id, owner_id:s.ownerId, slug:s.slug, name:s.name, description:s.description||'', category:s.category||'strategy', visibility:s.visibility||'private', source:s.source||'manual', repo:s.repo||'', sections:s.sections||{examples:'',references:''}, tags:s.tags||[], status:s.status||'active', relations:s.relations||{composeWith:[],dependsOn:[]}, latest_version_id:s.latestVersionId??null, latest_n:s.latestN||0, latest_score:s.latestScore??null, latest_tier:s.latestTier??null, invocations:s.invocations||0, invocations_by:s.invocationsBy||{}, last_invoked_at:s.lastInvokedAt??null, created_at:s.createdAt??null, updated_at:s.updatedAt??null }),
    from: r => ({ id:r.id, ownerId:r.owner_id, slug:r.slug, name:r.name, description:r.description||'', category:r.category||'strategy', visibility:r.visibility||'private', source:r.source||'manual', repo:r.repo||'', sections:r.sections||{examples:'',references:''}, tags:r.tags||[], status:r.status||'active', relations:r.relations||{composeWith:[],dependsOn:[]}, latestVersionId:r.latest_version_id||null, latestN:r.latest_n||0, latestScore:r.latest_score??null, latestTier:r.latest_tier??null, invocations:r.invocations||0, invocationsBy:r.invocations_by||{}, lastInvokedAt:r.last_invoked_at||null, createdAt:r.created_at, updatedAt:r.updated_at }),
  },
  versions: {
    table: 'versions', key: 'id',
    to: v => ({ id:v.id, skill_id:v.skillId, n:v.n, content:v.content||'', note:v.note||'', sms:v.sms??null, created_at:v.createdAt??null }),
    from: r => ({ id:r.id, skillId:r.skill_id, n:r.n, content:r.content||'', note:r.note||'', sms:r.sms||null, createdAt:r.created_at }),
  },
  apiKeys: {
    table: 'api_keys', key: 'id',
    to: k => ({ id:k.id, owner_id:k.ownerId, name:k.name||'default', key_hash:k.keyHash, prefix:k.prefix??null, created_at:k.createdAt??null, last_used_at:k.lastUsedAt??null, ...(k.encryptedKey ? { encrypted_key:k.encryptedKey } : {}) }),
    from: r => ({ id:r.id, ownerId:r.owner_id, name:r.name||'default', keyHash:r.key_hash, prefix:r.prefix||'', createdAt:r.created_at, lastUsedAt:r.last_used_at||null, encryptedKey:r.encrypted_key||undefined }),
  },
  chains: {
    table: 'chains', key: 'id',
    to: c => ({ id:c.id, owner_id:c.ownerId, name:c.name, slug:c.slug??null, steps:c.steps||[], invocations:c.invocations||0, created_at:c.createdAt??null, updated_at:c.updatedAt??null }),
    from: r => ({ id:r.id, ownerId:r.owner_id, name:r.name, slug:r.slug||'', steps:r.steps||[], invocations:r.invocations||0, createdAt:r.created_at, updatedAt:r.updated_at }),
  },
};

// 批量拉一个集合 → 内存 keyed map（{ [key]: camelRow }）
export async function loadCollection(name) {
  const c = COLLECTIONS[name];
  const rows = await sbSelectAll(c.table);
  const map = {};
  for (const r of rows) { const o = c.from(r); map[o[c.key]] = o; }
  return map;
}

// 差异同步：把内存 map 与上次快照比对，只 upsert 变化行 / delete 消失行。
// snapshot: { [key]: jsonString }。返回新 snapshot。纯函数式 diff + 网络写。
export async function syncCollection(name, mem, snapshot) {
  const c = COLLECTIONS[name];
  const next = {}, changed = [];
  for (const k of Object.keys(mem)) {
    const js = JSON.stringify(mem[k]); next[k] = js;
    if (snapshot[k] !== js) changed.push(c.to(mem[k]));
  }
  const removed = Object.keys(snapshot).filter(k => !(k in next));
  if (name === 'apiKeys') {
    // PostgREST requires the same columns on every row in a bulk upsert.
    await sbUpsert(c.table, changed.filter(row => 'encrypted_key' in row));
    await sbUpsert(c.table, changed.filter(row => !('encrypted_key' in row)));
  } else if (changed.length) {
    await sbUpsert(c.table, changed);
  }
  if (removed.length) await sbDelete(c.table, c.key, removed);
  return next;
}

export function snapshotOf(mem) {
  const s = {}; for (const k of Object.keys(mem)) s[k] = JSON.stringify(mem[k]); return s;
}

// ── evaluations 对账：把「文件里的全部评估行」同步成云库的真相（upsert 全部 + 删除文件里没有的）──
// 给 ingest / reseed 等直接改 evaluations.jsonl 的手动脚本在 supabase 模式下收尾调用。
// rows = 原始评估对象数组（须含 id）。dryRun=true 只算差异不写。
const coerceTs = v => { if (v == null || v === '') return null; if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString(); if (/^\d+$/.test(String(v))) { const n = Number(v); return new Date(n > 1e12 ? n : n * 1000).toISOString(); } return v; };
const evalToDbRow = r => ({ id: r.id, source: r.source || null, slug: r.slug || r.slugPath || r.path || null, name: r.name || null, repo: r.repo || null, total: r.total ?? null, max: r.max || 100, tier: r.tier || null, public: !!(r.public || r.source === 'hub'), ts: coerceTs(r.ts), data: r });
// 只新增/更新（给 ingest 这种「只追加」的脚本用，绝不删除）。
export async function upsertEvaluations(rows, { dryRun = false } = {}) {
  const dbRows = (rows || []).filter(r => r && r.id).map(evalToDbRow);
  if (!dryRun && dbRows.length) await sbUpsert('evaluations', dbRows);
  return { upsert: dbRows.length, dryRun };
}
export async function reconcileEvaluations(rows, { dryRun = false } = {}) {
  const withId = (rows || []).filter(r => r && r.id);
  const dbRows = withId.map(evalToDbRow);
  const keep = new Set(dbRows.map(r => r.id));
  const existing = (await sbSelectAll('evaluations')).map(r => r.id);
  const remove = existing.filter(id => !keep.has(id));
  if (!dryRun) {
    if (dbRows.length) await sbUpsert('evaluations', dbRows);
    if (remove.length) await sbDelete('evaluations', 'id', remove);
  }
  return { upsert: dbRows.length, remove: remove.length, dryRun };
}
