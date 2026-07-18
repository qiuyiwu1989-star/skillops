# SkillOps V3 · 架构规划（技能 HRD 重构）

> 状态：**草案，待邱懿武批准**。批准前不写一行产品代码；批准后新代码在新目录生长，老版本（api-server/xiaoneng/线上 skillops.tech）原样运行，一行不改，直到新版通过验收判据。
> 前置讨论：2026-07-05 第一性原理推倒重构（S14 + P12/P14 + S02 + P05），七面承重墙逐一裁决。
> 上承：V1-RERANK（脊梁）、V2-LEARNINGS（结构化/评估方法论）——大部分结论仍有效，被本文件重排而非否定。

---

## 0. 一句话

**SkillOps = AI 技能的人事部（HRD）**：你的技能散在哪都行（file-as-truth），SkillOps 负责**盘点、调度、考核、流通、治理**它们的全生命周期——招聘（发现）→ 落户（登记）→ 调度（部署）→ 考核（eval）→ 培训（coach）→ 入编（组织收编）→ 退休。

- 对个人（A · agent-native builder）：一处入册，处处部署，版本不漂，质量可证。
- 对组织（终局）：用户使用，组织管理——编制、锁版本、考核门槛、权限、审计。
- 类别叙事：GitHub 赢在 git 之上的托管+协作+身份层；我们做 SKILL.md 开放标准之上的 **registry + 信任 + 调度层**。今天的 skill 世界 = npm 出现之前的 JavaScript 世界。

**不当生产运行时**（红线重述见 §2-Q4）：我们不替你的 AI 干活，我们把对的技能装进对的 AI。1Password 不替你登录，它把钥匙送进锁孔。

---

## 1. 为什么推倒（一段话存档）

V1/V2 建成了精美的档案柜（收纳/评分/版本/网页控制台），但**创始人自己的 50+ 技能活在 `.claude/skills/` 和 git 里，产品在他自己的技能人生里出场次数为零**。创始人绕开自己的产品 = 形态错误，不是渠道错误。根因：① DB-row-as-truth 制造第二份拷贝，分裂即死亡；② B 用户（ChatGPT 网页）痛感不足——3 个提示词不需要 HRD；③ 产品不在任何人的工作现场里，Hook 无触发器。HRD 的教训：没人爱档案柜，价值在调度与考核。

---

## 2. 决议记录（七面承重墙 · 2026-07-05 全部裁决）

| # | 决议 | 内容 |
|---|------|------|
| Q1 | **file-as-truth** | 技能真身 = 符合 SKILL.md 标准的文件夹，活在用户的 repo/目录（"卷"）里；DB 永远只是索引/缓存。网页捕获落入"托管卷"，格式同一。现有 Supabase 数据未来平滑转为一个托管卷。 |
| Q2 | **自有场景当种子** | Wedge 用户从 B 改判为 A（事实裁定：B 没咬钩，创始人这个标准 A 用户也绕开了产品）。首批种子 = 自己 → 自己圈子的 builder → **训练营/课程（天然的微型组织，L4 治理层的自带试验田）**。产品双语，分发先打中文 builder 圈。B 是插件成熟后的第二波 on-ramp。 |
| Q3 | **两级身份：用户使用，组织管理** | `id: namespace/name` 写进 SKILL.md frontmatter；namespace 两类主体：个人（`qiuyiwu/`）与组织（`yongle-edu/`）。无 id 技能用内容指纹认亲 + 一键**落户**。组织**入编**个人技能 = 带血缘的收编（`adopted_from: qiuyiwu/speech-recap@3.2.0`），治理动作（锁版本/考核门槛/权限/审计）全部发生在编制上；**续聘** = 组织主动升级 pin。 |
| Q4 | **质检台架红线** | "不做生产工作负载的运行时，但做质检台架。" eval 是考核不是干活（HR 面试候选人 ≠ 替他上班）。生产执行永远在用户自己的 AI 里。 |
| Q5 | **eval 自带算力** | v0 用用户自己的 Claude 订阅/API key 在本地跑；golden cases 由技能作者写（像单元测试），coach 辅助生成。registry 时代官方算力跑公开榜（信任层投资）。 |
| Q6 | **GitHub 同构开闭** | 开：格式跟随 SKILL.md 不发明、**SMS rubric 公开发表成标准**、CLI 开源。闭（护城河）：托管的信任数据（eval 历史/使用数据/信用图谱）、registry 托管服务、企业控制平面。认知护城河输出才能成标准，数据护城河才是闭合处。 |
| Q7 | **day-1 可私有化** | 所有架构决策不引入 SaaS-only 依赖（零依赖 Node + 自托管 Supabase 路线已验证）。商业上先只卖托管版。 |

