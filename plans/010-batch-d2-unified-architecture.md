# plans/010 ｜ 批 D2：架构统一——预览入浏览器，dsh 侧变薄（D18）

## 背景与目标

按 D18 终稿落地统一架构：Chrome 扩展成为唯一标记/预览战场，dsh 侧插件只渲染所指卡片，上游 ui-preview 撤除。终态：用户指着真浏览器里的任何网页/文档就能评论发送，dsh 会话里看到结构化所指卡片。

## 子批划分（串行依赖 D2a → D2b → D2c → D2d）

### D2a ｜ 所指 schema 统一 + dsh 侧所指卡片

- dsh-point 仓库新增 `src/schema/`：所指消息结构化格式（JSON 头 + 人读文本）单一事实源；扩展 `background.ts` 的 `formatMarkText` 改为按 schema 生成（机器可解析块 + 人读摘要）
- dsh 侧插件（`src/client/`）新增所指卡片渲染：识别会话消息中的所指格式，渲染为卡片（截图缩略 + 来源 URL/标题 + 选择器/摘录 + 评论），非所指消息不受影响
- 验证：schema 单测（生成→解析往返）；8897 实例实测扩展发送 → 会话里出现卡片（截图证据）

#### D2a 实际范围与偏差

- 实际完成：
  - `src/schema/mark-format.ts` + `src/schema/index.ts`：定义 `ReferentPayload`、`formatMark(mark, comment)`、`parseMarkText(text)`、`extractReferents(text)`，版本号 `dsh-point/referent@1`。
  - schema 单测 `src/schema/mark-format.spec.ts`（vitest）：往返、缺字段容错、非所指文本不误判、多 payload 提取。
  - `extension/src/background.ts` 改用 `formatMark`；`extension/src/content.ts` 与 `src/client/engine.ts` 捕获时补 `sourceUrl`/`sourceTitle`。
  - `src/client/util.ts` 委托 schema，保证 dsh 侧旧标记引擎也发送同一格式。
  - `src/client/referent-card.ts`：因 `conversation.chat.node` 没有消息正文子槽，采用 DOM MutationObserver 增强已渲染消息；复用宿主 ImageGallery 截图；样式贴近 dsh 气泡。
  - `src/index.ts` node 半段注册 `dsh-point:referent-format` system-prompt section。
  - 端到端：8899 实例 curl 发送 schema 文本 + 1x1 PNG 附件，ego-browser 截图验证卡片渲染。
- 偏差：
  - 未找到正式消息正文扩展点，采用 MutationObserver 兜底（`referent-card.ts` 顶部 `ponytail` 标注）。
  - 截图缩略通过移动宿主 ImageGallery 实现，非卡片独立加载 attachment。
  - 端到端仅覆盖单条所指消息；多条合并发送场景由 `extractReferents` 支持，但未在 8899 实测。

### D2b ｜ 扩展文档标记

- 扩展 side panel 加「打开文档」入口：独立扩展标签页承载文档渲染 + 标记层
- PDF：扩展内 pdf.js 渲染（Chrome 内置 viewer 对 content script 封闭，D16 已知边界，故自渲）；文本层可选中，元素级标记复用现有捕获
- Markdown/docx：渲染为 HTML 页（评估复用 C3 在 ui-preview 的 Markdown 渲染实现——在 deepseek-harness 工作区未提交改动里）
- 验证：三种格式各一份样例，标记→评论→发送全链截图证据

### D2c ｜ dsh 侧插件瘦身

- 移除 MarkingEngine/PointDock/preview 槽位挂载（preview.toolbar/footer 注入全撤）；`src/client/` 只留所指卡片
- `mark-utils.ts`/`engine.ts` 中仅扩展在用的部分归档或删除（扩展已自带移植版）；保留与 schema 共用的部分
- 验证：`pnpm run build` 绿；8897 加载后会话头部/预览区无标记按钮残留，所指卡片正常

### D2d ｜ 上游撤除（D2b 落地后才开工）

- 删除 deepseek-harness `packages/client/ui-preview`、`packages/preview/preview-server`、`packages/preview/tool-preview`；清理 `packages/bundle/web-app`、`packages/bundle/base` 的引用；清理 C3 未提交改动残留
- 同时撤除 dsh-point 对 preview 槽位的类型依赖
- 验证：dsh 仓库自身门禁（`pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`）绿；8897 重启后无预览面板、其余功能正常；遵守 dsh 仓库 Agent Note / 双语 locales 惯例

## 边界与排除

- 不做：dsh → 扩展反向通道（dsh 主动请用户标记某页）、扩展商店上架、Firefox、鉴权、PPT 标记
- 8897 是用户验收口，agent 不碰；agent 自测另起端口
- deepseek-harness 有用户未提交改动，只准碰本批指定包

## 验收

- 每批：构建绿 + 证据截图（主 agent 抽读）+ plans 回填
- 全链联合验收（用户）：真浏览器标记网页 + 标记 PDF → 发送 → 8897 会话出现所指卡片
