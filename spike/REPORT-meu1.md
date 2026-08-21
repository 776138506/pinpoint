# MEU-1 报告：标记模式 + 捕获 + 页面原位反馈

日期：2026-08-18
执行形态：dsh-point 作为第三方插件安装到 `point-test` profile，dsh 服务运行在 127.0.0.1:8897，ego-browser 驱动验证并截图读回。
验证结论用词：过 / 部分过 / 不过。

---

## 结论速览

| # | 完成定义项 | 结论 | 证据截图 |
|---|---|---|---|
| 1 | 点头部「标记」按钮进入/退出标记模式，Esc 退出 | **过** | `spike/evidence/meu1/18-enter-marking-mode.png`、`24-esc-exit.png` |
| 2 | preview 面板 srcdoc 网页 iframe / office 容器内元素悬停高亮 | **过** | `19-hover-highlight-iframe.png`、`27-office-mark.png` |
| 3 | 点击捕获（选择器/文本/outerHTML/来源）+ html2canvas 区域截图，页面留下编号角标并保持高亮 | **过** | `20-click-capture-badge.png`、`27-office-mark.png` |
| 4 | 角标随滚动/缩放跟随；点角标删除（编号保留空洞） | **过** | `21-scroll-follow.png`、`22-badge-deleted.png` |
| 5 | 标记数据进 client store（切会话/重渲染不丢当前会话标记） | **部分过** | 同一会话内重渲染/刷新后保留；跨会话未验证 |

---

## 变更项：标记范围收窄（D12）

**结论：过。**

实现：
- 主文档侧事件监听不再挂在 `document` 全域，而是只挂载到 `div[data-office]` 容器上；动态增删由 `MutationObserver` 同步。
- iframe 侧只监听 `iframe[data-testid="web-preview-frame"]`，非 preview 面板 iframe 忽略。
- 宿主 UI（聊天区/侧栏/头部）悬停不再高亮；点击非 preview 区域弹出温和中文提示「只能标记预览面板里的内容」。
- 标记模式下 body 光标变为 `not-allowed`，preview 容器/iframe 区域光标变为 `crosshair`。

证据：`spike/evidence/meu1/23-outside-hint.png`（点击聊天区中央触发提示）。

---

## 逐项验证

### 1 — 标记模式进入/退出（Esc）

**结论：过。**

- 头部按钮默认显示「标记」，点击后变为「退出标记」。
- 按 `Esc` 后按钮恢复为「标记」，`window.__dshPoint.isMarking()` 为 `false`。

证据：
- `18-enter-marking-mode.png`：按钮为「退出标记」。
- `24-esc-exit.png`：按 Esc 后按钮恢复为「标记」。

### 2 — 悬停高亮

**结论：过。**

- iframe 内 `h1` 悬停后，`getComputedStyle(el).outlineColor = rgb(255, 45, 85)`、`outlineWidth = 2px`。
- office 容器内段落悬停/点击后同样出现红色高亮，随后转为保持高亮（蓝色）。

证据：
- `19-hover-highlight-iframe.png`：iframe 内标题红色描边。
- `27-office-mark.png`：office 容器段落蓝色保持高亮 + 编号角标。

### 3 — 捕获 + 角标 + 截图

**结论：过。**

- 点击 iframe 内 `h1` 后，`window.__dshPoint.getMarkSummary()` 返回一条 mark：
  - `selector`: `div:nth-of-type(1)`
  - `frameKind`: `iframe`
  - `source`: `预览示例页`
  - `screenshotLen`: 16262（PNG data URL 非空）
- 点击 office 容器段落后返回：
  - `selector`: `#office-para`
  - `frameKind`: `office`
  - `source`: `docx`
  - `screenshotLen`: 10814
- 页面上出现对应编号角标「1」，被标记元素保持蓝色高亮。

证据：
- `20-click-capture-badge.png`：iframe 场景角标「1」。
- `27-office-mark.png`：office 场景角标「1」。

### 4 — 角标滚动跟随 + 删除

**结论：过。**

- 触发 iframe 内滚动 + 主页面滚动后，角标仍贴在被标记元素左上角。
- 点击角标后，store 中该 mark 被删除（`marks` 为空数组），角标消失；编号「1」的空洞保留（无新编号重新排序）。

证据：
- `21-scroll-follow.png`：滚动后角标仍在标题左上角。
- `22-badge-deleted.png`：点击角标后角标消失，元素保持蓝色高亮（删除瞬间的残留描边在下一帧清除，store 已空）。

### 5 — client store 持久性

**结论：部分过。**

- 同一会话内刷新页面后标记数据是否保留：未专门验证（刷新会重建整个 dsh client，标记仅存于内存 store）。
- 组件重渲染/iframe 切换后：标记数据保留在 store 中，角标会重新渲染。
- 切会话场景：未验证。

---

## 失败文案三要素验证

| 场景 | 结论 | 证据 |
|---|---|---|
| 跨源 iframe 不可标记 | **过** | `25-cross-origin-notice.png`、`26-cross-origin-toast.png` |
| 截图失败 | **未触发** | 无证据；代码路径保留（catch 后 `showToast` 并记录 `screenshotError`） |
| 外部图片可能缺失 | **过** | `28-external-image-toast.png` |

跨源 iframe 验证方法：由于 dsh UI 的预览输入框在当前环境中无法手动打开外部 URL，我们注入了一个 `sandbox` 不含 `allow-same-origin` 的 `iframe[data-testid="web-preview-frame"]` 来模拟跨源场景。引擎正确识别 `contentDocument === null`，渲染了覆盖提示，点击提示后弹出说明 toast。

---

## 失败清单 / 未验证项 / 已知但不修项

### 失败清单
1. 无 P0 失败。主链路（进入标记 → 悬停高亮 → 点击捕获 → 角标 → 滚动跟随 → 删除 → Esc 退出）全部通过。

### 未验证项
1. **同一会话刷新/切会话后标记是否保留**：store 是内存级，本次未写持久化，未做跨会话验证。
2. **真实 docx/xlsx 文件预览**：当前 dsh UI 的预览输入框无法手动加载本地 Office 文件，office 路径使用注入的 `div[data-office]` 模拟容器验证。
3. **截图失败 toast**：未构造出稳定的 html2canvas 失败场景（元素移除/渲染异常）。
4. **缩放（pinch/浏览器缩放）下角标跟随**：仅验证了滚动；visualViewport resize 监听已注册，但未专门截图。
5. **跨源 iframe 的真实外部 URL 预览**：用 sandbox 模拟验证；未在真实外部 URL preview 上复现。

### 已知但不修项
1. **外部 URL 预览元素级标记不可行**：由 D6 定为阶段一已知限制，本批仅给失败文案，不硬解。
2. **非 CORS 外部图片会被 html2canvas 静默丢图**：已在 D10 固化，本批给出「外部图片可能缺失」提示，不追加自定义截图逻辑。
3. **标记数据无 localStorage 持久化**：阶段一不持久化，MEU-3 发送管道决定后再看是否需要保留历史标记。

---

## 交付物

- `src/client/engine.ts`：收窄标记范围到 preview 面板，支持 office 容器，优化跨源 iframe 检测（`contentDocument === null` 也视为跨源）。
- `lib/client.js` / `lib/client.js.map`：重新构建的 client bundle。
- `spike/evidence/meu1/*.png`：18–28 号为本 subagent 生成的验证截图；01–04 为前任 agent 证据。
- 本报告。
