# SkillOps MCP · v0.1（技术对接口·服务 A）

把你的私人 **SkillOps 技能库**接进 Claude Desktop / Claude Code / Cursor / 任何 MCP 客户端。
**检索型**：取出你自己的技能内容，跑在**你自己的 AI** 里 —— 不替你执行、不锁定（反 Capafy）。

## 工具
| 工具 | 作用 |
|------|------|
| `list_my_skills` | 列出我的技能（名称/段位/分/简介/id） |
| `get_skill(query)` | 取某技能完整内容（名称或 id），拿来执行当前任务；自动回传一次调用埋点 |
| `search_skills(q)` | 搜公开市场（官方/社区/GitHub）发现现成技能 |

## 安装
```bash
cd mcp
npm install
```
拿一个 **API Key**：https://skillops.tech/dashboard/ → 顶栏「API Key」→ 生成（`xn_…`）。

## 配置（任选你的客户端）

### Claude Desktop
编辑 `claude_desktop_config.json`（设置 → Developer → Edit Config）：
```json
{
  "mcpServers": {
    "skillops": {
      "command": "node",
      "args": ["/Users/qiu/Documents/qiuyiwu.com/mcp/server.js"],
      "env": { "SKILLOPS_API_KEY": "xn_你的key" }
    }
  }
}
```
重启 Claude Desktop。

### Claude Code
```bash
claude mcp add skillops -e SKILLOPS_API_KEY=xn_你的key -- node /Users/qiu/Documents/qiuyiwu.com/mcp/server.js
```

### Cursor
`~/.cursor/mcp.json` 里加同样的 `mcpServers.skillops` 段。

## 用起来
连上后直接说：
- “**列出我的技能**” → 调 `list_my_skills`
- “**用我的 jtbd 分析技能**分析这段访谈” → 自动 `get_skill("jtbd")` 取内容并执行
- “帮我**在市场找个写小红书的技能**” → `search_skills("小红书")`

## 边界 / 后续
- v0.1 = 工具（agent 主动拉）。**MCP prompts**（在 `/` 菜单里直接选技能注入）是后续增强。
- 鉴权用 API Key（env）。技能内容只在你的客户端里使用，本服务器不存任何东西。
- 环境变量 `SKILLOPS_API` 可覆盖 API 基址（默认 `https://skillops.tech/api`）。