---

## 3. 五层架构（对照 HRD 职能）

| 层 | HRD 类比 | 内容 | 现有资产 |
|----|---------|------|---------|
| **L0 格式** | 人事档案标准 | SKILL.md 开放标准（frontmatter 增 `id`/`version`/`evals`），不发明私有格式 | V2 结构化技能 PRD 直接对齐 |
| **L1 本体** | 花名册 + **调度** | `skillops` CLI（后期 daemon）：scan 盘点 · status 漂移警报 · deploy 部署 · 卷管理 | **全新建**（缺的腿） |
| **L2 信任** | 考核 + 培训 | SMS 静态分（潜力）+ **eval 台架**（实证）+ 使用遥测（hooks/MCP 回传） | scoring.mjs、coach 保留复用；eval 新建 |
| **L3 流通** | 招聘 / 内部人才市场 | registry：发布/订阅/安装/更新；个人免费，组织私有 registry 收费 | api-server + Supabase 直接改造为 registry 服务端；/d/ 页、MCP+OAuth 升为主干 |
| **L4 治理** | HR 合规 | 组织控制平面：入编/锁版本/考核门槛/权限/审计/血缘 | db.js ownerId/visibility 接缝有效 |

脊梁改写：旧「运行→管理→治理→市场」→ 新「**盘点/调度（每日动词）→ 信任（eval）→ 流通（registry）→ 治理（组织）**」。

---

## 4. 对象模型（六个名词）

1. **技能 Skill**：一个含 SKILL.md 的文件夹。身份 = frontmatter `id`（`namespace/name`），可选 `version`（semver，缺省用 git commit/内容指纹兜底）。
2. **卷 Vault**：一个被注册进 SkillOps 的技能根目录（某 repo 的 `.claude/skills/`、插件目录、`~/skills/`……）。本地卷 v0；托管卷（服务器代管的卷，服务网页用户与同步）后期。
3. **部署 Deployment**：把技能放进目标 agent 读得到的位置（项目 `.claude/skills/`、`~/.claude/skills/`、Cursor rules、OpenClaw……）。默认**复制 + 记账**（确定性、全平台兼容），`--link` 软链为进阶选项。
4. **台账 Lockfile**：目标项目里的 `.skillops/lock.json`——哪个技能的哪个版本部署在此。漂移检测 = 台账 vs 卷内最新 vs（后期）registry 最新 三方对比。
5. **考核 Eval**：技能文件夹内 `evals/cases.yaml`（输入 + 期望行为 + 判定提示）；runner 用本地 `claude -p` 无头跑，LLM-judge 出通过率；报告存 `~/.skillops/evals/`。
6. **编制 Establishment**（组织期）：组织对一个技能的收编记录——血缘（adopted_from@version）、锁版本、考核门槛、可用成员/项目、审计日志。

**产品词汇表**（认知资产，对外输出）：落户 · 入册 · 调度/部署 · 考核 · 培训 · 入编 · 续聘 · 退休。

---

## 5. 组件架构：新建 / 复用 / 冻结

### 新建（V3 的腿）
- **`cli/`** —— `skillops` 命令行（Node ESM，延续零依赖铁律；索引用 `node:sqlite` 或 JSON 文件）：
  ```
  skillops scan                    # 盘点所有注册卷，发现/指纹认亲/提示落户
  skillops ls / status             # 花名册 / 漂移·退化·没考核过的警报
  skillops deploy <id> --to <dir>  # 部署 + 写台账
  skillops eval <id>               # 质检台架（本地 claude -p + LLM-judge）
  skillops score <id>              # SMS 静态评分（复用 scoring.mjs）
  skillops sync                    # 与托管卷/registry 同步（Phase 3）
  ```
