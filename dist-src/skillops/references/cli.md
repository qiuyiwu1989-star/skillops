# skillops CLI 手册

零依赖（纯 Node 内置模块，需 Node ≥ 18）。入口：

```bash
node <本技能目录>/scripts/skillops.mjs <命令>
```

数据全在 `~/.skillops/`：
`config.json`（命名空间 + 卷注册表）· `index.json`（花名册缓存）· `state.json`（上次周报时间）· `telemetry.jsonl`（调用遥测）· `env`（可选 LLM_* 配置）

**隐私**：一切数据留在本机。技能内容不上传任何服务器。`score` 直连**用户自己配置的** LLM 端点，花用户自己的额度。

## 命令

### `init [--namespace <名>]`
第一次使用先跑它。设默认命名空间（省略则用系统用户名），并自动发现常见技能目录：`~/.claude/skills`、当前项目的 `.claude/skills`、`~/skills`。

### `scan`
盘点全部卷 → 重建花名册 + 打印体检。**任何拿不准花名册新鲜度的时候先跑它**（<1s）。跟随符号链接，realpath 防环。

### `ls [--vault 名]`
花名册。`✓`=有户口 `○`=无户口。列：id/名、卷、指纹前 6 位、文件数、mtime。

### `status [--hook]`
只看警报。`--hook` 是钩子模式：无 ANSI 颜色、**干净则零输出**（不打扰会话），含"周报到期"提醒。

### `register <技能名或目录> [--id ns/name]`
落户。往 SKILL.md frontmatter 插一行 `id:`（**字节级保守**，其余内容一字不动），随后自动重扫。省略 `--id` 时用 `<默认命名空间>/<目录名>`。
- 同名命中多处 → 用目录路径指定
- 只读卷会拒绝 → 去真身所在卷操作
- id 已被占用会拒绝

### `report`
人事周报：总览 / 新生 / 调用榜 / 待拍板（无户口、分歧）/ 分身。窗口 = 上次发报至今（首次 7 天，封顶 30 天）。发完自动记时间。

### `track`
遥测。给 PostToolUse 钩子从 stdin 灌 payload 用；永不出声、永不报错。手动补录：`track <技能名>`。

### `score <技能名>`
SMS v2.0 十维评级。需在 `~/.skillops/env` 配：
```
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=<你自己的 key>
```
（任何 OpenAI 兼容端点都行。）没配就走人工对照打分，见 [playbooks.md](playbooks.md) play 3。

### `vault add <目录> [--name 名] [--readonly]` / `vault ls` / `vault rm <名>`
卷管理。`--readonly` 用于插件缓存等不该改写的目录。`rm` 只取消登记，**文件一个不动**。

## 输出语义（重要）

- **分身**（≡）= 同指纹多处 = 内容相同的拷贝 = 事实上的手工部署。不是错误，但要让主人知道"这几处将来要一起更新"。
- **分歧**（✗）= 同身份不同指纹 = **版本漂移，最该处理**。处置：摆差异 → 主人选真身 → 同步内容，或给分支各立户口（如 en/zh 各一个 id）。
- **无户口**（○）= 没有 id。原创的批量落户；第三方的留着。

## 可选：装钩子（让专员自动上岗）

在 Claude Code 的 `~/.claude/settings.json` 里加（路径换成你的实际安装位置）：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/skills/skillops/scripts/skillops.mjs status --hook", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "Skill", "hooks": [{ "type": "command", "command": "node ~/.claude/skills/skillops/scripts/skillops.mjs track", "async": true }] }
    ]
  }
}
```
效果：每次开会话静默体检（有警报才出声）；每次技能被调用自动记一笔遥测（周报的数据来源）。
**这一步是可选的**——不装钩子，技能仍可被正常召唤使用，只是没有自动体检与调用数据。

## 故障排查

| 现象 | 处理 |
|---|---|
| 数字对不上 | 先 `scan`（索引只是缓存） |
| `score` 报缺 LLM_API_KEY | `~/.skillops/env` 没配，问主人要，别自己造 |
| `register` 找不到技能 | 先 `scan`；还不行用绝对路径 |
| 没有调用榜数据 | 没装 PostToolUse 钩子（见上），如实说明 |
| 提示"还没有注册任何卷" | 跑 `init` |
