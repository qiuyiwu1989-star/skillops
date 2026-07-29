# skillops CLI 完整手册（小能操作参考）

零依赖 Node ESM。入口：`node /Users/qiu/Documents/skillops/cli/skillops.mjs <命令>`。
数据都在 `~/.skillops/`：`config.json`（卷注册表+默认命名空间）· `index.json`（花名册缓存）· `state.json`（上次周报时间）· `telemetry.jsonl`（调用遥测）· `env`（可选 LLM_* 配置）。

## 命令

### `scan`
盘点全部卷 → 重建花名册 + 打印体检。**任何拿不准花名册新鲜度的时候先跑它**（很快，<1s）。跟随符号链接（插件、deploy --link 都是链接），realpath 防环。

### `ls [--vault 名]`
花名册。`✓`=有户口（有 id）；`○`=无户口。列：id/名、卷、指纹前 6 位、文件数、mtime。

### `status [--hook]`
只看警报。`--hook` 是 SessionStart 钩子模式：无 ANSI、**干净则零输出**（不打扰会话）；会包含「周报到期」提醒（距上次 report >7 天）。

### `register <技能名或目录> --id qiuyiwu/<名>`
落户。往 SKILL.md frontmatter 插一行 `id:`（字节级保守，其余内容一字不动），随后自动 rescan。
- 同名命中多处 → 用目录路径指定
- 只读卷（--readonly 注册的）会拒绝 → 去真身所在卷操作
- id 已被占用会拒绝 → 换名或先处理占用者

### `report`
人事周报：总览 / 新生（窗口内 mtime）/ 调用榜（遥测）/ 待拍板（无户口、分歧）/ 分身数。统计窗口 = 上次发报至今（首报 7 天，封顶 30 天）。**发完自动记时间**，status 不再催。

### `track`
遥测（PostToolUse(Skill) 钩子从 stdin 灌 payload）。永不出声、永不报错。手动补录：`track <技能名>`。

### `score <技能名>`
SMS 静态评分。需 `~/.skillops/env` 写 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`（花户主自己的额度——宪法 Q5 决议）。解读口径见 [sms.md](sms.md)。

### `vault add <目录> [--name 名] [--readonly]` / `vault ls` / `vault rm <名>`
卷管理。`rm` 只取消登记，文件一个不动。当前 7 卷：qiuyiwu.com 的 claude/agents/subskills、luedong、innolab-repo、lengjing/insight、global(~/.claude/skills)。

## 输出解读（重要语义）

- **分身**（≡，同指纹多处）= 内容相同的拷贝 = 事实上的手工部署。不是错误，是 P2 deploy 台账要接管的对象。
- **分歧**（✗，同身份不同指纹）= 版本漂移，**最该处理**。处置：向户主摆差异 → 他选哪版是真身 → 执行（同步内容或给分支独立户口，如 en/zh 各立 id）。
- **无户口**（○）= 没有 id。原创的批量落户；第三方的留着（规约 4）。

## 常用流程

**新技能出生**（最高频）：写完 SKILL.md → frontmatter 加 `id: qiuyiwu/<目录名>` → `scan` → 一句话告知户主"已入册"。
**周报仪式**：`report` → 汇报要点 → 户主拍板（落户谁/跳过谁/退休谁）→ 逐条执行 → 完成情况回一句。
**新项目建卷**：项目里出现 `.claude/skills/` → `vault add` 注册 → `scan`。

## 故障排查

- 花名册数字对不上 → 先 `scan`（索引只是缓存）
- score 报缺 LLM_API_KEY → `~/.skillops/env` 没配，找户主要（不要自己造）
- register 找不到技能 → 先 `scan`；还不行用绝对路径
- hooks 没生效 → `~/.claude/settings.json` 尚未装（待户主授权），专员在应召模式
