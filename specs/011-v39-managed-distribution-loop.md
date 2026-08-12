# 011: V3.9 市场托管分发与 HRD 管理闭环

## 要什么

让 Registry 中已发布、可分发的 Release 能安全进入用户自己的 Agent 目录，并在版本变化、质量退化或撤回时形成可解释、可恢复的管理动作：

`订阅 → 选择 Release → 安装预检 → 原子安装 + lock → 三方漂移 → 更新计划 → 复评 → 培训 → 退役/恢复`

SkillOps 仍不当运行时：不替技能执行生产任务，不接管用户的 Agent，不远程删除本地文件。技能真身仍是用户卷内的 SKILL.md 文件夹；Registry 包是经过信任审核的分发版本，lock 是受控副本台账。

## 前置与阶段门

- 必须消费 V3.8 Registry feed/API，不能从 CandidateStore 或市场 HTML 安装。
- 安装对象必须是具体 `skillId + releaseId + packageDigest`，不能是 `cand_*` 或可变的 `latest` 字符串。
- 复用现有 deploy 的安全底座：未知目标不覆盖、目标漂移不覆盖、拒绝 symlink/特殊文件、同盘临时目录、原子 rename 与 lock 原子替换。
- V3.9 本地/fixture 可先实现；远程生产 Registry、造物云生产和真实遥测上传均需另行授权。

## 核心实体

### RegistrySource

```json
{
  "sourceId": "regsrc_…",
  "baseUrl": "https://registry.example/v1",
  "channel": "stable",
  "trustAnchor": { "kind": "digest", "value": "sha256:…" },
  "cursor": "…",
  "status": "active",
  "lastSyncAt": "…"
}
```

- sourceId 标识一个 Registry 订阅，不复用供给侧 `src_*`。
- 凭据仅存系统安全存储的引用；lock、日志和遥测不能包含 token。
- sync 先验证 envelope/schema/digest/sequence，再原子推进 cursor；断档、降序和 trust anchor 变化进入 `blocked`。

### Installation 与 Lock

```json
{
  "installationId": "inst_…",
  "skillId": "qiuyiwu/humanizer",
  "releaseId": "rel_…",
  "version": "1.2.0",
  "packageDigest": "sha256:…",
  "registrySourceId": "regsrc_…",
  "targetPath": "…",
  "deployedFingerprint": "sha256:…",
  "trustSnapshot": { "policyVersion": "…", "reviewValidUntil": "…", "feedCursor": "…" },
  "state": "clean",
  "installedAt": "…"
}
```

- lock schema 升级时保留现有 `sourceFingerprint/deployedFingerprint`，新增 Registry 身份与信任快照；迁移必须可回滚并保留旧文件备份。
- `targetPath` 只保存在本机 lock，不进入公共事件或遥测；对外用随机 `installationId`。
- 状态投影：`clean | update_available | target_drift | source_drift | review_stale | withdrawn | revoked | missing | blocked`。多个问题同时存在时保留 reason 列表，不能拼字符串丢失结构。

### UpdatePlan / Reassessment / CoachProposal / Retirement

- **UpdatePlan**：不可变地记录 from/to Release、manifest 差异、trust/compatibility 差异、复评要求、漂移状态、计划摘要和用户确认；计划本身不修改文件。
- **Reassessment**：绑定目标 Release/package、suite、runner/policy，区分 `required/passed/failed/stale/waived`；waiver 必须是显式、可过期、可审计的人类决定，不能跨 Release 继承。
- **CoachProposal**：基于一个明确 source/release 和弱项证据生成建议或补丁，输出到隔离工作副本；接受后形成新的本地 source revision/candidate，永不改写已发布 Release 或已安装目录。
- **Retirement**：对用户卷中 Skill 的可逆状态事件，包含依赖检查、替代项和迁移指引。Registry withdraw/revoke 与本地 retire 是不同动作。

## 事件模型

