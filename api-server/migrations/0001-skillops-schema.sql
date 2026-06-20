-- SkillOps → 自托管 Supabase 迁移 · schema DDL (0001)
-- 在中台 Supabase 的 Postgres 上以 supabase_admin（或 postgres 超级用户）执行一次。
-- 铁律：只建独立 schema `skillops`，绝不碰共享库 zhongtai_app / 其它 schema。
--
-- 执行后还需两步（见文末）：① 把 skillops 加进 PostgREST 暴露 schema ② reload。

create schema if not exists skillops;

-- ── users ──
create table if not exists skillops.users (
  id               text primary key,
  github_id        text,
  login            text unique not null,
  name             text,
  avatar           text,
  email            text,
  account_key_hash text,
  anon             boolean default false,
  dev              boolean default false,
  created_at       timestamptz default now()
);

-- ── sessions ──
create table if not exists skillops.sessions (
  token      text primary key,
  user_id    text not null references skillops.users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_expires_idx on skillops.sessions(expires_at);

-- ── skills ──
create table if not exists skillops.skills (
  id                text primary key,
  owner_id          text not null references skillops.users(id) on delete cascade,
  slug              text not null,
  name              text not null,
  description       text default '',
  category          text default 'strategy',
  visibility        text default 'private',
  source            text default 'manual',
  repo              text default '',
  sections          jsonb default '{"examples":"","references":""}'::jsonb,
  tags              jsonb default '[]'::jsonb,
  status            text default 'active',
  relations         jsonb default '{"composeWith":[],"dependsOn":[]}'::jsonb,
  latest_version_id text,
  latest_n          int default 0,
  latest_score      numeric,
  latest_tier       text,
  invocations       int default 0,
  last_invoked_at   timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique(owner_id, slug)
);
create index if not exists skills_owner_idx on skillops.skills(owner_id);
create index if not exists skills_visibility_idx on skillops.skills(visibility);

-- ── versions ── (删 skill 级联删版本)
create table if not exists skillops.versions (
  id         text primary key,
  skill_id   text not null references skillops.skills(id) on delete cascade,
  n          int not null,
  content    text default '',
  note       text default '',
  sms        jsonb,
  created_at timestamptz default now(),
  unique(skill_id, n)
);

-- ── api_keys ──
create table if not exists skillops.api_keys (
  id           text primary key,
  owner_id     text not null references skillops.users(id) on delete cascade,
  name         text default 'default',
  key_hash     text not null,
  prefix       text,
  created_at   timestamptz default now(),
  last_used_at timestamptz
);
create index if not exists api_keys_hash_idx on skillops.api_keys(key_hash);

-- ── evaluations ── (异构：少量索引列 + data jsonb 兜底)
create table if not exists skillops.evaluations (
  id      text primary key,
  source  text,
  slug    text,
  name    text,
  repo    text,
  total   int,
  max     int default 100,
  tier    text,
  public  boolean default false,
  ts      timestamptz,
  data    jsonb not null     -- 整行原样；store 派生逻辑照旧
);
create index if not exists eval_source_idx on skillops.evaluations(source);
create index if not exists eval_slug_idx   on skillops.evaluations(slug);

-- ── 权限：service_role 全权（SkillOps 后端用它，绕 RLS；我们有自己的鉴权）──
grant usage on schema skillops to anon, authenticated, service_role;
grant all on all tables in schema skillops to service_role;
grant all on all sequences in schema skillops to service_role;
alter default privileges in schema skillops grant all on tables to service_role;
alter default privileges in schema skillops grant all on sequences to service_role;
-- 不开 RLS：仅 service_role 经后端访问；anon/authenticated 不授任何表权限（PostgREST 下默认拒）。

-- ════════════════════════════════════════════════════════════════════
-- 执行后（在 Supabase docker 目录）：
--   1) .env 把 skillops 加进 PostgREST 暴露：
--        PGRST_DB_SCHEMAS=public,storage,graphql_public,skillops
--   2) 重载：docker compose restart rest   （或 kong/rest 视栈而定）
--   验证：curl -s "$SUPABASE_URL/rest/v1/users?select=id&limit=1" \
--          -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--          -H "Accept-Profile: skillops"   → 应返回 [] 而非 schema 错误
-- ════════════════════════════════════════════════════════════════════
