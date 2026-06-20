-- 0002 · 调用分桶：按来源记调用数（copy / inject / mcp / api）
-- 纯加列，可重复执行。在深脑 Supabase 的 postgres 库上以 supabase_admin 执行。
alter table skillops.skills add column if not exists invocations_by jsonb default '{}'::jsonb;