本地管理日志 append-only，lock 与状态页是投影：

| 事件 | 触发与结果 |
|---|---|
| `registry.source_added/updated/blocked` | 配置订阅或信任锚变化；敏感凭据只记引用。 |
| `registry.sync_completed/failed` | 保存 from/to cursor、事件数、snapshot digest 与错误码。 |
| `install.planned` | 预检具体 Release、许可、审计、人审、manifest、目标所有权和空间。 |
| `install.completed/failed` | 原子安装并提交 lock，或完整回滚；失败不能留下半安装。 |
| `drift.detected/resolved` | 对比卷、lock 目标与 Registry 推荐 Release 的三方状态。 |
| `update.available/planned/applied/blocked` | 生成明确升级计划；目标漂移、撤回、吊销、复评失败均阻断自动应用。 |
| `reassessment.required/completed/expired` | 新 Release、suite/policy/环境变化触发复评。 |
| `coach.proposed/accepted/rejected` | 建议进入工作副本；只有接受才产生新的源 revision。 |
| `retirement.proposed/confirmed/restored` | 检查依赖后可逆退役或恢复；永不删除技能目录。 |
| `registry.withdraw_observed/revoke_observed` | 标记本地安装与更新策略；不远程删除用户文件。 |

每个事件包含随机唯一 `eventId`、`installationId/skillId/releaseId`、`occurredAt`、`actorRef`、`reasonCode`、`payloadDigest`。重放同一事件必须幂等；任何直接编辑历史事件或 lock 回退版本必须被审计检测。

## CLI 与 API 行为

### Registry source

- `skillops registry source add <url> --channel stable --trust <digest>`：只新增订阅，先 dry-run 握手并展示将信任的主体。
- `skillops registry source ls`：显示源、游标、同步健康和信任锚摘要。
- `skillops registry sync [source]`：拉取 snapshot/feed，验证后原子推进本地缓存；不安装、不更新。

### Install / update / withdraw

- `skillops install <skillId>[@<version>] --from <source> --to <root> [--dry-run]`：解析为具体 releaseId，展示许可、包、SMS、Eval、人审和文件计划；无显式确认的自动化调用仅可 dry-run。
- `skillops update <skillId> [--to <version|releaseId>] [--dry-run]`：先生成 UpdatePlan。默认 `notify`，不得静默追随 latest；`pinned` 永不自动越过 pin。
- `skillops withdraw <skillId|releaseId> --reason <code>`：仅供有发布权限的 Registry 管理面生成撤回请求；本地 CLI 默认只生成签名请求/fixture，不因同名命令删除本地文件。

### Eval / coach / retire

- `skillops eval <skillId> [--release <releaseId>]`：调用 V3.6 质检接口，对目标 Release 生成复评证据；真实模型 adapter 仍需用户显式授权并使用用户自己的算力。
- `skillops coach <skillId> --from <evidenceId>`：输出弱项解释、修改计划与隔离副本，默认不写回真身；接受后重新走 Package → Eval → Review → Registry。
- `skillops retire <skillId> [--replacement <skillId>]`：先检查本地依赖、安装与组织引用，展示迁移计划；主人确认后标记 `retired` 并归档，可 `--restore`，绝不删除文件。

统一本地命令结果 envelope：

```json
{
  "schemaVersion": 1,
  "operationId": "op_…",
  "action": "install.plan",
  "status": "ready",
  "subject": { "skillId": "…", "releaseId": "…" },
  "changes": [],
  "warnings": [],
  "requiredConfirmations": [],
  "evidenceRefs": [],
  "error": null
}
```

机器模式只输出该 envelope；人类模式使用中文说明。错误必须有稳定 `code`、可操作建议和是否可重试标记，不能仅依赖自然语言解析。

## 安装、幂等与原子性

