-- 0003 · 命名/保存技能链：把一条工作流（有序技能 id 列表）存成可复用资产。
-- 纯加表，可重复执行。在深脑 Supabase 的 postgres 库上以 supabase_admin 执行。
create table if not exists skillops.chains (
  id          text primary key,
  owner_id    text not null references skillops.users(id) on delete cascade,
  name        text not null,
  slug        text,
  steps       jsonb default '[]'::jsonb,   -- 有序的 skill id 数组
  invocations int default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists chains_owner_idx on skillops.chains(owner_id);
grant all on skillops.chains to service_role;
