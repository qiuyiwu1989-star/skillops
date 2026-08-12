# 009: V3.7 独立人类终审与持续再认证

## 要什么

在完整技能包、全包审计、SMS 与 Eval 证据之上增加真正独立的人类终审。市场的精选与完整包安装资格不再由任意 reviewer 字符串或 Agent 建议产生，而由同一证据快照上的两个不同、可验证人类身份共同批准；批准有期限，证据或策略变化立即失效，历史始终保留。

## 用户闭环

`当前证据快照 → Agent 辅助建议（不计票） → 两名独立人类终审 → 限时认证 → 精选/安装 → 到期或变化撤架 → 两人再认证`

## 核心判断

- SMS 是静态潜力，Eval 是运行实绩，人审是责任确认；三者不能互相冒充。
- `agent_assisted` 只能形成 advisory，不得形成 approve、有效期或独立人审票数。
- 四眼规则按可信身份系统映射后的稳定 `principalId` 去重，不按姓名、邮箱或 provider 内 subject 去重。
- 身份语法校验不等于身份验证。生产接缝必须只接受可信 IdP adapter 返回的验证回执；CLI 任意字符串不能直接生成合格身份。
- 认证绑定不可变证据快照，而不是候选状态字符串。

## 终审策略契约

策略 `reviewPolicy` 必须包含：

- 稳定 `policyId + policyVersion + policyDigest`；任何字段变化都生成新 digest。
- `minimumIndependentHumanApprovals >= 2`，V3.7 默认 2。
- `approvalValidityDays`，V3.7 默认 90，最大 365。
- 可信身份提供方 allowlist。
- 是否强制完整 package、当前 SMS 与当前 Eval；完整包安装/精选策略全部强制。
- 默认禁止提交者给自己计票；接缝可额外传入利益冲突 principal 清单。

## 证据快照

终审的 `evidenceSnapshot` 固定绑定：

- `contentFingerprint`
- `packageDigest`
- `licenseDigest`
- `smsDigest`
- `evalDigest`
- `policyDigest`

以上字段共同生成 `evidenceDigest`。内容、附件、许可结论、SMS 结果、Eval 结果或审核策略任一变化，旧认证都返回 `stale` 和明确原因；不得仅改回候选的 `approved` 字段恢复货架。

接缝层应对规范化许可结论、完整 SMS 对象和完整 Eval 结果计算稳定 digest，禁止绑定展示文案或易变时间文本。

## 身份与终审事件

人类 reviewer 必须包含：

- `kind: human`
- 组织内稳定 `principalId`
- IdP 的 `provider + subject`
- 当前有效的 verification 回执：`verifiedAt / expiresAt / reference`

人类终审事件包含 `approve / reject / request_changes`、中文理由、证据与策略 digest、时间和 reviewer 快照。批准事件的 `validUntil` 不得超过策略期限。

Agent 事件必须是 `type: agent_assisted`、`decision: advisory`，只允许写 recommendation 与理由；无论建议质量如何都不计入四眼。

所有 attestation 与 lifecycle event 只追加，不覆盖、不删除。ID 由规范化事件生成，存储层仍需执行 append-only 前缀校验。

## 认证状态机

| 状态 | 条件 | 货架处理 |
|---|---|---|
| `pending` | 当前快照不足两名独立有效人审 | 不精选、完整包不可安装 |
| `certified` | 同一快照、同一策略，两名不同且无冲突的人类有效批准 | 可进入精选/安装下一道门 |
| `changes_requested` | 当前快照存在未闭环修改请求 | 撤出 |
| `rejected` | 当前快照存在未闭环人类拒绝 | 撤出 |
| `expired` | 曾满足四眼但批准已到期 | 自动撤出，等待再认证 |
| `stale` | 内容/package/license/SMS/Eval/policy 已变化 | 自动撤出，重新取证与终审 |
| `withdrawn` | 发行方或运营人类主动撤回 | 撤出 |
| `recalled` | 安全/合规事件召回 | 立即撤出并传播到后续 Registry |

