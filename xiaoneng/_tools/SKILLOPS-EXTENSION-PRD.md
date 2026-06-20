# SkillOps 浏览器插件 · PRD（v1）

> 调用层的「魔法层」—— 把你的技能库直接搬进 AI 的输入框。配套 MCP（技术对接口）服务 A，本插件服务 B。
> 决策锚点：**全球 · ChatGPT + Claude · Chrome 商店**。日期：2026-06。

## 0. 一句话 & 定位
**你的 SkillOps 技能库，直接出现在 ChatGPT / Claude 的输入框里 —— 一键调起，顺手捕获。**
- 服务 **B（知识工作者）**：活在 AI 网页里、讲提示词不讲 curl 的人。
- 在脊梁里 = **运行(引信) 的魔法层**（复制是地板，插件是魔法）+ **捕获(on-ramp)**。
- 引力中心**中立/便携**在这里变得可感知：同一个 `//` 触发，在 ChatGPT 和 Claude 里都是你那一个库。
- **反 Capafy**：技能跑在**你自己的 AI**里（我们注入文本，不替你执行），你**拥有**、可携带、不锁定。

## 1. v1 范围
- **站点**：`chatgpt.com`（含 chat.openai.com）+ `claude.ai`。
- **浏览器**：Chrome / Edge（MV3），Chrome Web Store 上架。Firefox later。
- **账号**：需云端账号 + API key（插件跨 AI 同步本就要求账号——逻辑自洽）。本地匿名库不覆盖（插件与网页 localStorage 不互通）。
- **不做**：服务端执行（坚决）· 其他站点(豆包/Gemini…later) · 技能编排 · 离线。

## 2. 核心交互（三个动作，一个入口）
### ① 调用 / Insert（主）
- 在输入框打 **`//`**（可配置；用 `//` 而非 `/` 避开 Claude 原生斜杠菜单冲突）或快捷键 **⌘/Ctrl+K** → 弹出**可搜索的技能下拉**（你的库，带段位/被调用次数）。
- 选中 → 把该技能**当前版本正文注入输入框**（默认插在你已输入内容前面；可选"替换/追加"）。
- 找不到输入框时退化成**输入框旁浮标**点开同一面板。
- 每次注入 = 一次 `track('invoke', {via:'ext', site})` → 喂"调用次数"。

### ② 捕获 / Save（反向，同一面板）
- 选中对话里任意文本（你写的好提示词 / AI 给的好回答）→ 右键或浮标「**存进我的库**」→ 弹小卡：名称(自动建议) + 领域(自动猜) + 「存为新技能 v1 / 追加为某技能新版本」→ 可选「顺手评分」。
- 这是建库的零摩擦 on-ramp，也是"跨 AI"的体现：在 ChatGPT 捕获，在 Claude 调用。

### ③ 快速评分 / 钩子（次要）
- 选中一段提示词 → 「评一下」→ 行内 SMS 总分+段位+最弱维（复用 `/evaluate`）。零摩擦钩子，把"评分"带到使用现场。

### ④ 库迷你面板（popup）
- 点扩展图标 → 搜索/复制/「在控制台打开」。连接状态 + 切换账号。

## 3. 技术架构（MV3，尽量复用现有后端）
- **manifest v3**：`host_permissions`: `chatgpt.com`、`chat.openai.com`、`claude.ai`、`skillops.tech`。`permissions`: `storage`、`contextMenus`、`activeTab`。最小化。
- **content script**（每站一份适配器）：定位输入框（per-site selectors）、挂 `//`/快捷键监听、注入文本（写值 + 派发 `input`/`beforeinput` 事件让站点识别）、注入浮标/下拉 UI（Shadow DOM 隔离样式）。
- **background service worker**：API 调用、contextMenus、缓存技能列表。
- **popup + options**：连接账号、设置触发符/默认注入模式。
- **存储**：`chrome.storage.sync` 存 API key + 偏好 + 轻缓存。只与 `skillops.tech` 通信，无第三方。

### 站点适配（DOM 脆弱性对策）
- 每站一个 `adapter`：`{ findInput(), insertText(t), getSelection() }`。集中维护、易改。
- 选择器失效 → 浮标兜底 + 控制台告警；插件版本与适配器解耦，可快速热更（远端 selector 配置可选）。

## 4. 鉴权
- **v1**：粘贴账号 API key（控制台已能生成 `xn_...`）。够早期用。
- **v2（B 更友好）**：「连接 SkillOps」一键流 —— 打开 `skillops.tech/connect?ext=1` 登录→授权→token 回流插件（chrome-extension 回调页 / 网页 postMessage）。later。

## 5. 后端要补的（小）—— 现有是 session 鉴权，插件要 API-key 鉴权
已具备（API key）：`GET /v1/me/skills` ✓、`GET /v1/skills/:handle/:slug` ✓（公开）。
要新增（用 `db.userForApiKey` 鉴权，对齐 `/v1/me/skills` 模式）：
- `GET  /v1/me/skills/:id`（取我的某技能正文，私有也行）
- `POST /v1/me/skills`（捕获：建技能）
- `POST /v1/me/skills/:id/versions`（捕获：追加版本）
- `POST /v1/me/skills/:id/invoke`（调用埋点·API-key 版）
- `POST /v1/evaluate`（可选：快速评分，或复用现有 `/evaluate` 限流）

## 6. 隐私 / 合规（Chrome 商店要过审）
- 只读**用户主动选中**的文本（捕获），不抓取/不后台读页面。
- 仅与 `skillops.tech` 通信；API key 存本地。
- 需要：隐私政策页（放 skillops.tech/privacy）、商店描述、权限说明（host 仅三域）。
- ChatGPT/Claude ToS：注入输入框/读选中文本属正常用户行为，低风险；不自动化发送、不绕验证。

## 7. 指标
- **激活**：连接账号数。**核心留存**：`invoke` 次数（按站点/技能）。**建库**：capture 次数。**钩子**：快速评分次数。
- 全部经现有 `track()` + invoke 端点，与控制台"被调用 N 次 / 最常调用"打通。

## 8. 里程碑
- **v0.1**：ChatGPT，`//` 调起 + API key 连接 + 注入 + 埋点。← 先摸到魔法 + 拿到第一批调用数据
- **v0.2**：捕获（存进库 / 追加版本）。
- **v0.3**：Claude 适配 + 快速评分 + popup 库面板。
- **v0.4**：打磨 + 隐私页 + Chrome 商店提交。
- **v1.1（后）**：连接一键授权流；更多站点（豆包/Gemini）。

## 9. 风险
1. **DOM 变** → 适配器集中 + 浮标兜底 + 可热更 selector。
2. **商店审核**（数天）+ 权限/隐私说明要齐。
3. **API key 粘贴对纯 B 偏techy** → v2 一键连接流缓解。
4. **`/` 冲突** → 默认 `//` + 可配快捷键。
5. **国内用户装 Chrome 扩展难** → 本期定全球；国内分发是另一决策（Edge/360/crx），later。
