# V4.4 创作者中心与可信发布闭环

## 状态

approved

## 要什么

让个人与组织创作者能围绕稳定能力商品完成一条可审计链路：

`创建草稿 → 形成不可变草稿版本 → 提交发布 → 权利/质量复核 → 请求修订或批准 → 发布 → 普通下架 / 高危召回 → 申诉与再发布`

创作者中心管理的是商品元数据、版本引用、权利声明、发布证据和生命周期，不复制或在线编辑技能包正文。技能真身仍由 Package/Registry 管理，SkillOps 不成为第三方技能运行时。

## Creator Workspace

- 个人或组织 Publisher 可以创建 `skill | application` 创作项目。
- 创作项目使用稳定 `workId`，每次保存产生不可变 `draftRevision` 和 `draftDigest`。
- Draft 只保存中文/原文元数据、分类标签、定价意向、支持信息、目标 `productKey`、Release 引用和权利声明摘要。
- Skill Draft 必须引用 canonical Registry Release；Application Draft 必须引用已登记 Application Product/Application Release。
- 默认私有；未经提交和批准不能进入公共目录。
- 同一 Publisher + abilityType + productKey 不得创建两个身份冲突的项目。

## 发布提交与复核

- 提交必须绑定 `publisherId/productId/releaseId|applicationReleaseId/draftDigest`、MarketRegistry revision、许可权利、证据引用和声明版本。
- 提交者身份必须来自可信 IdP 回执，且能代表 Publisher。
- 复核至少分为 `rights` 与 `market` 两个角色，使用两个不同的、可信的人类身份；提交者不得给自己的提交计票。
- Agent 可以生成 advisory，但不能计入批准票。
- 复核结果只允许 `approve | request_changes | reject`，理由和证据摘要必须留存。
- `request_changes` 后必须产生新 draft revision 和新 submission；旧批准不得继承。
- 发布只能消费当前双人批准且证据未变化的 submission。

## 生命周期

- `published`：进入公共目录并允许创建新 Offer/Order。
- `withdrawn`：普通下架，阻止新订单；已有合法 Entitlement 保留调用权。
- `recalled`：高危召回，阻止新订单和既有调用，并记录风险、替代/回滚说明。
- `appealed`：创作者可对 reject/withdraw/recall 提交申诉，但不自动恢复发布。
- 再发布必须形成新 Release 或新的当前 submission，不覆盖历史事件。
- 所有事件追加式、可重放、revision CAS、时间单调；外部没有任意 `write()`。

## MarketRegistry 接缝

- V4.3 的 `registered` 不再自动等于 `published`；订单解析只接受发布工作流投影的当前状态。
- 商品、Release 和发布状态必须三元绑定；任何一项变化都会使提交和批准失效。
- Public catalog 只消费 `published`；withdrawn/recalled 从可获取货架撤出，但生命周期页保留公开说明。
- 旧 V4.3 fixtures 通过显式迁移事件进入 published，不隐式升级。

## 创作者中心体验

- 中文创作者首页：作品数、草稿、待复核、需修改、已发布、已下架/召回。
- 作品列表显示能力类型、中文标题、版本、状态、审核缺口和下一动作。
- 作品详情展示版本时间线、权利声明、审核证据、发布状态和申诉历史。
- 首版页面只消费本地公共/创作者投影；不连接生产、不上传技能正文、不接真实支付。

## 验收清单

- [x] 创建 Skill/Application 创作项目并保存至少两个不可变草稿版本。
- [x] 未登记 Publisher、错 Publisher、错 Release、重复 productKey 和敏感字段失败关闭。
- [x] 提交绑定 Draft/Product/Release/Registry revision，任一变化使旧提交失效。
- [x] rights + market 两个不同可信 human reviewer 才能批准；Agent、提交者或同一人别名不计票。
- [x] request_changes 后旧批准不能用于新草稿发布。
- [x] published 才可进入公共目录和新订单解析。
- [x] withdrawn 阻止新订单但保留已有 Entitlement；recalled 同时阻止既有调用。
- [x] reject、withdraw、recall 均可申诉，但申诉不自动恢复。
- [x] Creator/Publication Store 追加式、CAS、重启、幂等、故障与 symlink 边界通过。
- [x] 中文创作者中心具备空态、错误态、移动端、暗色和无障碍体验。
- [x] 公共/创作者投影不含原始身份、Candidate、CAS、本地路径、技能正文、Prompt、Output、Token 或 Secret。
- [x] 跨域 E2E 跑通 Draft → Submit → 双人批准 → Publish → Offer/Order → Withdraw/Recall。
- [x] `node --test trusted-supply/test/*.test.mjs` 与 `node --test market-preview/test/*.test.mjs` 全量通过。

## 不做什么

- 不做浏览器内代码编辑、技能包上传、在线执行或模型调用。
- 不接真实支付、结算、发票、提现、生产 IdP 或生产造物云。
- 不允许开放 UGC 自动上架、AI 自动审批、自动封禁或自动定价。
- 不建设评论社区、关注动态、私信和内容推荐算法。
- 不实现企业二创工作台；它属于 V4.6。

## 并行工作包

- A：Creator Workspace、不可变 Draft Revision、创作者投影与原子 Store。
- B：Publication Submission、双角色复核、生命周期、申诉与 MarketRegistry/Order/Access 接缝。
- C：中文创作者中心页面、公共投影适配和前端契约测试。
- D：跨域 E2E、迁移 fixture、独立安全审查和全量回归。
