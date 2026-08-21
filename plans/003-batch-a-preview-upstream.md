# 批 A：dsh 上游 ui-preview —— 默认落地页 + preview.toolbar 子槽

> 本批改的是 deepseek-harness 仓库（上游化路线，D13），不是 dsh-point 插件。

## 完成定义
1. 打开预览面板且无内容时，默认显示启动页：两个主按钮「打开网页」「打开 Office 文档」（Codex 式落地页），替代现有 demo 文档默认页
2. 「打开网页」→ 输入 URL 或内联 HTML → 渲染进沙箱 iframe（沿用 SandboxedFrame）
3. 「打开 Office 文档」→ 选择本地 .docx/.xlsx → 经 host `/preview-file` 渲染（沿用 OfficeRenderer）；不支持的头（如 .pptx）给中文失败文案
4. ui-preview 声明 `preview.toolbar` 子槽（面板头部工具栏），第三方插件可经 `ctx.slots.inject('preview.toolbar', ...)` 注入按钮——用 dsh-point 笔刷按钮实测挂得上
5. dsh 仓库门禁：`pnpm run test:gui` 绿；可见输出变更则 `DSH_SNAPSHOT=replay pnpm run test:web` 绿；非平凡改动附 Agent Note（.agents/notes/）；中英 locales 同步

## 验证方式
- 仓库内：`test:gui` + `test:web` replay
- 端到端：point-test profile 起 dsh web，ego-browser 截图——默认落地页、两个按钮各自走通、toolbar 子槽被 dsh-point 注入

## 预估范围（开工前写）
本批做 4 项：
1. 启动页组件 + 默认路由（无内容时显示）
2. 打开网页链路（复用现有输入 UI 或简化重做）
3. 打开 Office 链路（文件选择 → /preview-file → 渲染器分发）
4. preview.toolbar 子槽声明 + Agent Note + locales

## 实际范围（收尾时回填）
2026-08-19 回填。实际做 4 项 = 预估 4 项，两处偏差：

1. 落地页 + 打开网页/Office 链路：`PreviewPanel.tsx` 新增 landing/web/office/viewing 四态，「打开网页」URL 或内联 HTML → SandboxedFrame；「打开 Office 文档」选 .docx/.xlsx 渲染，不支持格式给中文失败文案
2. `preview.toolbar` 子槽：`apply.ts` 在 'preview' 注册里声明 `'preview.toolbar': { kind: 'list', scope: 'session' }`，`PreviewPanel` 以 `renderSlot('preview.toolbar', {})` 渲染；dsh-point 笔刷实测挂得上（joint-03 截图）
3. 附带修复：`srcdoc`→`srcDoc` React warning、toolbar key 重复、locale 命名空间合并移入 `contract/preview-slots.ts`
4. 门禁全过：`test:gui` 3779 绿；`DSH_SNAPSHOT=refresh+replay test:web` 绿（~42 个 header 快照因新增「预览」按钮更新，预期内）；Agent Note 中英三件套落 `.agents/notes/implemented/feature/2026-08-19-ui-preview-landing-toolbar.*`

偏差：
- **Office 文件走浏览器 blob URL 直开，未实现 `/preview-file` 服务端路由**——上游化后 preview 是纯客户端插件，本地文件 blob 直开更简单；将来需服务端转换/缓存再补
- 完成定义 ④「用 dsh-point 笔刷实测挂得上」由主 agent 在笔刷搬家步完成（joint-03 截图），非批 A agent 自验
