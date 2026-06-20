# SkillOps 数据库迁移方案 · 文件存储 → 自托管 Supabase

> 状态：**方案稿（不碰生产）**。2026-06。决策：你已选「先出迁移方案，不碰生产」。
> 目标库：**已存在**的自托管 Supabase —— `sb.ai.zaowuyun.com`（造物云中台，与「深脑」同栈）。
> 本文只设计，不执行；任何生产改动 / 凭据使用都需你那一次明确授权。

---

## 0. 一句话结论

SkillOps 现在用的是**自研文件存储**（`platform.json` + `evaluations.jsonl`），不是 Supabase 云。所以这**不是**「Supabase 云 → 自托管」的 `pg_dump` 搬迁，而是 **「文件存储 → Postgres 表」的存储层改造 + 一次性导入**。Supabase 那套（auth/RLS/pgvector/storage）我们**都用不上**——SkillOps 有自己的账号体系（account key + session + sha256）。所以走 skill 里的 **路 B 变体：在中台 Supabase 里开一个独立 schema `skillops`，用最小权限角色，从 SkillOps 后端连进去**。

铁律（沿用 skill）：**绝不碰中台共享库 `zhongtai_app`**；SkillOps 自己一个 schema、一个 DB 角色、权限最小化。

---

## 1. 现状盘点（从代码，非生产）

### 1.1 现在的存储
| 文件 | 内容 | 读写者 |
|---|---|---|
| `/var/lib/skill-api/platform.json` | `users` / `sessions` / `skills` / `versions` / `apiKeys` 五个集合，整文档原子落盘（temp+rename），内存里建索引 | `db.js` |
| `/var/lib/skill-api/evaluations.jsonl` | 评估行（`source` ∈ hub/github/user/batch），每行一条 JSON | `store.js`（读）、`server.js`/`ingest-github.mjs`（append）、迁移/prune 脚本（重写） |

### 1.2 数据形状（迁移要建的表）
- **users**：`id, githubId, login(uniq), name, avatar, email, accountKeyHash, anon, dev, createdAt`
- **sessions**：`token(PK), userId, createdAt, expiresAt`
- **skills**：`id, ownerId, slug, name, description, category, visibility, source, repo, sections{examples,references}, tags[], status, relations{composeWith[],dependsOn[]}, latestVersionId, latestN, latestScore, latestTier, invocations, lastInvokedAt, createdAt, updatedAt`（`(ownerId,slug)` 唯一）
- **versions**：`id, skillId, n, content, note, sms{…}, createdAt`（`(skillId,n)` 唯一，删 skill 级联）
- **apiKeys**：`id, ownerId, name, keyHash, prefix, createdAt, lastUsedAt`
- **evaluations**：异构行，公共字段 `id, ts, source, public, name, repo, slug/slugPath/path, total, max, tier, dimensions, summary, strengths, suggestions, contentHash, ipHash, model, stars, license, smsVersion, category`

### 1.3 关键约束（决定架构）
- **跨服务器**：SkillOps API（部署机 `43.159.171.3`）与 Supabase（`sb.ai.zaowuyun.com` / 深脑机 `122.51.221.171`）**不是同一台**。Supabase 的 Postgres 按 skill 安全红线**只听 `127.0.0.1`**，外部连不到 5432/5433。→ **跨服务器只能走 Kong 后的 HTTPS（PostgREST），或建私网/隧道直连 PG**。
- SkillOps 后端已能出网（调 GitHub / LLM），**到 `sb.ai.zaowuyun.com` 的 HTTPS 出站可用**（ICP 坑已被这个备案子域名解决，无需再处理）。

---

## 2. 架构决策

### 2.1 连接方式（二选一，推荐 A）

| | **A. supabase-js（PostgREST，service_role）over HTTPS** ✅推荐 | **B. 直连 PG（node-postgres）经私网/隧道** |
|---|---|---|
| 跨服务器 | 天然支持（HTTPS 到 Kong），**不开新端口** | 需 WireGuard/SSH 隧道把 PG 私网暴露给 `43.159.171.3` |
| 合规 | 符合 skill「唯一公网入口是 Kong」 | 需额外网络工程，注意别把 5432 bind 到 0.0.0.0 |
| 事务 | PostgREST 无多语句事务（用 RPC/单表 upsert 规避） | 原生 SQL/事务 |
| 性能 | 每次调用一个 HTTP 往返；SkillOps 流量低，够用 | PG 协议更快 |
| 落地速度 | 快（只加一个 client + schema 暴露配置） | 慢（先搭隧道） |
| **结论** | **一期就用 A**：最快、零新增暴露、ICP 干净 | 二期若延迟/事务有压力再上 |

