# SkillOps · 结构化技能 PRD（主题 1）+ SkillNet 可借清单（主题 5）

> 设计文档，不是实现。先想清楚数据模型 + 迁移路径，再决定动不动。
> 来源：Anthropic（skill = 文件夹 + 渐进式暴露）+ 浙大 SkillNet（文件夹包 / 4 类关系边 / 5 维评估含 Cost-Awareness）。
> 原则：**加法、不破坏**（现有单文本技能 = "只有 body 的结构化技能"，零迁移）；**不强迫 B**（默认还是一段提示词，进阶才用结构）。日期：2026-06。

---

## A. 主题 5 · SkillNet 可直接借的三样
1. **技能图谱 4 类关系边** `similar_to · belong_to · compose_with · depend_on` —— 比我们现在"同领域"丰富。用作关系视图(主题3)的本体 + 组合(compose_with)/依赖(depend_on)的基础。
2. **评估维度补一刀：Cost-Awareness（成本意识）** —— SkillNet 5 维(Safety/Completeness/Executability/Maintainability/Cost-Awareness)里，**唯独"成本意识"我们 SMS 没有**（Anthropic ③"别浪费模型推理"也是这条）。建议 SMS 加"成本/效率"判据。其余 4 维我们 10 维已覆盖。
3. **多源捕获** —— SkillNet 能把 GitHub/PDF/PPT/Word/对话记录/文本都转成技能包。我们现在只 文本/上传/GitHub；可扩 PDF/PPT/Word + 对话记录（=插件捕获，已在做）。

---

## B. 主题 1 · 结构化技能数据模型

### 现状 → 目标
- 现状：技能 = 单个 `content` 文本 blob（一段 SKILL.md/提示词）。
- 目标：技能 = **主体 + 可选结构区块**，渐进式暴露。对齐 Anthropic 文件夹模型 + SkillNet 文件夹包。

### 提议 schema（加法式，B 友好）
```
Skill {
  meta:    { id, name, slug, description, category, triggers[], visibility, source, owner }
  body:    string            // 主体 = 现在的 content（默认调用/复制的就是它）—— 单文本技能只有这个
  sections?: {               // 全部可选，进阶才填；渐进式暴露
    references?: [{ title, content }]   // 详细说明 / API / 边界条件
    examples?:   [{ title, input, output }]   // 好/坏示例（喂"结果质量""可评估性"）
    scripts?:    [{ name, lang, code }]       // 可执行脚本（Anthropic ③；主要服务 A/MCP）
    assets?:     [{ name, type, url }]        // 模板 / 图片 / 固定素材
  }
  relations?: [{ target, type }]   // type ∈ similar_to|belong_to|compose_with|depend_on（借 SkillNet）
  sms, invocations, lastInvokedAt, version…   // 现有字段不变
}
```
- **渐进式暴露**：`body` 是入口（调用/复制默认只给 body）；`sections` 按需加载（详情页/MCP 展开、agent 需要时再取）。
- **存储**：platform.json 的 skill 对象加 `body`（= 现 content）+ 可选 `sections`/`relations`。版本快照整个结构。

### 跨栈影响（这就是为什么要 PRD 先行）
| 环节 | 改动 |
|---|---|
| 捕获 | 默认存 body；进阶可加区块；多源(PDF/PPT later) |
| 版本 | 版本快照"整个结构"而非纯文本；diff 仍以 body 为主 |
| 调用·复制 | 复制 = body（不变）；可选"含示例/引用"模式 |
| 调用·MCP/插件 | `get_skill` 返回 body + 可选 sections 清单，agent 按需取 references/scripts —— 真·渐进式暴露 |
| /v1 API | 返回结构化；旧字段 content = body 兼容 |
| SMS | 有 examples/scripts/references 的技能在"可执行/可评估/可工程"加分；加 Cost-Awareness |
| 关系视图(主题3) | 从"同领域"升级成 4 类边 |

### 迁移（零破坏）
- 现有技能：`body = 旧 content`，`sections` 空 → 完全照常工作。
- 结构是**纯加法**：不填区块的技能行为不变；B 永远可以"只写一段提示词"。
- 分阶段：① body 重命名/兼容（无感）→ ② 详情页/工作台支持加 references/examples → ③ MCP/插件渐进式暴露 sections → ④ scripts + compose_with（A/第二幕）。

---

## C. 不做 / 守界
- 不做服务端执行 scripts（= 运行时，我们不当）；scripts 只作为"技能内容的一部分"被取用，跑在用户自己的 AI/环境。
- 不强迫 B 用文件夹；结构永远可选。
- 全自动 compose 编排留 A/第二幕；先做 relations 的"看得见"。

## D. 建议执行顺序（真要做时）
1. 数据模型加 `body`(兼容现 content) + 可选 `sections` + `relations`（后端 db.js / skillView / /v1）。
2. SMS 加 **Cost-Awareness** 判据（小改 scoring.mjs，立即可上，独立于结构）。
3. 工作台「编辑」支持加 references/examples（B 进阶）。
4. MCP/插件 `get_skill` 渐进式暴露 sections。
5. 关系升级成 4 类边（compose_with/depend_on 为后续组合铺路）。

> 一句话：把"技能"从一段文本，升级成**有主体 + 可选结构 + 关系**的资产；全程加法、不破坏、不强迫 B —— 这是 SkillOps 从"提示词收纳"长成"严肃技能管理"的产品级地基。