- **遥测钩子**：Claude Code `PostToolUse` hook 监听 Skill 调用 → 落 `~/.skillops/telemetry.jsonl`。A 用户的真实调用数据第一次成为可能（B 的复制计数永远做不到这个诚实度）。

### 复用（老资产换岗）
- `scoring.mjs`（SMS 引擎）→ 内嵌 CLI；rubric 公开发表（Q6）。
- skill-coach → `skillops coach <id>`（培训动词）。
- api-server + Supabase + MCP + OAuth → Phase 3 改造为 **registry 服务端**（发布/订阅/组织/编制）。可私有化路线已验证（Q7）。
- xiaoneng dashboard → Phase 3+ 作为托管卷/registry 的网页视图；当前原样在线，不动。
- /d/ 公开页 → registry 的 SEO/分发前台。

### 冻结（不删，封存）
- 技能链（太早）· 市场搜索/fork（第三幕）· 浏览器插件 v0.1（B 的后手，保留可下载）· /try/。

---

## 6. 关键机制设计

- **scan 与落户**：遍历注册卷 → 解析 SKILL.md → 有 id 者入册；无 id 者按内容指纹（正文归一化后 hash）认亲历史记录，交互式建议 `id` 并写回 frontmatter。跨卷同 id 不同内容 = 版本分歧警报（这是"3 个项目里的 speech-recap 落后 2 版"的数据基础）。
- **deploy 与漂移**：部署即记账（lock.json）；`status` 对比台账/卷/registry 三方 → 输出"哪个项目落后、哪个技能退化、哪个从未考核"。这是 Hook 触发器的 v0（人肉跑 status），Phase 2 加 launchd/cron 周报。
- **eval 台架**：cases.yaml 里每条 = {输入场景, 期望要点, 判定提示}；runner 起 `claude -p`（加载技能）跑输入 → 再起 judge 判定 → 通过率 + 逐条报告。花的是用户自己的订阅（Q5）。SMS 静态分与 eval 通过率并列呈现："潜力分 + 实证分"。
- **入编治理（组织期）**：组织 registry 中建立编制记录；成员 `skillops deploy yongle-edu/speech-recap` 时解析到组织锁定的版本；考核门槛不达标的版本拒绝部署；全程审计。训练营 = 第一个组织租户：课程技能包一键发给全体学员，老师续聘新版本，学员端自动收到更新提示。

---

## 7. 二级决议（建议已给，标 ⏳ 的待你拍板）

| 事项 | 建议 |
|---|---|
| 品牌 | 沿用 **SkillOps**（Ops = 调度/运维语义比以前更贴）；对外类别词 = 「AI 技能的人事部 / 技能 HRD」+ SMS 标准。V3 只是内部代号。 |
| Hook 触发器 | v0 = `skillops status` + scan 时警报；Phase 2 = cron 周报（漂移/退化/未考核摘要）。⏳ 通知落点（终端/邮件/微信）后议。 |
| 插件 | v0.1 封存，/connect 保留下载，不再开发，直到 B 波次。 |
| 线上过渡 | skillops.tech 原样运行；V3 CLI 验证后，Supabase 数据转为你的第一个托管卷；网页叙事那时再改版。 |
| 收费 | 个人永久免费；组织席位/私有 registry 收费（Phase 4）；训练营首租户免费换案例。⏳ 定价后议。 |
| SMS rubric 发表 | 公开发表为《Skill Management Standard》文档（对齐 Anthropic 方法论 + SkillNet 指标的叙事已在 V2 备好）。⏳ 发表时机与渠道后议。 |

---

## 8. 路线图（90 天）与验收判据

