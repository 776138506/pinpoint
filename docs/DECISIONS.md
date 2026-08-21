# DECISIONS — ADR 决策日志（只追加，不改历史）

## D1（2026-08-18）宿主范围：都要，分阶段
- 背景：用户要 Codex 式网页元素标记 + WorkBuddy 式 Office 标记
- 决定：阶段一 dsh Web UI 内闭环（preview 面板）→ 阶段二浏览器扩展（任意网页）→ 阶段三 Office 桌面（macOS AppleScript/AX 优先于 Office.js，链路更短）
- 理由：阶段一全插件化闭环、最快验证交互范式；外部宿主链路长，范式未验先铺是浪费

## D2（2026-08-18）内容形态：截图 + 结构化文本
- 截图走 dsh 现成图片附件管道（addImages → sha256 → ImageBlock），模型能"看"
- 结构化文本（类型/选择器/可见文本/截断 outerHTML/来源）让模型能"读懂"
- 排除项：不扩展自定义 ContentBlock 类型——文本编码够用，第二个需求出现再抽（YAGNI）

## D3（2026-08-18）交互流：标记 → 输入框引用芯片 → 用户补一句话一起发
- 复用 @ 引用管道（`inputTriggers.registerSource`），用户保持发送主动权
- 排除项：标记即发送（易误发）、静默 inject（不可审计）

## D4（2026-08-18）不新增会话事件族
- 所指内容搭普通 `user/message`（text+image）的车，天然满足 dsh「model-visible means logged」铁律
- 自定义 ConversationNodeDefinition / SessionEvent 族等特殊渲染，等"所指消息需要特殊展示"成为真实需求再说

## D5（2026-08-18）不改 dsh 本体
- 标记层 = 文档级事件监听 + 高亮 overlay，纯 out-of-tree 插件可做到（preview 的 single 槽位被 ui-preview 占用，不抢）
- 长期正式路径：给上游提 PR 加 `preview.overlay` 子槽，阶段二前再议
- 风险：依赖 preview 面板 DOM 结构（data-testid 等），上游改版可能漂移——标记模式入口失败时要有失败文案

## D6（2026-08-18）跨源 iframe 不可标记 = 阶段一已知限制
- 证据：`sandboxed-frame.tsx:21` 沙箱含 `allow-same-origin`；srcdoc 内联 HTML 同源可读 DOM，外部 URL 跨源不可读
- agent 生成的页面（artifact）都走 srcdoc → 主要场景覆盖；外部 URL 预览给明确失败文案，不硬解

## D7（2026-08-18）host 半段仅注册 prompt section
- 告诉模型 `[所指 #n]` 格式含义；web-app bundle 里「浏览器无隐式 DOM 上下文」声明不冲突（我们传的是显式消息内容），不 patch 它

## D8（2026-08-18）词表
- 标记（动作）/ 所指（对象）/ 引用芯片（输入框占位符）；UI 全中文，代码注释英文

## D9（2026-08-18）截图方案待 MEU-0 验证
- 候选：html2canvas（主）、foreignObject SVG（备，外部资源会污染 canvas）
- 验证点：同源 iframe 内 + office 渲染容器内的区域截图可行性；MEU-0 不过则回流改设计