> A 的前置：在中台 Supabase 的 `.env` 把 `skillops` schema 加进 PostgREST 暴露列表（`PGRST_DB_SCHEMAS=public,storage,graphql_public,skillops`），并给 `service_role` 授 `skillops` schema 的 usage + 表权限。`service_role` key **绕过 RLS**，SkillOps 作为可信后端用它，**不依赖 RLS**（我们有自己的鉴权）。

### 2.2 存储层抽象（核心改造思路）
SkillOps 的存储已经很干净地集中在 `db.js`（平台数据）+ `store.js`（评估）两个模块。**不要散改业务代码**，而是：

1. 把 `db.js` / `store.js` 的导出函数定义成一个**存储接口**（已经是了 —— `listSkillsByOwner`、`createSkill`、`addVersion`、`discoveredDataset`…）。
2. 抽出两套实现：`store/file.js`（现有逻辑原样搬过去）、`store/supabase.js`（同名函数，PostgREST 实现）。
3. 用环境变量 `STORE_BACKEND=file|supabase` 在启动时选实现。**业务代码（platform.js / server.js）一行不用改。**
4. 好处：**可双写、可影子读、可秒回**——回滚就是把 `STORE_BACKEND` 改回 `file` 重启。

---

## 2.5 跨境架构（确定）—— 国外 app ↔ 国内 DB

拓扑已确认：**SkillOps app 在国外，Supabase 在国内**（sb.ai.zaowuyun.com，备案子域名），两台机。深脑跑通的是「app 经备案域名 + PostgREST/HTTPS 接自托管 Supabase」——但深脑 app 与 DB 同区、无跨境延迟。SkillOps 跨境，所以**复用深脑连接路 + 加一层「内存权威 / 写穿透」把延迟挡在门外**：

1. **连接 = PostgREST over HTTPS → `sb.ai.zaowuyun.com`**（深脑同款）。
   - 不走跨境直连 PG：慢、GFW 干扰长连接、且 PG 只听 127.0.0.1（安全红线）。HTTPS:443 + 备案域名最稳、ICP 干净。
   - 用 `service_role`（绕 RLS；我们有自己的鉴权）。零依赖：原生 fetch 打 PostgREST（与现有后端同风格），不引 supabase-js。

2. **架构 = 保留 `db.js` 现有「内存权威」模型，只换两端** —— 这正好把跨境延迟挡掉：
   - **启动**：批量拉全部 `skillops` 表进内存（几个 GET，一次跨境批量，~1–2s）。
   - **读**：全走内存 → **零跨境延迟**（列表 / registry / openSkill 照样秒开）。
   - **写**：先改内存（请求立即返回）+ **写穿透** upsert 到 Supabase（跨境 ~250ms 只落在低频写上：建号 / 存版本 / 评分）。
   - 净效果：`db.js` 业务逻辑**一行不改**，只把「读/写本地 JSON」换成「启动批量拉 / 写穿透」。比"逐操作 PostgREST 查询"既快又少改。

3. **韧性 = 本地 JSON 降级为镜像 / 冷备**（跨境会偶尔抖，app 不能因此宕）：
   - 写穿透失败 → 重试队列；本地镜像仍有该写，连通恢复后对账补写。
   - 启动连不上 Supabase → 回落本地镜像（降级运行，不宕）。
   - 过渡期**双写**（Supabase + 文件）；稳定后 Supabase 为准、文件冷备。SkillOps 单实例、唯一写者 → 内存权威无并发冲突。

4. **规模兜底**：`versions.content`（全文）随库增大时，启动只拉版本元数据、正文按需取（lazy）。MVP 阶段先全量（与现 `db.js` 行为一致）。

> 切换 / 回滚同 §5：`STORE_BACKEND=supabase` 开关 → 影子对拍 → 切；不对改回 `file` 秒回。

## 3. Schema 设计（`skillops` schema · DDL 草案）

