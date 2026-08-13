# V4.5 需求方市场、企业授权库与技能管家

## 状态

approved

## 要什么

让企业需求方不必先理解技能目录结构，也能完成一条可审计、可解释、不会越权的能力获取链路：

`描述任务 → 技能管家解析意图 → 推荐当前可信能力 → 区分已授权 / 可免费获取 / 需采购 → 免费获取 → 企业授权库 → 形成可调用计划`

市场同时支持人工浏览与 Agent 推荐。技能是可被调用的能力模块，不要求用户“打开技能”；Application 可以跳转工作台，Skill 可以进入技能管家或企业授权库。SkillOps 只决定发现、获取、授权与调用计划，不执行技能，不替企业自动采购。

## 需求方市场投影

- 只消费可信 MarketRegistry、Publication、Offer 和企业授权投影，不读取 Candidate 池、CAS 或创作者私有草稿。
- 仅历史上真实发布且当前绑定有效的商品可以进入可获取目录。
- 每个商品必须明确显示 `skill | application`、中文标题/说明、发布者、当前版本、免费/付费/询价、授权状态、可调用状态和可信证据摘要。
- 获取状态固定为：`entitled | free_available | purchase_required | unavailable`。
- Application 的 BOM 必须显示依赖授权闭包；任一 required Skill 未授权时不得宣称应用可直接使用。
- 检索基于中文任务、分类、类型、授权和价格状态，排序稳定且给出匹配原因；不虚构下载量、评分、收益或热度。

## 免费获取与企业授权库

- 免费不等于无许可证；获取必须使用当前 active free Offer、当前 published Publication、可信 Product↔Release 绑定并冻结 LicensePolicy 快照。
- 免费获取服务在一个受控操作中生成 Order、Entitlement 并写入 MarketLedger；同一幂等请求重放不重复授权，冲突请求失败关闭。
- 任一步失败不得产生“有订单无授权”或“有授权无订单”的半提交状态。
- 企业授权库只展示当前组织的 Entitlement，不接受调用者自报组织归属；必须经过组织范围授权器。
- 授权库显示技能/应用、固定 Release、权利、项目/环境/期限/席位/额度约束、来源订单和当前状态。
- withdrawn 保留已购合法授权；recalled/revoked/expired/revoked entitlement 显示阻断原因且不可调用。
- 免费获取不连接支付；paid/contact 只生成明确的采购需求动作，不伪造订单或授权。

## 技能管家 Agent

- 输入为受限中文任务摘要、意图标签、组织/项目/环境和允许权限，不接收业务正文、Prompt、输出、密钥或本地路径。
- 推荐同时考虑 Skill Record/Routing、Publication、Offer、企业授权和 AccessDecision。
- 输出固定状态：
  - `ready`：已有当前授权，可进入 WorkOrder 草案。
  - `acquisition_required`：存在可免费获取或需采购能力，必须由人确认。
  - `blocked`：召回、无权利、依赖缺失、权限/兼容不满足或证据失效。
- 只能生成确定性、可重算的推荐计划；不得自动下单、自动授权、执行技能、访问网络或调用模型。
- 推荐必须解释为何匹配、为何未选、所需权利、授权状态、依赖、风险和下一动作。
- WorkOrder 仅为未来 `code.zaowuyun.com` 适配的离线草案，固定 product/release/entitlement，不连接生产工作台。

## 需求方体验

- 中文需求方首页采用“技能管家对话区 + 能力结果区 + 企业授权库”的工作台式布局。
- 支持输入示例、任务标签、结果筛选、授权状态和详情证据；首版交互只读/本地 fixture，不发送真实需求。
- 已授权显示“可形成调用计划”，免费显示“需确认获取”，付费显示“联系采购/待支付能力”，不可用显示具体原因。
- 页面具备加载、空态、错误态、移动端、暗色、键盘焦点和低动效；不加载外部字体或脚本。

## 验收清单

- [x] 公共目录只含真实发布且当前绑定有效的 Skill/Application，未发布、过期、召回和私有草稿不泄露。
- [x] 商品稳定归类 entitled/free_available/purchase_required/unavailable，并显示中文原因。
- [x] Application required BOM 逐项解析授权，缺少任何 required entitlement 时不可直接使用。
- [x] 免费获取真实生成 Order + Entitlement + 两条追加式事件，幂等重放只有一份授权。
- [x] 免费获取任一验证、CAS 或写入故障都零半提交、零越权。
- [x] 企业授权库必须经组织范围授权，跨组织、过期、撤销、召回状态准确且隐私安全。
- [x] 技能管家能对至少一个已授权、一个免费、一个付费/询价、一个不可用能力给出稳定解释。
- [x] 技能管家不能自动获取、自动采购、执行技能、调用网络/模型或输出业务正文。
- [x] WorkOrder 草案固定 Product/Release/Entitlement/权限/环境，缺授权时不生成可执行态。
- [x] 中文需求方工作台具备 Agent 区、市场结果、企业授权库和清晰下一动作。
- [x] 公共输出不含 Candidate、CAS、身份回执、本地路径、Prompt、Output、Token、Secret 或业务正文。
- [x] 跨域 E2E 跑通发现 → 推荐 → 免费获取 → 授权库 → ready WorkOrder，并验证 recall 阻断。
- [x] 独立安全审查 P0=0、P1=0。
- [x] `node --test trusted-supply/test/*.test.mjs`、`node --test market-preview/test/*.test.mjs` 和 `node --test test/*.test.mjs` 全量通过。

## 不做什么

- 不接真实支付、退款、发票、结算、提现、多币种或生产采购流程。
- 不接 `code.zaowuyun.com` 或企业工作台生产接口，不执行 WorkOrder。
- 不自动获取免费技能，不自动购买、自动审批或自动扩大权限。
- 不实现在线聊天模型、向量数据库、个性化推荐训练或上传业务材料。
- 不建设企业二创、私有 Fork 和公开再售；它们属于 V4.6。
- 不修改冻结中的 `api-server/`、`xiaoneng/` 或生产部署配置。

## 并行工作包

- A：需求方目录投影、获取状态、Application BOM 授权闭包与稳定检索。
- B：免费获取原子服务、企业授权库投影、组织范围授权与故障恢复。
- C：技能管家确定性推荐、WorkOrder 草案、中文需求方工作台与跨域 E2E。
- D：独立安全审查、全量回归、路线图和交付提交。
