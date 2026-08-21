# 批 C2：网页代理——预览面板像浏览器一样访问真实网站

> 用户要求：打开网页要达到 Codex 一样的功能，像浏览器一样访问各种网页（百度/必应等）。
> 侦察结论（2026-08-19）：真实网站直连 iframe 不可行——百度 GET 带
> `CSP frame-ancestors 'self'`、必应跳 cn.bing.com 带 `X-Frame-Options: SAMEORIGIN`。
> 唯一路线：host 服务端代理 → 剥 XFO/CSP → 重写 URL → srcdoc 同源渲染（顺带让标记可用）。

## 拆批说明
- **C2a（本 plan 前半）**：host 代理路由 + HTML/URL 重写引擎，独立可验证（curl + ego-browser 直开代理 URL）
- **C2b（后半，依赖批 C1 落地后开工，避免同改 PreviewPanel.tsx）**：预览面板浏览器化 chrome——
  地址栏、前进/后退/刷新、代理页内链接点击继续走代理

## C2a 完成定义
1. `packages/host/webserver`（src/index.ts:170 createServer 处）新增 `/preview-proxy?url=<目标>`
   GET 路由：抓取目标页（跟随重定向、合理 UA、超时 ≤15s、响应大小上限如 10MB）
2. HTML 重写：剥掉响应头 XFO/CSP（代理本身不转发这两个头）；文档内 `<base href>` 指向目标站；
   `src/href/srcset`、CSS `url()`、`<form action>` 相对/绝对路径重写为绝对或代理路径；
   剥离文档内 `<meta http-equiv="Content-Security-Policy">`
3. 注入导航脚本：拦截 `<a>` 点击与 form 提交，改写为 `parent` 可处理的代理跳转
   （postMessage 通知宿主或直接 `top.location = /preview-proxy?url=...`）
4. 非 HTML 资源（图片/CSS/JS/字体）代理直通：`/preview-proxy` 对非 HTML 内容类型透传字节+原 content-type
5. 安全边界：仅 http/https；拒绝内网地址（127.0.0.0/8、10.0.0.0/8、192.168.0.0/16、169.254.0.0/16、
   ::1 等 SSRF 防护）；失败给结构化错误（目标不可达/超时/协议不支持）
6. 仓库门禁：webserver 包相关测试绿；新增代理逻辑的单元测试（重写规则、SSRF 拦截）

## C2a 验证方式
- 单元测试：URL 重写（相对/绝对/srcset/CSS url()）、CSP meta 剥离、SSRF 地址拒绝
- 实测：`curl 'http://localhost:8897/preview-proxy?url=https://www.baidu.com'` 返回 200 且无 XFO/CSP 头；
  ego-browser 直开代理 URL 截图——百度首页渲染出 logo/搜索框
- 必应（会 302 到 cn.bing.com，XFO SAMEORIGIN）经代理可开

## C2b 完成定义（后半，C1 落地后开工）
1. 预览面板 web 模式加浏览器 chrome：地址栏（显示当前 URL、可编辑回车跳转）、后退/前进/刷新按钮
2. 打开网页默认走代理（`kind: 'web'` 且为 http(s) URL 时经 `/preview-proxy`）；
   内联 HTML 仍走原 srcdoc 直渲
3. 代理页内链接点击 → postMessage → 宿主面板导航（历史栈维护，前进后退可用）
4. SandboxedFrame 对代理页放开 `allow-scripts`（真实网站要 JS）；沙箱 flag 变化要在 Agent Note 里写明安全权衡
5. 标记引擎对代理页（同源 srcdoc）标记/截图照常工作——ego-browser 实测：打开百度 → 标记搜索框 → 评论发送

## C2b 验证方式
- ego-browser 全流程截图：打开百度 → 搜索词提交 → 结果页 → 点链接跳转 → 后退 → 标记元素 → 评论发送成功
- 已知上限写进文档：登录态站点、重度 SPA 可能半残；C2b 不承诺

## 预估范围（开工前写）
C2a 做 3 项：代理路由 + 重写引擎 + SSRF 防护与单测
C2b 做 3 项：地址栏 chrome + 导航历史 + 沙箱/标记联调

## 实际范围（收尾时回填）
- **C2a（批 c2a，完成并经主 agent curl+截图复核）**：`packages/host/webserver` 新增 `/preview-proxy?url=<目标>`
  GET 路由（跟随重定向、桌面 UA、超时、大小上限）；HTML 重写剥 XFO/CSP 头 + `<meta CSP>`，
  `<base href>` 指向目标站，资源 URL 绝对化；非 HTML 透传字节+原 content-type；SSRF 防护拦内网
  （127.0.0.1 实测返 400）；26 个单元测试（重写规则 + SSRF 拦截）。实测：百度/必应经代理 200 可开。
  预估 3 项 = 实际 3 项，零偏差。
- **C2b（批 c2b，代码与测试经主 agent 复核；端到端由主 agent 在 8897 亲验）**：预览面板 web 模式
  加浏览器 chrome——地址栏（显示真实 URL、可编辑回车跳转）、后退/前进/刷新；代理页内导航
  postMessage → 宿主历史栈（百度 GET 搜索表单序列化生效，地址栏跟到 `/s?...wd=...`）；
  SandboxedFrame 对代理页放开 `allow-scripts`（安全权衡见该批 Agent Note）；聚焦测试 44 个、
  test:gui 3813 绿、typecheck 0。主 agent 端到端复验：百度首页渲染 ✅、搜索 ✅、链接跳转 ✅、
  后退/前进机械可用 ✅。**已知打磨项：历史栈把 302 重定向中间跳也记入，后退会落在跳转中间页
  而非直接回上一可读页**（不阻塞验收，如实告知用户）。
- 已知上限（plan 内已声明，重申）：登录态站点、重度 SPA 半残；C2 不承诺。
