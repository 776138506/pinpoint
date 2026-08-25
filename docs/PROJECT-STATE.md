# 项目状态

## 路线图（长程）
- 终态（D18 修订）：用户在真浏览器里指着任何网页/文档就能评论发送，所指对象以「截图+结构化文本」直达模型，dsh 会话里渲染为所指卡片
- 阶段（D18 修订）：**统一架构**——Chrome 插件 = 唯一标记/预览战场；dsh 侧插件 = 所指卡片渲染端；dsh 上游预览层（ui-preview/packages/preview）撤除；阶段三 Office 桌面由扩展文档标记（D2b）取代
- 当前里程碑：批 D2（plans/010）——D2a 所指 schema+卡片 → D2b 扩展文档标记 → D2c dsh 侧瘦身 → D2d 上游撤除

## 当前状态
2026-08-20 **批 D2a 已完成**（所指 schema 统一 + dsh 侧所指卡片 + system-prompt section + 单测 + 8899 端到端截图验证）。D18 架构统一终稿已拍板，批 C3 叫停（目标作废，未提交改动留工作区待 D2b 评估复用）。扩展两个实测 bug 已修并构建（会话下拉显名称、删除清高亮），等用户刷新扩展复测。批 D1 联合验收（真浏览器全链）待用户重开侧栏续跑。**批 D2b 待开工**。

