# 批 C2d：代理质量收尾——localhost 白名单 + 错误页中文化 + JS 资源拦截 + 缩放适配 + 历史栈去重定向跳

> 用户验收反馈（2026-08-19）：①biying.com 打不开且错误是裸 JSON ②开发中的 web 页面
> （localhost）要能预览——**用户已拍板放开 localhost/127.0.0.1（::1 同为 loopback 一并放开），
> 继续拦 10/8、192.168/16、169.254/16 等其他内网段** ③JS 动态加载的图片挂（必应壁纸类）
> ④桌面站在窄面板里显示不全。另主 agent 复验发现：后退会落在 302 重定向中间跳。

## 完成定义
1. **SSRF 白名单收窄**：`/preview-proxy` 放行 loopback（localhost/127.0.0.0/8/::1），
   其余私网段维持拦截；单测更新（原「127.0.0.1 返 400」用例改为放行，新增 192.168 仍拦）
2. **错误页中文化**：代理失败（unreachable/timeout/blocked/协议不支持）渲染 HTML 中文错误页
   （非裸 JSON），包含目标 URL、原因、重试入口；地址栏保持显示目标 URL
3. **JS 资源拦截重写**：注入脚本拦截 fetch / XHR.open / Image.src 赋值（含 setAttribute），
   把根相对与同源绝对 URL 改写为代理路径；已知兜不住全部（JS 字符串拼接 URL、WebSocket），
   写进 Agent Note 已知上限
4. **缩放适配**：预览面板 web 模式加「缩放适配/实际宽度」切换（transform scale 让桌面站整页
   缩进面板宽度，默认实际宽度+横向滚动）；标记坐标换算要适配缩放后的页面（联调验证）
5. **历史栈去重定向跳**：导航历史不记录 3xx 中间跳，后退直接回上一可读页
6. 门禁：webserver/ui-preview 相关测试绿 + 新增单测；typecheck 0；`node build.mjs` 通过

## 验证方式
- 单测：loopback 放行/私网拦截、URL 拦截重写规则、错误页渲染分支
- ego-browser 端到端（8898/8899，8897 是用户验收口别碰）：
  a) `http://localhost:<某端口>` 起一个静态服务器 → 代理打开 → 截图可见
  b) cn.bing.com → 每日壁纸背景图渲染出来（修前挂、修后可见，截图对比）
  c) 故意访问不可达域名 → 中文错误页截图（无裸 JSON）
  d) 窄面板开百度 → 切「缩放适配」→ 整页可见截图；标记一个元素 → 角标落在正确位置
  e) 百度 → 搜索 → 后退 → 直接回首页（不卡中间跳）
- 证据截图进 dsh-point/spike/evidence/batch-c2d/

## 预估范围（开工前写）
1. webserver：白名单收窄 + 错误页 + 注入脚本增强 + 单测
2. ui-preview：缩放适配切换 + 标记坐标联调 + 历史栈修正
3. 端到端验证 + Agent Note + 三件套回填

## 实际范围（收尾时回填）
1. **webserver（`packages/host/webserver/src/preview-proxy.ts`）**：
   - SSRF 白名单收窄：放行 loopback（localhost / 127.0.0.0/8 / ::1），其余私网段（10/8、172.16/12、192.168/16、169.254/16、fe80::/10、fc00::/7）维持拦截；
   - 错误页中文化：`renderErrorPage()` 渲染自包含中文 HTML（目标 URL + 中文原因 + 技术信息 + 重试链接），不再裸 JSON；
   - 注入脚本增强：拦截 `fetch` / `XMLHttpRequest.open` / `Image.src`（含 `setAttribute`），把根相对/协议相对/相对/同源绝对 URL 改写为代理路径；加载完成回传 `dsh-preview-loaded`（final URL）。
   - 单测：新增 loopback 放行、错误页渲染、注入脚本 vm 行为（fetch/XHR/Image/loaded）用例；`preview-proxy.spec.ts` 32 用例 + `webserver.spec.ts` 2 用例全绿。
2. **ui-preview（`packages/client/ui-preview/src/client/`）**：
   - `SandboxedFrame.tsx` 加 `fitWidth` 缩放适配（固定 1280px 桌面视口 + `transform: scale`，ResizeObserver 测宽）与 `onLoaded` 回传；`PreviewPanel.tsx` 加「缩放适配/实际宽度」切换按钮 + `onFrameLoaded` 历史栈替换；`locales.ts` 中英双条；`sandboxed-frame.module.css` 加 `.scroll`/`.scrollFit`。
   - 单测：`preview-panel.client.spec.tsx` +2（缩放切换、重定向后历史栈替换）；`preview-node.client.spec.tsx` 5 用例；共 25 用例全绿。
3. **dsh-point（`src/client/engine.ts`）**：角标/评论窗坐标适配缩放——`frameVisualScale()` 计算 iframe 视觉缩放比，`elementParentRect`/`repositionPopup` 对 iframe 内元素本地坐标乘该比例。
4. 端到端验证（8898 自测口）：五条 a–e 全过 + 额外 302 重定向去重验证；证据截图 7 张进 `dsh-point/spike/evidence/batch-c2d/`。

预估 3 项 = 实际 3 项，零偏差（范围按 plan 完整落地）。

