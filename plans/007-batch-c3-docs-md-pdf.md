# 批 C3：文档扩展——Markdown（可标记）+ PDF（原生打开暂不可标记）

> 用户要求（2026-08-19）：打开文档可以打开 office、pdf、Markdown 等等文档；请做好规划，逐步迭代。
> 本批只覆盖 Markdown 与 PDF；pptx 维持现状（中文失败文案）。
> 设计立场（D14 的延续）：能同源的才给标记能力；不能同源的（PDF 原生 viewer）明说不可标记，
> 不做半成品（PDF 文本层 hack 进 backlog，不进本批）。

## 现状
- 「打开 Office 文档」入口在上游 `deepseek-harness/packages/client/ui-preview/src/client/PreviewPanel.tsx`
  （批 A 落地页 + C1 常驻 toolbar）；docx/xlsx 走 `renderers/office-renderer.tsx`
  （依赖 docx-preview / xlsx，包 deps 已有）；pptx 有中文失败文案。
- 上游已有 Markdown 渲染能力：`packages/client/ui-primitives` 的 `src/markdown/`
  （依赖 mdast-util-from-markdown，conversation 消息渲染在用）——C3 优先复用其转换产物或管线，
  不新增第三方 markdown 依赖；若复用粒度不合适（组件级耦合），可用 mdast-util-from-markdown
  自己转 HTML，同样不加新依赖。
- dsh-point 标记引擎只认同源内容（srcdoc / 代理页 / office-renderer 的 div[data-office]）。

## 完成定义
1. **Markdown**：「打开 Office 文档」文件选择 accept 扩展 `.md`/`.markdown`；
   md 文本渲染成 HTML，经 srcdoc 进 SandboxedFrame（与内联 HTML 同路径，同源可标记）；
   基本样式内联进 srcdoc（跟随面板主题的极简排版即可，不引外部 CSS）
2. **PDF**：accept 扩展 `.pdf`；用浏览器原生 viewer 打开（object/blob URL 或 iframe blob），
   不提供标记；PDF 打开后预览面板显示一行常驻中文提示「PDF 暂不支持标记」
   （提示形态对齐现有文案惯例，进 locales.ts 中英两条）
3. **打开入口命名**：若 accept 扩到 md/pdf，入口文案视情况从「打开 Office 文档」调整为
   「打开文档」（中英 locales 同步，对齐既有文案惯例）
4. 标记联调：md 页标记 → 评论窗 → 暂存/发送链路不受影响（engine 对 srcdoc 路径已验证，
   本批确认 md srcdoc 走同一路径即可）
5. 门禁：ui-preview 包测试绿 + 新增 md/pdf 分支的测试（test:gui 或包内单测，按包惯例）；
   typecheck 0；`node build.mjs` 构建通过

## 验证方式
- 包内测试 + typecheck
- ego-browser 端到端（agent 自跑 8898/8899，8897 是用户验收口别碰）：
  打开一个真实 .md（含标题/列表/代码块）→ 截图读回 → 标记其中一个元素 → 评论暂存成功；
  打开一个真实 .pdf → 原生 viewer 渲染 → 「PDF 暂不支持标记」提示可见
- 测试资产：dsh-point/spike/evidence/ 下新建 batch-c3/，md/pdf 样例可就地生成最小文件

## 预估范围（开工前写）
1. md：accept 扩展 + md→HTML→srcdoc 渲染路径 + 内联样式 + 标记联调
2. pdf：accept 扩展 + blob 原生 viewer + 「暂不支持标记」提示
3. 文案/locales 调整 + 测试 + Agent Note

## 实际范围（收尾时回填）
（待填）