同一 reviewer 的重复批准只计一票。提交者和显式利益冲突 reviewer 不计票。人类拒绝或修改请求之后，旧批准不再计数；同一快照若要恢复，必须在阻断事件之后重新取得完整四眼。

撤回、召回只作用于其绑定快照；申诉只记录请求，不自动恢复认证。修复后生成新证据快照，并重新走两人终审。到期但证据未变时可在同一快照上追加新一轮两人批准，旧事件继续保留。

## Candidate/Store 接缝（主 Agent 实现）

- Candidate 增加 `reviewPolicy`、`reviewEvidence`、append-only `reviewAttestations`、`reviewLifecycleEvents` 和当前 `certification` 投影。
- 兼容读取旧 `reviewEvents`，但旧任意 reviewer 字符串不能迁移成 certified；只能展示为 legacy history。
- `reviewCandidate` 拆为 Agent advisory 与受信 IdP 人类 attestation 两条路径。
- `toListing` 的精选和完整包 `install.eligible` 必须要求当前 `certification.status === certified`；来源索引可以保留但明确“未终审，不可安装”。
- `refreshCandidate`、`assessSms`、`recordEval`、`recordPackageAudit` 与许可重新分类后统一重算 snapshot/certification；变化返回 stale 而不是删除历史。
- Store 对 attestation 与 lifecycle event 执行 append-only 前缀验证。

## CLI 与运营接缝（主 Agent 实现）

- `review-advisory`：记录 Agent 辅助建议，不能批准。
- `review-attest`：只消费已配置可信 IdP adapter 的验证回执；不接受单独 `--reviewer 任意字符串` 进入 certified。
- `review-status`：展示缺少票数、冲突排除、stale 原因与到期时间。
- `review-withdraw / review-recall / review-appeal`：形成只追加生命周期事件。
- `review-recertify`：本质是当前快照上新一轮人类 attestation，不篡改旧事件。

## 分阶段实施

### A · 核心策略（本工作包）

- 稳定 policy/evidence digest、验证身份结构、四眼计票、期限、stale 原因、撤回/召回/申诉与单元测试。
- 文件边界：新增 `trusted-supply/lib/review-policy.mjs` 与独立测试。

### B · Candidate/Store 接缝

- 新事件流、当前投影、自动失效、旧事件兼容、append-only 守卫。

### C · CLI、市场与运营队列

- IdP 回执入口、待审/到期/撤回队列、listing 与中文详情证据。

### D · 独立验收

- 黑盒覆盖同快照两人批准、Agent 越权、同人重复、提交者/冲突、到期、六类变化、拒绝、撤回、召回与再认证。

## 验收清单

- [x] policy 与 evidence digest 稳定，调用者伪造 digest 失败关闭。
- [x] 两个不同的可信人类 principal 才能 certified；同人重复不计。
- [x] Agent 建议无法批准、生成有效期或计入四眼。
- [x] 不可信/过期身份失败关闭，提交者与利益冲突身份不计票。
- [x] 内容、package、license、SMS、Eval 与 policy 变化返回具体 stale 原因。
- [x] 到期后必须追加新一轮两人批准才能再认证，历史不变。
- [x] 人类拒绝、撤回、召回阻断；申诉不自动恢复。
- [ ] Candidate/Store 接缝与 append-only 投影完成。
- [ ] CLI、市场详情、待审与到期运营队列完成。
- [ ] 全量回归与桌面/移动端浏览器验收通过。

## 不做什么

- 不自建账号、密码、MFA 或 IdP；核心只验证受信 adapter 回执的契约。
- 不让 Agent、SMS 或 Eval 自动批准市场发布。
- 不修改或删除历史终审事件。
- 不连接造物云生产，不自动执行第三方技能，不读取模型/API 密钥。

## 状态

core policy implemented locally on 2026-08-13; Candidate/Store/CLI/market integration pending
