# Tasks

## Now

- [ ] 复核首批 3 个 SkillHub listing 的完整包与许可可得性；不可得则保持来源索引
- [x] V3.7-B：把四眼终审 policy 接入 Candidate/Store，旧 reviewer 字符串仅保留为 legacy history
- [ ] V3.7-C：增加可信 IdP 回执入口、待审/到期队列、市场认证状态与撤回/召回展示

## Next

- [ ] 为首批 3 个具备完整包的技能补固定测试集与离线 Eval；旧来源包不可得时不伪造实绩
- [x] V3.8-A/B：实现统一 Skill/Release/Source 身份、append-only Registry、只读 Feed 与投影重放
- [ ] V3.8-C/D：已完成 certified Candidate → Release 发布接缝；待造物云 dry-run Adapter，不连接生产
- [ ] V3.9-A/B：已完成 Lock v2、受控安装计划与漂移投影；待接 Registry Client、离线缓存和原子执行器
- [ ] V3.9-C/D：实现更新复评、coach 隔离建议、可逆 retire 与隐私遥测
- [ ] V4.0：实现造物云 adapter staging 与组织治理小规模试点

## Done

- [x] 2026-08-13：完成三阶段第一批核心：V3.7 Candidate/Store 四眼终审与再认证；V3.8 稳定身份、不可变 Release、append-only Registry、只读 Feed；V3.9 确定性安装计划、operation 幂等、Lock v2 与漂移/撤回/过期阻断。旧单人字符串审批不再赋予安装资格。
- [x] 2026-08-13：启动三阶段全面升级：V3.7 四眼终审核心 policy 与 9 项测试完成；V3.8 统一 Registry、V3.9 托管分发/HRD 闭环规格冻结；市场卡片桌面证据区与操作区对齐，移动端保持自然流。
- [x] 2026-08-13：完成 V3.6 Eval 实证闭环：受限 JSON 固定测试集、确定性断言、离线 fixture Runner、package/suite/runner 三重绑定、append-only 证据、CLI 与中文详情展示；伪造汇总和过期包失败关闭，161/161 自动化测试及 1440px/390px 浏览器验收通过。
- [x] 2026-08-13：完成 V3.5 完整技能包可信交付地基：manifest/CAS、双向校验、全包安全审计、状态失效、SkillHub/GitHub 全包采集、CLI 与市场证据链；危险附件不可批准或安装；134/134 自动化测试及 1440px/390px 浏览器验收通过。
- [x] 2026-08-13：完成 V3.4 独立中文技能详情页；3 个 approved listing 具备稳定深链、静态元信息、SMS/Eval/来源/治理/安装边界，88/88 自动化测试和 1440px/390px 浏览器验收通过。
- [x] 2026-08-13：完成 V3.3 本地 Go 演示：同步并审计 12 个真实 SkillHub 候选，3 个 SMS v2 完整评分进入 B 段，3 个 listing 经 Agent 辅助复核进入本地市场；68/68 测试和 1440px/390px 浏览器验收通过。
- [x] 2026-08-13：完成 SMS v2.0 严格数据契约、安全 YAML frontmatter、评估草案/显式确认 CLI 与市场详情证据链。
- [x] 2026-08-13：完成 SkillHub 外部候选源；首轮发现 138、深检 13、入库 6、2 个进入 review、0 自动批准（commit: 0f64b4c）。
- [x] 2026-08-12：完成 SkillOps 与造物云 V5 的产品边界分析，确认聚焦技能。
- [x] 2026-08-12：完成 3 个 fixture 仓库、12 个候选的离线审核演示。
- [x] 2026-08-12：完成 README、进度、接力包与安全边界复核；V3.1 自动化测试 23/23 通过。
- [x] 2026-08-12：完成 V3.2 白名单快照器与本地能力市场预览；32/32 自动化测试及桌面/390px 浏览器验收通过。

## Blocked

- 无。线上部署、真实 GitHub 批量采集和付费 LLM 评分均不在本次授权范围。
