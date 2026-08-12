# SkillOps 本地能力市场预览

该页面是只读本地预览。它不访问生产 API，构建数据只能来自
`CandidateStore.listListings()`。

## 使用真实候选库构建

```bash
node market-preview/build.mjs --store /absolute/path/to/candidates.json
node market-preview/serve.mjs
```

打开 `http://127.0.0.1:4173`。

市场首页的“查看完整详情”会进入稳定地址 `/skills/<candidate-id>/`。每次构建会同时输出：

- `data/listings.json`：首页 approved listing 集合；
- `data/skills/<candidate-id>.json`：单个技能详情数据；
- `skills/<candidate-id>/index.html`：可直接访问和刷新的静态入口。

详情页默认展示中文主题和中文说明，英文原名作为来源别名保留。SMS 表示静态潜力，Eval 表示运行实绩，两者不会混分。

V3.5 起，拥有完整技能包的 listing 还会展示 package digest、文件清单、总体积与全包审计。安装资格要求许可可分发、完整包、当前全包审计与批准同时有效；只有 `SKILL.md` 的旧 listing 会继续诚实显示不可安装。

## 生成隔离的示例数据

```bash
node market-preview/demo.mjs
node market-preview/serve.mjs
```

示例候选库只在系统临时目录中存在，命令结束后立即删除。仓库里仅保留由已批准
listing 生成的静态预览数据。

## 验证

```bash
node --test market-preview/test/*.test.mjs
node --check market-preview/build.mjs
node --check market-preview/demo.mjs
node --check market-preview/serve.mjs
node --check market-preview/app.js
```
