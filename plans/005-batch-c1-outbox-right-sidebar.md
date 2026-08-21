# 批 C1：待发列表搬到右侧预览面板折叠区块 + 打开入口常驻

> 用户验收反馈：待发列表不要放对话框下方，搬到右侧栏。右侧栏 = ui-layout 四列契约里的
> details/preview 列，契约冻结、加第三列出范围——落地形态定为**预览面板底部可折叠区块**，
> 需要 ui-preview 上游再加一个子槽 `preview.footer`（D14）。

## 完成定义
1. ui-preview 在 'preview' 注册里追加声明 `'preview.footer': { kind: 'list', scope: 'session' }`，
   PreviewPanel 在内容区底部以 `renderSlot('preview.footer', {})` 渲染
2. dsh-point 待发列表（PointDock）从 `conversation.composer.dock` 改挂 `preview.footer`，
   做成可折叠区块：标题栏「待发所指 (n)」+ 展开/收起箭头，默认展开，空列表时不渲染
3. 「打开网页」「打开 Office 文档」入口常驻 preview toolbar（不止落地页有），
   viewing 状态下点击可切换回输入界面再开新内容
4. dsh 仓库门禁：`pnpm run test:gui` 绿；可见输出变更跑 `DSH_SNAPSHOT=replay pnpm run test:web`；
   非平凡改动写 Agent Note；中英 locales 同步
5. dsh-point `node build.mjs` 构建通过

## 验证方式
- 仓库内测试 + 快照
- 端到端（ego-browser 截图读回）：暂存两条所指 → 预览面板底部出现「待发所指 (2)」折叠区块 →
  收起/展开正常 → 统一发送 → 会话出现拼接消息；composer.dock 位置不再出现待发列表

## 预估范围（开工前写）
本批做 3 项：
1. ui-preview：`preview.footer` 子槽声明 + 渲染 + locales + 测试
2. dsh-point：PointDock 搬家 + 折叠态 UI
3. ui-preview：落地页两个打开入口常驻 toolbar

## 实际范围（收尾时回填）
- ui-preview：`preview.footer` 子槽声明 + PreviewPanel 底部 renderSlot + OpenEntryButtons 常驻 toolbar + locales + 测试（同预估 3 项）
- dsh-point：PointDock 从 composer.dock 迁到 preview.footer，可折叠「待发所指 (n)」，默认展开，空列表不渲染
- 附带修复：dsh-point `engine.ts` 的 MutationObserver 在 `dispose()` 未断开，切会话后旧 controller 抢占新 iframe 导致标记捕获失效（批 A/B 遗留，非 C1 引入）
- 验证：test:gui 全绿；test:web replay 全绿（无需 refresh）；8898 端到端截图存 `spike/evidence/batch-c1/`
