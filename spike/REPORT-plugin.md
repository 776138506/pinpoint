# REPORT-plugin — 第三方 client 插件装进真实 dsh 端到端验证（MEU-0b）

结论：**跑通**。第三方 npm 包以 `dsh.bundle` + `dsh.client` 双 manifest 安装进一个全新 profile 后，浏览器端能加载其预构建 `lib/client.js`，在会话头部 `conversation.session.header.actions` 渲染出一个「标记」按钮，点击触发中文 `window.alert`。截图证据见 `spike/screenshots/mark-button.png`。

## 1. 结论与证据链

| 步骤 | 结果 |
|---|---|
| 插件包安装进新 profile | `dsh plugin --profile point-test add <本包>` 成功，reconcile 后 `dsh.profile.bundles` 追加 `dsh-point` |
| 配置合成 | `--dump-config` 输出含 `# == dsh-point` 层与 `- id: point / name: dsh-point` 行 |
| client bundle 被扫描/serve | 首页注入的 `window.__DSH_BOOT__` 含 `{"id":"dsh-point","url":"/plugins/dsh-point/client.js?rev=2c99728a6842",...}`；`curl /plugins/dsh-point/client.js` → HTTP 200（1953 字节）；未知 id → 404（非 SPA fallback） |
| 按钮渲染 | ego-browser 打开会话后，AX 树与 DOM 探针均见 `button "标记"`，`title="标记（dsh-point spike）"`，与「标准模式 / 2 个子代理 / 预览 / Session log」并列于会话层级头部 |
| 点击行为 | 覆写 `window.alert` 后点击，捕获到 `["标记已激活：dsh-point 第三方 client 插件链路跑通"]` |
| 视觉读回 | macOS Vision OCR 对截图识别到头部文本序列 `…标准模式 / 2个子代理 预览 / 标记 / Session log`，「标记」在图像中可视 |

截图：`spike/screenshots/mark-button.png`（1190×866 PNG，156 KB）。

## 2. 本机 dsh 运行方式（`which dsh` 缺失的根因）

本机无全局 `dsh`。dsh 以**源码构建产物**运行：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh -> …/deepseek-harness/apps/cli`（符号链接），CLI 入口是已构建的 `deepseek-harness/apps/cli/lib/bin.js`。所有命令等价为：

```sh
node <deepseek-harness>/apps/cli/lib/bin.js \
  --profile point-test --port 8897   # 等价于 dsh web 换端口
```

## 3. 交付物（dsh-point 根目录）

- `package.json` — `dsh.bundle.patch` + `dsh.client` 双 manifest，`exports["./client"]` 指向 `./lib/client.js`
- `cordis.patch.yml` — `- insert: [{id: point, name: dsh-point}]`，把 host 半段挂成 Loader entry
- `src/index.ts` — host 半段空 `apply()`
- `src/client/index.ts` — 向 `conversation.session.header.actions` 注入「标记」按钮
- `build.mjs` — esbuild 双产物构建（`lib/index.js` ESM / `lib/client.js` classic-script CJS）
- `spike/REPORT-plugin.md` + `spike/screenshots/mark-button.png`

## 4. 第三方 client 插件链路坑清单（关键）

### 4.1 构建格式（最大的坑）

client bundle **不是普通 ESM**。dsh 的 node 半段把 `lib/client.js` 当作同源 classic `<script>` 加载，产物必须是「注册工厂」形态：

```js
window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* CJS 打包产物，import react 编译成 require("react") */
  return module.exports; } });
