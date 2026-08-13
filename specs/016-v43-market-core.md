# V4.3 双边能力市场内核

## 状态

done

## 要什么

把现有可信技能供给升级为双边能力市场的最小商业地基。首个闭环不是付款，而是：

`发布主体 → 稳定能力商品 → 不可变 Release → 免费 Offer → 企业 Order → Entitlement → 调用授权判断`

技能是可被 Agent、应用、工作流或外部执行底座调用的无头模块；应用是面向场景、组合技能和流程的独立能力类型。两者共享发布、商品、价格与授权框架，但不共享类型契约。

## 既有能力复用

- Package/CAS 负责不可变完整包，不进入商业账本。
- Registry 负责稳定 `skillId/releaseId`、可信证据和发布生命周期。
- SMS/Eval/Review 继续负责质量与可信度。
- Organization Governance 负责组织/项目权限，不冒充商业授权。
- Operations 负责运营分析，不直接作为计费账单。

## 领域边界

### Publisher

发布主体与作者、创作者、权利人、收款主体分开。首版支持 `individual | organization`，发布主体必须引用可验证身份回执摘要，不保存原始身份。

### AbilityProduct

- 稳定 `productId`，类型仅 `skill | application`。
- `skill` 必须绑定稳定 `skillId`，不得使用 `cand_*`。
- `application` 使用独立稳定身份，不能伪装为 Skill Release。
- 商品元数据可变；已发布 Release 不可变。

### ApplicationRelease

- 固定应用版本和依赖 BOM。
- 每个技能依赖至少包含 `productId`、`skillId`、精确 `releaseId`、required/optional 和所需权利；三者必须由可信市场注册台账证明是同一商品版本。
- 应用发布不自动授予或转售依赖技能的权利。

### LicensePolicy

权利必须逐项声明：

- `invoke`
- `organization_use`
- `install`
- `view_source`
- `modify`
- `derive`
- `internal_distribute`
- `commercial_output`
- `redistribute_derivative`
- `updates`
- `support`

约束至少支持组织、项目、环境、席位、调用额度、有效期和 Release 范围。免费只是价格，不等于没有 LicensePolicy。

### Offer / Order / Entitlement

- Offer 可修订；订单必须冻结 `offerRevisionId`、价格和 LicensePolicy 快照。
- 首版只执行 `free` Offer，币种固定 `CNY`、金额为 0；付费 Offer 可建模但不得伪造已支付。
- 每个成功免费订单签发一个内容寻址 Entitlement。
- 相同幂等键与相同请求必须返回相同结果；相同键不同请求必须冲突。
- Entitlement 必须绑定组织、产品、Release 范围、权利、约束、有效期和来源订单。

### AccessDecision

每次调用前根据受信 Resolver 提供的 Entitlement、Release 状态、用量、席位与可信时钟判断 `allow | deny`，调用方不得自报授权证据或计量，至少校验：

- 组织、项目、环境一致；
- Release 在授权范围内且未撤回/召回；
- 所需权利存在；
- 时间、席位和额度未超限；
- 不能以 Registry callable、组织入编或订单存在代替 Entitlement。

## 稳定身份迁移

- 新市场目录和详情路由只使用 `productId`、`skillId`、`releaseId`。
- `CandidateStore` 与 `cand_*` 只存在于候选审核域，不得出现在公共商品、订单、授权或调用决策中。
- WP0 只建立联合投影与测试，不删除旧预览兼容入口。

## 追加式账本

- 订单、授权、撤销和退款占位事件只追加，不允许公开任意覆写。
- 公共投影不得包含 Candidate、CAS 路径、原始身份、密钥、企业正文、Prompt 或完整输出。
- 普通下架只阻止新订单；高危召回可以阻止既有 Entitlement 调用，并保留审计原因。

## 验收清单

- [x] 个人和组织发布主体生成稳定身份，身份角色不混淆。
- [x] Skill Product 只绑定 canonical `skillId/releaseId`，拒绝 `cand_*`。
- [x] Application Release 固定依赖 BOM，缺失依赖授权时失败关闭。
- [x] 免费 Offer 也包含明确 LicensePolicy。
- [x] 免费获取生成冻结条款的 Order 与可验证 Entitlement。
- [x] 重复免费获取幂等；换请求复用幂等键冲突。
- [x] 未授权、过期、错组织、错项目、错环境、错 Release、缺权利、超额度均拒绝调用。
- [x] Offer 后续改价或改条款不影响历史订单证据。
- [x] 普通下架与高危召回语义分开。
- [x] 企业二创至少能记录 `baseReleaseId + entitlementId + lineageDigest`，无 `derive` 权拒绝。
- [x] 公共投影不含 Candidate、本地路径、身份、企业正文和密钥。
- [x] 跨域 E2E 跑通“发布者→商品→免费 Offer→企业订单→Entitlement→允许调用”。
- [x] `node --test trusted-supply/test/*.test.mjs` 全量通过。

## 不做什么

- 不接真实支付、退款、发票、税务、提现或银行账户。
- 不做多币种、动态定价、竞价、多级分销或自动分账。
- 不做创作者中心和市场页面；它们属于 V4.4/V4.5。
- 不对接 `code.zaowuyun.com` 或企业工作台。
- 不执行第三方技能或脚本，不调用付费模型。
- 不开放 UGC 自动上架，不允许 AI 自动审批、定价或封禁。

## 并行工作包

- A：`trusted-supply/lib/market/*` 与对应单测——Publisher、AbilityProduct、ApplicationRelease。
- B：`trusted-supply/lib/commerce/*` 纯领域文件与对应单测——LicensePolicy、Offer、Order、Entitlement、AccessDecision。
- C：商业追加式账本、Registry 联合公共投影与跨域 E2E。
- 主线：规格、ADR、公共导出、全量回归和文档状态。
