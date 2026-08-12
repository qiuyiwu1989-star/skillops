# SkillOps · 项目卡

> AI 每次开工第一个看这里，再看 `谱/进度.md`（到哪了）、`谱/决定.md`（拍过什么板）。
> 最后更新 2026-07-29。**注意：2026-06 的旧定位（"1Password"/主打 B）已被 V3 推翻，见下。**

## 这是什么

**SkillOps = AI 技能的人事部（HRD）。** 把每个 skill 当员工管：招聘 → 落户 → 调度 → 考核 → 培训 → 绩效 → 入编 → 退役。

主人：**邱懿武**（造物云出品），中文沟通，习惯"判断层"思考（护城河 / 终局 / 为什么不直接问 ChatGPT）。
他是**拍板者，不是操作者**——不亲手敲命令（有 14 天 0 次的实测）。**agent 操作，人拍板。**

## 谁在用

**A 类（agent-native builder）优先**——2026-07 从"主打 B（ChatGPT 网页知识工作者）"改判，理由见决定 D08。
种子路径：主人自己（41 个真实技能已入册）→ 他的 builder 圈 → **训练营/学员**（天然的微型组织 = 组织治理层的自带试验田）。

## 现在做到哪

**P1.5 已完成**：CLI（盘点/落户/体检/周报/遥测）+ 小能技能包 + 便携标准包 v1.0.0。
**V3.3 本地开发中**：P2 deploy 台账/漂移闭环、可信供给、GitHub 白名单与 SkillHub 外部候选源已完成；当前按 Spec 005 并行建设 SMS v2.0 十维评分、外部 YAML 兼容、市场发现/详情和受保护安装闭环，仍未获准接生产。

## 当前档位

**G3 生产档**：已有线上服务、外部输入、安全与许可边界。新功能先写 spec，完成以自动化测试为准；本地开发不等于获准部署生产。

## 六条铁律

1. **file-as-truth** —— 真身是用户各处的 SKILL.md 文件夹，索引/数据库永远只是缓存。任何"复制进我的库"都制造第二份拷贝，**分裂即死亡**。
2. **不当运行时** —— 不做生产工作负载的运行时，技能永远跑在用户自己的 AI 里。评级是**质检台架**（考核≠替他上班）。
3. **agent 操作，人拍板** —— 把操作台发给主人＝设计错误。
4. **老平台冻结** —— `api-server/`、`xiaoneng/`、线上 skillops.tech 在 P3 前**一行不改**；新代码只长新目录。
5. **绝不删除技能文件** —— 退役 = 标 `status: retired`，可逆。
6. **动生产先问** —— 服务器、线上站点、花钱的批量 LLM 调用，一律请示。

## 绝对不能碰

- **密钥/密码**：`.env`、service_role key、服务器密码——不进 git、不打印到对话、**不用聊天里贴的密码去 SSH**。
- **生产**：两台机（Web/API 国外 + 自托管 Supabase 国内），rsync 部署；nginx `skillops.tech` 配置是 **chattr +i 不可变**（改前 `-i`、改完复 `+i`）。
- **视觉/品牌**：Rams/Braun（cream `#fbfaf6` + 橙 `#e2522a`，Space Grotesk + JetBrains Mono）。**品牌色锁定，别乱动首页视觉。**
- **账号**：不替主人注册任何账号。

## 东西都在哪

| 位置 | 是什么 |
|---|---|
| `V3-ARCHITECTURE.md` | **宪法**：七面承重墙 + 四条修正案 + 五层架构 + 路线图 |
| `specs/` `TASKS.md` `DECISIONS.md` | V3.1 意图、任务、决策与验收 |
| `trusted-supply/` | V3.1 可信技能供给 MVP（隔离开发，不连生产） |
| `market-preview/` | V3.2 只读能力市场预览，只消费 approved listing |
| `谱/` | 进度 · 决定 · 每天记录 |
| `cli/` | 兼容入口；唯一 CLI 源码在 `dist-src/skillops/scripts/` |
| `skills/skillops/` | 户主版小能（`~/.claude/skills/skillops` 符号链接到此） |
| `dist-src/skillops/` | **便携标准包**源码（给第三方 agent 的通用版，含 SMS 标准全文） |
| `api-server/` `xiaoneng/` `extension/` `mcp/` | 老平台后端/前端/插件/MCP（**冻结中**） |

GitHub `github.com/qiuyiwu1989-star/skillops`（私有）· 运行数据 `~/.skillops/`

## 人 & 竞品

- **小能 / Ace**：产品里的 agent 人格（不是人）。
- **郑刚教授**：浙大管院，其方法论被做成 skill。
- **Capafy**（capafy.ai）：闭源 skill 市场 + 服务端执行 + 变现。**与我们对立两极**（它当运行时+锁定；我们便携+不当运行时）。它的存在反证"开源可 fork 市场"是弱命题。

## 说话口径

对外讲这个产品，以 `dist-src/skillops/references/methodology.md` 为权威，**不即兴发明**。
关键词：技能 HRD · file-as-truth · 落户/入编/续聘/退役 · SMS 段位 · 不当运行时。
