# 013: V4.0-B 可信身份、持久台账与中文运营入口

## 要什么

把 V4.0-A 的纯内存组织治理与造物云 staging 核心升级为可恢复、可审计、可由中文 CLI 和本地运营视图使用的 staging 产品闭环。所有敏感动作仍需要显式确认，所有外部能力继续通过注入式 fixture 实现。

## A. 可信 IdP 回执

- 定义版本化、可验证的身份回执，至少包含 provider、用途、subject digest、human/service 类型、签发时间、过期时间和 receipt digest。
- 原始 principal、subject、邮箱、token、provider secret 不得进入公共投影、组织台账或 staging 台账。
- 回执只能由显式受信 provider verifier 产生；调用者自填 `verified` 不算可信证据。
- 提供到 V3.7 reviewer 结构的受限适配，保持双人终审、不同主体、有效期和 provider policy 门禁。

## B. 持久化台账

- `OrganizationGovernanceStore` 原子保存 append-only 组织事件，写前后均重放校验；并发旧版本写入失败关闭。
- `ZaowuyunStagingStore` 原子保存 cursor、operation binding 与裁剪回执；重启后同 operation 幂等，换摘要冲突。
- staging 发送采用 prepare/transport/commit 三段式；本地提交失败必须形成 `reconciliation_required`，不得伪称可安全重发。
- 台账大小、事件数量、单事件大小有硬限制；符号链接、目录目标、越界路径和篡改 JSON 失败关闭。

## C. 中文治理入口与运营视图

- CLI 支持组织状态、事件规划/提交、staging 规划/状态；成功 stdout 为纯 JSON，失败 stderr 为中文与稳定错误码。
- CLI 不接受生产 URL、secret、任意网络 transport 或调用者自填可信回执。
- 本地运营视图展示组织、编制、入编、角色数量、审计事件、staging cursor、已接收与待对账状态。
- 视图只消费公共投影/裁剪台账，不展示 principal、正文、路径、prompt、output、token。

## 不做什么

- 不连接真实 IdP、造物云生产或任意公网 API。
- 不在浏览器内执行治理写操作；运营页保持只读。
- 不实现完整账号系统、登录、支付、多租户计费或生产密钥管理。
- 不修改冻结的 `api-server/`、`xiaoneng/` 与线上站点。
- 不自动执行技能或第三方脚本。

## 验收清单

- [x] 自填 verified identity、过期回执、错误用途、未知 provider、回执篡改均失败关闭。
- [x] 两个不同有效 human receipt 可满足四眼规则，同一 subject digest 不可重复计票。
- [x] 组织台账重启后投影一致；篡改、并发旧版本、符号链接与原子写故障零污染。
- [x] staging 台账重启后同 operation 幂等；提交不确定时标记待对账并阻止盲重发。
- [x] CLI 黑盒覆盖组织查询/提交与 staging dry-run/status，输出中文且不泄露身份或秘密。
- [x] 运营视图展示组织和 staging 状态，空态、错误态、移动端和暗色模式可用。
- [x] 运营视图没有治理写按钮，没有生产连接入口，也不请求外部字体或资源。
- [x] 全仓测试、`node --check` 和 `git diff --check` 通过。

## 实现约束

- 零新增运行时依赖，使用 Node.js 内置 crypto/fs/path。
- 核心契约在 `trusted-supply/lib/`；便携 CLI 通过相对路径接入，浏览器视图只消费构建后的公共 JSON。
- 时间、verifier、transport、故障注入均可测试；默认不得联网。
- IdP verifier 的 fixture 只证明协议和失效边界，不声称接入真实身份平台。

## 工作包

1. `V4.0-B1`：可信 IdP receipt/verifier 与 reviewer adapter。
2. `V4.0-B2`：组织治理和 staging 原子台账、恢复与对账状态。
3. `V4.0-B3`：中文运营只读投影与页面。
4. `V4.0-B4`：中文 CLI、跨模块 E2E、安全复核。

## 状态

done
