# SkillOps 全面升级路线图

> 更新：2026-08-14。范围：双边能力市场、可信技能供给、企业技能 HRD 与造物云适配。生产接入仍需单独授权。

## 当前主航道：双边能力市场

市场不再把技能理解为“需要打开的页面”，而是把技能定义为可被 Agent、应用、工作流和外部执行底座调用的能力模块。当前版本先建立商业授权地基，再逐层建设创作者中心、企业授权库和技能管家。

`可信 Release → 能力商品 → Offer/LicensePolicy → Order/Entitlement → 调用授权 → 二创血缘 → 使用运营`

### V4.3 · 市场与商业授权内核

- Publisher 区分发布主体、创作者、权利人、收款与支持责任。
- Skill Product 绑定稳定 `skillId/releaseId`；Application Product 保持独立类型并固定依赖 BOM。
- 免费 Offer 也冻结许可证权利与约束，获取后签发可验证 Entitlement。
- 每次调用前校验组织、项目、环境、版本、期限、席位、额度和权利。
- 企业二创必须持有 `derive` 权并记录不可变血缘；普通下架与安全吊销分离。
- 订单和授权进入追加式账本；公共目录不暴露 Candidate、CAS、本地路径、身份或业务正文。

### V4.4—V4.8 · 市场产品化顺序

1. V4.4 创作者中心与可信发布：草稿、版本、审核、发布、下架与召回。
2. V4.5 需求方市场与企业授权库：中文发现、免费获取、授权状态和企业能力库。
3. V4.6 企业私有能力与二创：租户隔离、自研技能、Fork 血缘、升级与回滚。
4. V4.7 真实商业：付费订单、计量、退款、结算占位和应用依赖授权闭包。
5. V4.8 技能管家与工作台接缝：授权感知推荐、WorkOrder、Code/企业工作台适配和运营飞轮。

V4.4 已完成：创作者工作区默认私有，每次保存形成不可变 Draft；提交必须绑定当前 Publisher、Product、Release、MarketRegistry revision、许可和证据，并由权利与市场两个不同可信 human 独立批准。普通下架只关闭新订单，高危召回同时阻断既有调用，申诉不会自动恢复；重新提交只改变审核状态，不降低召回或自动恢复新订单。中文只读创作者中心已覆盖作品、草稿、审核缺口、权利声明、时间线与申诉状态。

V4.5 已完成本地可交付闭环：需求方目录只消费可信市场与发布投影，稳定区分已授权、可免费获取、需采购和不可用；免费获取原子生成 Order 与 Entitlement，企业授权库按组织、固定 Release、权利和生命周期展示调用资格；技能管家依据正式目录、企业库和 AccessDecision 生成解释性推荐及不可执行 WorkOrder 草案。中文需求方工作台仍为本地 fixture，不连接支付、模型或生产工作台。下一主版本进入 V4.6 企业私有能力、自研技能与授权二创；同时补齐审核/发布双轴和最后一次公开发布快照。

## 升级判断

V3.4 已经证明能力市场的发现与详情体验，但当前市场商品仍主要绑定 `SKILL.md` 单文件。下一阶段不再优先堆叠页面功能，而是把“技能”升级成可验证、可考核、可撤回的完整发布单元。

核心依赖链：

`完整技能包 → 全包可信审计 → 固定测试集 Eval → 独立人类终审 → Registry 发布投影 → 受控安装/更新 → 造物云适配 → 组织治理`

## Now

### V3.5 · 完整技能包可信交付（已完成）

目标：把审批对象从单个 `SKILL.md` 升级为不可变 `packageRevision`。

- 建立 package manifest、排序包指纹、内容寻址存储与原子发布。
- SkillHub/白名单采集器同步 `SKILL.md`、scripts、references、assets 和许可证覆盖范围。
- 拒绝路径穿越、符号链接、大小写冲突、重复路径、特殊文件、超限和 hash 不匹配。
- 全包安全扫描，任何附件变化都使审计、SMS、Eval 和批准失效。
- listing 只有同时满足许可可分发、包完整、全包审计当前有效时才获得安装资格。
- 市场详情展示真实文件清单、包指纹、总体积和安装边界。

验收结果：首批 3 个 listing 均能明确归类为“完整可安装”或“仅来源索引”，不再存在伪完整包。

### V3.6 · Eval 实证台架（基础闭环已完成）

目标：为首批技能建立可重复的真实考核，而不是继续展示 `pending`。

- 定义安全的 `evals/cases.json` 或受限 YAML 契约。
- runner adapter 与具体模型/CLI 解耦；默认 dry-run，真实执行需显式授权并使用用户自己的算力。
- 保存测试集、技能包、模型、环境、judge、结果和证据指纹。
- 首批 3 个技能每个至少 3 个固定案例，覆盖成功与失败路径。
- SMS 继续表示静态潜力；Eval 独立表示运行实绩，不混分。

## Next

### V3.7 · 人类终审与持续再认证（进行中）

