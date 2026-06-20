# Memory

> 由 Claude 从协作上下文引导生成（2026-06）。有错/要补尽管说，会持续长。

## Me
邱懿武（qiuyiwu），独立开发者 / 创始人，**造物云**出品。在做一组 AI 产品，主力是 **SkillOps**。沟通用中文，喜欢「判断层」思考（护城河 / 终局 / 为什么不直接问 ChatGPT）。

## People
| Who | Role |
|-----|------|
| **小能 / Ace** | SkillOps 的 AI agent 人格（不是人，是产品里的 agent） |
| **郑刚教授** | 浙大管理学院教授，其方法论被做成 skill（郑刚工具包/视角） |

## Terms（详见 memory/glossary.md）
| 术语 | 含义 |
|------|------|
| **SkillOps** | 主产品：你的私人 AI 技能库（"AI 技能的 1Password"） |
| **SMS** | Skill Management Standard，技能评级，4 支柱 × 10 维，**100 分制**，S/A/B/C/D 段 |
| **技能 / skill** | 提示词 / SKILL.md（对 B 讲"提示词/技能"，不讲 skill/curl） |
| **调用 (invoke)** | 在任何 AI 里随手调起技能 —— **矛尖** |
| **捕获 (capture)** | 把好提示词顺手存进库 —— 建库 on-ramp |
| **便携 / 中立** | 引力中心：跟着你走、不被一家 AI 锁住 |
| **MCP** | Model Context Protocol，技术对接口（服务 A） |
| **A / B** | A = 开发者（Claude/Cursor/agent）；B = 知识工作者（ChatGPT 网页）→ **当前主打 B** |
| **脊梁** | 运行(引信) → 管理(核心/护城河) → 治理/团队(终局) → 市场(第二幕) |

## Projects（详见 memory/projects/）
| Name | What |
|------|------|
| **SkillOps** | skillops.tech · 个人 AI 技能库（评分/版本/调用）· 本期主力 |
| **skill hub** | skill.qiuyiwu.com · 旧的技能展示站（legacy） |
| **造物云** | 出品方 / 品牌；底部署名「造物云出品 · © 邱懿武」 |
| **BookPress** | 深度榨书 agent（另一产品，定位打法可参考） |
| **略懂AI / luedong** | luedong.com · AI 写作平台（另一产品） |
| **InnoLab** | 邱懿武的创新方法论 skill（48 方法） |

## 竞品
- **Capafy**（capafy.ai，2026-05 上线）：闭源 skill 市场 + **服务端执行** + 变现。与我们对立两极（它当运行时+锁定；我们便携+不当运行时）。详见 memory/projects/skillops.md。

## Preferences
- **设计**：博朗 / Rams 配色（cream `#fbfaf6` + 橙 `#e2522a`，Space Grotesk + JetBrains Mono）。**别乱动首页/视觉**，保留博朗配色。
- **定位**：B 优先；运行是矛尖、评分是钩子、**管理是核心护城河**、市场是第二幕；中立/便携是引力中心。
- **安全**：不替我注册账号（GA/百度等账号我自己建给 ID）；生产数据/凭据谨慎。
- **工程**：rsync 部署 → 验证后再上；deploy-when-verified；改动尽量原子、别留半成品。
- **协作节奏**：先想清楚（PRD/一页纸）再动手；大改前确认方向；做完给我看（截图/URL）。

## 关键文档
- `xiaoneng/_tools/SKILLOPS-V1-RERANK.md` — v1 定位重排（脊梁）
- `xiaoneng/_tools/SKILLOPS-EXTENSION-PRD.md` — 浏览器插件 PRD
- `extension/` — 浏览器插件 v0.1（ChatGPT+Claude）
