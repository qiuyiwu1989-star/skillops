# 002: SkillOps V3.1 · 技能内部管理闭环

## 要什么

把现有盘点 CLI 从「档案柜」推进到最小可验证的管理闭环：统一 CLI 真身，加入技能版本、部署台账和漂移检测，为后续 Eval 与真实绩效建立稳定入口。

## 不做什么

- 不做生产工作负载运行时。
- 不建设网页管理台。
- 不在本版接入组织权限、支付或市场交易。
- 不执行需要用户付费额度的批量 LLM Eval。

## 验收清单

- [x] 明确 `dist-src/skillops/scripts/` 为 CLI 唯一源码，根 `cli/` 仅保留兼容入口。
- [x] `deploy <技能> --to <目录>` 写入可审计的 `.skillops/lock.json`。
- [x] 部署目标不覆盖未知文件，重复部署具有幂等性。
- [x] `status` 能比较源技能指纹与部署台账并报告漂移。
- [x] 测试覆盖初次部署、重复部署、源变化、目标变化和异常目标。
- [x] 现有 `scan / ls / register / report / track / score` 代码路径保持不变并通过语法检查。

## 状态

implemented locally; real-project trial pending