```sql
create schema if not exists skillops;
-- 专用最小权限角色（执行时改密码）；不用 postgres 超级用户
-- create role skillops_app login password '***';
-- grant usage on schema skillops to skillops_app, service_role;

create table skillops.users (
  id text primary key,
  github_id text, login text unique not null, name text, avatar text, email text,
  account_key_hash text, anon boolean default false, dev boolean default false,
  created_at timestamptz default now()
);
create table skillops.sessions (
  token text primary key,
  user_id text not null references skillops.users(id) on delete cascade,
  created_at timestamptz default now(), expires_at timestamptz not null
);
create index on skillops.sessions(expires_at);

create table skillops.skills (
  id text primary key,
  owner_id text not null references skillops.users(id) on delete cascade,
  slug text not null, name text not null, description text default '',
  category text default 'strategy', visibility text default 'private',
  source text default 'manual', repo text default '',
  sections jsonb default '{"examples":"","references":""}'::jsonb,
  tags jsonb default '[]'::jsonb, status text default 'active',
  relations jsonb default '{"composeWith":[],"dependsOn":[]}'::jsonb,
  latest_version_id text, latest_n int default 0,
  latest_score numeric, latest_tier text,
  invocations int default 0, last_invoked_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique(owner_id, slug)
);
create index on skillops.skills(owner_id);
create index on skillops.skills(visibility);

create table skillops.versions (
  id text primary key,
  skill_id text not null references skillops.skills(id) on delete cascade,
  n int not null, content text default '', note text default '',
  sms jsonb, created_at timestamptz default now(),
  unique(skill_id, n)
);

create table skillops.api_keys (
  id text primary key,
  owner_id text not null references skillops.users(id) on delete cascade,
  name text default 'default', key_hash text not null, prefix text,
  created_at timestamptz default now(), last_used_at timestamptz
);
create index on skillops.api_keys(key_hash);

-- 评估：异构 → 少量索引列 + data jsonb 兜底
create table skillops.evaluations (
  id text primary key,
  source text, slug text, name text, repo text,
  total int, max int default 100, tier text,
  public boolean default false, ts timestamptz,
  data jsonb not null            -- 整行原样，store.js 的派生逻辑照旧
);
create index on skillops.evaluations(source);
create index on skillops.evaluations(slug);
```

> 设计取舍：`tags`/`relations`/`sections`/`sms` 用 `jsonb` 直存（和现有 JS 结构 1:1，零转换）。`evaluations` 因为字段随 source 漂移，用「少量索引列 + `data jsonb` 全量」最稳，`store.js` 的 `hubDataset/discoveredDataset/recent` 改成 `select ... where source=...` 后在 JS 里跑现有派生逻辑。

---

## 4. 一次性导入器（`scripts/import-to-supabase.mjs`）

只读现有文件 → upsert 进 PG，**幂等可重跑**：

1. 读 `platform.json` → 五集合逐表 upsert（`users → sessions → skills → versions → api_keys`，按外键顺序）。
2. 读 `evaluations.jsonl` → 逐行 upsert 进 `evaluations`（`id` 做主键去重；老行若无 `id` 用 `sha256(行)` 兜底生成）。
3. **行数 / 关键计数校验**：导入后比对每表行数与源文件条数，`skills.latest_*` 与 `versions` 对齐。
4. 用 `service_role` 跑（绕 RLS）；**只读源文件、只写 `skillops` schema**，不碰其它 schema。

> 注意辅助写入者：`ingest-github.mjs`、`reseed-hub-from-catalog.mjs`、`migrate-scores-100.mjs`、`rotate-account-key.mjs` 现在都直接读写文件。切到 Supabase 后这些脚本要改成走 store 层（或新增 PG 版）。一期可先只迁运行时读写，脚本二期跟上（迁移期间它们仍可对文件操作，导入器重跑即可同步）。

---

## 5. 分阶段切换（每步可回滚，零数据损失）

| 阶段 | 动作 | 回滚 |
|---|---|---|
| **P0 准备** | 中台开 `skillops` schema + 最小权限角色 + PostgREST 暴露 schema；`.env` 注入 `SUPABASE_URL/ANON/SERVICE_ROLE`（chmod 600） | 删 schema |
| **P1 建层** | 写 `store/supabase.js` + 抽 `store/file.js`，加 `STORE_BACKEND` 开关。默认仍 `file`，生产行为不变 | 无影响（默认 file） |
| **P2 灌数据** | 跑导入器，把现有文件全量导入 PG；校验行数 | 清空 `skillops` 表重来 |
| **P3 影子验证** | 临时实例设 `STORE_BACKEND=supabase`，跑只读冒烟（登录、列技能、registry、discovered、评分卡），与文件版对拍 | 关实例 |
| **P4 切换** | 生产 `STORE_BACKEND=supabase` 重启；切换前最后再跑一次导入器追平增量 | 改回 `file` 重启（**秒回**） |
| **P5 退役** | 稳定运行 N 天后，文件存储留作冷备，停止双写 | 文件仍在，可随时切回 |