## D10（2026-08-18）MEU-0 spike 结论固化（D9 闭环）
- **截图主路径定 html2canvas + `useCORS:true`**：同源 srcdoc iframe 内元素、office 容器元素均实测可行；CORS 服务器的外部图正常渲染不污染，非 CORS 图静默丢图（白块不崩）→ 配「外部图片可能缺失」降级文案
- **foreignObject 备选弃用**：子树含任何 `<img>` 时 SVG-as-img 整体加载失败，agent 页面普遍含图，不可用
- **禁止**对非 CORS 图裸 `drawImage`（taint → `toDataURL` 抛 SecurityError）
- **iframe 内 MouseEvent.clientX/Y 是 iframe 自身视口坐标**：`elementFromPoint` 直用，不得再减父页偏移（误减会命中 `<html>`）
- 第三方 client 插件端到端跑通（D5 的 out-of-tree 路线成立）：client bundle 是 `window.__ModuleLoader__.load({id, factory})` 闭包工厂 classic script（非 ESM），react 等平台模块 external；`exports["./client"]` 必须指向构建产物；新 profile 需手动补 `@deepseek-ai/dsh-web-app` 进 bundles
- 证据：spike/REPORT.md、spike/REPORT-plugin.md、spike/evidence/*.png、spike/screenshots/mark-button.png

## D11（2026-08-18）交互流修订：评论流取代引用芯片（修订 D3）
- 旧值（D3）：标记 → @ 引用芯片进输入框草稿 → 用户补一句话一起发
- 新值：标记 → 页面原位反馈（编号角标 + 保持高亮，Codex 风格）→ 跟随元素弹评论窗 → 「发送」单条即发 / 「暂存」进待发列表 → 待发列表（输入框上方）可统一发 / 逐条发 / 回输入框编辑
- @ 引用芯片管道取消：评论流一条链路到底，不维护两套入口
- 理由：用户 L2 反馈——标记现场就要评论；发送主动权用双按钮兼顾（逐条即发 + 攒着统一发）
- 技术影响：角标需处理滚动/缩放跟随与 iframe→父页坐标换算（spike 已验证坐标系）；待发列表挂 `conversation.composer.dock` 槽位；角标/评论窗状态进 client store（跨条目共享、防 remount 丢失）

## D12（2026-08-18）标记范围限定预览面板内容区
- 决定：标记只作用于 preview 面板内的内容——srcdoc 网页 iframe、`div[data-office]` office 渲染容器；dsh 宿主 UI（聊天区、侧栏、头部等）**不响应**标记
- 实现含义：主文档监听只对 preview 区域内的 office 容器生效（按 `data-office` 祖先判定），不是 document 级全域监听；标记模式开启时光标/提示也应体现「只能标预览内容」
- 理由：用户定位 = 人机协作办公——标记的是「工作产物」（预览的网页/文档），不是工具本身的 UI；全域监听会误标聊天消息，污染所指语义

## D13（2026-08-19）上游化路线（修订 D5 与 D12 的笔刷入口）
- 背景：L2 验收反馈——①标记笔刷应长在预览页上（预览的工具，不是会话的工具）；②预览面板默认要是 Codex 式启动页（打开网页 / 打开 Office 文档按钮）；③评论入口缺失（= 已排队的 MEU-2，不缺陷）
- 决定：dsh（deepseek-harness）是我们自己的部署（用户本就在改 ui-preview），preview 侧扩展点**上游化**：ui-preview 增加 `preview.toolbar` 子槽 + 默认落地页；dsh-point 的笔刷从会话头部搬到 `preview.toolbar`
- 修订 D5「不改 dsh 本体」→ 新边界：**preview 相关扩展点上游化；标记/评论/发送引擎仍在插件**；dsh 上游改动遵守仓库自身门禁（`pnpm run test:gui`、可见输出变更跑 `DSH_SNAPSHOT=replay pnpm run test:web`、非平凡改动写 Agent Note、中英双语 locales）
- 修订 D12：笔刷入口从 `conversation.session.header.actions` 改为 `preview.toolbar`（会话头部不再放标记按钮）
- 发送管道两条路（侦察已探明，本周期实现）：直发 = `session.prompt`（结构化文本+图片附件 → user/message）；进草稿 = composer 草稿契约（addImages + 引用插入），供待发列表「回输入框编辑」

## D14（2026-08-19）待发列表搬右侧 + 网页代理浏览器化（L2 二轮验收反馈）
- 背景：用户联合验收反馈——①待发列表不要放对话框下方（composer.dock），搬到右侧栏；②「打开网页」要能像浏览器一样访问真实网站（百度/必应），当前直连 iframe 白屏，用户感知为"功能缺失"；③「打开文档」要扩展到 Office 之外的 PDF/Markdown
- 侦察结论：真实网站直连 iframe 不可行——百度 GET 带 `CSP frame-ancestors 'self'`，必应 302 到 cn.bing.com 带 `X-Frame-Options: SAMEORIGIN`；右侧栏是 ui-layout 四列冻结契约（sidebar/center/details/preview），加第三右列出范围
- 决定：
  1. **待发列表 = 预览面板底部可折叠区块**：ui-preview 上游再开 `preview.footer` 子槽（list/session），dsh-point PointDock 从 `conversation.composer.dock` 搬家；「右侧栏」落地为预览面板内底部区块，用户验收时校准
  2. **打开入口常驻**：「打开网页」「打开 Office 文档」从仅落地页改为常驻 preview toolbar
  3. **网页代理浏览器化**（C2）：host webserver 加 `/preview-proxy`——抓取目标站、剥 XFO/CSP、重写 URL、注入导航脚本，srcdoc 同源渲染；预览面板 web 模式加地址栏/前进/后退；代理页放开 `allow-scripts`；SSRF 防护（仅 http/https + 拒内网段）；**bonus：代理页同源，标记/截图对真实网站可用**
  4. **文档扩展排队**（C3）：Markdown 渲染 HTML 可标记；PDF 原生 blob 打开暂不可标记（pdf.js 可标记版后期单独立批）；pptx 继续中文失败文案
- 已知上限（写进 plan）：代理 MVP 保"能开/能看/能标记/能点链接"，登录态与重度 SPA 半残不承诺

## D15（2026-08-19）代理 SSRF 白名单放行 loopback + JS 资源拦截的已知上限（C2d）
- 背景：用户验收反馈——①开发中的本地 web 页面（localhost）要能预览 ②必应每日壁纸等 JS 动态加载资源 404 ③桌面站窄面板显示不全；主 agent 复验发现后退卡 302 中间跳
- 决定：
  1. **SSRF 放行 loopback**（localhost / 127.0.0.0/8 / ::1），继续拦 10/8、172.16/12、192.168/16、169.254/16、fe80::/10、fc00::/7 等其余私网段。安全权衡：loopback 放行让代理可访问本机任意端口的 HTTP 服务（含仅本机可见的调试/内网服务），SSRF 面从「仅公网」扩到「公网 + 本机 loopback」；因代理本身只跑在本机、目标由使用者在预览面板主动输入、且仍拦其余私网段（防跳板到局域网/云元数据），风险可控，用户已拍板
  2. **JS 资源拦截**：注入脚本拦截 `fetch` / `XMLHttpRequest.open` / `Image.src`（含 `setAttribute`），把根相对/协议相对/相对/同源绝对 URL 改写为代理路径。已知上限（兜不住，不承诺）：JS 字符串拼接 URL、WebSocket、CSSOM 内联样式动态改背景（如 `el.style.backgroundImage`）、`<link>/<script>` 动态注入
  3. **缩放适配**：预览面板 web 模式加「缩放适配/实际宽度」切换——固定 1280px 桌面视口渲染，缩放适配用 `transform: scale` 缩到面板宽度（默认实际宽度 + 横向滚动）；dsh-point 标记角标/评论窗坐标按 `frameVisualScale()` 换算缩放比
  4. **历史栈去重定向跳**：注入脚本加载完成回传 `dsh-preview-loaded`（final URL），宿主把当前历史栈条目替换为可读的 final URL，后退/前进不再落在 302 中间跳
- 理由：修用户可感知的四类代理质量问题；loopback 放行与 JS 拦截上限都做显式声明，不静默扩大能力或假装兜全

## D16（2026-08-20）浏览器扩展提前：Side Panel 形态 + background 中转通道（批 D1）
- 背景：用户验收代理方案后追问硬缺陷（登录态/重度 SPA/视频/反爬）的治本路线；三条候选（浏览器扩展/系统浏览器逃生门/本地托管真浏览器+屏幕流），用户拍板扩展提前（原阶段二），并要求保持现有侧边栏模式
- 决定：
  1. **MV3 扩展放 dsh-point/extension/**，Chrome/Edge 通用；`chrome.sidePanel` 原生侧边栏承载待发列表/会话选择/连接状态（与 dsh Web UI 预览面板同构体验，不用页面内 iframe 假侧栏）；悬停高亮/角标/评论窗留页面内 content script（必须贴着元素）
  2. **发送通道 = background service worker 中转**：content script 直连 localhost:8897 会被页面 CORS 拦；background + `host_permissions: http://localhost:8897/*` 合法跨域，POST /api/session.prompt（apiproxy JSON 信封，415 媒体类型门禁天然挡跨站简单请求，扩展不受影响）
  3. **截图 = DOM-clone 路线**（与 engine.ts 同源，零额外权限）；`captureVisibleTab` 更保真但要 activeTab 权限+用户手势门槛，不进 MVP
  4. **标记引擎复用策略**：能抽共享纯函数就抽，不能就移植，禁止在扩展里重写第三套捕获/序列化逻辑
  5. **信任模型**：本机单用，不做鉴权；扩展只连 localhost:8897
- 已知边界：Chrome 内置 PDF viewer 对 content script 封闭——浏览器里直开的 PDF 标不了，回退路径 = dsh 预览面板；附件过 harness 校验只有 Kimi K3 可行（批 B 经验），扩展通道的附件格式开工第一天实测，不通则降级纯文本所指并 UI 明示
- 排除项（本批不做）：扩展商店上架、Firefox、鉴权、PDF 内标记

## D17（2026-08-20）dsh 信任栅栏放行浏览器扩展 Origin（批 D1 联合验收发现的阻断点）
- 背景：批 D1 联合验收时扩展 Side Panel 健康检查 403——`packages/client/connection/src/api-request-trust.ts` 的 Origin 栅栏要求 Origin 与 Host 严格同源，`chrome-extension://<id>` 恒不匹配。node 直测（无 Origin 头）能过，掩盖了该问题直到真实扩展环境暴露
- 决定：栅栏放行 `chrome-extension://` 与 `moz-extension://` scheme 的 Origin。依据：该 scheme 的 Origin 网页无法伪造（只有用户主动安装的扩展才能持有），用户安装扩展即显式授权；Host 栅栏（loopback/trustedHosts）与跨站标记检查不受影响，恶意网站 Origin 仍 403
- 验证：新增单测（extension Origin 放行 + 既有用例全绿 11/11）；8897 实测 curl：扩展 Origin 200 / evil.example 403 / 无 Origin 200
- 边界说明：本批原计划不动 dsh 仓库，此为联合验收暴露的最小上游修复（connection 一个文件 + 一个测试），已在现场拍板

## D18（2026-08-20）架构统一终稿：预览层撤到 Chrome 插件，dsh 侧插件变薄（用户三轮方向校准后拍板）
- 背景：批 D1 联合验收后用户提出架构级要求——dsh 里有插件、Chrome 里也有插件，要统一成「一个适用于 dsh 的插件，仅一个核心功能：标记评论（直达结果的沟通交流方式）」。经三轮校准：①初案（ui-preview 保持上游，两端共享标记 core）→ ②用户：ui-preview 是基础依赖也并入 dsh-point → ③用户终案：**预览层整个撤掉，迁移到 Chrome 插件**——真浏览器本身就是预览器，代理/srcdoc 路线（D14/C2 系列）的硬缺陷（登录态/SPA/视频/反爬）在真浏览器里天然不存在
- 决定：
  1. **Chrome 插件 = 主插件**：网页标记（浏览器即预览）+ 文档标记（扩展内打开 PDF/Markdown/docx 并标记）+ 评论 + 发送，一套 UI 一处维护
  2. **dsh 侧插件（dsh-point client）变薄**：唯一职责 = 把到达会话的所指消息渲染为结构化「所指卡片」（截图缩略 + 来源 + 评论）；不再挂 preview.toolbar/footer，不再做标记引擎；会话创建/选择留在扩展侧栏（用户确认）
  3. **上游撤除**：`packages/client/ui-preview` + `packages/preview/*`（preview-server/tool-preview）从 deepseek-harness 删除，时机 = 扩展侧文档标记落地之后（用户确认），避免青黄不接；撤除后 dsh 无内置预览能力
  4. **所指 schema 统一**：dsh-point 仓库内单一 schema 定义，扩展生成端与 dsh 卡片渲染端共用，不再两处各写
  5. **批 C3 叫停**（ui-preview Markdown/PDF 目标作废）；其未提交改动留在 deepseek-harness 工作区，Markdown 渲染部分在批 D2b 评估复用，上游撤除批一并清理
- 修订关系：D13「preview 扩展点上游化」整体作废（上游化路线终结）；D14 第 1/2 条（preview.footer/打开入口常驻）、D15（代理质量）随 ui-preview 撤除而失效；D16（扩展形态）、D17（信任栅栏）继续有效
- 同批修复（用户实测反馈）：扩展会话下拉改显示 `projections.values.title`（原只显 id 尾 8 位）；删除/清空标记时释放元素 KEPT_OUTLINE 高亮（原 renderBadges 只清角标 DOM 不清元素 outline）
