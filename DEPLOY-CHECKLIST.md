# Deploy Checklist · SkillOps（skillops.tech）

> 定制自实际部署流程（rsync → VPS + systemd）。**每次部署前过一遍。** 部署者：邱懿武
> 没有 CI / 没有自动化测试 → 用 `node --check` / `python ast` + 本机 `curl --resolve` 烟测代替。

## 0. 先认清这次部署的类型
- [ ] **仅前端**（HTML/CSS/JS/analytics）→ 只 rsync web 根，**不重启** skill-api
- [ ] **含后端**（`api-server/*.js|*.mjs`）→ rsync `/opt/skill-api` + **重启** skill-api
- [ ] **含数据迁移 / reseed**（改 platform.json / evaluations.jsonl）→ **停服 → 迁移 → 启服**（见 §5）

## 1. Pre-Deploy（本地，部署前）
- [ ] 改动的 `.js/.mjs`：`node --check <file>` 全过
- [ ] 改动的 `.py`：`python3 -c "import ast; ast.parse(open(f).read())"` 全过
- [ ] 内嵌 JS 的 HTML：抽出 `<script>` 块 `node --check`（控制台/插件页易错）
- [ ] grep 残留：换算/重命名类改动全站搜旧值（如曾经的 `/50`、旧术语），确认 0 残留
- [ ] 确认**目标站点根**：skillops.tech → `/var/www/html/skillops`；skill hub → `/var/www/html/skill`（**别搞反、别覆盖错位置**）
- [ ] 确认**精确路径**：多文件同名（如多个 `index.html`）必须 rsync 到各自完整路径，**别用同目录批量**（曾把 demo 内容刷进首页）
- [ ] （可选·回滚保险）`git add -A && git commit`（本会话一直没提交；至少在大改前打个 checkpoint）
- [ ] 若动数据：先在服务器 `cp platform.json platform.json.bak-pre<x>` + `evaluations.jsonl` 同样备份

## 2. Deploy
- [ ] rsync 模板：`rsync -avc --rsync-path="sudo rsync" -e "ssh -i ~/.ssh/id_ed25519_skill_deploy" SRC ubuntu@43.159.171.3:DEST`
- [ ] 后端：rsync 改动文件 → `/opt/skill-api/` → `sudo systemctl restart skill-api && sleep 2 && systemctl is-active skill-api`（须 `active`）
- [ ] 前端：rsync 到正确 web 根（必要时 `/s/` 同步到 skillops + skill 两个根）
- [ ] 新目录：rsync 文件到不存在的目录会失败 → 先 `ssh ... 'sudo mkdir -p <dir>'`
- [ ] `&&` 串联陷阱：上一步 rsync 没传成功也可能让后续步骤误判 —— 用 `-avc`（checksum）确认真传了

## 3. Verify（本机 on-box，因为沙箱代理够不到 skillops 证书）
- [ ] `R="--resolve skillops.tech:443:127.0.0.1"`
- [ ] 改动页 HTTP 200：`curl -s -o /dev/null -w "%{http_code}" $R https://skillops.tech/<path>`
- [ ] grep 实测改动真生效：`curl -s $R https://skillops.tech/<path> | grep -o "<期望串>"`
- [ ] 后端端点：可达 + 鉴权正确（如未带 key 返回 401，不是 404/500）
- [ ] 数据类：API 返回值符合预期（如 `max:100`、`invocations` 字段、段位正确）
- [ ] 百度统计：`analytics.js` 含 ID + 页面引入（实时数据去 tongji.baidu.com 实时访客确认）

## 4. Post-Deploy
- [ ] 更新 `TASKS.md`（move 到 Done）/ changelog（如有）
- [ ] 两个站点根一致性（若 /s/ 等双根内容）
- [ ] 给邱懿武看（截图 / URL）—— 视觉改动尤其
- [ ] 关掉相关 task

## 5. 数据迁移 / reseed 专用（高危）
- [ ] **停服**：`sudo systemctl stop skill-api`（db.js/store.js 内存缓存，不停会被覆盖）
- [ ] 备份 `platform.json` + `evaluations.jsonl`
- [ ] 跑迁移脚本（幂等护栏，如 `max===50` 才 ×2）→ reseed（如 `reseed-hub-from-catalog.mjs`）
- [ ] **启服**：`sudo systemctl start skill-api`（用 `;` 不用 `&&`，保证总会启回来）
- [ ] 原子性：跨全站的换算（如 50→100）必须引擎+数据+显示一次性上，**绝不留 50/100 混杂**

## 6. Rollback Triggers（先定好，别临场慌）
- skill-api `is-active` ≠ active / 页面 5xx → 重启；不行则 rsync 回上一版 / 还原 `.bak`
- 评分出现 50/100 混杂 → 立即回滚（换算没原子）
- **vhost 被覆盖**（首页变 stub / 证书错 / `/api` 404）→ 这是历史坑，nginx 配置已 `chattr +i` 锁；若复发，恢复 `/etc/nginx/sites-available/skillops.tech` 指向 `/var/www/html/skillops`
- 数据迁移出错 → 停服 → 还原 `.bak-pre*` → 启服

## 7. 非服务器部署（即将到来，流程不同）
- **浏览器插件**（`extension/`）：不走 rsync。开发 = Chrome `加载已解压扩展`；发布 = 打包 + Chrome Web Store 审核（隐私页 + 权限说明）
- **MCP**（待建）：发布方式取决于形态（npm 包 / 托管 endpoint / `.dxt` 一键扩展）