```

要点：

- dsh 官方 tsdown preset 用的是 `format: 'cjs'`（非 ESM）+ banner（开 `load({id, factory:(require)=>{ var module…}`）+ footer（`return module.exports; } });`）。
- `react`/`react-dom`/`@deepseek-ai/cordis`/`@deepseek-ai/dsh-client-ui-slots` 等**平台模块必须 external**（不打包），运行时由浏览器 module table 的 seed 提供；`require("react")` 从 seed 解析。把 react bundle 进去会得到重复实例并 `require` 不到。
- esbuild 的 JS API **没有 `intro` 选项**（rolldown/tsdown 有），首次构建报 `Invalid option in build() call: "intro"`——把 `var module=…; var exports=…` 并入 banner 即可。
- 入口用 `createElement`（import from 'react'）而非 JSX，可避免 `react/jsx-runtime` 额外 external。

### 4.2 package.json 双 manifest 字段

- `dsh.bundle.patch` 指向 host 侧 config 层 YAML；`dsh.client` 是浏览器半段声明，**`platform` 必填**（string），`inject`/`immediately` 可选。
- `exports["./client"]` **必须存在**（string 或 `{default: string}`）。缺失时报错：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。
- `main: lib/index.js` 是 host Loader 导入入口；`type: module` + ESM 产物。

### 4.3 cordis.patch.yml 结构

`- insert: [{id, name, config?...}]`。`name` 用 **bare 包名**（不是相对路径），使包成为 host Loader entry——`dsh-client-modules` node half 只扫**已挂载的 Loader entry** 的 `dsh.client` 声明。host 半段 `apply()` 可以空，但必须存在（否则该行 import 失败）。

### 4.4 profile 模板陷阱

`dsh plugin --profile <新名字> add <包>` 首次初始化用 `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`（**不含 web-app**）。要起 web UI，必须手动把 `@deepseek-ai/dsh-web-app` 加进 `~/.dsh/profiles/point-test/package.json` 的 `dsh.profile.bundles`（顺序 `base → web-app → dsh-point`）。`web`/`headless` 是仅有的两个 shipped 模板名。

### 4.5 `inject` 有两层含义（易混）

- `dsh.client.inject`（package.json manifest）= 包名依赖边，**仅信息性**（preflight 显示 / HMR diff），不决定激活顺序。
- `export const inject = ['slots']`（client bundle 导出）= cordis **服务**依赖，fiber 等 `slots` 服务就绪才激活。激活顺序由服务等待决定。

### 4.6 槽位注入纪律

挂进别的包声明的槽位必须 `ctx.slots.inject(name, () => ctx.slots.register(...))`：等槽声明、随声明塌缩移除、重新声明后重跑。裸 `slots.register` 进未声明槽位是错误。

### 4.7 本地目录安装 = `link:`

`dsh plugin add <绝对路径>` 走 pnpm `link:`（符号链接），dsh 运行时读的是插件的**已构建** `lib/`（非 src）。所以 boot 前必须先构建 `lib/index.js` + `lib/client.js`；devDependencies（esbuild）不会被装进 profile。

## 5. 失败清单（验证纪律）

- **首次点击验证超时**：直接 `js()` 里 `b.click()` 触发 `window.alert`，原生对话框阻塞 `Runtime.evaluate`，导致 ego-browser 的 `js()`/`pageInfo()` 超时。属验证方法问题，非插件缺陷。改用「先覆写 `window.alert` 收集消息 → 点击 → 读回」的非阻塞验证后确认 onClick 正确触发。
- **esbuild `intro` 报错**：见 4.1，已并入 banner 修复。
- tesseract 对截图 OCR 返回空（全图与放大裁剪均空，含合成测试图），弃用；改用 macOS Vision OCR 成功读回。

## 6. 未验证项

- 多插件同挂 / 卸载 / HMR 重载路径（本 spike 单插件、无 rebuild）。
- npm registry / tarball / git 安装（git 安装的 `prepare` build + pnpm `allowBuilds` 流程未走；本 spike 用本地 `link:` 目录）。
- `ctx.locale` 字典与 `NS` 命名空间（按钮文案硬编码中文）。
- host 半段真实 prompt section 注入（本 spike host `apply()` 为空）。
- 按钮真实业务功能（本 spike 仅弹 alert 证明链路，不做真实「标记」）。

## 7. 已知但不修项（spike 简化）

- 按钮用 inline style，未接 dsh CSS token / CSS Module（正式实现改 CSS Module + `--dsw-*`）。
- `apply(ctx)` 用了宽松 `ctx: { slots: Slots }` 类型，未接 dsh 的 `ClientContext`/`PropsRuntime`/`PropsLocale` 类型链（避免引入 monorepo 类型依赖，spike 不 typecheck）。
- `window.alert` 仅作 spike 证明，正式实现用真实 toast。
- 未给插件包写 README.md（Model Experience 段）——spike 交付物不要求。
- 测试 profile `point-test` 保留在 `~/.dsh/profiles/`（用户既有 `web` profile 全程未动）。
