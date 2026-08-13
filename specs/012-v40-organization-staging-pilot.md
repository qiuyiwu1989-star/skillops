# 012: V4.0 组织治理与造物云 Staging 试点

## 要什么

把 V3.7–V3.9 已完成的可信审核、Registry、托管分发和 HRD 治理能力，接入一个不触碰生产的小规模组织试点。首个试点使用训练营/永乐教育的抽象组织夹具，验证技能从外部候选到组织入编、造物云 staging 发布、受控安装、绩效与退役的完整证据链。

## 本阶段交付

### A. 首批技能实证

- 从现有 SkillHub 候选中选择最多 3 个技能，逐项判断完整包、许可、包审计、SMS、Eval 与双人终审是否齐全。
- 只为完整包建立固定离线 Eval 测试集；每个测试集至少 3 个案例。
- 证据缺失时输出结构化阻断原因，不补写虚假许可、测试结果或人工身份。
- 形成可重放的 `pilot readiness` 报告，明确 `source_only / evidence_pending / release_ready`。

### B. 组织治理核心

- 定义 Organization、Project、Establishment、Enrollment、Policy、RoleBinding 与 AuditEvent。
- 技能入编必须绑定稳定 `skillId` 与明确 `releaseId`，禁止使用 `cand_*` 或 `latest`。
- 组织策略可规定 SMS、Eval、双人终审、版本锁定和允许的分发状态。
- 角色至少区分 `viewer / member / reviewer / operator / org_admin`，敏感动作必须显式授权。
- 所有治理状态由 append-only 事件重放产生；公共投影不得泄露人员原始身份、路径、prompt、output 或 token。

### C. 造物云 Staging 接缝

- 只消费 Registry 公共 Release 投影，不读取 CandidateStore。
- 支持 `upsert / withdraw / supersede / revoke` 的 dry-run、staging 发送和幂等回执。
- 发布前生成确定性差异与 confirmation digest；没有精确确认不得发送。
- staging transport 必须注入，核心库不得内置生产 URL、密钥或通用网络客户端。
- 保存裁剪后的发送台账与回执；失败不得推进本地发布游标。

## 不做什么

- 不连接造物云生产，不修改冻结的 `api-server/`、`xiaoneng/`、线上站点或服务器配置。
- 不自动执行第三方技能、脚本或模型调用，不批量消耗付费额度。
- 不伪造许可证、Eval 实绩、下载量、评论、评分或人工终审。
- 不建设支付、推荐算法或完整多租户 SaaS。
- 不把插件、方法、应用、数字员工压成 Skill；仅为未来 relations 保留引用能力。

## 验收清单

- [ ] 首批最多 3 个技能生成确定性 readiness 报告；证据不足时失败关闭。
- [ ] 组织策略阻止 `cand_*`、`latest`、未认证、证据过期或已撤回 Release 入编。
- [ ] 两个不同组织的数据、角色和审计投影不可串读。
- [ ] 未授权角色不能发布、更新、退役、恢复或改变组织策略。
- [ ] 同一治理事件重放幂等；同一 operation 不同摘要返回冲突。
- [ ] staging dry-run 零外部写；错误 confirmation 零发送；正确 confirmation 只发送一次。
- [ ] staging 失败不写成功回执、不推进 cursor；重试保持相同幂等键。
- [ ] public projection 与台账不含 reviewer principal、路径、storageRef、正文、prompt、output、token 或 secret。
- [ ] 从 ready Release 到组织入编、staging 回执、受控安装计划形成离线端到端测试。
- [ ] 全仓自动化测试通过，`node --check` 与 `git diff --check` 通过。

## 实现约束

- 零新增运行时依赖，优先 Node.js 内置模块和现有确定性摘要工具。
- 新增模块优先放在 `trusted-supply/lib/`；SkillOps CLI 只在核心契约稳定后接入。
- 时间、transport、身份回执均通过参数注入，测试不得依赖公网。
- 组织治理与 staging 台账使用原子写或纯内存 fixture；事件只能追加。
- 所有安装资格继续服从 V3.5–V3.9 的包、安全、许可、SMS、Eval、双人终审与生命周期门禁。

## 分阶段

1. `V4.0-A`：首批技能 readiness + 组织治理核心 + staging 确认发送核心并行实现。
2. `V4.0-B`：可信 IdP 回执、组织治理 CLI、跨模块 E2E 与中文运营视图。
3. `V4.0-C`：训练营/永乐教育单组织 staging 演练和 go/no-go 报告；生产连接另行授权。

## 状态

approved