1. 解析具体 Release，并验证 Registry 状态不是 withdrawn/revoked。
2. 拉取 manifest 与包到隔离缓存；重算 package digest、逐文件 hash、路径和许可边界。
3. 核对当前 Package Audit、SMS、Eval、人审有效期与本地组织政策。
4. 验证目标根、所有权、lock、当前目标指纹与空间；未知目录和 target drift 失败关闭。
5. 生成 UpdatePlan/InstallPlan 与确定性 `planDigest`；确认必须绑定该 digest，计划变化后旧确认失效。
6. 复制到同盘临时目录并复算摘要；rename 切换目标后原子提交 lock 和事件。任一步失败恢复旧目标与旧 lock。

同一 `operationId + planDigest` 重试返回既有结果；同 operationId 换 planDigest 返回冲突。安装同一 release 到同一 installation 且指纹一致返回 `unchanged`。不以文件名、版本别名或缓存时间判断成功。

## 更新、兼容与复评政策

- Registry 的 supersede 只产生 `update_available`，不等于允许安装。UpdatePlan 必须比较 package、许可、安全、兼容声明、依赖、SMS/Eval suite、review 和策略版本。
- SemVer 只影响风险提示，不绕过证据门：patch 也可能触发全包审计和 Eval；major 默认要求显式确认及迁移说明。
- 目标存在本地修改时，禁止覆盖；提供 `keep local / export patch / install beside` 计划选项，任何选择都需主人确认。
- 新 Release 必须重新验证 Registry 信任证据；Eval 不能从旧 package 继承。若本地政策要求的 suite/runner 与 Registry 证据不一致，状态为 `reassessment.required`。
- 复评失败保持旧 Release 和 lock 不变；过期评估撤出自动更新资格，但不破坏已安装技能。
- withdrawn：停止新安装/推荐更新，既有安装显示迁移提示。revoked：阻断新安装和更新，既有安装显示紧急告警与隔离/替代计划；仍不远程删除。
- Registry source 暂时不可达时只允许使用已缓存且未过本地策略有效期的 pinned Release；不得把“网络失败”当“仍可信”。

## HRD 闭环政策

### 绩效与退化

- 默认只在本地记录调用是否发生、成功/失败枚举、耗时桶、releaseId 和时间桶；不记录 prompt、输出、文件内容和用户任务名称。
- 未显式 opt-in 不上传遥测。上传时只发送聚合桶，使用随机 installationId，不发送本地路径、用户名、设备名或组织成员明细。
- 退化判断至少需要稳定样本门槛，并区分 Release 变化、环境变化与 Eval policy 变化；样本不足显示“证据不足”，不能判低绩效。

### 培训 Coach

- coach 使用 SMS 弱维、Eval 失败 case 与明确的使用错误码形成建议；外部模型调用需要单次授权与数据预览。
- proposal 必须保留 base package digest、生成者、输入证据、patch digest 与时间；不接受脱离 base 的模糊覆盖。
- 接受 proposal 后创建新 source revision，重新走可信供给链；coach 分数不能替代 Eval 或独立人审。

### 退役 Retire

- 先建立依赖图：部署、组合技能、组织编制、当前项目引用和推荐后继。依赖未知即不可宣称“安全退役”。
- 退役只标记状态并移动到可恢复归档；Registry 发布者如需撤下另发 withdraw/deprecate 事件。
- retired Skill 的既有 lock 保持可解释；新部署默认阻断，恢复后仍需重新检查 Release 与证据有效期。

## 撤回、召回和权限边界

- `withdraw`、`revoke`、`retire` 三者分离：撤回是发布可见性，吊销是信任紧急状态，退役是用户/组织的人事决定。
- Registry 撤回请求需要发布权限、reason、subject 和幂等键；安全吊销需要更高权限与双人规则，继承 V3.7 审核身份体系。
- 下游收到事件后先写本地事件与状态，再通知用户；通知失败不丢状态，处理重复通知不重复动作。
- 平台不能借 revoke 获得删除本地技能的权力；只提供 quarantine/migrate/export 计划，由用户或组织授权执行。

