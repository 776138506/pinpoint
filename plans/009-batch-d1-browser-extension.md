# 批 D1：浏览器扩展 MVP——真实网页上标记→评论→发到 dsh 会话

> 用户拍板（2026-08-20）：浏览器扩展提前（原阶段二）。形态 = Chrome/Edge MV3 扩展，
> Side Panel 侧边栏（与 dsh Web UI 预览面板同构体验）。代理方案继续覆盖"读"场景，
> 扩展解决其硬缺陷（登录态/重度 SPA/视频/反爬）。

## 现状
- dsh-point 已有标记引擎 `src/client/engine.ts`（悬停高亮/点击捕获/角标反馈/DOM-clone 截图/
  结构化序列化）与评论窗、待发列表 UI——但耦合 dsh client runtime（slot 注入、conversation 服务）
- dsh 侧外部通道：`packages/host/apiproxy`，`POST /api/<method>` JSON 信封（rpcId 回显、
  Zod 双层解析、415 媒体类型门禁挡跨站简单请求）；`session.prompt` 存在；
  README.zh.md 与 `lib/types/api/*.d.ts` 是协议事实源
- 批 B 经验：harness 附件校验只有 Kimi K3 能过图片；Web UI 内部走 createDraftImages，
  扩展是外部通道，图片格式要按 sessions.schema 实测

## 完成定义
1. **扩展骨架**：`dsh-point/extension/`，Manifest V3（Chrome/Edge 通用）；
   `chrome.sidePanel` 原生侧边栏（点击工具栏图标对当前标签页开合）
2. **页面内标记**（content script）：悬停高亮、点击捕获、编号角标、跟随元素的评论窗
   （「发送」/「暂存」双按钮）——复用 engine.ts 的捕获/截图/序列化逻辑
   （能抽共享纯函数就抽，不能就移植，禁止重写第三套）
3. **侧边栏**：待发列表（统一发/逐条发/删除）、目标会话选择（默认最近活跃会话）、
   与 8897 的连接状态；页面内标记与侧栏列表经扩展消息实时同步
4. **发送通道**：content script → background service worker 中转 fetch →
   `http://localhost:8897/api/session.prompt`（`host_permissions: http://localhost:8897/*`）；
   所指 = 结构化文本 + 截图附件；附件格式若被 harness 校验拒，降级为纯文本结构化所指
   并在 UI 明示（不静默丢图）
5. **截图**：DOM-clone 路线（零额外权限，与 engine 同源）；`captureVisibleTab` 不进本批
6. **本批不做**：扩展商店上架、Firefox 版、鉴权/多用户、PDF 内标记（Chrome PDF viewer 对
   content script 封闭，已知边界）

## 验证方式
- 协议层：node 模拟 background 直连 8897——`session.prompt` 带所指文本（+图片）真实送达会话，
  Kimi K3 会话可见（读 session log 或 Web UI 截图）
- 标记逻辑层：content script 的捕获/角标/评论窗在测试页（本地静态页）上可跑——
  可借 ego-browser 向真实页面注入脚本验证 DOM 行为，截图存 spike/evidence/batch-d1/
- 真浏览器端到端（装扩展→标记→发送）属联合验收项，agent 交付安装说明，用户装完一起验
- 门禁：扩展自身构建通过；dsh-point 既有测试不红；typecheck 0

## 预估范围（开工前写）
1. 协议打通：apiproxy 信封 + session.prompt + 附件实测（第一天先跑通，不通则调整通道设计）
2. 扩展骨架 + content script 标记 + 评论窗
3. Side Panel 待发列表 + 消息桥 + 发送管道
4. 验证 + 安装说明 + 三件套回填

## 实际范围（收尾时回填）
1. 协议打通：apiproxy 信封（`type/rpcId/method/payload`）+ `session.list/create/prompt` 实测；文本与 1×1 PNG 附件均通过 harness 校验并真实进入 `session-a0e6a86c-5a02-4875-954a-9c8f923ab609` 测试会话历史
2. 扩展骨架：`dsh-point/extension/` MV3 扩展；`manifest.json` 声明 `sidePanel`/`tabs`/`activeTab`/`host_permissions: http://localhost:8897/*`；`background` ESM service worker + content script IIFE + Side Panel HTML
3. content script：移植 engine.ts 核心能力（悬停高亮/点击捕获/编号角标/跟随元素评论窗/发送+暂存双按钮/DOM-clone 截图）；纯函数抽取到 `src/client/mark-utils.ts` 与 engine.ts 共享
4. Side Panel：待发列表（统一发/逐条发/删除）、目标会话选择（默认最近更新会话）、8897 连接状态；content script 与侧栏经 background 端口实时同步
5. 发送通道：background 直调 `http://localhost:8897/api/session.prompt`；图片附件被 harness 拒绝时自动降级纯文本所指并返回 `downgraded` 标志，侧栏 UI 明示
6. 验证：node 协议脚本 + ego-browser 注入 content script 捕获截图（`spike/evidence/batch-d1/ego-mark-captured.png`）
7. 未做（本批边界）：扩展商店上架、Firefox、鉴权、PDF 内标记、`captureVisibleTab`
