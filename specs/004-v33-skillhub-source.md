# 004: V3.3 SkillHub 外部候选源

## 要什么

把 SkillHub 接成一个只读外部候选源：从公开推荐、趋势、热榜或上新货架发现技能，验证版本签名、文件哈希与外部安全报告，读取 `SKILL.md` 和许可信息后进入 SkillOps 候选库。候选可执行本地格式、许可和安全审计，但绝不自动批准或上架。

## 不做什么

- 不镜像 SkillHub 全站，不绕过访问控制。
- 不安装、运行或调用第三方技能中的脚本和命令。
- 不同步付费 Skill；默认不同步要求 API Key 的 Skill。
- 不把 SkillHub 的下载、收藏或 TRACE 分数冒充为 SMS。
- 不在许可缺失或不明确时复制正文到公开市场。
- 不自动批准候选。

## 试运行筛选规则

- 仅使用固定的 `https://api.skillhub.cn` 公开接口。
- 默认读取 `recommended` 与 `trending`，每个分类最多 2 个。
- 默认要求 SkillHub 包签名和至少 2 家 benign 安全报告。
- `SKILL.md` 必须存在且与文件清单 SHA-256 一致。
- 许可缺失进入 `index_only`，安全硬风险进入隔离状态。
- SkillHub 外部报告只作为来源证据，仍执行 SkillOps 自有安全扫描。

## 验收清单

- [x] 支持固定货架、数量、分类多样性和硬上限。
- [x] 每个条目独立失败，单个异常不污染其他候选。
- [x] 验证版本签名、slug/version 一致性与 `SKILL.md` SHA-256。
- [x] 保存 SkillHub 坐标、分类、标签、来源货架和观测指标。
- [x] 许可缺失不阻止索引，但禁止未来公开复制正文。
- [x] 同来源新版本或内容变化使既有批准失效。
- [x] CLI 支持只读同步与可选本地审计。
- [x] 完成首批真实候选同步并形成人工审核队列：138 个发现、13 个深检、6 个候选、2 个进入 review、0 个自动批准。

## 命令

```bash
node trusted-supply/cli.mjs sync-skillhub \
  --store .skillops/skillhub-candidates.json \
  --report .skillops/skillhub-sync-report.json \
  --limit 6 \
  --shelves recommended,trending \
  --audit
```
