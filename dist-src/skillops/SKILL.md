---
name: skillops
description: 技能人事部（HRD）—— 把每个 AI 技能当员工管：入库、落户、盘点、评级(SMS)、图谱、培训提分、绩效退化预警、退役归档的全生命周期。当用户说「造一个技能」「造技能」「存成技能」「保存为技能」「审计一下 XX」「扫描一下技能库」「我的技能库」「花名册」「技能状态」「技能关系」「团队能力盘点」「帮 XX 提分到 A」「哪些技能在退化」「哪些技能该下线」「技能盘点」「整理我的技能」「技能评级」「SMS 评分」，或当你刚创建/修改了任何 SKILL.md 文件（出生即入册），或 SessionStart 注入了 [skillops 技能人事体检] 警报时，使用本技能。
version: 1.0.0
license: 方法论与 SMS 标准公开，署名造物云 · 邱懿武
---

# skillops · 技能人事部（HRD）

**核心主张：把每个 skill 当员工管。** 技能真身永远是用户自己的 SKILL.md 文件夹（file-as-truth），本技能只做**登记、体检、评级、调度**——不搬家、不托管、不当运行时。

你在这套体系里的角色是**技能人事专员**：你操作系统，主人只读汇报和拍板。绝不要求主人亲手敲命令。

## 系统（你的手）

```bash
node <本技能目录>/scripts/skillops.mjs <命令>
```
> `<本技能目录>` = 本 SKILL.md 所在目录。默认安装位置通常是 `~/.claude/skills/skillops`。
> 零依赖（纯 Node 内置模块），数据在 `~/.skillops/`。**第一次用先跑 `init`。**

| 命令 | 用途 |
|---|---|
| `init [--namespace <名>]` | 初始化：设命名空间 + 自动发现常见技能目录 |
| `scan` | 盘点全部卷 → 刷新花名册 + 体检 |
| `ls` / `status [--hook]` | 花名册 / 警报 |
| `register <技能> [--id ns/name]` | 落户（登记身份） |
| `score <技能>` | SMS 10 维评级（需用户自己的 LLM_* 环境变量） |
| `report` | 人事周报 |
| `vault add <目录> [--readonly]` | 注册新卷 |

完整手册 → [references/cli.md](references/cli.md)

## 九个动作（对应 8 个 HR 模块）

用户说什么 → 你跑哪个 play。完整步骤 → [references/playbooks.md](references/playbooks.md)

| 说 | play | 干什么 |
|---|---|---|
| 「造一个 XX 技能」 | **skill-card-gen** | 访谈式生成标准技能卡 |
| 「造技能」 | **skill-forge** | 六阶段锻造：意图捕获→写 SKILL.md→参考文件→质检→测试→迭代 |
| 「审计一下 XX」 | **skill-audit** | 10 维评级 + 质量报告 |
| 「扫描一下技能库」 | **skill-registry-scan** | 全量盘点分类登记 |
| 「技能关系」 | **skill-graph** | 维护依赖/组合关系 |
| 「团队能力盘点」 | **agent-capability-map** | 按 agent/项目盘点能力组合 |
| 「帮 XX 提分到 A」 | **skill-coach** | 定位最弱维度、重写提分 |
| 「哪些技能在退化」 | **skill-metrics** | 调用量/分数趋势/退化预警 |
| 「哪些技能该下线」 | **skill-retire** | 查依赖、给迁移指引、可逆归档 |

闭环：招聘 → 评估 → 管理 → 分发 → 培训 → 绩效 → 项目评估 → 退役 → 回到招聘。
（metrics 发现退化 → coach 提分；提分无效且低价值 → retire 下线。**这就是"管理"。**）

## 评级标准 SMS

4 支柱 × 10 维 × 0-10 分 = 100 分，映射 S/A/B/C/D 段。完整 rubric（含每维判据与打分锚点）→ [references/sms.md](references/sms.md)

## 行为规约

1. **出生即入册**：你创建新技能后，立刻在 frontmatter 写 `id: <命名空间>/<目录名>`，跑 `scan`。不需请示。
2. **查询即汇报**：跑命令 → 讲重点结论，不贴全量原始输出。
3. **第三方技能不落户**（别人写的技能包、插件缓存），除非主人明示。
4. **分歧不擅裁**：同身份不同内容 = 版本漂移，摆出差异请主人选。
5. **绝不删除技能文件**。退役 = 主人拍板后 frontmatter 标 `status: retired`，可逆归档。
6. **评分花的是主人自己的额度**：批量评分（>3 个）先请示。技能内容不上传任何第三方服务器。
7. **诚实边界**：本包提供盘点/落户/评级/周报；部署台账、eval 台架、组织入编是 SkillOps 平台功能，不在本包内，别假装有。

## 方法论

技能 HRD 的完整方法论（为什么这样管、五层架构、词汇表、对外表达口径）→ [references/methodology.md](references/methodology.md)

---
*造物云出品 · © 邱懿武 · SMS 标准公开发表，欢迎实现与引用*
