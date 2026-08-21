# MEU-0 Spike 报告 — 纯前端静态 harness 验证

日期：2026-08-18
执行形态：`spike/harness/` 静态页 + `python3 -m http.server`（127.0.0.1:8899）+ ego-browser 驱动与截图。
验证结论用词：过（前提成立）/ 部分过（前提成立但有关键限制）/ 不过（前提不成立）。

---

## 结论速览

| # | 验证项 | 结论 |
|---|---|---|
| 1 | 同源沙箱 iframe（`allow-same-origin allow-forms allow-popups` + `srcdoc`）DOM 可达 | **过** |
| 2 | iframe 内元素区域截图（html2canvas 主路径） | **过（主路径）；备选 foreignObject 有硬伤** |
| 2b | 外部图片污染 canvas | **部分过**：污染机制成立，但 html2canvas 不触发它（见下） |
| 3 | office 容器文本选区捕获 + 区域截图 | **过** |

---

## 验证 1 — 同源沙箱 iframe DOM 可达：**过**

证据截图：`spike/evidence/01-hover-highlight-iframe.png`、`spike/evidence/02-click-capture-iframe.png`

实测（Chromium，经 ego-browser 的 CDP 驱动真实鼠标事件）：

- (a) `iframe.contentDocument` 可读：`hasDoc=true`、`readyState=complete`。
- (b) 在 iframe 文档上挂 `mouseover/click` 监听（capture 阶段）后，`elementFromPoint` 用 **iframe 本地坐标** 命中内部元素，实测命中 `LI`。
- (c) 能拿到 CSS 选择器路径、可见文本、outerHTML 片段。点击卡片内列表项，捕获：
  - 选择器：`#card-1 > ul > li:nth-of-type(2)`
  - 可见文本：`列表项 B`
  - outerHTML：该 `<li>` 的 HTML 片段（结果区 `<pre>` 显示）

悬停高亮验证：悬停 `#page-title` 后，`getComputedStyle(el).outlineColor = rgb(255, 45, 85)`、`outlineWidth = 2px`；PIL 采样证据 01 检出 1074 个红色描边像素点（bbox 144,30–1108,242）。

**关键坑（已修并固化进 harness）**：iframe 内的 `MouseEvent.clientX/clientY` 是**相对 iframe 自身视口**的坐标，不能像「父页坐标减 iframe rect」那样再减一次偏移。若误减，`elementFromPoint` 会偏移到错误位置（实测命中 `<html>`）。正确写法是 `doc.elementFromPoint(e.clientX, e.clientY)` 直用，或直接取 `e.target`。

对设计影响：D6 成立 —— agent 生成的 srcdoc 页面（同源）可被父页标记层读取 DOM、命中元素、提取结构化信息。

---

## 验证 2 — iframe 内元素区域截图：**过（html2canvas 主路径）**

证据截图：`spike/evidence/02-click-capture-iframe.png`（结果区含该截图 `<img>`）

实测 `html2canvas(el)` 直接传入 iframe 内部元素：

- `li`（列表项）：产出 `data:image/png;base64,...`（924×23，dataURL 长 3174），结果区 `<img>` 加载成功（`naturalWidth=924`）。
- `#card-1`（整卡）：html2canvas 成功（dataURL 长 27686）。
- 结论：html2canvas 对 **sandbox srcdoc iframe 内的元素** 直接截图可行，PNG 可用（落 `<img>` 正常显示）。

### 2b — 外部图片污染 canvas：**部分过（机制成立，html2canvas 不触发）**

实测矩阵（Chromium）：

| 场景 | 结果 |
|---|---|
| 直接 `ctx.drawImage(crossOriginImg)` 后 `canvas.toDataURL()` | **抛 `SecurityError: Tainted canvases may not be exported.`**（污染机制成立，是真实风险） |
| `html2canvas(el, { useCORS:false })` 截含外部图元素 | **静默丢图**：产出 300×120 纯白 canvas（非白像素比 0，dataURL 仅 1734 字节），**不抛错** |
| `html2canvas(el, { useCORS:true })` 截含外部图元素 | **正确渲染外部图**（非白像素比 1.0，dataURL 6382 字节，无污染），前提是图片服务器返回 CORS 头（实测 placehold.co 返回） |
| foreignObject SVG 序列化（`<svg><foreignObject><div>…outerHTML…</div></foreignObject></svg>` 转 `data:image/svg+xml` 后作 `<img>` 加载） | **纯文本元素能加载**；但**子树含任何 `<img>`（外部 URL 或 data URI）时，整个 SVG 加载失败（`img.onerror`）** |

