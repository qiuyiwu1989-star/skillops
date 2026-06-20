# SkillOps 浏览器插件 · v0.1

在 **ChatGPT / Claude** 的输入框里一键调起你的 SkillOps 技能库；选中文本顺手「存进库」。

## 装载（开发测试 · 加载已解压扩展）
1. Chrome / Edge 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序** → 选这个 `extension/` 目录
4. 点扩展图标 → 粘贴你的 **API Key**（在 https://skillops.tech/dashboard/ → 右上「API Key」生成）→ 连接

## 用法
- 打开 **chatgpt.com** 或 **claude.ai**
- 点页面右下角 **「⚡ 技能」** 浮标，或按 **⌘/Ctrl + Shift + K**
- 搜你的技能 → ↑↓ 选 → 回车 → 该技能正文注入输入框，接着写你的内容即可
- **捕获**：在对话里选中一段好提示词 → 右键 **「存进 SkillOps 技能库」** → 起个名 → 存为私有技能（之后在任何 AI 里都能调）

每次调用都会回传到 SkillOps，控制台「被调用 N 次 / 最常调用」能看到真实使用。

## v0.1 范围 / 已知边界
- 站点：ChatGPT + Claude（全球）。豆包/Gemini 等 later。
- 触发：浮标 + 快捷键（`//` 行内触发是后续增强）。
- 鉴权：粘贴 API key（后续做「一键连接」授权流）。
- 技能跑在**你自己的 AI 里**（我们只注入文本，不替你执行、不锁定）。
- DOM 适配是脆弱点：若某天找不到输入框，会自动复制到剪贴板兜底；选择器集中在 `content.js` 的 `findInput()`，站点改版时改这里。

## 文件
- `manifest.json` — MV3 配置（host 权限仅 chatgpt/claude/skillops 三域）
- `background.js` — 所有 API 调用（走后台，免 CORS）+ 右键菜单
- `content.js` — 注入 UI + 输入框适配 + 调起/捕获
- `popup.js` / `popup.html` — 连接账号 + 库速览
- 后端：`/api/v1/me/skills`（列表/建/取/版本/invoke，API-key 鉴权）