| 阶段 | 内容 | 验收判据（可证伪） |
|---|---|---|
| **P1 · Dogfood**（2 周） | `cli/` 出生：scan / ls / 落户 / score。把你散在 qiuyiwu.com、skillops、luedong、插件目录的 50+ 技能全部入册 | **你连续两周、每周 ≥3 次在真实工作中使用。不达标 → 回到本文件重议，不硬推。** |
| **P2 · 调度+考核**（4 周） | deploy + lock.json + status 漂移警报；eval 台架 v0（先给 3 个你最常用的技能写 cases）；遥测 hook | 漂移警报至少抓到一次真实的版本分歧；eval 跑通并影响过一次你的技能修改 |
| **P3 · 十个像你的人**（6 周） | registry v0（api-server 改造）：发布/安装/更新；10 个中文圈 builder 的技能入册被管理 | ≥5 人自发完成第二次 deploy/update（非你代操作） |
| **P4 · 组织试点**（其后） | 训练营/永乐教育作为首个组织租户：入编、锁版本、发包给学员 | 一期学员真实通过 SkillOps 收到课程技能包 |

**北极星指标**：每周被管理的活跃技能数 × 管理动作数（scan/deploy/eval/coach/续聘 的真实发生量）。调用次数降为参考指标。

**并行原则（铁律）**：V3 代码只生长在新目录（`cli/` 等）；`api-server/`、`xiaoneng/`、线上 skillops.tech 在 P3 改造前一行不动；任何生产变更走既有 rsync 流程且先经你确认。

---

## 9. 风险与反证条件

1. **巨头补位**（Anthropic 插件市场 / GitHub 原生 skill 语义）——应对：速度 + 跨厂商中立（Anthropic 结构性不会管你 OpenAI 侧的资产）+ 中文企业纵深（国产模型混用 + 合规 + 私有化，恰是我们 day-1 约束）。
2. **Dogfood 失败** —— P1 判据不达标即回炉。这条判据比任何定位文档都硬，不许找理由绕过。
3. **SKILL.md 标准漂移** —— 跟随策略，格式解析做成适配层，不与某一版标准焊死。
4. **精力分散**（多产品线并行）—— 90 天内 SkillOps 只认北极星一个指标，其余一律"冻结不删"。
5. **"为什么不直接问 ChatGPT"自检** —— ChatGPT 不知道你的技能散在哪 8 个 repo、装不进你的 `.claude/skills/`、跑不了你的 eval、做不了 registry。新形态过关比"提示词收纳盒"硬得多。（作为对照持续自问。）

---

## 10. 修正案（2026-07-19 · P1 验收回炉产物，已批准）

**P1 验收记录**：原判据（用户连续两周每周 ≥3 次亲手使用）**不达标**——`~/.skillops/` 自建成那一分钟起 14 天零触碰；同期用户在会话里新生 3 个技能，花名册次日即过期。根因不是价值缺失，是**操作者错位**：用户的一切界面是对话（14 天亲手敲命令 0 次），CLI 把操作台错发给了 CEO。

- **修正案一 · 操作者条款**：SkillOps 的操作者 = 用户会话里的 agent；人 = 拍板者。CEO/专员分工：agent 操作系统并汇报，人只读周报、作决策。CLI 重新定位为 agent 的手。
- **修正案二 · 验收判据 v2**（两周窗口）：① agent 经 skillops 完成的管理动作 ≥5 次/周（telemetry 佐证）；② 用户每周 ≥1 次读周报并拍板；③ 新技能出生 24h 内入册率 100%。
- **修正案三 · 捕获一等动词**：技能在会话中出生 = 招聘现场，出生即入册+落户（agent 顺手完成，不打断工作流）。证据：用户技能出生率 3 个/14 天。
- **修正案四 · 双平面条款**：本体是系统（确定性/可审计），agent 是**岗位**不是应用——寄生于用户已有的各家 AI，不自建聊天应用。**本地面 = 手**（CLI + hooks + skillops 技能，操作真身，P1.5）；**远程面 = 嘴**（远程 MCP link+key，已建成于老平台，P3 改接托管卷后升格为**组织分发轨道**：训练营发 link+key，学员任何 AI 30 秒上岗）。key 分级：调用 key（只读）≠ 管理 key（落户/入编/退休），P3 实现。
- **P1.5 · 聘专员**（插入 P1 与 P2 之间）：`skillops` 技能进 `~/.claude/skills`（岗位说明书）+ SessionStart 体检 hook（静默扫描，有警报才开口，花名册永不过期）+ Skill 调用遥测 hook + 人事周报（到期由 hook 在会话内送达，CEO 只读和批）。

---

*造物云出品 · © 邱懿武 · 本文件为 V3 宪法草案，批准后方生效*
