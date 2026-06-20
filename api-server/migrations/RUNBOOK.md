# SkillOps → 自托管 Supabase 切换 Runbook（照着粘）

跨境：**app 国外（43.159.171.3）↔ DB 国内（sb.ai.zaowuyun.com，深脑同栈 122.51.221.171）**。
适配层已部署（默认 `STORE_BACKEND=file`，生产零影响）。本 Runbook 把它切到 Supabase。
铁律：**只动 `skillops` schema，绝不碰共享库 `zhongtai_app`**。复制不是搬移——文件全程留底，可秒回。

分两边：**A = 国内 Supabase 机（你 / 中台做，我无访问权）**；**B = 国外 SkillOps 机（我能做，等 A 完 + key 到位）**。

---

## A · 国内 Supabase 机（你做）

> 在跑着深脑那套自托管 Supabase 的机器上（122.51.221.171）。端口/目录按你实际，深脑当时是 PG `5433`、docker 目录 `~/deepbrain-supabase`。

### A1. 建 schema（用 supabase_admin / postgres 超级用户）
```bash
# 把 0001-skillops-schema.sql 传上去（或贴进去）。POSTGRES_PASSWORD 在该栈 .env 里。
psql "postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/postgres" -f 0001-skillops-schema.sql
# 期望：CREATE SCHEMA / CREATE TABLE … / GRANT … 无报错
```

### A2. 把 skillops 加进 PostgREST 暴露 + reload
```bash
cd ~/deepbrain-supabase            # 你那套 supabase docker 目录
grep PGRST_DB_SCHEMAS .env          # 看现值，通常 public,storage,graphql_public
# 编辑 .env，在末尾加上 ,skillops，例如：
#   PGRST_DB_SCHEMAS=public,storage,graphql_public,skillops
docker compose restart rest         # 或 docker compose up -d（重载 rest 容器）
```

### A3. 验证暴露成功（在国内机本地测）
```bash
SRK='<SERVICE_ROLE_KEY>'   # 该自托管栈的 service_role key（.env 里）
curl -s "https://sb.ai.zaowuyun.com/rest/v1/users?select=id&limit=1" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Accept-Profile: skillops"
# 期望返回 []（空数组）。若报 "schema must be one of…" → A2 没生效，检查 PGRST_DB_SCHEMAS + 重载。
```

**A 做完后，把 `SERVICE_ROLE_KEY` 贴到国外 SkillOps 机的 `/etc/skill-api/.env`（见 B1），然后告诉我「A 好了」，B 我来跑。**

---

## B · 国外 SkillOps 机（43.159.171.3，我来跑 / 你也可自行粘）

### B1. 注入连接信息到 /etc/skill-api/.env（你贴 key，别发我）
```bash
sudo tee -a /etc/skill-api/.env >/dev/null <<'EOF'
SUPABASE_URL=https://sb.ai.zaowuyun.com
SUPABASE_SERVICE_ROLE_KEY=<把 service_role key 粘这里>
EOF
sudo chmod 600 /etc/skill-api/.env
```
> 先**不要**加 `STORE_BACKEND=supabase`——这一步只是让 .env 有连接信息，给导入器用。app 仍跑 file 模式。

### B2. 灌数据：先干跑看行数，再真灌
```bash
cd /opt/skill-api
set -a; . /etc/skill-api/.env; set +a     # 载入 SUPABASE_URL / KEY 到环境
node import-to-supabase.mjs                # DRY-RUN：只读 + 连通自检 + 报源行数，不写
APPLY=yes node import-to-supabase.mjs      # 确认行数无误后真导入；写完自动对拍远端行数
```

### B3. 影子对拍（不切生产，临时端口起一个 supabase 模式实例验证）
```bash
cd /opt/skill-api; set -a; . /etc/skill-api/.env; set +a
STORE_BACKEND=supabase PORT=8799 node server.js &   # 临时实例
sleep 3
curl -s http://127.0.0.1:8799/registry | python3 -c 'import sys,json;print("registry",len(json.load(sys.stdin)["items"]))'
curl -s http://127.0.0.1:8799/evaluations/hub | python3 -c 'import sys,json;print("hub",len(json.load(sys.stdin)["items"]))'
curl -s http://127.0.0.1:8799/evaluations/discovered | python3 -c 'import sys,json;print("discovered",len(json.load(sys.stdin)["items"]))'
# 与线上 file 模式的数对得上 → OK。kill 掉临时实例：
kill %1
```

### B4. 正式切换
```bash
echo 'STORE_BACKEND=supabase' | sudo tee -a /etc/skill-api/.env
sudo systemctl restart skill-api
sudo journalctl -u skill-api -n 5 --no-pager | grep -E 'backend=supabase|store=supabase'   # 确认
```
切完冒烟：登录、列技能、新建/存版本/评分、registry、/d/ fork、导出——读秒开（走内存），写穿透到国内库。

### B5. 回滚（任何不对，秒回）
```bash
sudo sed -i '/^STORE_BACKEND=supabase$/d' /etc/skill-api/.env
sudo systemctl restart skill-api    # 回 file 模式，文件镜像一直在，零损失
```

---

## 辅助脚本在 supabase 模式下的行为（已闭合）
两个直接改 `evaluations.jsonl` 的手动脚本现在会**自动回写云库**（须带 `STORE_BACKEND=supabase` 跑）：
- `ingest-github.mjs` — 只新增 github 行 → 收尾 `upsertEvaluations(本轮新增)`（只 upsert，不删）。
- `reseed-hub-from-catalog.mjs` — 重写整组 hub 行 → 收尾 `reconcileEvaluations(全量)`（upsert 全部 + 删掉文件里已不存在的旧 hub id）。

```bash
# 在 /opt/skill-api 上、带 supabase 环境跑（systemd 的 EnvironmentFile 已含 SUPABASE_*）
set -a; source /opt/skill-api/.env; set +a
STORE_BACKEND=supabase node ingest-github.mjs          # → 日志末尾 "☁ 已回写云库 evaluations"
STORE_BACKEND=supabase node reseed-hub-from-catalog.mjs # → 日志末尾 "☁ 已对账云库"
sudo systemctl restart skill-api                        # ⚠️ 内存权威：必须重启，服务才从云库重新拉到新行
```
缺 `SUPABASE_URL/KEY` 或非 supabase 模式 → 只写本地文件（与旧行为一致，零网络）。云库写失败不影响本地文件已写成功，日志会 `✗` 报错。
> 仍可用老路：`import-to-supabase.mjs` 补增量（但它**只 upsert 不删**，reseed 删掉的旧 hub 行它清不掉 → reseed 请用脚本自带的对账）。

## 已知边界（迁移后补）
- `versions.content`（全文）随库增大可改懒加载（启动只拉元数据）。MVP 全量。
