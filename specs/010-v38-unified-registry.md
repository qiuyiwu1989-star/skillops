# 010: V3.8 统一 Registry 身份与造物云发布投影

## 要什么

在 Candidate 可信供给链与公开市场之间建立唯一的发布边界：候选池负责采集和审核，Registry 只接收已经满足当前 Package、SMS、Eval 与人类终审策略的不可变 Release。任何市场、CLI 或造物云适配器只能消费 Registry 发布投影，不能直接读取候选池。

本版只完成本地 Registry、只读 feed/API、离线造物云投影与契约测试；不连接造物云生产，不修改冻结中的 `api-server/`、`xiaoneng/` 或线上站点。

## 身份边界

| 身份 | 例子 | 生命周期 | 用途与禁止事项 |
|---|---|---|---|
| `skillId` | `qiuyiwu/humanizer` | 长期稳定 | 产品身份，规范为小写 `namespace/name`；发布后不回收、不改绑。改名通过 alias 与 supersede 表达，不能复用旧 ID。 |
| `releaseId` | `rel_…` | 永久不可变 | 发布版本身份；由 `schemaVersion + skillId + version + packageDigest` 规范化后计算。任一内容变化必须产生新 Release；同一 `skillId+version` 不允许对应两个包。 |
| `sourceId` | `src_…` | 来源坐标稳定期 | 标识 GitHub、SkillHub、本地授权源等来源坐标，不代表产品身份。一个 Skill 可以有多个来源。 |
| `candidateId` | `cand_…` | 供给审核期 | 现有 `sourceIdentity` 派生的候选池内部 ID。可刷新、隔离、拒绝；永不作为市场路由、安装键、lock 键或造物云能力 ID。 |
| `packageDigest` | `sha256:…` | 内容永久稳定 | 完整文件包的内容证据；不是业务身份，但 Release 必须绑定它。 |
| `eventId` | `evt_…` | 永久唯一 | Registry 只追加事件的幂等键；重复提交相同事件返回同一回执，载荷不同则冲突。 |

`releaseId` 的 v1 计算输入为 UTF-8 字符串：`skillops.release.v1\0<skillId>\0<semver>\0<packageDigest>`，输出为 `rel_` 加 SHA-256 十六进制。显示用版本号不参与身份之外的可变格式化。

候选到发布的单向边界：

`source revision → candidateId → trust evidence → publish decision → skillId/releaseId → Registry projection`

- Candidate 可以被多个审计事件刷新，但一次发布必须冻结具体 `candidateId + source revision + packageDigest + assessment/review ids`。
- Registry 对外仅公开经过隐私裁剪的 provenance；内部 `candidateId` 可作为审计引用保存，不进入市场 URL 与普通公开 feed。
- 同包可由多个来源证明，但不能据此生成多个长期 Skill 身份；身份冲突进入人工仲裁，不自动合并。

## 实体模型

### Skill

```json
{
  "schemaVersion": 1,
  "skillId": "qiuyiwu/humanizer",
  "status": "active",
  "title": { "zh-CN": "文本去 AI 味", "original": "humanizer" },
  "description": { "zh-CN": "…", "original": "…" },
  "aliases": [],
  "createdAt": "…",
  "updatedAt": "…"
}
```

Skill 只保存跨版本稳定的目录信息；质量、安全、许可和安装资格必须来自具体 Release，不能挂在 Skill 上冒充当前事实。

### Release

```json
{
  "schemaVersion": 1,
  "releaseId": "rel_…",
  "skillId": "qiuyiwu/humanizer",
  "version": "1.2.0",
  "status": "published",
  "package": { "packageDigest": "sha256:…", "manifestDigest": "sha256:…", "storageRef": "cas:sha256:…" },
  "compatibility": { "contract": "skill-package.v1", "targets": ["claude-code"] },
  "assessmentRefs": ["sms_…", "eval_…"],
  "reviewRefs": ["review_…"],
  "sourceRefs": ["src_…"],
  "publishedAt": "…"
}
```

- Release 不可原地修改；标题翻译、货架归类等市场信息进入 Listing 投影版本。
- `compatibility.targets` 是经过格式检查的兼容声明，不等同于运行验证；经 Eval 验证的目标必须另列 evidence ref。
- `storageRef` 只供授权分发端解析，公开 feed 不泄露本地路径或内部 CAS 位置。

### Source / Assessment / Review / Listing

