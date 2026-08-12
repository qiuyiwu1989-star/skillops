# SkillOps 本地能力市场预览

该页面是只读本地预览。它不访问生产 API，构建数据只能来自
`CandidateStore.listListings()`。

## 使用真实候选库构建

```bash
node market-preview/build.mjs --store /absolute/path/to/candidates.json
node market-preview/serve.mjs
```

打开 `http://127.0.0.1:4173`。

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
