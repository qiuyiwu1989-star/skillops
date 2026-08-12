# SkillOps

> AI 技能的人事部（HRD）与可信供给层：对内管理技能全生命周期，对外为造物云能力市场提供可验证的技能卡。
> 造物云出品 · © 邱懿武

**私有仓库**：版本历史 + 异地备份。生产部署走 rsync（非 git），密钥/数据只在服务器侧，从不进库。

## 目录结构

| 目录 | 是什么 | 线上 |
|------|--------|------|
| `api-server/` | 后端：零依赖 Node ESM，SMS 评分引擎 · 技能/版本/调用/技能链 CRUD · 远程 MCP · OAuth 2.1 · Supabase 适配层（内存权威+写穿透） | `skillops.tech/api/`（systemd `skill-api`，:8788） |
| `xiaoneng/` | 前端：管理后台 dashboard · 公开技能页 `/d/` · 接入页 `/connect` · 范例 `/exemplars` · 文档 | `skillops.tech` 静态站 |
| `extension/` | 浏览器插件 v0.1（ChatGPT + Claude 内随手调用/捕获） | `/connect` 可下载 |
| `mcp/` | 独立 MCP 服务实现（`node_modules` 不入库，`npm i` 还原） | 远程 MCP `skillops.tech/api/mcp` |
| `trusted-supply/` | V3.1 可信技能供给 MVP：候选池、许可/安全硬门、人工审核、市场技能卡 | 本地验证，尚未接生产 |
| `dist-src/skillops/` | 便携 CLI 唯一源码：盘点、落户、部署台账、漂移检测 | 可分发标准包 |

V3.4 后的全面升级路线见 `ROADMAP.md`；V3.5 完整技能包 revision 地基见 `specs/007-v35-trusted-skill-packages.md`。下一阶段复核首批真实来源包，再进入 Eval、人类终审和造物云适配。

## 核心理念（脊梁）

运行（引信·调用）→ **管理（核心·护城河）** → 治理（终局）→ 市场（第二幕）。中立/便携是引力中心；评分是钩子。详见 `CLAUDE.md`。

## V3.1 本地验收

```bash
# 可信供给：离线候选 → 审核 → 市场技能卡
node trusted-supply/cli.mjs help

# 内部管理：安全部署 + lock 台账 + 漂移检查
node dist-src/skillops/scripts/skillops.mjs deploy <技能> --to <项目目录>
node dist-src/skillops/scripts/skillops.mjs status --to <项目目录>

# 全部 V3.1 自动化测试
node --test trusted-supply/test/*.test.mjs test/*.test.mjs
```

`trusted-supply` 的抓取结果永远先进入候选池；只有通过格式、来源、许可证、安全门并经人工批准的当前指纹，才能生成市场技能卡。许可证不明确时仅生成来源链接，不复制正文。

## V3.2 白名单试运行与预览

```bash
# 显式采集 GitHub 白名单，只进入候选池
node trusted-supply/cli.mjs collect trusted-supply/examples/whitelist.example.json \
  --store .skillops/trusted-supply.json --report .skillops/collect-report.json

# 从 approved listing 构建只读市场预览
node market-preview/build.mjs --store .skillops/trusted-supply.json
node market-preview/serve.mjs
```

本地示例预览可运行 `node market-preview/demo.mjs` 后打开 `http://127.0.0.1:4173`。采集器不 checkout、不执行仓库代码，远端只允许无凭证的 GitHub HTTPS 来源；本地 git 来源必须显式添加 `--allow-local`。

## 老平台本地启动

```bash
# 后端本地起（file 模式，零依赖、零外部服务）
cd api-server && node server.js        # 默认 STORE_BACKEND=file

# MCP 服务（需依赖）
cd mcp && npm install && node server.js
```

部署与运维细节见 `DEPLOY-CHECKLIST.md`、`api-server/migrations/RUNBOOK.md`。

## 关键文档

- `CLAUDE.md` —— 协作上下文 / 定位 / 术语
- `xiaoneng/_tools/SKILLOPS-V1-RERANK.md` —— v1 定位重排（脊梁）
- `xiaoneng/_tools/SKILLOPS-V2-LEARNINGS.md` —— v2 演进总结
- `api-server/migrations/RUNBOOK.md` —— DB 迁移 / 云库对账 / 部署手册
- `specs/001-v31-trusted-supply.md` —— V3.1 可信供给规格
- `specs/002-v31-skill-runtime-loop.md` —— V3.1 内部部署闭环规格