- **Source**：来源类型、规范坐标、上游 revision、许可证据摘要与采集时间；凭据、下载临时地址和本地路径不入 Registry。
- **Assessment**：绑定 `releaseId/packageDigest` 的 SMS、Eval、Package Audit 等不可变证据摘要；原始敏感输出留在受控证据库。
- **Review**：V3.7 产生的可验证终审、四眼规则、有效期和撤回状态；公开面只暴露角色、结论、时间和证据摘要，不暴露不必要的个人信息。
- **Listing**：面向一个 channel/locale 的可变发现投影，包含中文标题说明、分类、分发边界、当前推荐 Release 和信任摘要；Listing 变化不能改写 Release。

## 事件模型与状态机

Registry 以 append-only 事件为事实源，Skill/Release/Listing/feed 都是可重建投影。

| 事件 | 作用 |
|---|---|
| `skill.upserted` | 首次登记 Skill 或更新非身份目录字段。 |
| `skill.aliased` | 增加旧 ID 到新 ID 的永久解析关系；拒绝环与一对多。 |
| `release.published` | 发布一个满足当前政策的不可变 Release。 |
| `release.superseded` | 声明旧 Release 的推荐后继；旧 Release 与证据继续可查。 |
| `release.withdrawn` | 停止新发现和新安装；保留 tombstone、审计与既有 lock 可解释性。 |
| `release.revoked` | 安全/许可紧急撤回；下游必须高优先级传播，但不得远程删除用户文件。 |
| `listing.upserted` | 更新 channel/locale 的市场展示投影。 |
| `listing.withdrawn` | 从指定货架撤下，不删除 Skill/Release。 |
| `projection.receipted` | 记录下游消费的游标、动作和结果，不改变发布事实。 |

Release 主状态为 `published | superseded | withdrawn | revoked`，只允许向右收紧，不允许把同一 Release 从撤回/吊销改回 published；恢复发布必须创建新发布事件，并在需要时创建新 Release。所有事件包含 `eventId`、`sequence`、`occurredAt`、`actorRef`、`reasonCode`、`subject`、`payloadDigest` 与 `policyVersion`。

## 只读 API 与 Feed 契约

### 查询 API

- `GET /registry/v1/skills/{namespace}/{name}`：Skill 与当前可见 Listing 摘要。
- `GET /registry/v1/skills/{namespace}/{name}/releases`：可见 Release 历史。
- `GET /registry/v1/releases/{releaseId}`：不可变 Release、信任摘要与分发描述符。
- `GET /registry/v1/feed?after=<cursor>&limit=<n>&channel=<channel>`：增量事件。
- `GET /registry/v1/packages/{releaseId}/manifest`：授权后的只读 manifest；包内容下载使用短期、受策略约束的独立能力，不写进公共 feed。

统一响应 envelope：

```json
{
  "schemaVersion": 1,
  "requestId": "req_…",
  "registry": "skillops-local",
  "generatedAt": "…",
  "data": {},
  "error": null
}
```

Feed 的 `data` 固定为 `{ "events": [], "nextCursor": "…", "hasMore": false }`。游标按 Registry 单调序列推进，客户端只能将游标前移；分页重放可能重复事件，因此消费者必须用 `eventId` 幂等。未知事件类型或更高 major schema 必须停止应用并保留旧投影，不得猜测字段含义。

### 发布命令边界

写入只存在于受控发布服务/本地构建器，不进入公共查询 API：

`publish(candidateSnapshot, policyVersion, idempotencyKey) → receipt`

发布器重新核对 package digest、当前审计、SMS、Eval、人审有效期及 `skillId+version` 唯一性；不能信任调用者给出的 `eligible=true`。事务必须同时追加事件与推进投影，失败不留下半个 Release。

## 造物云 Adapter Envelope

V3.8 输出 `zaowuyun.ability.skill.v1` 离线投影文件或 mock transport，不持有生产凭据：

```json
{
  "schema": "zaowuyun.ability.skill.v1",
  "projectionId": "zyproj_…",
  "idempotencyKey": "evt_…:zaowuyun-staging:v1",
  "mode": "dry-run",
  "action": "upsert",
  "subject": { "abilityType": "skill", "skillId": "qiuyiwu/humanizer", "releaseId": "rel_…" },
  "display": { "titleZh": "文本去 AI 味", "descriptionZh": "…", "category": "内容创作" },
  "trust": { "packageDigest": "sha256:…", "sms": {}, "eval": {}, "review": {} },
  "distribution": { "status": "eligible", "manifestRef": "registry://releases/rel_…/manifest" },
  "relations": [],
  "sourceEvent": { "eventId": "evt_…", "sequence": 42 },
  "payloadDigest": "sha256:…"
}
```