- reviewer 使用可验证身份，不再只是任意字符串。
- Agent 辅助评估与独立人类终审严格区分；精选与安装必须经过人类终审。
- 引入四眼规则、批准有效期、复审到期、申诉、撤回与召回事件。
- 内容、包、许可、SMS、Eval 或策略变化自动转为 `stale`，从精选/可安装货架撤出。

阶段进展：核心 policy、证据快照、可验证身份、四眼计票、有效期、stale/撤回/召回状态机已接入 Candidate/Store；完整包只有当前双人认证才可安装，旧字符串审批只保留历史；中文运营队列和市场卡片/详情已能展示待第二人复核、即将到期、证据失效、拒绝、撤回、召回、退役与安装阻断原因。可信 IdP 回执入口留待 V4.0 组织试点，详见 `specs/009-v37-review-recertification.md`。

### V3.8 · 统一 Registry 合约

- 分离长期 Skill 身份 `namespace/name` 与来源候选 `cand_*`。
- 建立 Skill、Release、Source、Package、Assessment、Review、Listing、Deployment 事件模型。
- 发布只读 feed/API；任何下游只能消费发布投影，不能读取候选池。
- 支持 `upsert / withdraw / supersede` 生命周期和幂等回执。

阶段进展：稳定 Skill/Release/Source 身份、不可变 Release、append-only Registry、可重放投影、只读分页 Feed、公共隐私裁剪、certified Candidate 发布桥与造物云 `zaowuyun.ability.skill.v1` dry-run/staging mock Adapter 已实现；四类动作与回执均确定性、可重算且不含生产网络能力。下一步补运营 CLI 与 staging 人工验收，详见 `specs/010-v38-unified-registry.md`。

### V3.9 · 内部 HRD 管理闭环

- CLI 增加 registry source、install、update、withdraw、eval、coach、retire。
- 对比源卷、部署台账和 registry release 的三方漂移。
- 市场安装进入 lock 台账，版本变化进入复评，真实使用遥测进入退化预警。
- 形成“招聘 → 考核 → 分发 → 绩效 → 培训 → 退役”闭环。

阶段进展：Registry 只读 Client、经摘要验证的快照/Feed 离线缓存、确定性安装/更新计划、operation 幂等冲突、Lock v2、三方状态投影与 CAS 原子安装已实现；更新复评会比较版本、包、许可、安全、兼容、依赖和全套证据，新包不能继承旧 Eval/终审；中文治理 CLI 已串联更新判断、隐私绩效、Coach 和可逆退役；旧 Lock v1 迁移要求明确 Registry Release 映射、独立重算目标包摘要和 planDigest 确认，提交异常不写且 v1 原样保留。下一步进入 V4.0 staging 小规模试点，详见 `specs/011-v39-managed-distribution-loop.md`。

## Later

### V4.0 · 造物云试点与组织治理

- 造物云技能适配合同 `zaowuyun.ability.skill.v1`，默认 dry-run/staging。
- SkillOps 只提供技能供给与信任中台；插件、方法、应用、数字员工保留各自对象模型，通过 relations 关联。
- 组织编制、入编、锁版本、考核门槛、成员/项目权限、管理 key 分级与审计。
- 以训练营/永乐教育为首个小规模组织试点，再判断生产扩张。

阶段进展：V4.0-A/B 已完成最多 3 个技能的试点准备度报告、稳定 Release 入编、组织/项目/编制/角色治理、HMAC 可信身份回执、双人终审接缝、组织与 Staging 原子台账、待对账阻断、中文治理 CLI 和本地只读运营页。台账拒绝覆盖历史、父目录符号链接和越界写入；运营页不发起公网资源请求。下一步仅在本地 fixture/staging-mock 中完成训练营/永乐教育单组织演练和 go/no-go 报告，生产连接仍需另行授权，详见 `specs/012-v40-organization-staging-pilot.md` 与 `specs/013-v40b-identity-ledgers-operations.md`。

## 能力市场五层

| 层 | 职责 | 当前状态 |
|---|---|---|
| 供给接入 | SkillHub、GitHub 白名单、未来 SourceAdapter | SkillHub 与 Git 白名单已做完整包 CAS 采集；通用增量 SourceAdapter 待补 |
| 信任工厂 | 来源、许可、安全、SMS、Eval、人审 | 全包、Eval、双人独立终审与持续再认证基础已完成 |
| 目录发现 | 分类、搜索、货架、详情 | V4.5 已有中文任务检索、授权/价格状态与技能管家本地工作台；在线语义检索和版本历史待补 |
| 受控分发 | manifest、安装预览、deploy、lock、更新、撤回 | Registry 缓存、CAS 安装、Lock v2、更新复评与 v1 迁移已完成；远程生产传播待补 |
| 运营治理 | 同步健康、审核队列、策略、复审、召回、漏斗 | 中文终审队列、组织角色、原子治理台账、本地治理 CLI 与只读运营页已完成；真实试点漏斗待补 |

## 明确延后

- 暂不建设支付、评论、五星、虚构下载榜或个性化推荐。
- 暂不直连造物云生产、冻结中的 `api-server/` 与 `xiaoneng/`。
- 暂不自动执行第三方脚本或批量消耗付费模型额度。
- 暂不让 candidate id 成为长期产品身份。
