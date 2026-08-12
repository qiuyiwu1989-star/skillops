# 008: V3.6 固定测试集与 Eval 实证闭环

## 要什么

在完整技能包可信交付之上建立可重复、可审计、与具体模型供应商解耦的 Eval 台架。Eval 只用于质检考核，不承担生产任务；默认离线 fixture adapter，任何真实模型调用都必须由用户另行显式授权并使用自己的算力。

## 用户闭环

`完整包 → 固定测试集 → 隔离执行 adapter → 确定性断言/judge adapter → 结果证据 → 人类终审 → 市场实绩`

## 测试集契约

- 采用受限 JSON `evals/cases.json`，不执行 YAML tag、模板表达式或任意代码。
- 测试集包含 `schemaVersion`、`suiteId`、`suiteVersion`、`cases`。
- 每个 case 至少包含稳定 `id`、中文任务说明 `prompt`、非空断言列表 `assertions`。
- v1 断言只支持确定性类型：`contains`、`not_contains`、`json_path_equals`、`max_chars`。
- case、suite 必须有硬限制：数量、输入长度、断言数量、期望值大小、JSON 总大小。
- `suiteDigest` 由规范化测试集计算，顺序和内容变化必须生成新的 digest。

## Runner 契约

- runner 只接受已通过当前全包审计的 package revision 与已校验 suite。
- executor 是注入式 adapter，核心库不内置 shell、网络或模型密钥。
- adapter 输入只包含明确 case、只读 package 路径/摘要和超时；输出为文本或 JSON 结果及公开环境元数据。
- 每个 case 独立运行，超时、adapter 错误和断言失败只形成失败证据，不修改技能文件。
- 默认 fixture adapter 完全离线、确定性、无网络、无子进程。
- 真实模型 adapter 不在本版实现，也不自动发现环境变量。

## Eval 结果契约

```json
{
  "schemaVersion": 1,
  "status": "complete",
  "suiteId": "fixture/basic",
  "suiteVersion": "1.0.0",
  "suiteDigest": "sha256:...",
  "basedOnPackageDigest": "sha256:...",
  "runner": "fixture:v1",
  "environment": { "kind": "offline-fixture" },
  "cases": [],
  "passed": 2,
  "failed": 1,
  "successRate": 0.6667,
  "startedAt": "...",
  "completedAt": "..."
}
```

- 每个 case 保存状态、耗时、断言结果和经过大小限制的结果摘要，不保存秘密或无限原文。
- 成功率由 case 结果计算，不接受调用者手填。
- 结果绑定 `packageDigest + suiteDigest + runner identity`。
- package、suite、runner policy 变化后旧 Eval 变为 stale；历史结果只追加。

## 候选与市场规则

- CandidateStore 增加 append-only `evalEvents` 和当前 `eval` 投影。
- `recordEval` 必须校验结果完整、package digest 当前、suite digest 合法。
- package 变化继续清空当前 Eval，但保留历史事件。
- V3.6 本地 listing 可以展示 `pending / complete / stale`；不得用 SMS 冒充 Eval。
- 可安装基础门仍由 V3.5 决定；进入精选或造物云生产的 Eval 阈值留到 V3.7 策略层。

## CLI

- `eval-suite-validate <cases.json>`：输出规范化 suite 与 digest。
- `eval-run <candidate-id> --suite <cases.json> --adapter fixture --fixture-results <json>`：离线运行并记录结果。
- `eval-import <candidate-id> --input <result.json>`：只导入完整、当前且可验证的外部结果。
- `eval-show <candidate-id>`：展示当前结果和历史摘要。
- CLI 不提供任意 shell 命令参数，不读取模型密钥，不允许 adapter 路径注入。

## 并行工作包

### A · Eval 契约

- suite/result 规范化、digest、断言引擎、硬限制和单元测试。
- 文件边界：新增 `trusted-supply/lib/eval-*.mjs` 与对应单元测试。

### B · 隔离 Runner

- executor adapter 接口、fixture adapter、超时/错误隔离、结果汇总。
- 文件边界：新增 runner 模块和 runner 测试，不改候选/CLI。

### C · 候选、CLI 与市场接缝

- evalEvents、current/stale、CLI、listing、详情证据。
- 文件边界：candidate/store/CLI/market 与独立接缝测试。

### D · 独立验收

- 从 package/CAS/audit 到 suite/runner/eval/listing/详情的离线黑盒闭环。
- 危险包、过期 suite/package、伪造成功率和 adapter 失败必须失败关闭。

## 验收清单

- [ ] 测试集 digest 稳定，非法结构、未知断言和超限失败关闭。
- [ ] 断言引擎覆盖文本、JSON 路径和输出长度，不执行表达式。
- [ ] fixture runner 离线、确定性，不启动 shell/网络/第三方技能。
- [ ] 超时、adapter 错误、断言失败形成逐 case 证据与准确成功率。
- [ ] Eval 绑定 packageDigest、suiteDigest、runner 和环境，不接受伪造汇总。
- [ ] package 或 suite 变化使当前 Eval stale，历史事件保持只追加。
- [ ] SMS 与 Eval 在 listing 和详情中继续分开展示。
- [ ] 全量自动化测试和桌面/移动浏览器验收通过。

## 不做什么

- 不调用真实付费模型，不读取 API key。
- 不执行第三方技能、scripts 或任意 shell。
- 不以 Eval Runner 承担生产工作负载。
- 不自动批准、精选、安装或连接造物云生产。

## 状态

approved for local parallel implementation; real-model execution and production integration not authorized