- `action` 只允许 `upsert | withdraw | supersede | revoke`；每个动作都由 Registry 事件确定性生成。
- 插件、方法、应用、数字员工不是 Skill 的子类型；它们保持造物云各自对象模型，只通过 `relations` 引用 `skillId/releaseId`。
- adapter 必须返回 `{ projectionId, idempotencyKey, status, remoteRef?, receivedAt, payloadDigest }` 回执；相同 key + 相同 digest 重试返回同一结果，相同 key + 不同 digest 必须冲突。
- V3.8 只允许 `dry-run` 或显式 staging mock。生产 URL、token、写权限、自动重试生产流量均不实现。

## 幂等、撤回、升级与兼容

- 所有确定性 ID 在写入前本地重算；客户端传入 ID 与重算不一致即失败关闭。
- `skillId+version` 首次发布后锁定 package digest；重复同载荷返回原 receipt，换包复用版本号返回 `VERSION_IMMUTABLE`。
- withdraw/revoke 形成 tombstone 并进入 feed；缓存不能因查询 404 而自行删除历史。
- supersede 只给出推荐迁移边，不自动替换下游安装；兼容性由新旧 Release 的 manifest、声明和 Eval 证据共同决定。
- minor 字段可向前兼容忽略；未知必需字段、未知 major、摘要不符、事件序列倒退或断档必须暂停消费并请求全量快照。
- 全量快照携带 `snapshotDigest + throughCursor`，与增量 feed 对账；不能用快照覆盖本地未处理的更高游标。

## 隐私与安全

- 公共 Registry 不包含候选正文、Eval 原始 prompt/输出、审核者邮箱、API key、访问 token、本地绝对路径、设备/组织成员标识或私有 Source URL。
- 中文自动翻译保留原文与 `translationStatus`，但不把私有技能内容发送到第三方翻译服务；外部调用需另行授权。
- 私有 channel 使用最小字段授权和审计日志；公开/私有投影必须从同一 Release 事实派生，不能复制成两个互相漂移的 Release。
- package 下载前仍需校验许可、withdraw/revoke、review 有效性和 manifest digest；Registry 是信任分发层，不是执行环境。

## 后续可并行工作包与依赖

### A · 身份与实体契约

- 实现规范化 `skillId/releaseId/sourceId/eventId`、实体校验、冲突规则与契约测试。
- 依赖：V3.5 Package；输入采用 V3.7 终审投影。

### B · 事件存储与只读投影

- 实现 append-only log、事务投影、snapshot/feed/cursor 与重放测试。
- 依赖 A；可与 C 的 adapter fixture 并行。

### C · 造物云离线 Adapter

- 实现 `zaowuyun.ability.skill.v1` mapper、dry-run 文件输出、mock receipt、upsert/withdraw/supersede/revoke 契约测试。
- 依赖 A 的实体 JSON Schema；不依赖生产账号。

### D · Candidate 发布接缝

- 将当前 CandidateStore 的 package/SMS/Eval/review 快照转换为发布请求，重新校验策略并记录内部 provenance。
- 依赖 A，且 V3.7 的独立人审与有效期规则必须冻结后才能开放正式 publish。

### E · 独立一致性验收

- 从 approved Candidate 发布 Release，经 feed 重放生成市场与造物云 dry-run 投影；覆盖重复、乱序、断档、撤回、吊销和版本冲突。
- 依赖 A–D。

## 验收清单

- [ ] `skillId`、`releaseId`、`sourceId`、`candidateId` 边界有单测，市场/lock/造物云投影均不再以 `cand_*` 为长期身份。
- [ ] 同一发布重复提交零重复事件；同版本换包、同 idempotency key 换载荷均失败关闭。
- [ ] Release 不可变，Listing 可独立更新，所有投影可由 append-only log 重建且 digest 一致。
- [ ] feed 支持分页、重放、断档检测、snapshot 对账与未知 schema 失败关闭。
- [ ] withdraw/supersede/revoke 能传播到所有本地消费者，历史与 tombstone 可审计。
- [ ] 造物云四类动作在 dry-run/mock 中有确定性 envelope 与幂等回执，未出现任何生产网络写入。
- [ ] 公共投影不含候选原文、秘密、个人身份、本地路径和私有来源；中文展示保留原文及翻译状态。
- [ ] 全量既有测试保持通过，并新增发布、feed、adapter 端到端黑盒测试。

## 不做什么

- 不直连造物云生产，不申请、读取或保存生产凭据。
- 不允许市场、CLI 或适配器绕过 Registry 读取 CandidateStore。
- 不把 `cand_*` 升格为产品身份，不让 mutable Listing 改写 immutable Release。
- 不执行技能、脚本或生产工作负载。
- 不在本版实现组织权限、支付、评论或个性化推荐。

## 状态

spec proposed; implementation not started; production integration unauthorized