## 排队清单
1. 批 D2a：所指 schema 统一 + dsh 侧所指卡片（plans/010，开工中）
2. 批 D2b：扩展文档标记（PDF 自渲/Markdown/docx）
3. 批 D2c：dsh 侧插件瘦身（只留所指卡片）
4. 批 D2d：上游撤除 ui-preview + packages/preview/*（D2b 落地后）
5. 用户联合验收：扩展 bug 复测（刷新扩展）+ D1 全链（重开侧栏）+ D2 全链
6. prompt section 告诉模型所指格式（随 D2a schema 一并考虑）
7. 标记持久化（切会话/刷新后保留，扩展侧）
8. 扩展：dsh → 扩展反向通道（backlog）；扩展商店上架/Firefox/鉴权（backlog）

## 待用户输入
- （无）

## 变更日志

### 2026-08-25：白板画笔模式（页面级涂抹）

- 需求：两种模式互证——标记模式圈出要移动的元素，白板模式画箭头/矩形给出目标位置；涂抹内容截图发 dsh
- 形态：侧栏「白板涂抹」按钮（START_DRAWING 经 background 注入重试中继，一次性触发非 toggle）→ 页面盖全屏画布 + 浮动工具条（画笔/箭头/矩形/撤销/清空/完成/退出）→ 笔迹文档坐标存储、内层滚动锚点跟踪（首笔 elementFromPoint 取底层元素）→「完成」= 笔迹包围盒 +16px 截屏 + 笔迹归一化入 strokeMap，产出普通 region mark 复用暂存/发送管线（发送时 composeScreenshot 合成）
- 关键顺序：先 exitDrawingMode 撤画布再截图（否则笔迹截进底图双重叠加）；strokeMap 先于 addMark 挂载（setState 同步渲染 popup）
- Esc 层级：白板态 > 工具态 > 拖拽态 > 标记态；画布在 OWN_UI_SELECTOR 内，标记/框选处理器天然不响应画布事件（两模式并存不互抢）
- 测试：content.spec +5 例（完成流程/空板守卫/Esc 退出/并存互斥/工具切换），sidepanel.spec fixture 补 start-drawing 按钮；130/130 绿
- ponytail 上限：白板笔迹不持久化（刷新即丢）；多内层滚动容器只跟踪首笔落点链


### 2026-08-25：内层滚动容器失锚 + 弹窗按钮不可见修复

- 现象：dsh 这类应用在内部容器滚动时，region 边框/徽标/弹窗停在视口原位不随内容走（用户报"边框随页面滑动、按钮看不到"）；popupLayer 是 fixed 定位但坐标又加了 window.scroll，window 滚动后弹窗被推出视口
- 修法：mousedown 记录目标祖先链 scroll 快照（ScrollAnchor，全量记录、排除 body/documentElement 防与 window 滚动双重计数），region 边框/徽标/弹窗定位统一减 delta；FOCUS_MARK 跳转先复原锚点滚动；popup 改纯视口坐标 + 完整钳制（下方满→上方→钳进视口）
- 测试：content.spec.ts +2 例（内层滚动 delta 跟随 + FOCUS_MARK 复原；window 滚动 popup 视口钳制），125/125 绿
- 坑：jsdom 同文件存活的旧 content 实例会重复处理拖拽并各挂边框，测试取最后一个匹配元素（本实例最后挂载）（纯增量，唯一的历史通道）
### 2026-08-24 ｜ 侧栏暂存区持久化修复（关窗不丢暂存）
- 根因：侧栏打开期间收到的 STAGE_MARK 只进 sidepanel 内存 state.outbox；side panel 文档一关即销毁，background 的 stagedQueue 只缓冲「侧栏关闭期间」到达的标记——已送达侧栏的标记无人留副本，重开即空
- 变更：sidepanel.ts 新增 panelOutbox 写穿到 chrome.storage.session（微任务合批防抖），初始化时恢复并渲染；background 冲刷缓冲项与 panelOutbox 按 (tabId,index) 去重以新到为准；outbox 每次变更（入列/状态/删除/清空/编辑评论）都触发写穿
- 验证：sidepanel.spec.ts 新增 2 例（重开恢复 / 冲刷去重）；117/117 绿
- 已知项：截图 dataURL 大时可能超 session 配额（10MB），写入失败只记日志不崩（ponytail 已注）

### 2026-08-25 ｜ 框选坐标三 bug 修复（滚动漂移/显示不符/超界）
- 根因与修复（engine.ts 与 extension/content.ts 双侧同构）：
  1. 拖拽中页面滚动 → 区域边界漂移：起点是 mousedown 时的客户区坐标，update/end 却用「旧客户区坐标 + 当前滚动」换算。改为两端点各自「客户区坐标 + 当时滚动快照」换算文档坐标
  2. 框选显示与实际不符：选区矩形/常驻边框挂在 body 下，站点给 body 设 position:relative/margin 时 absolute 定位按 body 偏移。改挂 documentElement
  3. 截图裁剪与框选不符：html2canvas 克隆渲染默认只铺视口大小，页面滚动后按文档坐标裁剪错位/空白。补 windowWidth/windowHeight = scrollWidth/scrollHeight（ponytail：克隆窗口变宽可能触发响应式媒体查询差异）
  4. 顺带：框选钳制到文档范围 [0, scrollWidth]×[0, scrollHeight]，完全拖出范围不产出 mark
- 测试：engine.spec.ts / content.spec.ts 各 +3 例（滚动漂移/钳制/完全出界），123/123 绿 + build 绿
- 待实机验证：重载扩展后在横向滚动页/长页面框选核对显示与截图

### 2026-08-24 ｜ 白板绘画标记（dsh 侧 + 扩展侧）
- 变更：
  - 新增 `src/client/drawing.ts`：纯函数绘画原语，定义 `DrawTool`（画笔/箭头/矩形）与 `Stroke`（比例坐标），提供 `getArrowHead`、`drawStrokes`、`composeScreenshot`。
  - `src/client/engine.ts`：评论窗增加白板绘制层（截图 + canvas + 工具栏），支持画笔、箭头、矩形、撤销、清空；比例坐标存储 strokes；发送/暂存时合成到截图；删除/清空时清理 strokes；Esc 层级改为「工具态 > 拖拽态 > 标记态」；暴露 `consumeStrokes(index)` 给宿主。
  - `src/client/MarkingEngine.tsx`：新增 `onReady(sessionId, api)` 回调，把 `consumeStrokes` 暴露给插件宿主。
  - `src/client/index.ts`：按 `sessionId` 缓存 `MarkingEngineApi`；`sendMark`/`sendAll`/`editInComposer` 在发送前调用 `composeMark` 合成 strokes；`editInComposer` 改为异步。
  - `src/client/PointDock.tsx`：「回输入框」按钮改为 `await editInComposer`，捕获图片插入失败。
  - `extension/src/content.ts`：扩展评论窗同步增加绘画层与工具栏；发送/暂存前调用 `composeLocalMark` 合成 strokes；删除/清空时清理 strokes；Esc 层级对齐 dsh 侧（工具态 > 拖拽态 > 标记态）；新增 `.dsh-point-ext-drawing*` 样式。
  - 新增 `src/client/drawing.spec.ts`（8 例）：覆盖箭头几何、比例→像素换算、绘制指令、合成成功/失败/短路。
  - 扩展 `src/client/engine.spec.ts`（+3 例）与 `extension/src/content.spec.ts`（+3 例）：覆盖绘画层渲染、已发送不渲染、Esc 工具态、发送前合成截图。
- 旧值：评论窗仅支持文字评论，截图原样发送；无标注/画笔/箭头/矩形能力；Esc 不识别工具态。
- 原因：用户验收反馈——需要在截图上圈画重点后再发送，避免纯文字描述位置。
- 验证：`npm test` = `tsc --noEmit && vitest run` 117/117 绿；`npm run build` 绿。
- 已知项/教训：jsdom 无 canvas 2d 实现，drawing.spec 用 fake context + spy 验证绘制指令；content.spec 同文件残留 content 实例监听器未清理，Esc 相关断言只验证当前实例行为；扩展侧绘画 strokes 不持久化（刷新丢失），与 dsh 侧一致。

### 2026-08-24 ｜ 区域框选标记（engine + 扩展 content）
- 变更：
  - `src/client/engine.ts` 增加区域框选：标记模式下 mousedown 开始拖拽，移动 >6px 时绘制选区矩形，mouseup 捕获为 `region:x,y,w,h` 标记；≤6px 视为点击继续走元素捕获；拖拽中 Esc 取消；新增 `.dsh-point-region-rect`/`.dsh-point-region-kept` 样式；`resolveMarkElement`/`markViewportRect`/`renderBadges`/`repositionBadges`/`repositionPopup` 覆盖 region 分支，支持持久边框与角标/弹窗定位。
  - `extension/src/content.ts` 同步实现扩展侧区域框选与持久边框；`FOCUS_MARK` 对 region 滚动并闪烁边框；增加 `scrollIntoView` 运行时存在性判断以兼容 jsdom。
  - 新增 `src/client/engine.spec.ts`（6 例）：覆盖 >6px region 捕获、≤6px 元素捕获、Esc 取消、overlay 起点不触发、region 渲染/定位分支。
  - 扩展 `extension/src/content.spec.ts`（5 例）：覆盖同样规格 + FOCUS_MARK region 闪烁。
- 旧值：仅支持点选元素，无法框选任意区域；无 region selector 及相关渲染分支。
- 原因：用户已确认设计——区域框选用于图片/图表/非文本块的精准所指。
- 验证：`npm test` = `tsc --noEmit && vitest run` 101/101 绿；`npm run build` 绿。
- 已知项/教训：jsdom 不会自动合成 click，≤6px 测试需显式 dispatch `click`；content.ts 模块级 mount 导致多用例间残留 DOM，region 闪烁断言改用组合类名 `.dsh-point-ext-region-kept.dsh-point-ext-flash`；iframe 内区域坐标沿用 iframe 文档坐标，已在注释中说明。

### 2026-08-21 ｜ 测试加固 + ocr 审查修复（schema/mark-utils/shortcut/扩展三文件）
- 变更：
  - 扩展 schema 边界测试：`src/schema/mark-format.spec.ts` 从 13 例增至 27 例，覆盖非法 JSON、缺必填字段、未知字段透传/拒绝行为、version 不匹配、`parseMarkText` 空串/畸形 fence/JSON 数组与原始值/嵌套 fence、`extractReferents` 重复 payload/空锚点/与畸形块共存。
  - 新增 `src/client/mark-utils.spec.ts`（25 例），使用 jsdom 覆盖 `cssPath`、`visibleText`、`snippet`、`detectExternalImages`、`cloneForScreenshot`、`documentRectOf`、`xpathFor`、`textFragmentFor`、`codeLocationFor` 的构造/序列化/边界；DOM 依赖部分全部在 jsdom 环境运行。
  - 新增 `extension/src/shortcut.spec.ts`（6 例），覆盖 `comboFromEvent` 修饰键组合、单键拒绝、大小写统一、非字符键（F5/方向键/Escape/Enter）。
  - 安装 `jsdom` + `@types/jsdom` 到项目内 `devDependencies`；通过 `// @vitest-environment jsdom` 指令为 DOM 测试指定环境，未改动默认 node 环境。
  - ocr scan 审查 `extension/src/content.ts`、`background.ts`、`sidepanel.ts`（25 条评论），修复 P0/P1：
    - `background.ts`：`fetch` 增加 15s `AbortController` 超时；`port.onMessage` 加顶层 try/catch；`checkConnection`/降级分支去除死三元；`chrome.commands.onCommand` 加 try/catch；`STAGE_MARK` 入队前校验 `mark.index`；`session.list`/`session.create`/`SEND_MARK` 增加运行时形状校验。
    - `sidepanel.ts`：增加 `safePost` 与 `port.onDisconnect` 处理；`getElementById` 改为 `reqEl` 显式空值检查；`STAGE_MARK` 改为合并已有记录而非丢弃更新；`sendToActiveTab` 增加 1.5s 超时；健康轮询使用具名常量并随断开清理。
    - `content.ts`：删除未使用的 `disposed` 标志；`renderBadges` 保存元素原始 outline/outlineOffset；`releaseElement` 恢复原始 outlineOffset；评论窗发送增加 10s 超时看门狗；暂存按钮改用 Promise 并处理失败；点击捕获增加 `captureInFlight` 互斥防止并发。
- 旧值：schema 测试仅 13 例；mark-utils/shortcut 无测试；扩展三文件存在多处无超时外部调用、裸 catch、XSS/选择器误伤隐患、端口断连未处理、弹窗死锁、并发捕获等隐患。
- 原因：用户要求按序加固测试并在 ocr 审查后修复 P0/P1；测试优先锁定现有行为，实现改动仅针对已确认缺陷。
- 验证：`npm test` 58/58 passed（3 files）；`npm run build` 绿；`pnpm add -D jsdom @types/jsdom` 仅改项目内依赖。
- 未验证项：未在真实浏览器/扩展环境中运行（只跑纯单元测试，未起 dsh 服务/未装扩展）；ocr 提出的部分 P2（如自定义快捷键 TOCTOU、`renderSessions` 在渲染中改状态、`BASE` URL 硬编码）本次未修复，已记录待后续评估。

### 2026-08-20 ｜ 批 D2a 完成：所指 schema 统一 + dsh 侧所指卡片
- 变更：新增 `src/schema/` 作为所指消息单一事实源；`extension/src/background.ts` 与 `src/client/util.ts` 统一调用 schema 生成；dsh 侧新增 `src/client/referent-card.ts` 通过 DOM MutationObserver 将含 schema 的用户消息渲染为所指卡片；node 半段注册 `dsh-point:referent-format` system-prompt section；新增 vitest 单测并跑绿；8899 端到端 ego-browser 截图验证卡片（截图缩略 + 来源/选择器/摘录/评论）。
- 旧值：schema 由 `src/client/util.ts` 的 `formatMarkText` 单独维护，扩展与 dsh 侧格式可能分叉；dsh 侧无结构化卡片，所指消息以纯文本气泡显示；无 system-prompt 说明；无单测框架。
- 原因：D18 架构统一要求 schema 单一事实源、dsh 侧唯一职责为卡片渲染；批 D2a 按计划落地。
- 证据：`spike/evidence/batch-d2a/02-card-selected.png`。
- 已知上限：消息正文无正式 slot，卡片增强依赖 DOM 结构；多条合并发送未在端到端中实测。

### 2026-08-20 ｜ 批 D2a 代码审查收尾（ocr review）
- 变更：`src/schema/mark-format.ts` 完成三轮 `ocr scan` 发现并修复：消除 `parseMarkText`/`parseBlock` 重复、移除嵌套三元表达式、`extractReferents` 改用 `matchAll` 避免 `lastIndex` 泄漏、摘要对人类可读部分做 HTML 转义并折叠空白、JSON 序列化前将反引号编码为 `\u0060` 防止用户内容破坏 Markdown fence、`parseBlock` 异常时只记录错误消息避免泄露用户内容、版本号 JSDoc 明确为 exact match、单测新增对应覆盖（10 个用例全绿）。
- 旧值：schema 层存在代码重复、嵌套三元、静默吞异常、未对用户内容做 HTML 转义、反引号可破坏 fence。
- 原因：项目验证体系要求交付前完成 `ocr review` 并处理发现；安全与健壮性问题需在 D2a 闭合。
- 验证：`pnpm run build` 绿，`pnpm run test` 10 passed，`src/schema/mark-format.ts` diagnostics 无错误。

### 2026-08-18 ｜ L2 反馈：交互流修订（D11）
- 变更：SCOPE 场景 1 增删功能行（+页面角标反馈/+评论窗/+待发列表，@引用芯片标 ✂）；排队清单重排为 MEU-1 标记+反馈 → MEU-2 评论窗+待发列表 → MEU-3 发送管道；新增 plans/002
- 旧值：排队清单原为「MEU-1 标记+捕获 / MEU-2 @芯片+序列化 / MEU-3 prompt section」；SCOPE 有「@ 引用芯片进输入框草稿」⬜ 行
- 原因：用户验收反馈——标记后要页面原位反馈、标记现场弹评论窗、支持逐条即发与统一发；映射 SCOPE 场景 1，属③增强，当场过堂确认
### 2026-08-18 ｜ MEU-0 spike 通过
- 变更：当前状态从「建档」推进到「spike 完成，可开工 MEU-1」；排队清单移除 MEU-0；plans/001 回填实际范围（预估 2 项 = 实际 2 项，零偏差）；DECISIONS 追加 D10（D9 闭环）
- 旧值：当前状态原为「项目建档，MEU-0 开工」；排队清单首位原为 MEU-0
- 原因：harness 三验证全过 + 第三方 client 插件端到端跑通，设计假设全部成立
### 2026-08-18 ｜ 项目建档
- 变更：创建三件套 + SCOPE + plans/001 + architecture.c4
- 原因：需求讨论（宿主/形态/交互流三问）与设计确认完成，进入 L1

### 2026-08-18 ｜ MEU-1 完成
- 变更：标记模式 + 捕获 + 页面原位反馈（编号角标 + 保持高亮）实现并验证；D12 落地，主文档监听收窄到 `div[data-office]`，iframe 只挂 `iframe[data-testid="web-preview-frame"]`；宿主 UI 点击提示「只能标记预览面板里的内容」；`spike/REPORT-meu1.md` 与 ego-browser 证据截图生成；plans/002 回填实际范围；SCOPE 对应行状态更新。
- 旧值：当前状态为「MEU-0 spike 通过，MEU-1 未开工」；SCOPE 中「页面原位反馈」为 ⬜。
- 原因：完成 MEU-1 全部验收项，进入 MEU-2 前置状态。

### 2026-08-19 ｜ L2 验收反馈过堂：上游化路线（D13）
- 变更：DECISIONS 追加 D13（修订 D5/D12：preview 扩展点上游化、笔刷搬进 preview.toolbar）；SCOPE +2 行（落地页、工具栏子槽）、发送管道行改写两路；排队清单重排为 批 A（plans/003）→ 批 B（plans/004）→ 笔刷搬家+联合验收
- 旧值：排队清单原为「MEU-1 → MEU-2 评论窗+待发列表 → MEU-3 发送管道」；D5 原为「不改 dsh 本体」；笔刷入口原为会话头部
- 原因：用户验收反馈三条——笔刷应在预览页、评论入口缺失（=MEU-2 优先级确认）、预览默认要 Codex 式落地页；ui-preview 无子槽，纯插件路线等于重写预览面板，上游化最快最干净

### 2026-08-19 ｜ 批 A + 批 B + 笔刷搬家完成，进入联合验收
- 变更：SCOPE 场景 1 五行（评论窗/待发列表/发送管道/落地页/toolbar 子槽+笔刷搬家）⬜→✅；plans/003、004 回填实际范围；当前状态推进到「等用户联合验收」；排队清单重排为 验收 → prompt section → 标记持久化 → /preview-file → preview_asset 暴露
- 旧值：当前状态原为「批 A/批 B 并行开工」；排队清单原为「批 A → 批 B → 笔刷搬家+联合验收」
- 原因：批 A（test:gui 3779 绿 + 快照 replay 绿 + 落地页截图）与批 B（评论/暂存/统一发/已发送态截图 + Kimi K3 真实收到图片回复）经主 agent 对抗复核通过；笔刷槽位从 `conversation.session.header.actions` 改为 `preview.toolbar` 并在 8897 实例截图验证（joint-03）
- 附带记录：批 B 修了两个实现 bug（dataUrlToFile 硬校验 PNG；iframe 内元素截图空 data URL → cloneForScreenshot）；发图只有 Kimi K3 过得了 harness 附件校验

### 2026-08-19 ｜ L2 二轮验收反馈过堂：右侧栏 + 网页代理（D14）
- 变更：DECISIONS 追加 D14；新增 plans/005（批 C1 待发列表搬 preview.footer + 入口常驻）、plans/006（批 C2 网页代理浏览器化，拆 C2a/C2b）；当前状态推进到 C1+C2a 并行开工；排队清单重排为 C1 → C2a → C2b → C3 → prompt section → 标记持久化
- 旧值：当前状态原为「等用户联合验收」；排队清单首位原为「用户联合验收（8897）」
- 原因：用户验收反馈三条——①待发列表搬右侧栏（原 composer.dock 在对话框下方）；②打开网页要类浏览器访问真实网站（侦察：百度 CSP frame-ancestors、必应 XFO SAMEORIGIN 封锁直连 iframe，只能走 host 代理）；③打开文档扩展 PDF/Markdown

### 2026-08-19 ｜ 批 C1 完成（preview.footer + 待发列表搬家 + 打开入口常驻 + engine observer 修复）
- 变更：ui-preview 上游加 `preview.footer` 子槽（list/session，PreviewPanel 底部 renderSlot）；dsh-point PointDock 从 `conversation.composer.dock` 迁到 `preview.footer`，可折叠「待发所指 (n)」默认展开、空列表不渲染；「打开网页」「打开 Office 文档」入口常驻 `preview.toolbar`（viewing 态也在）；附带修复 `engine.ts` 的 MutationObserver 在 `dispose()` 未断开导致切会话后旧 controller 抢占新 iframe 的标记捕获失效；plans/005 回填实际范围
- 旧值：待发列表原挂 `conversation.composer.dock`（对话框下方）；打开入口只在落地页；engine observer 未断开
- 原因：D14 落地 + 端到端验证时发现 engine observer 泄漏（批 A/B 遗留，非 C1 引入）阻断标记，最小修复以闭合 C1 验收

### 2026-08-19 ｜ 批 C2d 完成（代理质量收尾：loopback 白名单 + 错误页中文化 + JS 资源拦截 + 缩放适配 + 历史栈去重定向跳）
- 变更：dsh 上游 `packages/host/webserver/src/preview-proxy.ts` 收窄 SSRF 白名单（放行 loopback，其余私网段维持拦截）、`renderErrorPage()` 中文 HTML 错误页、注入脚本拦截 fetch/XHR/Image.src 并回传 `dsh-preview-loaded`；`packages/client/ui-preview` 加「缩放适配/实际宽度」切换（1280px 桌面视口 + transform scale）与历史栈去重定向跳；dsh-point `engine.ts` 角标坐标适配缩放。SCOPE 场景 1「外部 URL 预览元素级标记」✂→✅（代理使其同源可标）。plans/008 回填实际范围；DECISIONS 追加 D15
- 旧值：外部 URL 跨源不可标（D6）；代理错误页为裸 JSON；loopback 被 SSRF 拦截；JS 动态资源（必应壁纸）404；桌面站窄面板显示不全；历史栈记录 302 中间跳
- 原因：用户验收反馈四条 + 主 agent 复验发现后退卡 302 中间跳；loopback 放行已由用户拍板（本地开发页可预览）
- 已知上限（JS 资源拦截兜不住）：JS 字符串拼接 URL、WebSocket、CSSOM 内联样式动态改背景、`<link>/<script>` 动态注入，写入 DECISIONS D15 与最终交付说明

### 2026-08-19 ｜ 批 C2b 完成（补录：预览面板浏览器化 chrome）
- 变更：预览面板 web 模式加地址栏（显示真实 URL、可编辑回车跳转）+ 后退/前进/刷新；代理页内导航 postMessage → 宿主历史栈（百度 GET 搜索表单序列化生效）；SandboxedFrame 对代理页放开 allow-scripts；plans/006 回填实际范围。主 agent 在 8897 亲验：百度渲染/搜索/链接跳转/前进后退 ✅
- 旧值：预览面板打开网页仅落地页输入 URL 直渲，无浏览器 chrome
- 原因：D14 第 3 条落地的后半批；已知打磨项——历史栈当时记录 302 中间跳（后退会落在跳转中间页），已在批 C2d 修复
- 补录说明：本条目因批 C2d 收尾时一并回填 plans/006 而迟录，证据见 spike/evidence/c2-verify/

### 2026-08-20 ｜ 批 D1 完成（浏览器扩展 MVP）
- 变更：`dsh-point/extension/` MV3 扩展交付；content script 移植标记引擎、Side Panel 承载待发列表/会话选择/连接状态、background service worker 中转 `localhost:8897/api/session.prompt`；`src/client/mark-utils.ts` 抽取纯函数与 `engine.ts` 共享；`package.json` build 脚本同步构建扩展；plans/009 回填实际范围；SCOPE 场景 2 行状态更新
- 旧值：浏览器扩展仅立项，无代码；场景 2 content script 圈选为 ⬜
- 原因：协议实测通过（文本+图片均达 8897 测试会话），按 D16 边界完成最小可用扩展闭环
- 证据：`spike/evidence/batch-d1/ego-mark-captured.png`；协议测试会话 `session-a0e6a86c-5a02-4875-954a-9c8f923ab609`
- 已知上限：扩展商店/Firefox/鉴权/PDF 内标记/captureVisibleTab 未做；端到端装扩展真浏览器运行属联合验收项

### 2026-08-20 ｜ 批 D1 立项（浏览器扩展提前，D16）
- 变更：DECISIONS 追加 D16（MV3 + Side Panel + background 中转通道 + DOM-clone 截图 + 引擎复用策略）；新增 plans/009；architecture.c4 加扩展插件边界（content script / Side Panel / background 三容器）；排队清单重排为 D1 → C3 → 联合验收
- 旧值：浏览器扩展原排在阶段二（路线图中远期）；C3 原排首位
- 原因：用户验收代理方案后确认其硬缺陷（登录态/SPA/视频/反爬）需治本，拍板扩展提前并要求保持侧边栏模式；C3 用户明示排在 D1 之后

### 2026-08-20 ｜ 批 D1 代码完成 + 信任栅栏修复（D17）
- 变更：扩展 MVP 落地（`dsh-point/extension/`：MV3 + Side Panel + content script 标记 + background 中转）；`src/client/mark-utils.ts` 抽取共享纯函数（engine.ts 与扩展共用）；dsh 上游 `packages/client/connection/src/api-request-trust.ts` 放行扩展 Origin（D17）；plans/009 回填实际范围；SCOPE 场景 2 行状态更新
- 旧值：浏览器扩展为空白；dsh /api 对扩展 Origin 一律 403
- 原因：批 D1 实施 + 联合验收发现 403 阻断（node 直测无 Origin 头掩盖）；已 curl 验证放行精确（扩展通/恶意网站仍拦）
- 待办：真浏览器端到端联合验收（装扩展→标记→发送→8897 查收）进行中

### 2026-08-20 ｜ D18 架构统一终稿 + 扩展 bug 修复 + C3 叫停
- 变更：DECISIONS 追加 D18（预览层撤到 Chrome 插件、dsh 侧插件变薄为所指卡片端、上游 ui-preview 待 D2b 后撤除、所指 schema 统一）；新增 plans/010（批 D2 四子批）；路线图/当前状态/排队清单整体改写；批 C3 叫停（agent-17 killed，未提交改动留 deepseek-harness 工作区待 D2b 评估复用）
- 旧值：路线图为「阶段一 dsh Web UI 内闭环 → 阶段二 浏览器扩展 → 阶段三 Office 桌面」；D13 上游化路线有效；排队首位为批 D1/C3
- 原因：用户三轮架构校准后拍板——真浏览器即预览器，代理路线硬缺陷（登录态/SPA/视频/反爬）在真浏览器天然不存在；dsh 侧插件只保留所指卡片渲染（用户确认）；上游撤除时机 = 扩展文档标记落地后（用户确认）
- 同批修复（扩展实测 bug）：会话下拉显示 `projections.values.title`（background.ts LIST_SESSIONS 映射 + sidepanel.ts 渲染）；删除/清空标记释放元素 KEPT_OUTLINE 高亮（content.ts 新增 releaseElement）；`pnpm run build` 绿，待用户 chrome://extensions 刷新复测

### 2026-08-20 ｜ 所指精准锚点（用户验收反馈）
- 变更：所指消息新增 `anchor` 通道（schema ReferentAnchor，可选）——文档坐标 rect / XPath / Text Fragments 文本锚（可拼 URL 直接滚动高亮）/ 代码位置（GitHub/GitLab 风格页面尽力识别文件+行号）；捕获助手进 `src/client/mark-utils.ts` 共享，扩展 content.ts 捕获时填充；人读摘要新增「代码位置 / 定位 / 坐标」行；schema 版本保持 `dsh-point/referent@1`（可选字段，向后兼容）；13/13 测试绿
- 原因：用户要求所指像坐标一样精准锁定，避免接收方反复查找沟通

### 2026-08-21 ｜ 标记全灭事故修复（OWN_UI_SELECTOR 子串误伤）
- 变更：content.ts 自有 UI 排除选择器从 `[class*="dsh-point-ext"]` 子串匹配改为精确类名枚举（overlay/badge/popup-layer/popup/toast）
- 旧值：子串选择器命中 body 上的标记态类名 `dsh-point-ext-marking`，标记模式下每个元素都被排除 → 全页面无法标记
- 原因：08-20 修「评论窗被高亮」时引入；经 ego 实机复现（标记态开但悬停/点击无响应）+ 控制变量探针定位；修复后实机 E2E 全链验证通过（标记/高亮/捕获/评论窗/截图）
- 教训：自有 UI 排除禁用属性子串通配，必须枚举精确类名；扩展改动后核心链路要实机复测

### 2026-08-21 ｜ 草稿标记生命周期修复（孤儿高亮 + 重复捕获）
- 变更：content.ts 评论窗「×」关闭草稿态标记 = 撤销（清高亮+角标）；onClick 命中已标记元素（含子元素）时重开评论窗而非重复捕获
- 旧值：捕获即挂高亮+角标，关闭评论窗不清理 → 页面留高亮但暂存区无记录；再点同元素重复捕获
- 原因：用户验收反馈；ego 实机 E2E 验证（关闭即全清 / 暂存后重开不重复）

### 2026-08-21 ｜ 暂存列表跳转定位 + 评论二次编辑（用户验收反馈）
- 变更：暂存项点击跳转——STAGE_MARK 链路携带 tabId（background 从 sender.tab 提取，缓冲/冲刷同带）；侧栏点击暂存项 info → FOCUS_MARK（background 激活标签页+聚焦窗口，content 滚动居中+box-shadow 脉冲闪烁 1.8s，selector 失效回退 anchor.xpath）；暂存项新增「编辑」按钮行内二次编辑评论，保存同步 UPDATE_MARK 到来源页；删除/清空/发送状态同步从「活动页」改为「标记来源页」（修跨 tab 残留高亮隐患）；测试 58/58 绿 + build 绿；ego 实机验证（闪烁类出现/消失、标签页激活、编辑同步到页面评论窗）
- 原因：用户要求暂存列表可直达标记位置（闪烁提醒）并支持评论二次编辑
- 已知上限：updateUi 全量重渲染会丢弃未保存的行内编辑内容（ponytail：不加草稿保护）

### 2026-08-21 ｜ 不变量归并审计补漏（Esc 退出草稿 + 重载残留 DOM）
- 变更：按 状态×事件 矩阵审计「页面高亮 ⇔ 暂存区有记录」全路径，补两个空格——①退出标记态（Esc/快捷键/侧栏）时 settleDraft 了结草稿（有评论自动暂存、无评论撤销）；②mount 时清理扩展重载后旧实例残留的 overlay/popup/toast DOM（防双 overlay/僵尸角标；旧内联 outline 无法枚举，随页面刷新消失，ponytail 上限已注）
- 原因：用户纠正"点修未归并根因"后按新机制（~/.agents/docs/llm-deficiency-compensation.md 第 1/10 行）回扫同族路径
- 验证：58/58 测试绿 + build 绿；ego 实机——Esc 无评论=全清、Esc 有评论=自动暂存并冲刷到侧栏

### 2026-08-21 ｜ 五问审视整改：3 个 P1 + 参数分级可调（不器）
- 变更（五问审视后整改）：
  - 枚举 P1：mark.index 原为 tab 内编号却在暂存区当全局键——跨 tab 同号互覆；暂存区改 (tabId,index) 复合键，SEND_MARK/SEND_RESULT 透传 tabId
  - 容错 P1：html2canvas 加超时（挂起曾致标记功能静默锁死）
  - 复归 P1：stagedQueue 持久化 chrome.storage.session（MV3 SW 死亡不再丢缓冲；超限降级纯内存，ponytail 已注）
  - 不器整改（用户拍板）：参数三级分级——L1 实例地址（侧栏设置区）、L2 高级五项超时/轮询（折叠区+慎改提示）、L3 系统常量不开放；每字段带合法域校验（端口范围/超时上下限），非法拒收；三容器（background/content/sidepanel）经 chrome.storage 缓存+热更新；状态栏显示配置地址；设置变更立即重检连接；RPC 错误体截断 120 字符防 HTML 撑爆状态栏
- 新增：extension/src/settings.ts + settings.spec.ts（8 例）；测试 66/66 绿
- 验证：ego 实机——跨 tab（example.com+org）双 #1 不合并；改地址 9999 立即如实显示未连接；非法输入被拒；恢复默认回 8897
- 注意：localhost:9999 实为 Hindsight Control Plane（Docker），非 dsh

### 2026-08-24 ｜ 设置迁入选项页 + itemKey 复合键修复 + Pinpoint 更名发布 GitHub
- 变更：
  - 设置统一迁入扩展选项页（options.html + src/options.ts），侧栏只留「打开设置」入口（chrome.runtime.openOptionsPage）；侧栏内旧设置表单/快捷键录入代码清除
  - 快捷键改「按键即绑定」：聚焦输入框按下组合键立即保存；无效按键给原因反馈（单字母拒收/只按修饰键提示补主键/Esc 取消/Tab 留给焦点导航）；选项页移除 L1/L2 分级 jargon（用户：分级字样不应出现在前端）
  - 修 itemKey 复合键失配 P0：OutboxItem 无顶层 index（在 mark.index），三处 find 全部失配——sendNow 自动发送失效、SEND_RESULT 匹配不上卡「发送中」、去重失效；esbuild 不做类型检查致静默通过 → 引入 tsc 门禁
  - 新增 tsconfig.json + typescript/@types/chrome/@types/react，`npm test` = `tsc --noEmit && vitest run`；39 个存量类型错误清零（行为保持：instanceof 守卫/判别联合/补初值）
  - 修 background 两个队列 bug：多 port 时 onDisconnect 无条件置空 panelPort（改为仅当前 port 断开才置空）；onConnect 冲刷队列与异步恢复竞态（queueReady 屏障，此前 SW 重启+侧栏快连会用空队列覆盖已持久化暂存=数据丢失）
  - 更名 Pinpoint（用户弃「所指助手」）：manifest name/description、侧栏/选项页标题、package.json description、README；内部标识（CSS 类名/log 前缀/端口名/存储键/包名 dsh-point/挂载路径 /plugins/dsh-point/）保持不变以兼容已装实例
  - 发布 GitHub 公开仓库 https://github.com/776138506/pinpoint（topic: dshplugin/dsh/chrome-extension/browser-extension）；CI（typecheck+vitest+双侧构建）首跑绿；Release 流水线（tag v* → 扩展 zip + dsh 插件 tgz）v0.1.0 实跑绿，双产物已下载校验内容
  - 上传前审计：密钥 0 命中（2 处误报已核）、/Users/ 路径 2 处已改通用形式、数据文件为开发证据截图（测试页/公开站点）、.git 18M
- 旧值：设置在侧栏内（L1/L2 分区）；快捷键录入无反馈；测试无类型门禁；品牌为 dsh-point 所指助手
- 原因：用户指令——设置入插件设置页、按键即绑定、去分级字样、起好名字公开发布带 CI/CD
- 验证：66/66 测试绿（含 tsc 前置）+ build 绿；ego 实机——选项页改地址 9999 侧栏热更「未连接」、恢复默认回 8897、快捷键四场景（单字母拒/修饰键提示/Ctrl+Shift+K 绑定/恢复默认）、确认即发 1.5s 内「已发送」、缓冲→重连冲刷→手动发送送达（dsh 侧 session title 证实）
- 教训：esbuild 只转译不查类型，TS 项目必须有独立 tsc 门禁（本次 P0 即漏网）；YAML plain scalar 折叠会吞续行反斜杠，多行命令一律用块标量 `run: |`
- 已知项：缓冲期 sendNow 标记重连后因会话列表未加载不自动补发，转为待发送需手点（排队清单）；github.com:443 本机间歇性被重置（api.github.com 正常），push 需重试循环

### 2026-08-24 ｜ 扩展名称残留排查：非代码问题，是扩展未重载
- 现象：用户截图侧栏顶栏仍显示「dsh-point 所指助手」，面板 h1 已是 Pinpoint
- 结论：顶栏文字来自 manifest.json name 字段（浏览器 chrome 渲染），更名提交后扩展未重载故仍是旧名；源码全仓 grep 已无「所指助手」残留
- 处理：ego CDP 对扩展 service worker 执行 chrome.runtime.reload()，重开 sidepanel 验证 title=「Pinpoint 侧边栏」/ h1=Pinpoint；dsh 侧 UI 无显示包名的位置（可见文案为「所指/待发所指」标记物称呼），cordis.patch.yml 的 name 仅作 Loader 挂载标识，不动
- 教训：浏览器扩展的 manifest 元信息（名称/图标/权限）改动后必须重载扩展才生效——交付含 manifest 变更的批次时，验收步骤要带「重载扩展」动作

### 2026-08-24 ｜ 侧栏去重：移除面板内 h1
- 变更：extension/sidepanel.html 删除 `<h1>Pinpoint</h1>` 及其 CSS——顶栏（manifest name 渲染）与面板标题重复
- 验证：66/66 测试绿 + build 绿；ego 重载后 DOM 断言 h1=null、首元素为状态条，截图确认视觉

### 2026-08-24 ｜ 标记态「复归」修复：不支持页无法退出标记 + port 断线自愈
- 变更：
  - background 新增 markingTabs 按 tab 跟踪标记态；整页导航（status:loading）/关 tab 自动出清并同步侧栏按钮；切 tab 时按钮反映新活动 tab 标记态
  - 活动页不支持标记但仍有 tab 在标记时，toggle（侧栏按钮与 Alt+Shift+M 同语义）视为「退出全部标记」——强制 SET_MARKING false + 复位侧栏，不再卡死报错
  - sidepanel port 断线自动重连（1s 重试 + 重连后补 HEALTH_CHECK/LIST_SESSIONS）；断线不再停健康轮询——轮询报文兼作 SW 唤醒器
  - 新增 extension/src/background.spec.ts（4 条回归：强制退出/导航出清/SPA 不误清/正常 toggle 跟踪），chrome API 全 stub 动态 import
- 旧值：标记态为全局单值且无按 tab 跟踪；活动页不支持标记时 toggle 只报错；port 断开即死（面板后台节流时点击静默无反应）
- 原因：用户验收发现「支持页进入标记 → 进入不支持页无法退出」（留白缺口：不支持页无状态落点）
- 验证：红灯复现 3/4 → 修复后 70/70 绿（含 tsc）+ build 绿。ego 端到端部分验证——content 标记/退出机制、面板↔background 消息链路实测通；但 ego 任务空间窗口拿不到 OS 焦点，chrome.tabs.query currentWindow 恒为用户窗口，面板点击→活动 tab 的完整回路无法决定性复现（依赖单元测试兜底）；调试期间曾误触用户窗口标记态，已全量广播 SET_MARKING false 清理
- 教训：MV3 SW 空闲即死、长连 port 随之断——面板类 UI 必须有断线重连；ego 任务空间验证涉及「当前焦点窗口」语义的扩展 API 时有方法论盲区

### 2026-08-24 ｜ 异常边界全面过堂：状态×事件矩阵枚举 + 4 缺口修复
- 缺口与修复：
  1. Esc 退出标记不同步 background/侧栏（页面内自定义快捷键有同步、Esc 漏了）→ 侧栏按钮停「退出标记」，再点反而重开（状态撕裂）。抽 syncMarkingState() 统一两条本地路径
  2. content onMouseOut 缺 chrome.runtime.id 失效守卫（onMouseOver/onClick/onKeyDown 都有）→ 扩展重载后旧实例擦掉新实例的悬停高亮（双实例干扰）
  3. port 断开瞬间在飞的发送永远等不到 SEND_RESULT → 卡「发送中」永久禁用。断开时 sending 项如实降级 error「连接中断，结果未知」，不自动重发（session.prompt 非幂等），用户确认后手动重发
  4. 侧栏（重）连后标记按钮靠记忆值 → background 在 onConnect 时用 GET_STATE 探测活动 tab 真实标记态同步按钮（SW 重启丢 markingTabs / 断连期间用户 Esc 都能复归）
- 测试：新增 content.spec.ts（jsdom，Esc 同步/快捷键同步/失效守卫 3 条）、sidepanel.spec.ts（jsdom，sending 降级/断线重连 2 条）、background.spec.ts 补 2 条（重连探态/探测失败不回推）；77/77 绿（含 tsc）+ build 绿
- 枚举后判定为「已有覆盖」的边界（抽查确认）：捕获时了结旧草稿/退出标记了结草稿/关闭草稿窗即撤销（高亮⇔暂存不变量）、截图超时降级纯文本、发送看门狗、点已标记元素重开评论、捕获防抖 captureInFlight、popupBusy 防双击、暂存区跨 tab 删除/清空、FOCUS_MARK 页面已导航如实报错、SPA 导航标记保留+角标隐藏
- 已知不改项：截图异步期间退出标记仍会弹评论窗（与「角标点击开评论」同语义，非缺陷）；跨域 iframe 内元素不可标记（manifest 未开 all_frames，边界有意）；旧实例内联 outline 无法枚举清理（随刷新消失）

### 2026-08-24 ｜ 全面审查二轮：并发/竞态/注入面 13 处缺口修复
- 缺口与修复（审查：三路并行源码审查 + 逐条人工核实，全部为真实可触发路径）：
  - P0 engine：捕获无防重入且无 KEPT_FLAG 检查——连点/点已标记元素会并发跑 captureElement 读同一 nextIndex，产生同 index 重复 mark。加 captureInFlight 闸 + findKeptMarkIndex 重开 popup（对齐扩展侧 findMarkedAncestor 语义）；stores.addMark 同 index 替换而非追加作最后防线
  - P1 engine：iframe 内导航/刷新后 `__dshPointAttached` 永不重置 → 监听器 stranded 在死文档上，标记功能静默失效。onFrameLoad 重置 attached/crossOrigin 标志并重绑
  - P1 PointDock：单条发送 busyOne 时批量按钮仍可点（并发双发）；任一发送在飞时其他行单发/回输入框仍可点。统一 `busyAll || busyOne !== null` 门禁
  - P1 index：editInComposer 先 addImages 后 setDraft——setDraft 抛异常时输入框留悬空图片。换序为先文本后图片，图片失败时报错文案明示「文字已写入」
  - P1 referent-card：消息内容里的 source.url 直接进 `link.href`（javascript:/data: 可注入）。URL 协议白名单 http/https，其余渲染纯文本
  - P1 background：queueReady 恢复「空才恢复」——SW 重启后恢复完成前到达的新 STAGE_MARK 让已持久化暂存被整体丢弃（数据丢失）。改为按 (tabId, index) 合并去重
  - P1 background：toggle 完成后直接回推被操作 tab 状态——期间用户切 tab 则按钮显示错 tab 状态。改为重查当前活动 tab 回推
  - P1 background：rpc 只校验 rpcId——200 + 非信封 JSON 时调用方访问 result.ok 抛 TypeError。补 server-response/result.ok 形状校验
  - P1 sidepanel：connect 失败 1s 无限重试（扩展失效时静默空转）。指数退避（1s→30s 封顶）+ 连续 10 次放弃并提示「关闭后重新打开侧边栏」；connectPort 入口互斥防叠加
  - P1 options：「全部恢复默认」未清 customShortcut，文案不名副其实。同步清除
  - P2 background：STAGE_MARK 缓冲不去重（重连冲刷出重复项）→ 同键替换；SEND_MARK 补 mark.index 校验；session.list 逐项过滤脏条目；截图 base64 提取失败从静默丢失改为 downgraded 上报
  - P2 键盘：content onKeyDown 与 options 快捷键录入补 e.repeat 守卫（长按反复 toggle）；options 录入放行 F1-F12 与 Ctrl/⌘+R/T/W/N/Q/L 等浏览器自身按键
- 测试：新增 stores.spec.ts（2 条）；background.spec.ts harness 升级（tabsQuery/sessionGet/sessionSet 可编程）+ 7 条新用例（恢复合并/去重×2/切 tab 回推/信封校验/脏条目过滤/malformed 不发起 rpc）；content.spec.ts 修假等待 + repeat 守卫 2 条；sidepanel.spec.ts 补 connect 退避放弃/退避后恢复 2 条（fake timers）。90/90 绿（含 tsc）+ build 绿
- 记录为已知不改项：saveSettings 双选项页 read-modify-write 竞态（storage 无原子合并）；attachment-error 降级重发文字重复风险（待验证 dsh 幂等性）；persistQueue 超 10MB 配额只记日志（ponytail 已注）；referent-card MutationObserver dispose 未接（enhancer 幂等）；manifest host_permissions 过宽（任意页标记是核心功能，有意）；engine 本地 state 与 store 瞬态撕裂；发送中关 popup 失重试入口；批量发送用渲染快照；textFragmentFor 死代码路径；engine 未填 anchor 字段（dsh 侧精准定位未启用）
- 教训：jsdom 同文件多用例共享 document——早前用例挂的 content 实例监听器不清，且读「当前」全局 chrome stub，会串到后跑用例的 mock（断言计数需容忍或用行为断言）
