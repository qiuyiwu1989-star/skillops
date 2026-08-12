# Decisions

- 2026-08-13：V3.3 本地 Go 演示允许明确标注 `agent_assisted` 的复核事件，但不能对外宣称为独立人工终审；进入生产前必须补独立人类复核。Basis: 本地研发授权不等于生产发布授权。Confidence: high.
- 2026-08-13：安装资格同时要求许可可分发与包完整；SkillHub 只同步 `SKILL.md` 的候选即使 approved 也显示安装不可用，不将缺失 references/scripts 的条目伪装成完整技能包。Basis: 浏览器验收时发现外部同步只缓存单文件。Confidence: high.
- 2026-08-13：V3.3 使用三层评估：硬信任门不可被抵消；SMS v2.0 十维静态评分决定质量段位；Eval 独立记录实绩。B≥64 为公开质量门槛，A≥76 才进入精选候选，S≥86 才标记旗舰候选。SkillHub TRACE 与热度不替代 SMS。Basis: 用户要求确认并使用造物云评估体系。Confidence: high.
- 2026-08-13：V3.3 本地开发按四个工作包并行：SMS 管线、外部 YAML 兼容、市场发现/详情、主线集成/安装；各 Agent 使用互斥文件边界，主 Agent 负责最终合并与验收。Basis: 用户明确要求拆解子 Agent 分头执行。Confidence: high.
- 2026-08-12：SkillOps V3.1 聚焦「技能」；插件、方法、应用、数字员工由造物云能力市场分别承载，SkillOps 只记录其与技能的关系。Basis: 用户在当前会话明确认可聚焦技能。Confidence: high.
- 2026-08-12：采用一核两面——对外为能力市场提供可信技能供给，对内管理技能的入册、考核、部署和提升。Basis: 当前会话产品讨论。Confidence: high.
- 2026-08-12：外部抓取结果只进入候选池，未经许可/安全硬门、质量评估和人工批准不得公开上架。安全与许可证不能被综合分抵消。Basis: 用户提出抓取评估入库方向，准入规则由本版章程收敛。Confidence: high.
- 2026-08-12：D14 继续有效；V3.1 新代码在 `trusted-supply/` 与现有便携 CLI 中隔离开发，本版不修改或部署冻结中的 `api-server/`、`xiaoneng/`。备选：直接启动 P3 改老平台（风险高、未采用）。Confidence: high.
- 2026-08-12：项目按 G3 管理，新功能必须先有 spec，并以自动化测试作为完成依据。Basis: 已有线上服务、外部输入、安全和长期维护要求。Confidence: high.
- 2026-08-12：技能批准绑定内容指纹与许可证；正文或许可证变化必须失效，listing 生成时重新计算内容指纹。Basis: V3.1 发布前安全复核。Confidence: high.
- 2026-08-12：技能部署拒绝符号链接，目标已存在但无 lock、或目标偏离部署指纹时均拒绝覆盖。Basis: 防止路径逃逸与破坏用户本地修改。Confidence: high.
- 2026-08-12：V3.2 采用显式白名单 JSON 与 git commit 快照，不提供全网搜索或自动发布；本地市场预览只消费 `listListings()` 的批准数据。Basis: 让真实来源试运行与生产边界解耦。Confidence: high.
