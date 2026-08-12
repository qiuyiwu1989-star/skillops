# 007: V3.5 完整技能包可信交付

## 要什么

把候选、审核、上架和安装从 `SKILL.md` 单文件指纹升级为完整技能包 revision。一个技能包包括根 `SKILL.md` 及同目录内被发布的 scripts、references、assets、模板、eval 定义和许可文件；任何文件变化都必须形成新的包指纹并触发重新审计。

## 产品闭环

`来源版本 → 文件清单 → 隔离暂存 → 逐文件校验 → 全包审计 → packageRevision → SMS/Eval/人审 → listing → 受控部署`

## 数据契约

候选增加：

```json
{
  "artifact": {
    "package": {
      "schemaVersion": 1,
      "packageDigest": "sha256:...",
      "manifest": [
        {
          "path": "SKILL.md",
          "size": 1234,
          "sha256": "...",
          "mediaType": "text/markdown",
          "executable": false
        }
      ],
      "fileCount": 1,
      "totalBytes": 1234,
      "storageRef": "cas:sha256:...",
      "collectedAt": "...",
      "basedOnSourceVersion": "..."
    }
  }
}
```

- `packageDigest` 由规范排序后的 `path + size + sha256 + executable` 本地计算，禁止直接信任上游总 hash。
- manifest 路径使用 POSIX 相对路径、Unicode NFC、区分大小写；相同 fold key 视为冲突。
- `storageRef` 只指向本地内容寻址存储，不进入 listing 的可写路径。
- 缺完整包时可以继续作为 `source_link_only` listing，但不得标记可安装。

## 硬门

- 路径不得为空、绝对、含 `..`、反斜杠、NUL、重复项或大小写冲突。
- 拒绝 symlink、hardlink、device、socket、FIFO 和未知文件类型。
- 限制文件数量、单文件大小、总大小、目录深度、路径长度和 manifest 大小。
- 每个文件都必须和上游文件表的 size/hash 匹配；落盘内容与 manifest 双向一致。
- 来源坐标、版本、签名与包 revision 必须一致。
- 安全扫描覆盖 SKILL.md、scripts、references、模板与可读 assets 元数据；危险附件直接隔离。
- 许可必须明确覆盖包内分发内容；不明确时降级为来源索引。
- 暂存失败、部分下载或任一硬门失败均不得污染 CAS、候选 store 或既有批准。

## 状态失效

以下任一变化都会使当前 package audit、SMS、Eval、review 和 install eligibility 失效：

- packageDigest、文件清单或任一文件 hash；
- 来源版本、签名或坐标；
- 许可结论或安全策略版本；
- Eval 测试集绑定的包 revision。

历史事件只追加，不覆盖旧证据。

## CLI 与库接口

- `package-sync <candidate-id>`：从已登记来源拉取并原子发布完整包。
- `package-import <candidate-id> --from <dir>`：仅供本地 fixture/明确授权来源。
- `package-show <candidate-id>`：展示 manifest、digest、审计状态和安装资格。
- `package-audit <candidate-id>`：对当前 package revision 进行全包安全/许可复审。
- 核心库提供 manifest 规范化、digest、目录导入、CAS 写入和一致性校验接口。

## 并行工作包

### A · Package 核心与 CAS

- manifest 规范化、digest、路径/大小硬限、CAS 原子发布、幂等与一致性校验。
- 仅修改新的 package 模块和对应单元测试。

### B · 候选状态与可信门

- candidate/store/listing 绑定 packageDigest；附件变化使批准 stale。
- 安装资格要求完整包及当前 package audit。
- 仅修改 candidate/store/audit 接缝和状态机测试。

### C · SourceAdapter 全包采集

- SkillHub 与 GitHub 快照基于来源文件表同步完整包，保持逐源隔离。
- 不执行文件，不 checkout 到工作目录，不自动审核或批准。

### D · CLI、市场与独立验收

- package 命令、详情页包证据、安装边界与端到端黑盒测试。
- 首批 3 个真实 listing 仅在来源许可和包可得时升级；否则诚实保留来源索引。

## 验收清单

- [ ] manifest 排序与 digest 在不同扫描顺序下稳定。
- [ ] hash 不匹配、缺文件、额外文件、路径穿越、symlink、大小写冲突和超限全部失败关闭。
- [ ] scripts/references 中的危险内容能阻断全包批准。
- [ ] 部分失败不污染 CAS/store；同包重复同步幂等且零重复存储。
- [ ] 仅修改附件即可使旧 audit、SMS、Eval、review 和 listing 失效。
- [ ] `source_link_only` 不复制包内容且不显示安装操作。
- [ ] 可安装 listing 同时满足许可可分发、包完整、package audit 当前有效和批准有效。
- [ ] 全量既有测试保持通过，并新增端到端包同步验收。

## 不做什么

- 不执行第三方技能或脚本。
- 不在本版运行付费 Eval。
- 不自动批准或自动部署完整包。
- 不连接造物云生产，不修改冻结中的老平台。

## 状态

approved for local parallel implementation; production integration not authorized
