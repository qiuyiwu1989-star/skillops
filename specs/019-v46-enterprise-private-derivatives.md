# V4.6 企业私有能力、授权二创与版本演进

## 状态

done

## 要什么

让企业在已获得合法授权的前提下，把公开技能或企业自研技能建立为组织私有能力，并形成一条可审计、可升级、可回滚且不跨租户泄露的版本链：

`企业自研 / 已授权技能 → 私有能力项目 → 不可变私有 Release → 测试与审核 → 入企业能力库 → 上游比较 → 显式升级或回滚`

SkillOps 仍是技能 HRD 与可信治理层，不托管企业业务正文，不执行技能，不自动公开或再销售企业二创。

## 企业私有能力

- 企业私有 Product 与 Release 必须绑定可信 organization、稳定 skill identity、不可变 package digest、来源类型和创建证据。
- 来源固定为 `self_authored | authorized_derivative`；二创必须绑定 base Release 与有效 Entitlement，且具备 `derive` 权。
- 私有 Release 只允许组织范围内的可信 authorizer 查询；公共投影只能给出聚合数量，不得暴露标题、版本、包、血缘或成员身份。
- 每个新 Release 都是追加式记录；不得覆盖旧版本，不得把私有 Product 直接伪装成公开市场 Product。
- 私有 Release 进入企业能力库前必须绑定当前 package audit、SMS、Eval 和组织复核状态；缺失证据只能显示 `evidence_pending`。
- 企业成员离职、项目变化或权限收回不得删除历史；只改变访问资格和当前状态。

## 二创血缘

- 二创创建必须由受信 Entitlement resolver、组织 authorizer、基础 Release resolver 与 Product resolver 联合验证。
- 血缘至少绑定 organizationId、privateProductId、baseProductId、baseReleaseId、entitlementId、license snapshot digest、创建时间和 lineage digest。
- 授权范围、期限、项目、环境与 `derive` / `internal_distribute` 权利必须同时满足；调用者自带的 Entitlement、时间或组织声明不作为信任证据。
- 一个私有 Release 可以基于上一个私有 Release 演进，但必须始终保留最初公开/企业基础 Release 的 root lineage。
- 普通下架不抹除既有合法二创；安全召回、授权撤销或许可证禁止升级时，后续发布与升级失败关闭并进入人工处置。
- 默认不允许公开再销售；`redistribute_derivative` 仅作为未来审核输入，本阶段不生成公开 Offer。

## 上游比较、升级与回滚

- 比较必须固定 current private Release、current base Release、proposed upstream Release 与三份 package manifest。
- 输出确定性差异：新增、修改、删除文件；许可、安全、权限、兼容、依赖和证据变化；不得输出文件正文。
- 升级计划必须给出 `ready | reassessment_required | blocked | no_change`、原因、需重跑的 Package Audit/SMS/Eval/Review 和 migration notes。
- 上游新版本不能继承旧 Eval、终审或调用授权；新私有 Release 必须重新形成证据。
- 回滚只允许指向该组织、同一 private Product 的既有不可变 Release；要求明确 planDigest 确认，追加 rollback event，不删除失败版本。
- recall/revoke、目标不存在、跨组织、包摘要不匹配、证据失效、目标漂移或未知依赖均失败关闭。

## 企业技能开发台

- 中文只读工作台显示私有能力、来源、当前版本、证据、血缘、上游差异、升级/回滚状态和下一动作。
- 清楚区分“企业自研”“授权二创”“待复评”“可用”“已召回”“已回滚”。
- 页面只消费脱敏公共组织投影；不包含 SKILL.md 正文、Prompt、Output、密钥、本地路径、成员身份或 CAS 地址。
- 首版使用本地 fixture，不提供上传、编辑、执行、发布、支付或生产工作台连接。

## 验收清单

- [x] 企业自研和授权二创均可创建稳定私有 Product/Release，旧版本不可覆盖。
- [x] 二创缺 derive 权、授权过期、Release 越界、跨组织或调用者伪造信任证据时失败关闭。
- [x] 组织 A 无法读取、比较、升级、回滚或枚举组织 B 的私有能力。
- [x] 私有 Release 缺当前 Package Audit/SMS/Eval/Review 时不能进入 callable 状态。
- [x] 上游比较只输出 manifest 与治理差异，不泄露文件正文或私有路径。
- [x] 上游变更使新版本的 Eval/Review 重新待办，不继承旧证据。
- [x] 回滚需精确 planDigest，追加事件且保留原版本；重复请求幂等、不同摘要冲突。
- [x] recall/revoke 在新提交、升级或回滚后仍保持阻断，不得降级为普通下架。
- [x] 企业开发台具备中文空态、错误态、移动端、暗色、键盘焦点和低动效。
- [x] 跨域 E2E 跑通免费授权 → 私有 Fork → 新私有 Release → 复评 → 入库 → 上游升级比较 → 回滚。
- [x] 独立安全审查 P0=0、P1=0。
- [x] trusted-supply、market-preview 与便携 CLI 全量测试通过。

## 不做什么

- 不上传或托管企业 SKILL.md 正文、测试输入输出、业务数据或密钥。
- 不实现在线编辑器、模型执行、自动合并、自动升级、自动回滚或生产部署。
- 不允许企业二创自动公开、自动再售或绕过权利/市场复核。
- 不接真实支付、退款、结算、发票或创作者分成。
- 不修改冻结中的 `api-server/`、`xiaoneng/`、生产服务器或 `code.zaowuyun.com`。

## 并行工作包

- A：企业私有 Product/Release、租户隔离、证据资格与私有投影 Store。
- B：授权 Fork 血缘、上游 manifest 比较、升级与回滚计划/台账。
- C：中文企业技能开发台、fixture、跨租户与跨域 E2E。
- D：独立安全审查、全量回归、路线图与交付提交。