备选 foreignObject 结论：**不推荐**。原因：SVG 作为 `<img>` 加载时，浏览器阻止其内的嵌套图片资源，含图元素直接加载失败 —— 而 agent 生成的页面普遍含图，该备选对主场景不可用。

对设计影响（D9）：
- 主路径定 **html2canvas**（同源 iframe 内 + office 容器内均验证可行）。
- 外部图用 `useCORS:true`：CORS 服务器 → 正常渲染且不污染；非 CORS 服务器 → html2canvas 静默丢图（白块，不崩）——需在失败文案里提示「外部图可能缺失」。
- **禁止**自写截图逻辑时对非 CORS 图裸 `drawImage`（会 taint → `toDataURL` 抛 `SecurityError`）。
- foreignObject 备选不采纳。

---

## 验证 3 — office 容器文本选区捕获 + 区域截图：**过**

证据截图：`spike/evidence/03-office-selection-highlight.png`、`spike/evidence/04-office-selection-capture.png`、`spike/evidence/06-office-table-region-shot.png`

实测（普通 `div#office-container` 内渲染类 docx 标题/段落/表格）：

- 选区捕获：对 `#para-1` 建立 Range 后，`window.getSelection().toString()` 返回 `们完成了三项关键交付`；选区公共祖先元素 `#para-1` 被正确解析。
- 选区区域截图：`html2canvas(#para-1)` 成功（646×48，dataURL 长 20170），结果区 `<img>` 正常显示。
- 表格单元格点击：捕获选择器 `#office-container > table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)`，文本 `320ms`，截图 81×34 成功。

对设计影响：阶段一「office 渲染容器（主文档 DOM div）」的选区捕获与区域截图路径打通，标记层用 `window.getSelection` + `html2canvas` 即可，无需 Office.js。

---

## 失败清单 / 已知限制 / 未验证项

1. **foreignObject 备选不可用（含图场景）**：子树含 `<img>` 时 SVG-as-`<img>` 加载失败。→ 不采纳。
2. **非 CORS 外部图会被 html2canvas 静默丢图**（白块，非报错）：需产品层提示「外部图片可能缺失」，或接受该降级。
3. **裸 `drawImage` 非 CORS 图会 taint canvas**（`SecurityError`）：未来任何自写截图路径都不得对非 CORS 图直接 drawImage。
4. **视觉读回方式**：本 subagent 工具集无 `ReadMediaFile`，视觉验证改用以下等价手段完成——(a) `getComputedStyle` 断言红色 outline、(b) PIL 对截图红色像素采样（01 检出 1074 点）、(c) `file`+`sips` 校验 6 张 PNG 有效性（尺寸均正常）、(d) `js` 读回结果卡 `<img>.naturalWidth>0`。截图未人工目视，但 DOM 状态 + 像素 + 文件有效性三重证据已覆盖。
5. **未验证**：跨源 iframe（外部 URL 预览）DOM 不可达 —— 由 DECISIONS D6 定为阶段一已知限制，本 spike 只测同源 srcdoc，未测跨源。
6. **未验证**：html2canvas 对 iframe **整体元素**（而非内部元素）的截图 —— 本 spike 均传内部元素，已足够支撑结论；未测 `html2canvas(iframeElement)` 本身。

---

## 交付物

- `spike/harness/index.html` — 静态页（含 srcdoc 模板、office 容器、结果区、标记模式开关、一键验证按钮）
- `spike/harness/harness.js` — 标记模式/高亮/捕获/截图/选区逻辑（UI 全中文，代码注释英文）
- `spike/harness/package.json` + `node_modules/html2canvas@1.4.1` — 本地依赖，未污染全局
- `spike/evidence/*.png` — 6 张证据截图
- 本文件

## 复现方式

```bash
cd spike/harness && python3 -m http.server 8899 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8899/index.html
# 开「标记模式」→ 悬停/点击 iframe 内元素、office 元素、生成选区→捕获选区、点「一键验证全部」
```