## 隐私、安全与兼容

- lock 权限为当前用户最小可读写；日志、错误和导出自动裁剪 token、绝对路径、prompt、输出和私有 Registry URL 查询参数。
- 包内容永不发送给遥测服务；coach/eval 的数据出境前展示字段清单并取得显式授权。
- schema 使用 major 版本失败关闭、minor 扩展可忽略的规则；升级 lock 前生成备份并在异常时恢复。
- V3.9 不做平台运行时、远程 Agent 控制、后台执行第三方脚本、静默自动更新、无授权模型评测或生产造物云写入。

## 后续可并行工作包与依赖

### A · Registry Client 与本地缓存

- 实现 source 管理、snapshot/feed 校验、游标、信任锚、离线缓存与断档恢复。
- 依赖 V3.8 API/feed；与 C 的政策引擎可并行。

### B · Installer 与 Lock v2

- 把 `releaseId/packageDigest/trustSnapshot/installationId` 接入现有 deploy，完成迁移、预检、计划摘要、原子回滚和结构化漂移。
- 依赖 V3.8 Release/manifest schema；可使用本地 Registry fixture，不等待真实服务。

### C · 更新与复评策略

- 实现 update diff、SemVer 风险、withdraw/revoke、assessment expiry、suite/policy 变化和 `reassessment.required` 状态机。
- 依赖 V3.6 Eval、V3.7 review policy、V3.8 Release 事件；与 B 并行后在 UpdatePlan 汇合。

### D · HRD Coach / Metrics / Retire

- 实现最小本地遥测、退化规则、隔离 coach proposal、依赖检查、可逆退役和恢复。
- 依赖稳定 `skillId/releaseId`；不依赖远程遥测服务。

### E · CLI 与中文交互

- 串联 registry source/install/update/withdraw/eval/coach/retire，统一 JSON envelope、中文预览、确认和错误码。
- 依赖 A–D 的公共接口；界面工作可先基于 fixtures 并行。

### F · 独立安全验收

- 覆盖断档/重放、hash 不符、未知目录、目标漂移、安装中断回滚、过期人审、复评失败、撤回/吊销传播、coach 不改真身、retire 可恢复和隐私裁剪。
- 依赖 A–E；验收不得执行第三方技能或连接生产。

## 验收清单

- [ ] 所有安装 lock 绑定 `skillId + releaseId + packageDigest + registrySourceId`，不含 `cand_*`，旧 lock 可安全迁移/回滚。
- [ ] install/update 重试幂等；hash 不符、未知目录、target drift、证据过期和 withdrawn/revoked 全部失败关闭。
- [ ] 安装或更新任一步故障后目标与 lock 要么全旧、要么全新，不存在半安装。
- [ ] Registry/卷/目标三方漂移形成结构化 reason；source 不可达、证据不足和真正漂移不混为一类。
- [ ] update 只生成明确计划，未经 planDigest 绑定确认不静默切换版本；复评失败保留旧版本。
- [ ] withdraw/revoke 能幂等传播且不远程删除本地文件，retire 可恢复并有依赖/迁移报告。
- [ ] coach 只写隔离 proposal，接受后产生新 source revision 并重新走 Package/Eval/Review/Registry。
- [ ] 默认遥测完全本地且不含 prompt、输出、内容、路径或个人身份；未 opt-in 无网络上传。
- [ ] CLI 人类模式全中文、机器模式 envelope 稳定；全量既有测试保持通过并新增端到端安全测试。

## 不做什么

- 不把 SkillOps 变成技能执行或 Agent 生产运行时。
- 不从 CandidateStore、市场卡片或可变 `latest` 直接安装。
- 不静默自动更新，不绕过漂移、复评和人类确认。
- 不远程删除、改写用户真身或上传未授权遥测。
- 不连接造物云生产，不在本版实现组织控制平面。

## 状态

spec proposed; implementation not started; runtime and production integration unauthorized