> 迁移是**复制不是搬移**：文件存储全程保留到你确认无误。

---

## 6. 必踩坑（适配到本项目）

1. **ICP 墙**：已解 —— 用的就是备案子域名 `sb.ai.zaowuyun.com`，国内 HTTPS 通（深脑已验证）。新增 SkillOps 不引入新域名，无新坑。
2. **跨服务器连通**（新的头号坑）：PG 只听 127.0.0.1，`43.159.171.3` 连不到 → 一期走 PostgREST(HTTPS)，**不开 PG 公网口**。若选直连 PG，必须先建私网/隧道。
3. **PostgREST 不暴露自定义 schema**：默认只暴露 `public` 等 → 必须把 `skillops` 加进 `PGRST_DB_SCHEMAS` 并授权，否则 supabase-js 调 `skillops` 表 404。
4. **service_role 权限**：给 `skillops` schema 的表 usage + CRUD；**绝不**给它碰 `zhongtai_app` / 其它 schema。
5. **辅助脚本仍写文件**：迁移期 `ingest` 等仍 append 文件 → 切换前用导入器追平增量（P4），并把脚本排进二期改造。
6. **session 过期清理**：文件版在读时惰性删过期 session；PG 版用 `expires_at` 索引 + 定时清理（或读时过滤 `expires_at > now()`）。

---

## 7. 安全红线（沿用 skill，逐条守）

- **不替你输/存任何凭据**：`SERVICE_ROLE_KEY`、DB 角色密码只进服务器 `/etc/skill-api/.env`（chmod 600），**不进仓库、不进日志、不打印进聊天**。要 key 时你自己贴到服务器，或 server→server 直传，不经本地中转。
- 生产 `.env` 改写、建 schema、切 `STORE_BACKEND`、跑导入器 —— 每一步都要你**那一次明确授权**（「执行」是明确动词）。
- 不碰 `zhongtai_app`；`skillops` 角色权限最小化；PG/Studio 继续只听 127.0.0.1。

---

## 8. 执行前需要你确认 / 提供（到执行那一步再给）

1. **连通拓扑**：SkillOps API（43.159.171.3）与 Supabase（sb.ai.zaowuyun.com）确是两台机吗？有无私网可走？（定 PostgREST vs 直连 PG）
2. **中台权限**：能否在这套 Supabase 上新建 schema + 角色 + 改 PostgREST 暴露配置？由你还是中台管理员操作？
3. **凭据**（执行时你贴到服务器，不发我）：`SUPABASE_URL`(=https://sb.ai.zaowuyun.com)、`ANON_KEY`、`SERVICE_ROLE_KEY`。
4. **数据量级**确认（决定导入器批大小）：users/skills/versions/evaluations 行数。

## 9. 工作量 & 排期（估）

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0+P1 | schema + 角色 + PostgREST 暴露；store 抽象 + supabase.js 实现 | ~1–1.5 天 |
| P2 | 导入器 + 校验 | ~0.5 天 |
| P3 | 影子冒烟对拍 | ~0.5 天 |
| P4 | 生产切换 + 增量追平 + 验收 | ~0.5 天（含观察） |
| 二期 | ingest/脚本改走 store 层；按需上直连 PG | 另议 |

## 10. 验收清单（切换后）

- [ ] 旧账号能登录（account key），session 有效
- [ ] 列技能 / 打开 / 编辑保存（新版本）/ 评分 / 培训 / 版本回滚 / 维度 diff
- [ ] 公开技能：registry 出现、`/u/?id=` 公开页、agent curl 拉取
- [ ] 发现库：`/d/` 评分卡、`复制到我的库` fork
- [ ] 导出库 zip/json、标签/组合关系/归档/批量
- [ ] 行数与切换前一致；文件冷备保留；`STORE_BACKEND=file` 可秒回
```
