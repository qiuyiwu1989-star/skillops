# SkillOps

> 你的私人 AI 技能库 —— 「AI 技能的 1Password」。跟着你走、不被任何一家 AI 锁住，任何 AI 里随手调用。
> 造物云出品 · © 邱懿武

**私有仓库**：版本历史 + 异地备份。生产部署走 rsync（非 git），密钥/数据只在服务器侧，从不进库。

## 目录结构

| 目录 | 是什么 | 线上 |
|------|--------|------|
| `api-server/` | 后端：零依赖 Node ESM，SMS 评分引擎 · 技能/版本/调用/技能链 CRUD · 远程 MCP · OAuth 2.1 · Supabase 适配层（内存权威+写穿透） | `skillops.tech/api/`（systemd `skill-api`，:8788） |
| `xiaoneng/` | 前端：管理后台 dashboard · 公开技能页 `/d/` · 接入页 `/connect` · 范例 `/exemplars` · 文档 | `skillops.tech` 静态站 |
| `extension/` | 浏览器插件 v0.1（ChatGPT + Claude 内随手调用/捕获） | `/connect` 可下载 |
| `mcp/` | 独立 MCP 服务实现（`node_modules` 不入库，`npm i` 还原） | 远程 MCP `skillops.tech/api/mcp` |

## 核心理念（脊梁）

运行（引信·调用）→ **管理（核心·护城河）** → 治理（终局）→ 市场（第二幕）。中立/便携是引力中心；评分是钩子。详见 `CLAUDE.md`。

## 上手

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
