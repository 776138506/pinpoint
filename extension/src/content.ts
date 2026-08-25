/**
 * dsh-point browser extension content script.
 *
 * Runs in the context of arbitrary web pages. Owns the marking mode
 * (hover highlight + click capture), numbered badge overlays, the per-mark
 * comment popup, and screenshotting via html2canvas.
 *
 * The side panel is the source of truth for the outbox and the target session;
 * this script only owns the in-page visual state.
 */
import html2canvas from 'html2canvas'
import { cloneForScreenshot, codeLocationFor, cssPath, detectExternalImages, documentRectOf, snippet, textFragmentFor, visibleText, xpathFor } from '../../src/client/mark-utils.ts'
import { formatMarkText } from '../../src/client/util.ts'
import { composeScreenshot, drawStrokes, eraseStrokes } from '../../src/client/drawing.ts'
import type { DrawTool, Stroke } from '../../src/client/drawing.ts'
import { BUILTIN_SHORTCUT, comboFromEvent } from './shortcut.ts'
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type ExtSettings } from './settings.ts'
import type { Mark, MarkStatus } from '../../src/client/stores.ts'

const STYLE_ID = 'dsh-point-ext-style'
const OVERLAY_ID = 'dsh-point-ext-overlay'
const POPUP_LAYER_ID = 'dsh-point-ext-popup-layer'
const KEPT_FLAG = '__dshPointExtKept'
const HOVER_OUTLINE = '2px solid #ff2d55'
const KEPT_OUTLINE = '2px solid #2563eb'
const REGION_RECT_CLASS = 'dsh-point-ext-region-rect'
const REGION_KEPT_CLASS = 'dsh-point-ext-region-kept'
const DRAG_THRESHOLD = 6

interface ContentState {
  marking: boolean
  marks: Mark[]
  nextIndex: number
  activeIndex: number | null
}

let state: ContentState = { marking: false, marks: [], nextIndex: 1, activeIndex: null }
let overlay: HTMLDivElement | null = null
let popupLayer: HTMLDivElement | null = null
let hoveredEl: Element | null = null
let rafPending = false
let popupBusy = false
// 2026-08-25: 记录弹窗当前渲染的是哪个标记——截图回填触发的重渲染要保住
// 用户正在输入的评论（只对同一标记且不 busy 时恢复）
let popupRenderedIndex: number | null = null
let lastHintAt = 0
let captureInFlight = false

// 2026-08-24: region drag state. mousedown starts a drag; mousemove beyond
// DRAG_THRESHOLD draws the selection rect; mouseup either captures the region
// (if dragged) or falls through to the click handler (if not). Esc cancels drag.
let dragStartX = 0
let dragStartY = 0
// 2026-08-25: mousedown 时的滚动快照——拖拽中页面滚动时，起点必须用「起点客户区
// 坐标 + 起点滚动」换算文档坐标，否则区域边界随页面漂移
let dragStartScrollX = 0
let dragStartScrollY = 0
let isDragging = false
let dragRectEl: HTMLElement | null = null
let suppressClick = false

// 2026-08-24: region marks have no DOM element, so we keep a persistent
// border div per mark that follows scroll/resize via repositionAll().
const regionEls = new Map<number, HTMLElement>()

// 2026-08-25: 内层滚动容器锚点——region 边框挂 documentElement 只跟随 window 滚动；
// dsh 这类应用在内部容器里滚动时内容动、边框不动（视觉上边框"跟着页面滑"）。
// mousedown 时记录目标祖先链全部元素及 scroll 快照，渲染时用 delta 修正。
// 不做 overflow 检测：computed style/尺寸在 jsdom 与运行时行为不一致，且非滚动
// 容器 scrollTop 恒不变（delta 恒 0），全量记录代价可忽略。排除 body/
// documentElement——它们的滚动即 window 滚动，已由文档坐标系覆盖，计入会双重修正。
interface ScrollAnchor { el: Element; top: number; left: number }
let dragScrollAnchors: ScrollAnchor[] = []
const regionAnchors = new Map<number, ScrollAnchor[]>()

function collectScrollAnchors(el: Element): ScrollAnchor[] {
  const anchors: ScrollAnchor[] = []
  let cur = el.parentElement
  while (cur !== null && cur !== document.body && cur !== document.documentElement) {
    anchors.push({ el: cur, top: cur.scrollTop, left: cur.scrollLeft })
    cur = cur.parentElement
  }
  return anchors
}

function regionDelta(index: number): { dx: number; dy: number } {
  const anchors = regionAnchors.get(index)
  if (anchors === undefined) return { dx: 0, dy: 0 }
  let dx = 0
  let dy = 0
  for (const a of anchors) {
    if (!a.el.isConnected) continue
    dx += a.el.scrollLeft - a.left
    dy += a.el.scrollTop - a.top
  }
  return { dx, dy }
}

// 2026-08-24: per-mark whiteboard strokes stored as ratios relative to the
// original screenshot. Deleted when the mark is removed; composed into the
// screenshot at send/stage time. ponytail: not persisted (lost on refresh).
// 2026-08-25: 唯一生产者=页面白板（finishBoard）；评论窗白板已移除
const strokeMap = new Map<number, Stroke[]>()
// 2026-08-25: 在途截图（用户要求点击→评论窗 ms 级）——评论窗先开，html2canvas
// 异步回填；暂存/发送/了结草稿时若截图未决则等它，保证暂存区必有图
const pendingShots = new Map<number, Promise<void>>()

// 2026-08-20: 页面内自定义快捷键（侧栏设置区配置，chrome.storage 共享）。
// 等于内置 Alt+Shift+M 时不处理——该组合由 manifest commands 全局接管，避免双重切换
let customShortcut: string | null = null
// 2026-08-21: 可调参数（不器整改），缓存 + 热更新
let extSettings: ExtSettings = { ...DEFAULT_SETTINGS }
if (chrome.runtime?.id) {
  chrome.storage.local.get('customShortcut').then((data) => {
    customShortcut = typeof data.customShortcut === 'string' ? data.customShortcut : null
  }).catch((e) => console.error('[dsh-point-ext] load customShortcut failed:', e))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('customShortcut' in changes)) return
    const v = changes.customShortcut.newValue
    customShortcut = typeof v === 'string' ? v : null
  })
  void loadSettings().then((s) => { extSettings = s })
  onSettingsChanged((s) => { extSettings = s })
}

ensureStyle()

/* ---------- toast ---------- */

function showToast(message: string): void {
  const el = document.createElement('div')
  el.className = 'dsh-point-ext-toast'
  el.textContent = message
  document.body.appendChild(el)
  window.setTimeout(() => { el.remove() }, 4500)
}

function showHint(message: string): void {
  const now = Date.now()
  if (now - lastHintAt < 3000) return
  lastHintAt = now
  showToast(message)
}

/* ---------- highlight ---------- */

// 2026-08-20: 插件自有 UI 选择器——标记模式下悬停/点击必须排除（评论窗/角标/提示条）。
// 教训：不可用 [class*="dsh-point-ext"] 子串匹配——body 上的标记态类名
// dsh-point-ext-marking 会让每个元素都被排除，标记功能全灭（2026-08-21 事故）
const OWN_UI_SELECTOR = '.dsh-point-ext-overlay, .dsh-point-ext-badge, .dsh-point-ext-popup-layer, .dsh-point-ext-popup, .dsh-point-ext-toast, .dsh-point-ext-board, .dsh-point-ext-board-toolbar'

function highlight(el: Element): void {
  if (!el || el.nodeType !== 1) return
  if (!(el instanceof HTMLElement)) return
  const rec = el as HTMLElement & { __dshPointExtOrigOutline?: string; __dshPointExtOrigOutlineOffset?: string }
  if (rec.__dshPointExtOrigOutline === undefined) {
    rec.__dshPointExtOrigOutline = el.style.outline || ''
    rec.__dshPointExtOrigOutlineOffset = el.style.outlineOffset || ''
  }
  rec.style.outline = HOVER_OUTLINE
  rec.style.outlineOffset = '1px'
}

function unhighlight(el: Element): void {
  if (!el || el.nodeType !== 1) return
  if (!(el instanceof HTMLElement)) return
  const rec = el as HTMLElement & { __dshPointExtOrigOutline?: string; __dshPointExtOrigOutlineOffset?: string }
  if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) {
    // 2026-08-25: KEPT 分支禁止删 __dshPointExtOrigOutline——它是「扩展动手前页面
    // 自己的 outline」，生命周期必须覆盖整个 KEPT 期间。此前这里删掉它，下一次
    // renderBadges 重跑时会把 KEPT 蓝框当成原始样式重新存进 orig，releaseElement
    // 再把高亮「还原」成高亮——×关闭后高亮永不消失（实机复现，hover→点击路径）
    rec.style.outline = KEPT_OUTLINE
    rec.style.outlineOffset = '1px'
    return
  }
  if (rec.__dshPointExtOrigOutline !== undefined) {
    // 2026-08-25: outlineOffset 与 outline 对称还原——highlight 存了两个，
    // 这里只还 outline 会把 '1px' 垃圾留在元素内联样式上（同类快照污染）
    rec.style.outline = rec.__dshPointExtOrigOutline
    rec.style.outlineOffset = rec.__dshPointExtOrigOutlineOffset ?? ''
    delete rec.__dshPointExtOrigOutline
    delete rec.__dshPointExtOrigOutlineOffset
  } else {
    rec.style.outline = ''
    rec.style.outlineOffset = ''
  }
}

function clearHover(): void {
  if (hoveredEl) { unhighlight(hoveredEl); hoveredEl = null }
}

/* ---------- event listeners ---------- */

function onMouseOver(e: MouseEvent): void {
  // 2026-08-20: 扩展重载后旧实例的 DOM 监听仍挂在页面上，上下文已失效（chrome.runtime.id 为空），
  // 旧实例必须静默，否则与按需注入的新实例双重触发
  if (!chrome.runtime?.id) return
  // 2026-08-25: 鼠标在窗口外松开时 mouseup 永远不到达，isDragging 会卡死
  // （后续悬停高亮全部消失、选区矩形残留）——复归守护：悬停到达且按键已
  // 松开 = 拖拽实际已结束，就地复位。用户操作不像机器人那么精准，凡依赖
  // 「事件必然成对到达」的状态都要有自愈路径
  if (isDragging && e.buttons === 0) {
    isDragging = false
    if (dragRectEl !== null) { dragRectEl.remove(); dragRectEl = null }
    dragScrollAnchors = []
  }
  if (!state.marking) return
  // 2026-08-24: 拖拽期间不画悬停高亮，避免选区矩形与 hover outline 叠加。
  if (isDragging) return
  const el = e.target as Element
  if (!el || el.nodeType !== 1) return
  if ((el as Element).closest(OWN_UI_SELECTOR)) return
  if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) return
  if (hoveredEl && hoveredEl !== el) unhighlight(hoveredEl)
  hoveredEl = el
  highlight(el)
}

function onMouseOut(e: MouseEvent): void {
  // 2026-08-24: 与 onMouseOut 对称的失效守卫——旧实例（扩展重载后）若继续响应
  // mouseout，会擦掉新实例刚画上的悬停高亮（双实例干扰）
  if (!chrome.runtime?.id) return
  if (!state.marking) return
  const el = e.target as Element
  if (el === hoveredEl) { unhighlight(el); hoveredEl = null }
}

/**
 * 2026-08-25: 框选坐标统一换算——两端点各自用「客户区坐标 + 当时滚动」换成文档
 * 坐标（拖拽中滚动也正确），再钳制到文档范围内。文档尺寸不可读（jsdom/异常页）
 * 时不钳制。完全钳没（<2px）返回 null = 放弃本次框选。
 */
function regionRectFromDrag(e: MouseEvent): { x: number; y: number; width: number; height: number } | null {
  const docStartX = dragStartX + dragStartScrollX
  const docStartY = dragStartY + dragStartScrollY
  const docCurX = e.clientX + window.scrollX
  const docCurY = e.clientY + window.scrollY
  const de = document.documentElement
  const maxX = de.scrollWidth > 0 ? de.scrollWidth : Number.POSITIVE_INFINITY
  const maxY = de.scrollHeight > 0 ? de.scrollHeight : Number.POSITIVE_INFINITY
  const x1 = Math.max(0, Math.min(Math.min(docStartX, docCurX), maxX))
  const y1 = Math.max(0, Math.min(Math.min(docStartY, docCurY), maxY))
  const x2 = Math.max(0, Math.min(Math.max(docStartX, docCurX), maxX))
  const y2 = Math.max(0, Math.min(Math.max(docStartY, docCurY), maxY))
  if (x2 - x1 < 2 || y2 - y1 < 2) return null
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1),
  }
}

function onMouseDown(e: MouseEvent): void {
  if (!chrome.runtime?.id) return
  if (!state.marking) return
  const el = e.target as Element
  if (!el || el.nodeType !== 1) return
  if ((el as Element).closest(OWN_UI_SELECTOR)) return
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartScrollX = window.scrollX
  dragStartScrollY = window.scrollY
  // 2026-08-25: 记录内层滚动锚点（见 ScrollAnchor 注释），供 region 标记失锚修正
  dragScrollAnchors = collectScrollAnchors(el)
  isDragging = true
}

function onMouseMove(e: MouseEvent): void {
  if (!chrome.runtime?.id) return
  if (!state.marking || !isDragging) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
  // 2026-08-24: 拖拽中阻止文本选择，避免页面内容被高亮。
  e.preventDefault()
  const rect = regionRectFromDrag(e)
  if (rect === null) {
    if (dragRectEl !== null) { dragRectEl.remove(); dragRectEl = null }
    return
  }
  if (dragRectEl === null) {
    dragRectEl = document.createElement('div')
    dragRectEl.className = REGION_RECT_CLASS
    // 2026-08-25: 挂 documentElement 而非 body——站点给 body 设 position:relative/
    // margin 时 absolute 相对 body 偏移，框选显示与实际不符
    document.documentElement.appendChild(dragRectEl)
  }
  dragRectEl.style.left = `${rect.x}px`
  dragRectEl.style.top = `${rect.y}px`
  dragRectEl.style.width = `${rect.width}px`
  dragRectEl.style.height = `${rect.height}px`
}

function onMouseUp(e: MouseEvent): void {
  if (!chrome.runtime?.id) return
  if (!state.marking || !isDragging) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  const dragged = Math.hypot(dx, dy) > DRAG_THRESHOLD
  if (dragRectEl !== null) { dragRectEl.remove(); dragRectEl = null }
  isDragging = false
  if (dragged) {
    suppressClick = true
    const rect = regionRectFromDrag(e)
    if (rect !== null) void captureRegion(rect, dragScrollAnchors)
  }
  dragScrollAnchors = []
}

function onClick(e: MouseEvent): void {
  if (!chrome.runtime?.id) return // 同上：失效旧实例静默
  const el = e.target as Element
  if (!el || el.nodeType !== 1) return
  // 2026-08-25: 自身 UI 的点击永不拦截、也不消耗 suppressClick——必须在 suppressClick
  // 检查之前：拖拽产生的 suppressClick 会存到下一次点击，若下次点的是弹窗按钮
  // （暂存/发送），拦截会把按钮点击吞掉（实机必现：框选后点发送无反应）
  if ((el as Element).closest(OWN_UI_SELECTOR)) return
  // 2026-08-24: a region drag consumes the click; do not also capture the
  // element under the mouseup.
  if (suppressClick) {
    suppressClick = false
    // 2026-08-25: 拖拽起于链接/按钮时，mouseup 后的 click 仍会触发导航与页面
    // 监听器（用户实机报告点链接直接跳转），suppress 路径同样要拦。
    // 注意此分支不能要求 state.marking——框选完成即暂停标记（弹窗打开），
    // 紧随其后的 click 到达时标记已是暂停态，不拦就跳转了
    e.preventDefault()
    e.stopPropagation()
    return
  }
  // 2026-08-25: 评论窗开着（标记被弹窗暂停）时页面交互整体屏蔽——用户注意力在
  // 评论上，此时点到链接/按钮不该触发页面行为（实机报告：写评论时点穿跳转到
  // 别的页面）。自身 UI 已在上面放行；屏蔽只拦行为、不产生新捕获。
  if (state.activeIndex !== null) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  if (!state.marking) return
  // 2026-08-25: 标记态点击 = 捕获所指，不是页面交互——拦截链接默认导航与页面
  // 自身的 click 处理器（capture 阶段 stopPropagation，页面监听器收不到）
  e.preventDefault()
  e.stopPropagation()
  // 2026-08-21: 点已标记元素（或其子元素）= 重开评论窗，不重复捕获
  const marked = findMarkedAncestor(el)
  if (marked) {
    const existing = state.marks.find(m => resolveElement(m) === marked)
    if (existing) {
      openMark(existing.index)
      return
    }
  }
  if (captureInFlight) return
  captureInFlight = true
  captureElement(el).finally(() => { captureInFlight = false })
}

function onKeyDown(e: KeyboardEvent): void {
  if (!chrome.runtime?.id) return // 同上：失效旧实例静默
  if (e.repeat) return // 2026-08-24: 长按 repeat 会反复 toggle 标记态，只认第一次
  // 2026-08-25: Esc 最高层是白板模式（比标记态更靠近用户当前注意力）
  if (e.key === 'Escape' && drawingMode) {
    exitDrawingMode()
    return
  }
  // 2026-08-25: 评论子流程（标记被弹窗暂停）中的 Esc = 明确退出：了结草稿——
  // 已输入的评论自动进暂存区（用户拍板：已输入的不该丢），无评论才撤销；不恢复标记
  if (e.key === 'Escape' && state.activeIndex !== null && markPauseActive) {
    settleDraft()
    openMark(null)
    markPauseActive = false
    return
  }
  if (e.key === 'Escape' && state.marking) {
    // 2026-08-24: Esc 层级：拖拽态 > 标记态（评论窗白板已移除，无工具态）。
    if (isDragging) {
      isDragging = false
      if (dragRectEl !== null) { dragRectEl.remove(); dragRectEl = null }
      return
    }
    setMarking(false)
    syncMarkingState()
    return
  }
  // 页面内自定义快捷键切换标记；内置组合由 manifest commands 接管，这里跳过防双重切换
  if (customShortcut && customShortcut !== BUILTIN_SHORTCUT && comboFromEvent(e) === customShortcut) {
    e.preventDefault()
    e.stopPropagation()
    setMarking(!state.marking)
    syncMarkingState()
  }
}

// 2026-08-24: 页面内退出/切换（Esc、自定义快捷键）必须同步 background 的
// 按 tab 跟踪与侧栏按钮——此前 Esc 退出不同步，侧栏按钮停在「退出标记」，
// 再点反而把标记重新打开（状态撕裂）
function syncMarkingState(): void {
  chrome.runtime.sendMessage({ type: 'MARKING_STATE_SYNC', marking: state.marking })
    .catch((err) => console.error('[dsh-point-ext] marking state sync failed:', err))
}

function onScrollOrResize(): void {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    repositionRegions()
    repositionBadges()
    repositionPopup()
    redrawBoard()
  })
}

/* ---------- 页面白板（2026-08-25：画笔模式——直接在页面上涂抹，截图发给 dsh） ---------- */

// 与标记模式并存：画布盖住页面接管鼠标（已有标记保持显示，两模式互证——标记
// 模式圈出要移动的元素，白板模式画箭头给出目标位置）。「完成」= 笔迹包围盒
// 截屏 + 笔迹归一化入 strokeMap，产出普通 region mark，复用暂存/发送管线。
let drawingMode = false
let boardCanvas: HTMLCanvasElement | null = null
let boardCtx: CanvasRenderingContext2D | null = null
let boardToolbar: HTMLElement | null = null
let boardStrokes: Stroke[] = [] // 文档坐标（px，非归一化）
let boardActive: Stroke | null = null
// 2026-08-25: 橡皮是白板工具但不是笔画类型——擦过的笔画在交点处被切成子笔画
// （像素级橡皮，矢量切割实现），落库的只有 pen/arrow/rect 三种
type BoardTool = DrawTool | 'eraser'
let boardTool: BoardTool = 'pen'
let boardErasing = false
let boardLastErase: { x: number; y: number } | null = null
const ERASE_RADIUS = 10 // px，文档坐标；ponytail: 固定半径，要做粗细档位再进设置
let boardAnchors: ScrollAnchor[] = [] // 首笔落点处元素的内层滚动锚点

function boardDelta(): { dx: number; dy: number } {
  let dx = 0
  let dy = 0
  for (const a of boardAnchors) {
    if (!a.el.isConnected) continue
    dx += a.el.scrollLeft - a.left
    dy += a.el.scrollTop - a.top
  }
  return { dx, dy }
}

// 文档坐标 = 客户区坐标 + window 滚动 + 内层容器滚动 delta
function boardPoint(e: MouseEvent): { x: number; y: number } {
  const d = boardDelta()
  return { x: e.clientX + window.scrollX + d.dx, y: e.clientY + window.scrollY + d.dy }
}

function redrawBoard(): void {
  if (boardCanvas === null || boardCtx === null) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (vw <= 0 || vh <= 0) return
  if (boardCanvas.width !== vw || boardCanvas.height !== vh) {
    boardCanvas.width = vw
    boardCanvas.height = vh
  }
  boardCtx.clearRect(0, 0, vw, vh)
  // drawStrokes 走归一化坐标——文档坐标换算成「当前视口」归一化，复用其几何实现
  const d = boardDelta()
  const offX = window.scrollX + d.dx
  const offY = window.scrollY + d.dy
  const toView = (s: Stroke): Stroke => ({
    tool: s.tool,
    points: s.points.map((v, i) => (i % 2 === 0 ? (v - offX) / vw : (v - offY) / vh)),
  })
  const all = boardActive !== null ? [...boardStrokes, boardActive] : boardStrokes
  drawStrokes(boardCtx, all.map(toView), vw, vh)
}

let boardRafPending = false

// 2026-08-25: 渲染合帧——mousemove 高频触发，每帧最多重绘一次；
// 配合落笔采样（onBoardMove），避免涂抹越久越卡。
// ponytail 上限：笔迹极多时全量重绘仍可能掉帧，升级路径是双画布分层
// （底笔迹一次栅格化 + 活动笔迹单独层）
function scheduleBoardRedraw(): void {
  if (boardRafPending) return
  if (typeof requestAnimationFrame !== 'function') { redrawBoard(); return } // jsdom 无 rAF
  boardRafPending = true
  requestAnimationFrame(() => { boardRafPending = false; redrawBoard() })
}

function onBoardDown(e: MouseEvent): void {
  if (!chrome.runtime?.id) return
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  // 首笔收集落点处元素的内层滚动锚点——画布盖住页面，需临时隐藏才能取到底层元素
  if (boardAnchors.length === 0 && boardCanvas !== null) {
    boardCanvas.style.visibility = 'hidden'
    let under: Element | null = null
    try {
      under = document.elementFromPoint(e.clientX, e.clientY)
    } catch (err) {
      // jsdom 未实现 elementFromPoint；运行时失败也只是退化为不跟踪内层滚动
      console.error('[dsh-point-ext] elementFromPoint failed:', err)
    }
    boardCanvas.style.visibility = ''
    if (under !== null) boardAnchors = collectScrollAnchors(under)
  }
  const p = boardPoint(e)
  if (boardTool === 'eraser') {
    boardErasing = true
    boardLastErase = p
    applyErase(p.x, p.y, p.x, p.y)
    return
  }
  boardActive = { tool: boardTool, points: [p.x, p.y, p.x, p.y] }
  scheduleBoardRedraw()
}

// 橡皮沿路径切割笔画：擦过哪段切哪段，不整条删（整条删 = 撤销的重复功能）
function applyErase(ex1: number, ey1: number, ex2: number, ey2: number): void {
  const { strokes, changed } = eraseStrokes(boardStrokes, ex1, ey1, ex2, ey2, ERASE_RADIUS)
  if (!changed) return
  boardStrokes = strokes
  scheduleBoardRedraw()
}

function onBoardMove(e: MouseEvent): void {
  if (boardErasing) {
    e.preventDefault()
    const p = boardPoint(e)
    const last = boardLastErase ?? p
    applyErase(last.x, last.y, p.x, p.y)
    boardLastErase = p
    return
  }
  if (boardActive === null) return
  e.preventDefault()
  const p = boardPoint(e)
  if (boardActive.tool === 'pen') {
    // 2026-08-25: 落笔采样——<2px 的移动不产生新点，长涂抹的点数降一个量级
    const pts = boardActive.points
    const lx = pts[pts.length - 2]!
    const ly = pts[pts.length - 1]!
    if (Math.hypot(p.x - lx, p.y - ly) < 2) return
    pts.push(p.x, p.y)
  } else {
    // arrow/rect：终点跟随当前位置
    boardActive.points[2] = p.x
    boardActive.points[3] = p.y
  }
  scheduleBoardRedraw()
}

function onBoardUp(e: MouseEvent): void {
  if (boardErasing) {
    e.preventDefault()
    const p = boardPoint(e)
    const last = boardLastErase ?? p
    applyErase(last.x, last.y, p.x, p.y)
    boardErasing = false
    boardLastErase = null
    return
  }
  if (boardActive === null) return
  e.preventDefault()
  const p = boardPoint(e)
  if (boardActive.tool === 'pen') {
    const pts = boardActive.points
    const lx = pts[pts.length - 2]!
    const ly = pts[pts.length - 1]!
    if (Math.hypot(p.x - lx, p.y - ly) >= 2) pts.push(p.x, p.y)
  } else {
    boardActive.points[2] = p.x
    boardActive.points[3] = p.y
  }
  boardStrokes.push(boardActive)
  boardActive = null
  scheduleBoardRedraw()
}

async function finishBoard(): Promise<void> {
  if (boardStrokes.length === 0) {
    showToast('白板上还没有涂抹内容')
    return
  }
  // 笔迹包围盒 + 边距，钳到文档范围
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const s of boardStrokes) {
    for (let i = 0; i < s.points.length; i += 2) {
      x1 = Math.min(x1, s.points[i]!)
      y1 = Math.min(y1, s.points[i + 1]!)
      x2 = Math.max(x2, s.points[i]!)
      y2 = Math.max(y2, s.points[i + 1]!)
    }
  }
  const pad = 16
  const de = document.documentElement
  const maxX = de.scrollWidth > 0 ? de.scrollWidth : Number.POSITIVE_INFINITY
  const maxY = de.scrollHeight > 0 ? de.scrollHeight : Number.POSITIVE_INFINITY
  const rx = Math.max(0, Math.min(x1 - pad, maxX))
  const ry = Math.max(0, Math.min(y1 - pad, maxY))
  const rx2 = Math.max(0, Math.min(x2 + pad, maxX))
  const ry2 = Math.max(0, Math.min(y2 + pad, maxY))
  const rect = { x: Math.round(rx), y: Math.round(ry), width: Math.round(rx2 - rx), height: Math.round(ry2 - ry) }
  if (rect.width < 2 || rect.height < 2) {
    showToast('涂抹区域过小，无法生成所指')
    return
  }
  // 笔迹归一化到包围盒（= 截图坐标系），随 mark 入 strokeMap 由发送管线合成
  const strokes: Stroke[] = boardStrokes.map(s => ({
    tool: s.tool,
    points: s.points.map((v, i) => (i % 2 === 0 ? (v - rect.x) / rect.width : (v - rect.y) / rect.height)),
  }))
  const anchors = boardAnchors
  // 先撤画布再截图——否则笔迹被 html2canvas 截进底图，发送时合成会双重叠加
  exitDrawingMode()
  await captureRegion(rect, anchors, strokes)
}

function enterDrawingMode(): void {
  if (drawingMode) return
  // 2026-08-25: 两模式互斥——进白板先退标记（setMarking(false) 会顺便了结草稿、
  // 关评论窗），并同步 background 的按 tab 状态，否则侧栏按钮停在「退出标记」。
  // 已有标记的边框/角标不撤，白板中仍可对照（两模式互证）
  if (state.marking) {
    setMarking(false)
    syncMarkingState()
  }
  drawingMode = true
  boardStrokes = []
  boardActive = null
  boardErasing = false
  boardLastErase = null
  boardAnchors = []
  boardTool = 'pen'

  boardCanvas = document.createElement('canvas')
  boardCanvas.className = 'dsh-point-ext-board'
  boardCanvas.addEventListener('mousedown', onBoardDown)
  boardCanvas.addEventListener('mousemove', onBoardMove)
  boardCanvas.addEventListener('mouseup', onBoardUp)
  document.documentElement.appendChild(boardCanvas)
  // jsdom 无 2d 上下文（返回 null）——笔迹照常记录，仅缺实时渲染
  boardCtx = boardCanvas.getContext('2d')

  boardToolbar = document.createElement('div')
  boardToolbar.className = 'dsh-point-ext-board-toolbar'
  const tools: { tool: BoardTool; label: string }[] = [
    { tool: 'pen', label: '画笔' },
    { tool: 'arrow', label: '箭头' },
    { tool: 'rect', label: '矩形' },
    { tool: 'eraser', label: '橡皮' },
  ]
  for (const t of tools) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.tool = t.tool
    btn.textContent = t.label
    btn.classList.toggle('active', t.tool === boardTool)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      boardTool = t.tool
      boardToolbar?.querySelectorAll('button[data-tool]').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.tool === t.tool))
    })
    boardToolbar.appendChild(btn)
  }
  const undoBtn = document.createElement('button')
  undoBtn.type = 'button'
  undoBtn.textContent = '撤销'
  undoBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    boardStrokes.pop()
    redrawBoard()
  })
  boardToolbar.appendChild(undoBtn)
  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.textContent = '清空'
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    boardStrokes = []
    redrawBoard()
  })
  boardToolbar.appendChild(clearBtn)
  const finishBtn = document.createElement('button')
  finishBtn.type = 'button'
  finishBtn.textContent = '完成'
  finishBtn.className = 'primary'
  finishBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    void finishBoard()
  })
  boardToolbar.appendChild(finishBtn)
  const exitBtn = document.createElement('button')
  exitBtn.type = 'button'
  exitBtn.textContent = '退出'
  exitBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    exitDrawingMode()
  })
  boardToolbar.appendChild(exitBtn)
  document.documentElement.appendChild(boardToolbar)

  redrawBoard()
}

function exitDrawingMode(): void {
  drawingMode = false
  boardStrokes = []
  boardActive = null
  boardErasing = false
  boardLastErase = null
  boardAnchors = []
  if (boardCanvas !== null) { boardCanvas.remove(); boardCanvas = null }
  boardCtx = null
  if (boardToolbar !== null) { boardToolbar.remove(); boardToolbar = null }
}

/* ---------- capture ---------- */

// 2026-08-21: 新捕获前了结旧草稿——有评论自动暂存进暂存区（不丢已写内容），
// 无评论直接撤销。保持「页面高亮 ⇔ 暂存区有记录」不变量，杜绝孤儿高亮
function settleDraft(): void {
  const draft = state.marks.find(m => m.status === 'draft')
  if (!draft) return
  // 评论优先读当前打开的 textarea（用户可能输了字还没点按钮）
  const textarea = state.activeIndex === draft.index
    ? popupLayer?.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')
    : null
  const comment = (textarea?.value.trim() || draft.comment?.trim()) ?? ''
  if (comment) {
    updateMark(draft.index, { comment, status: 'pending' })
    // 2026-08-25: 截图异步回填后，暂存必须带上截图——在途截图未决时等它
    // （用户要求暂存区可见截图）；标记若在等待期间被删除（侧栏清空等）则不再暂存
    const doStage = (): void => {
      const fresh = state.marks.find(m => m.index === draft.index)
      if (!fresh) return
      const staged: Mark = { ...fresh, comment, status: 'pending' }
      chrome.runtime.sendMessage({ type: 'STAGE_MARK', mark: staged, sendNow: false })
        .catch((e) => console.error('[dsh-point-ext] auto-stage failed:', e))
    }
    const pending = pendingShots.get(draft.index)
    if (pending) void pending.then(doStage)
    else doStage()
  } else {
    removeMark(draft.index)
  }
}

async function captureElement(el: Element): Promise<void> {
  settleDraft()
  const clone = el.cloneNode(true) as HTMLElement
  clone.style.outline = ''
  clone.style.outlineOffset = ''

  const mark: Mark = {
    index: state.nextIndex,
    selector: cssPath(el),
    text: visibleText(el),
    html: snippet(clone.outerHTML || ''),
    source: document.title || '页面',
    sourceUrl: location.href,
    sourceTitle: document.title,
    frameKind: 'main',
    screenshot: '',
    hasExternalImage: detectExternalImages(el),
    time: new Date().toISOString(),
    status: 'draft',
  }
  // 2026-08-20: 精准锚点——多通道冗余定位，接收方不用反复查找
  mark.anchor = {
    rect: documentRectOf(el),
    xpath: xpathFor(el) || undefined,
    textFragment: textFragmentFor(el),
    code: codeLocationFor(el),
  }

  // 2026-08-25: 先开评论窗再截图（用户要求 ms 级响应）——html2canvas 是重活，
  // 在途承诺挂 pendingShots，完成后 updateMark 回填；暂存/发送会等它。
  // pendingShots 必须先于 addMark/openMark 挂上——openMark 同步渲染弹窗，
  // 「截图生成中」反馈依赖这个标记位
  pendingShots.set(mark.index, (async () => {
    const prepared = cloneForScreenshot(el)
    try {
      // 2026-08-21: html2canvas 无内建超时——截图挂起会让 captureInFlight 永真、
      // 标记功能静默锁死（五问审视：留白/容错缺口）。超时后降级为纯文本所指
      const canvas = await Promise.race([
        html2canvas(prepared.clone, {
          backgroundColor: '#ffffff',
          scale: 1,
          logging: false,
          useCORS: true,
          allowTaint: false,
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`截图超时（${extSettings.screenshotTimeoutMs}ms）`)), extSettings.screenshotTimeoutMs)),
      ])
      updateMark(mark.index, { screenshot: canvas.toDataURL('image/png') })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.error('[dsh-point-ext] screenshot failed:', e)
      updateMark(mark.index, { screenshotError: reason })
      showToast(`截图失败：${reason}。仍可发送纯文本所指。`)
    } finally {
      prepared.cleanup()
      pendingShots.delete(mark.index)
    }
  })())

  addMark(mark)
  openMark(mark.index)

  if (mark.hasExternalImage) {
    showToast('提示：该区域含外部图片，若截图中缺图，是图片服务器未允许跨域加载。')
  }
}

async function captureRegion(rect: { x: number; y: number; width: number; height: number }, anchors: ScrollAnchor[] = [], strokes?: Stroke[]): Promise<void> {
  if (captureInFlight) return
  captureInFlight = true
  try {
    await captureRegionInner(rect, anchors, strokes)
  } finally {
    captureInFlight = false
  }
}

async function captureRegionInner(rect: { x: number; y: number; width: number; height: number }, anchors: ScrollAnchor[], strokes?: Stroke[]): Promise<void> {
  settleDraft()
  const mark: Mark = {
    index: state.nextIndex,
    selector: `region:${rect.x},${rect.y},${rect.width},${rect.height}`,
    text: '',
    html: '',
    source: document.title || '页面',
    sourceUrl: location.href,
    sourceTitle: document.title,
    frameKind: 'main',
    screenshot: '',
    hasExternalImage: false,
    time: new Date().toISOString(),
    status: 'draft',
    anchor: { rect },
  }
  // 2026-08-25: 锚点随 mark 落库（内存级），截图失败也要保留——失锚修正不依赖截图
  if (anchors.length > 0) regionAnchors.set(mark.index, anchors)
  // 2026-08-25: 白板笔迹必须先于 addMark 入 strokeMap——setState 同步渲染 popup，
  // 挂晚了 popup 白板画布读不到本次笔迹
  if (strokes !== undefined && strokes.length > 0) strokeMap.set(mark.index, strokes)

  // 2026-08-25: 先开评论窗再截图（用户要求 ms 级响应）——同 captureElement；
  // pendingShots 先于 addMark/openMark 挂上，弹窗首帧就能显示「截图生成中」
  pendingShots.set(mark.index, (async () => {
    try {
      const de = document.documentElement
      // 2026-08-25: 视口内区域走快速路径——克隆窗口保持视口大小、裁剪坐标换算成
      // 视口坐标。布局/媒体查询与用户当前所见一致（更保真），且免去整文档渲染
      // （长页面截图卡顿大头）。只有超出视口的区域才撑整文档窗口（慢速兜底）。
      const sx = window.scrollX
      const sy = window.scrollY
      const inViewport = rect.x >= sx && rect.y >= sy
        && rect.x + rect.width <= sx + window.innerWidth
        && rect.y + rect.height <= sy + window.innerHeight
      const startedAt = performance.now()
      const canvas = await Promise.race([
        html2canvas(document.documentElement, {
          backgroundColor: '#ffffff',
          scale: 1,
          logging: false,
          useCORS: true,
          allowTaint: false,
          x: inViewport ? rect.x - sx : rect.x,
          y: inViewport ? rect.y - sy : rect.y,
          width: rect.width,
          height: rect.height,
          windowWidth: !inViewport && de.scrollWidth > 0 ? de.scrollWidth : undefined,
          windowHeight: !inViewport && de.scrollHeight > 0 ? de.scrollHeight : undefined,
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`截图超时（${extSettings.screenshotTimeoutMs}ms）`)), extSettings.screenshotTimeoutMs)),
      ])
      // 实机性能观测点：卡顿时让用户开控制台看这个耗时即可定位是哪个路径慢
      console.debug(`[dsh-point-ext] region screenshot took ${Math.round(performance.now() - startedAt)}ms (${inViewport ? 'viewport' : 'full-document'} path)`)
      updateMark(mark.index, { screenshot: canvas.toDataURL('image/png') })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.error('[dsh-point-ext] region screenshot failed:', e)
      updateMark(mark.index, { screenshotError: reason })
      showToast(`截图失败：${reason}。仍可发送纯文本所指。`)
    } finally {
      pendingShots.delete(mark.index)
    }
  })())

  addMark(mark)
  openMark(mark.index)
}

/* ---------- state ---------- */

function setState(next: ContentState): void {
  const markingChanged = next.marking !== state.marking
  const marksChanged = next.marks !== state.marks
  const activeChanged = next.activeIndex !== state.activeIndex
  state = next
  document.body.classList.toggle('dsh-point-ext-marking', state.marking)
  if (markingChanged && !state.marking) clearHover()
  if (marksChanged) renderBadges()
  if (activeChanged || marksChanged) renderPopup()
  repositionPopup()
}

// 2026-08-25: 捕获即暂停、了结即恢复（用户拍板）——评论窗打开期间标记输入暂停，
// 避免「写评论时页面还处于标记态」的叠加冲突（历史上出过评论区被高亮的 bug）。
// markPauseActive 记着「这次标记是被弹窗自动暂停的」；只有弹窗动作（暂存/发送/
// 删除/关闭）才恢复，显式退出（Esc/快捷键/侧栏按钮）清除标记但不恢复。
let markPauseActive = false

function pauseMarking(): void {
  if (!state.marking || markPauseActive) return
  markPauseActive = true
  // 不经 setMarking(false)——它会了结草稿/关弹窗，而此刻正要开弹窗
  setState({ ...state, marking: false })
  syncMarkingState()
}

function resumeMarking(): void {
  if (!markPauseActive) return
  markPauseActive = false
  if (drawingMode) return // 白板优先：互斥语义大于恢复语义
  setMarking(true)
  syncMarkingState()
}

function setMarking(on: boolean): void {
  // 2026-08-25: 显式开关（Esc/快捷键/侧栏按钮）优先于自动暂停/恢复——用户明确
  // 操作后，不再欠「恢复」这笔账
  markPauseActive = false
  // 2026-08-21: 退出标记态也要了结草稿（Esc/快捷键/侧栏按钮路径）——
  // 不变量「页面高亮 ⇔ 暂存区有记录」对退出路径同样成立，否则孤儿高亮长期残留
  if (!on) {
    settleDraft()
    if (state.activeIndex !== null) openMark(null)
  }
  // 2026-08-25: 两模式互斥（用户实机报告画笔与标记并存冲突）——进标记退白板。
  // 所有开启路径（TOGGLE/SET/快捷键/侧栏）都汇聚到此，一处兜底
  if (on && drawingMode) exitDrawingMode()
  // 2026-08-25: 暂停中显式开标记（快捷键/侧栏）= 了结当前弹窗并回到标记态
  if (on && state.activeIndex !== null) {
    settleDraft()
    openMark(null)
  }
  setState({ ...state, marking: on })
  if (on) {
    showHint('标记模式已开启：悬停高亮，点击元素捕获所指。按 Esc 退出。')
  }
}

function addMark(mark: Mark): void {
  setState({
    ...state,
    marks: [...state.marks, mark],
    nextIndex: Math.max(state.nextIndex, mark.index + 1),
    activeIndex: mark.index,
  })
}

// 2026-08-20: 删除标记时必须释放元素上的 KEPT_OUTLINE 高亮，否则页面残留标记
function releaseElement(mark: Mark): void {
  // 同一元素可能被多个标记指向，只剩一个标记时才清除高亮
  const stillUsed = state.marks.some(m => m.index !== mark.index && m.selector === mark.selector)
  if (stillUsed) return
  const el = resolveElement(mark)
  if (el === null || !(el instanceof HTMLElement)) return
  delete (el as unknown as Record<string, unknown>)[KEPT_FLAG]
  const rec = el as HTMLElement & { __dshPointExtOrigOutline?: string; __dshPointExtOrigOutlineOffset?: string }
  if (rec.__dshPointExtOrigOutline !== undefined) {
    rec.style.outline = rec.__dshPointExtOrigOutline
    rec.style.outlineOffset = rec.__dshPointExtOrigOutlineOffset ?? ''
    delete rec.__dshPointExtOrigOutline
    delete rec.__dshPointExtOrigOutlineOffset
  } else {
    rec.style.outline = ''
    rec.style.outlineOffset = ''
  }
}

function removeMark(index: number): void {
  const mark = state.marks.find(m => m.index === index)
  if (mark) releaseElement(mark)
  strokeMap.delete(index)
  regionAnchors.delete(index)
  setState({
    ...state,
    marks: state.marks.filter(m => m.index !== index),
    activeIndex: state.activeIndex === index ? null : state.activeIndex,
  })
}

function updateMark(index: number, patch: Partial<Omit<Mark, 'index'>>): void {
  setState({
    ...state,
    marks: state.marks.map(m => m.index === index ? { ...m, ...patch } : m),
  })
}

function clearMarks(): void {
  for (const mark of state.marks) releaseElement(mark)
  for (const index of strokeMap.keys()) strokeMap.delete(index)
  regionAnchors.clear()
  setState({ ...state, marks: [], activeIndex: null, nextIndex: 1 })
}

function openMark(index: number | null): void {
  // 2026-08-25: 打开评论窗（新捕获/点已标记元素重开/点角标）一律暂停标记输入——
  // 用户补充：重开也要暂停，不要造成「以为在评论其实还在标记」的混乱
  if (index !== null) pauseMarking()
  setState({ ...state, activeIndex: index })
}

/* ---------- badges ---------- */

function ensureOverlay(): HTMLDivElement {
  if (overlay === null) {
    overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.className = 'dsh-point-ext-overlay'
    document.body.appendChild(overlay)
  }
  return overlay
}

function renderBadges(): void {
  const layer = ensureOverlay()
  const wanted = new Set(state.marks.map(m => m.index))
  for (const badge of Array.from(layer.children)) {
    const index = Number((badge as HTMLElement).dataset.index)
    if (!wanted.has(index)) {
      const border = regionEls.get(index)
      if (border) { border.remove(); regionEls.delete(index) }
      badge.remove()
    }
  }
  for (const mark of state.marks) {
    let badge = layer.querySelector<HTMLElement>(`.dsh-point-ext-badge[data-index="${mark.index}"]`)
    if (badge === null) {
      badge = document.createElement('div')
      badge.className = 'dsh-point-ext-badge'
      badge.dataset.index = String(mark.index)
      badge.textContent = String(mark.index)
      badge.addEventListener('click', (e) => {
        e.stopPropagation()
        // 2026-08-25: 角标关弹窗也是「了结」——恢复被暂停的标记；开弹窗则经 openMark 自动暂停
        if (state.activeIndex === mark.index) {
          // 2026-08-25: 角标关闭与 ×/Esc 同语义——先了结草稿（有评论暂存、无评论
          // 撤销），否则这条路径漏 settleDraft，留下「高亮还在、暂存区没有」的孤儿标记
          settleDraft()
          openMark(null)
          resumeMarking()
        } else {
          openMark(mark.index)
        }
      })
      layer.appendChild(badge)
    }
    badge.classList.toggle('sent', mark.status === 'sent')
    badge.classList.toggle('pending', mark.status === 'pending')
    badge.title = mark.status === 'sent' ? '已发送' : '点击打开评论'
    const regionRect = parseRegionSelector(mark.selector)
    if (regionRect !== null) {
      let border = regionEls.get(mark.index)
      if (border === undefined) {
        border = document.createElement('div')
        border.className = REGION_KEPT_CLASS
        border.dataset.index = String(mark.index)
        // 2026-08-25: 挂 documentElement——body 被站点设为 relative 时 absolute
        // 定位按 body 偏移，区域边框与框选位置不符
        document.documentElement.appendChild(border)
        regionEls.set(mark.index, border)
      }
      // 定位统一走 repositionRegions()（含内层滚动 delta 修正），此处只建元素
      continue
    }
    const el = resolveElement(mark)
    if (el !== null && el instanceof HTMLElement) {
      const rec = el as HTMLElement & { __dshPointExtOrigOutline?: string; __dshPointExtOrigOutlineOffset?: string }
      if (rec.__dshPointExtOrigOutline === undefined) {
        rec.__dshPointExtOrigOutline = el.style.outline || ''
        rec.__dshPointExtOrigOutlineOffset = el.style.outlineOffset || ''
      }
      rec.style.outline = KEPT_OUTLINE
      rec.style.outlineOffset = '1px'
      ;(el as unknown as Record<string, unknown>)[KEPT_FLAG] = true
    }
  }
  repositionRegions()
  repositionBadges()
}

// 2026-08-25: region 边框定位统一入口——文档坐标减去内层滚动容器 delta，
// 使边框在内层滚动（dsh 类应用）时跟随内容，而不是停在视口原位
function repositionRegions(): void {
  for (const mark of state.marks) {
    const regionRect = parseRegionSelector(mark.selector)
    if (regionRect === null) continue
    const border = regionEls.get(mark.index)
    if (border === undefined) continue
    const d = regionDelta(mark.index)
    border.style.left = `${regionRect.x - d.dx}px`
    border.style.top = `${regionRect.y - d.dy}px`
    border.style.width = `${regionRect.width}px`
    border.style.height = `${regionRect.height}px`
  }
}

function repositionBadges(): void {
  if (overlay === null) return
  for (const mark of state.marks) {
    const badge = overlay.querySelector<HTMLElement>(`.dsh-point-ext-badge[data-index="${mark.index}"]`)
    if (badge === null) continue
    const regionRect = parseRegionSelector(mark.selector)
    if (regionRect !== null) {
      const d = regionDelta(mark.index)
      badge.style.display = ''
      badge.style.left = `${regionRect.x - d.dx - window.scrollX}px`
      badge.style.top = `${regionRect.y - d.dy - window.scrollY}px`
      continue
    }
    const el = resolveElement(mark)
    if (el === null || !el.isConnected) {
      badge.style.display = 'none'
      continue
    }
    const r = el.getBoundingClientRect()
    badge.style.display = ''
    badge.style.left = `${r.left}px`
    badge.style.top = `${r.top}px`
  }
}

function parseRegionSelector(selector: string): { x: number; y: number; width: number; height: number } | null {
  const m = /^region:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(selector)
  if (!m) return null
  const [, xs, ys, ws, hs] = m
  const rect = { x: Number(xs), y: Number(ys), width: Number(ws), height: Number(hs) }
  if (rect.width <= 0 || rect.height <= 0) return null
  return rect
}

function resolveElement(mark: Mark): Element | null {
  try {
    return document.querySelector(mark.selector)
  } catch (e) {
    console.error('[dsh-point-ext] invalid selector:', e)
    return null
  }
}

// 2026-08-21: 从暂存列表跳转定位——selector 失效时回退 anchor.xpath，
// 滚动到视口中央并闪烁提醒（box-shadow 脉冲，不与 KEPT_OUTLINE 内联 outline 冲突）
// 2026-08-24: 新增 region 标记分支——滚动到矩形位置并闪烁区域边框。
function focusMark(index: number): { ok: boolean; error?: string } {
  const mark = state.marks.find(m => m.index === index)
  if (!mark) return { ok: false, error: '页面上不存在该标记（可能已删除或页面已刷新）' }

  const regionRect = parseRegionSelector(mark.selector)
  if (regionRect !== null) {
    const border = regionEls.get(mark.index)
    if (!border) return { ok: false, error: '无法定位区域标记（页面已刷新）' }
    // 2026-08-25: 内层容器锚点复原——区域被内层滚动带走时，scrollIntoView 只会
    // 滚 window（边框挂在 documentElement），必须先把各锚点滚回捕获时位置
    const anchors = regionAnchors.get(mark.index)
    if (anchors !== undefined) {
      for (const a of anchors) {
        if (!a.el.isConnected) continue
        a.el.scrollTop = a.top
        a.el.scrollLeft = a.left
      }
      repositionRegions()
    }
    // jsdom 没有 scrollIntoView；运行时判断，避免测试崩溃。
    if (typeof border.scrollIntoView === 'function') {
      border.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    const cls = 'dsh-point-ext-flash'
    border.classList.remove(cls)
    void border.offsetWidth
    border.classList.add(cls)
    window.setTimeout(() => { border.classList.remove(cls) }, 1800)
    return { ok: true }
  }

  let el = resolveElement(mark)
  if (el === null && mark.anchor?.xpath) {
    try {
      const node = document.evaluate(mark.anchor.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      if (node && node.nodeType === 1) el = node as Element
    } catch (e) {
      console.error('[dsh-point-ext] xpath fallback failed:', e)
    }
  }
  if (el === null || !el.isConnected) return { ok: false, error: '无法定位标记元素（页面结构已变化）' }
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const cls = 'dsh-point-ext-flash'
  el.classList.remove(cls)
  // 强制 reflow：连续点击同一标记也能重新触发动画
  void (el as HTMLElement).offsetWidth
  el.classList.add(cls)
  window.setTimeout(() => { el.classList.remove(cls) }, 1800)
  return { ok: true }
}

// 2026-08-21: 向上找带 KEPT_FLAG 的已标记祖先；命中即重开其评论窗，不重复捕获
function findMarkedAncestor(el: Element): Element | null {
  let cur: Element | null = el
  while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY') {
    if ((cur as unknown as Record<string, unknown>)[KEPT_FLAG]) return cur
    cur = cur.parentElement
  }
  return null
}

// 2026-08-24: compose whiteboard strokes onto the screenshot before staging/sending.
async function composeLocalMark(mark: Mark): Promise<Mark> {
  const strokes = strokeMap.get(mark.index)
  if (!strokes || strokes.length === 0) return mark
  const result = await composeScreenshot(mark.screenshot, strokes)
  if (result === null) {
    console.error('[dsh-point-ext] compose screenshot failed, staging original screenshot')
    return mark
  }
  strokeMap.delete(mark.index)
  return { ...mark, screenshot: result }
}

/* ---------- popup ---------- */

// 2026-08-25: 在途截图未决时先等它再读 mark（暂存/发送共用），返回最新 mark
async function awaitPendingShot(index: number): Promise<Mark | undefined> {
  const pending = pendingShots.get(index)
  if (pending) await pending
  return state.marks.find(m => m.index === index)
}

function ensurePopupLayer(): HTMLDivElement {
  if (popupLayer === null) {
    popupLayer = document.createElement('div')
    popupLayer.id = POPUP_LAYER_ID
    popupLayer.className = 'dsh-point-ext-popup-layer'
    document.body.appendChild(popupLayer)
  }
  return popupLayer
}

function renderPopup(): void {
  const layer = ensurePopupLayer()
  // 2026-08-25: 截图回填会触发重渲染——同一标记且不 busy 时保住正在输入的评论
  const prevTa = layer.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')
  const typedText = prevTa !== null && !popupBusy && popupRenderedIndex === state.activeIndex
    ? prevTa.value
    : null
  layer.textContent = ''
  popupRenderedIndex = state.activeIndex
  if (state.activeIndex === null) return
  const mark = state.marks.find(m => m.index === state.activeIndex)
  if (mark === undefined) { openMark(null); return }

  const container = document.createElement('div')
  container.className = 'dsh-point-ext-popup'

  const header = document.createElement('div')
  header.className = 'dsh-point-ext-popup-header'
  header.textContent = `所指 #${mark.index}`
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dsh-point-ext-popup-close'
  closeBtn.textContent = '×'
  closeBtn.title = '关闭'
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    // 2026-08-25: 关闭 = 默认暂存（用户拍板，与 Esc 同语义）——已输入的评论进
    // 暂存区不丢失；无评论才撤销（保持「页面高亮 ⇔ 暂存区有记录」不变量）
    settleDraft()
    openMark(null)
    resumeMarking() // 2026-08-25: 了结评论子流程，恢复被弹窗暂停的标记
  })
  header.appendChild(closeBtn)
  container.appendChild(header)

  const textarea = document.createElement('textarea')
  textarea.className = 'dsh-point-ext-popup-textarea'
  textarea.placeholder = mark.status === 'sent' ? '（已发送）' : '在此写下对所指对象的评论…'
  // 2026-08-25: 截图回填重渲染时恢复用户正在输入的内容（优先于已保存评论）
  textarea.value = typedText ?? mark.comment ?? ''
  textarea.disabled = mark.status === 'sent' || popupBusy
  container.appendChild(textarea)

  if (mark.status !== 'sent' && mark.hasExternalImage) {
    const hint = document.createElement('div')
    hint.className = 'dsh-point-ext-popup-hint'
    hint.textContent = '提示：该区域含外部图片，截图可能因跨域策略缺失。'
    container.appendChild(hint)
  }
  if (mark.screenshotError !== undefined) {
    const err = document.createElement('div')
    err.className = 'dsh-point-ext-popup-hint'
    err.textContent = `截图未生成：${mark.screenshotError}。仍可发送纯文本。`
    container.appendChild(err)
  }

  const meta = document.createElement('div')
  meta.className = 'dsh-point-ext-popup-meta'
  meta.textContent = `文本：${mark.text || '（无可见文本）'}`
  container.appendChild(meta)

  // 2026-08-25: 评论窗白板已移除（用户拍板：涂抹只有「页面白板」一个入口，
  // 两套绘画工具并存反而造成混乱）。截图只读预览，想标注就用页面白板再画一张。
  // 截图包进独立滚动容器——长截图不再把暂存/发送按钮挤出视口（用户实机报告）
  if (mark.screenshot) {
    const wrap = document.createElement('div')
    wrap.className = 'dsh-point-ext-popup-shot-wrap'
    const img = document.createElement('img')
    img.className = 'dsh-point-ext-popup-shot'
    img.src = mark.screenshot
    img.alt = '所指截图'
    wrap.appendChild(img)
    container.appendChild(wrap)
  } else if (mark.screenshotError === undefined && pendingShots.has(mark.index)) {
    // 2026-08-25: 截图异步回填期间给出反馈，完成后 updateMark 触发重渲染自动替换
    const pending = document.createElement('div')
    pending.className = 'dsh-point-ext-popup-hint'
    pending.textContent = '截图生成中…'
    container.appendChild(pending)
  }

  const actions = document.createElement('div')
  actions.className = 'dsh-point-ext-popup-actions'

  if (mark.status !== 'sent') {
    const sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'dsh-point-ext-popup-btn primary'
    sendBtn.textContent = '发送'
    sendBtn.disabled = popupBusy
    sendBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const comment = textarea.value.trim()
      if (comment === '' && !window.confirm('评论为空，确认直接发送所指内容？')) return
      popupBusy = true
      renderPopup()
      void (async () => {
        // 2026-08-25: 截图异步回填——暂存/发送前等在途截图，保证暂存区与 dsh 都带图
        const current = await awaitPendingShot(mark.index)
        if (!current) { popupBusy = false; renderPopup(); return } // 等待期间标记已被删除
        const prepared = await composeLocalMark(current)
        updateMark(mark.index, { screenshot: prepared.screenshot, comment, status: 'pending' })
        const staged: Mark = { ...prepared, comment, status: 'pending' }
        const sendTimeout = window.setTimeout(() => {
          popupBusy = false
          renderPopup()
          showToast('发送超时：后台无响应，请重试。')
        }, extSettings.sendWatchdogMs)
        chrome.runtime.sendMessage({ type: 'STAGE_MARK', mark: staged, sendNow: true }, (res) => {
          window.clearTimeout(sendTimeout)
          popupBusy = false
          if (chrome.runtime.lastError) {
            renderPopup()
            showToast(`发送失败：${chrome.runtime.lastError.message}`)
            return
          }
          if (res && !res.ok) {
            renderPopup()
            showToast(`发送失败：${res.error || '未知错误'}`)
            return
          }
          updateMark(mark.index, { status: 'sent' })
          openMark(null)
          resumeMarking() // 2026-08-25: 发送了结，恢复被暂停的标记
        })
      })()
    })

    const stageBtn = document.createElement('button')
    stageBtn.type = 'button'
    stageBtn.className = 'dsh-point-ext-popup-btn'
    stageBtn.textContent = '暂存'
    stageBtn.disabled = popupBusy
    stageBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const comment = textarea.value.trim()
      void (async () => {
        // 2026-08-25: 截图异步回填——暂存/发送前等在途截图，保证暂存区与 dsh 都带图
        const current = await awaitPendingShot(mark.index)
        if (!current) { popupBusy = false; renderPopup(); return } // 等待期间标记已被删除
        const prepared = await composeLocalMark(current)
        updateMark(mark.index, { screenshot: prepared.screenshot, comment, status: 'pending' })
        const staged: Mark = { ...prepared, comment, status: 'pending' }
        chrome.runtime.sendMessage({ type: 'STAGE_MARK', mark: staged, sendNow: false })
          .then(() => {
            updateMark(mark.index, { comment, status: 'pending' })
            openMark(null)
            resumeMarking() // 2026-08-25: 暂存了结，恢复被暂停的标记
          })
          .catch((err) => {
            console.error('[dsh-point-ext] stage failed:', err)
            showToast(`暂存失败：${err?.message || '未知错误'}。请重试。`)
          })
      })()
    })

    actions.appendChild(sendBtn)
    actions.appendChild(stageBtn)
  }

  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.className = 'dsh-point-ext-popup-btn danger'
  delBtn.textContent = '删除'
  delBtn.disabled = popupBusy
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    removeMark(mark.index)
    openMark(null)
    resumeMarking() // 2026-08-25: 删除了结，恢复被暂停的标记
  })
  actions.appendChild(delBtn)

  container.appendChild(actions)
  layer.appendChild(container)
  repositionPopup()
}

function repositionPopup(): void {
  if (popupLayer === null || state.activeIndex === null) return
  const container = popupLayer.querySelector<HTMLElement>('.dsh-point-ext-popup')
  if (container === null) return
  const mark = state.marks.find(m => m.index === state.activeIndex)
  if (mark === undefined) return

  let r: { left: number; top: number; bottom: number; width: number }
  const regionRect = parseRegionSelector(mark.selector)
  if (regionRect !== null) {
    const d = regionDelta(mark.index)
    r = {
      left: regionRect.x - d.dx - window.scrollX,
      top: regionRect.y - d.dy - window.scrollY,
      bottom: regionRect.y + regionRect.height - d.dy - window.scrollY,
      width: regionRect.width,
    }
  } else {
    const el = resolveElement(mark)
    if (el === null || !el.isConnected) {
      container.style.display = 'none'
      return
    }
    const rect = el.getBoundingClientRect()
    r = { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }
  }

  container.style.display = ''
  const pad = 8
  let top = r.bottom + pad
  let left = r.left
  const vw = window.innerWidth
  const vh = window.innerHeight
  const bw = container.offsetWidth
  const bh = container.offsetHeight
  if (left + bw > vw) left = Math.max(pad, vw - bw - pad)
  // 2026-08-25: 下方放不下优先放上方；上方也不够或标记滚出视口时钳进视口，
  // 保证按钮可见（原实现标记在视口外时弹窗跟着出视口，按钮看不到）
  if (top + bh > vh && r.top - bh - pad >= pad) top = r.top - bh - pad
  if (top + bh > vh) top = Math.max(pad, vh - bh - pad)
  if (top < pad) top = pad
  // 2026-08-25: popupLayer 是 position:fixed，子元素用视口坐标——原实现再加
  // window.scroll 双重计数，window 滚动后弹窗被推出视口
  container.style.top = `${top}px`
  container.style.left = `${left}px`
}

/* ---------- styles ---------- */

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
body.dsh-point-ext-marking { cursor: crosshair; }
body.dsh-point-ext-marking .dsh-point-ext-badge { cursor: pointer; }
.dsh-point-ext-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
}
.dsh-point-ext-badge {
  position: absolute;
  pointer-events: auto;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border-radius: 999px;
  background: #2563eb;
  color: #ffffff;
  font: 600 12px/22px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: center;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.dsh-point-ext-badge.sent { background: #16a34a; }
.dsh-point-ext-badge.pending { background: #d97706; }
.dsh-point-ext-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70vw;
  padding: 10px 16px;
  background: rgba(31, 35, 40, 0.92);
  color: #fff;
  font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  border-radius: 8px;
  z-index: 2147483001;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}
.dsh-point-ext-popup-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483002;
}
.dsh-point-ext-popup {
  position: absolute;
  pointer-events: auto;
  width: 320px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.18);
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #1f2328;
  overflow: hidden;
  /* 2026-08-25: flex 列布局 + 视口限高——长截图时收缩的是截图滚动容器，
     header/输入框/按钮始终可见（原实现无 max-height，按钮被推出视口点不到） */
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 16px);
}
.dsh-point-ext-popup > * { flex: none; }
.dsh-point-ext-popup > .dsh-point-ext-popup-shot-wrap { flex: 0 1 auto; }
.dsh-point-ext-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: #f3f4f6;
  font-weight: 600;
}
.dsh-point-ext-popup-close {
  border: none;
  background: transparent;
  font: 18px/1 sans-serif;
  color: #6b7280;
  cursor: pointer;
}
.dsh-point-ext-popup-textarea {
  width: 100%;
  min-height: 72px;
  padding: 10px 12px;
  border: none;
  border-bottom: 1px solid #e5e7eb;
  resize: vertical;
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.dsh-point-ext-popup-hint {
  padding: 6px 12px;
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
  border-bottom: 1px solid #e5e7eb;
}
.dsh-point-ext-popup-meta {
  padding: 8px 12px;
  color: #6b7280;
  font-size: 12px;
  border-bottom: 1px solid #e5e7eb;
  word-break: break-all;
}
.dsh-point-ext-popup-actions {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  justify-content: flex-end;
}
.dsh-point-ext-popup-btn {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}
.dsh-point-ext-popup-btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}
.dsh-point-ext-popup-btn.danger {
  color: #dc2626;
  border-color: #fca5a5;
}
.dsh-point-ext-popup-btn:disabled { opacity: 0.5; cursor: not-allowed; }
@keyframes dshPointExtFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 45, 85, 0); }
  50% { box-shadow: 0 0 0 8px rgba(255, 45, 85, 0.45); }
}
.dsh-point-ext-flash { animation: dshPointExtFlash 0.5s ease-in-out 3; }
.dsh-point-ext-region-rect {
  position: absolute;
  border: 2px dashed #2563eb;
  background: rgba(37, 99, 235, 0.08);
  pointer-events: none;
  z-index: 2147483000;
}
.dsh-point-ext-region-kept {
  position: absolute;
  border: 2px dashed #2563eb;
  background: rgba(37, 99, 235, 0.04);
  pointer-events: none;
  z-index: 2147482999;
}
/* 2026-08-25: 页面白板——画布低于徽标/弹窗（pointer-events 在画布上，标记层均
   pointer-events:none 不影响作画）；工具条最高，保证始终可点 */
.dsh-point-ext-board {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 2147482998;
  cursor: crosshair;
  background: transparent;
}
.dsh-point-ext-board-toolbar {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483003;
  display: flex;
  gap: 6px;
  padding: 8px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.18);
}
.dsh-point-ext-board-toolbar button {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  color: #374151;
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  cursor: pointer;
}
.dsh-point-ext-board-toolbar button.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}
.dsh-point-ext-board-toolbar button.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}
/* 2026-08-25: 评论窗截图只读预览（白板唯一入口=页面白板，评论窗不再内嵌绘画）。
   截图装在独立滚动容器里：超高截图在容器内滚动，不撑爆弹窗、不挤走按钮 */
.dsh-point-ext-popup-shot-wrap {
  max-height: 32vh;
  min-height: 60px;
  overflow-y: auto;
  overflow-x: hidden;
  margin: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
}
.dsh-point-ext-popup-shot {
  display: block;
  width: 100%;
}
`
  document.head.appendChild(style)
}

/* ---------- messaging ---------- */

function mount(): void {
  // 2026-08-21: 扩展重载后按需注入的新实例会撞见旧实例残留 DOM（角标/弹窗层，同 id）。
  // mount 时清掉，避免双 overlay 与僵尸角标。ponytail: 旧实例留在元素上的内联 outline
  // 无法枚举（JS 属性不可查询），随页面刷新自然消失，不另做清理
  for (const stale of document.querySelectorAll('.dsh-point-ext-overlay, .dsh-point-ext-popup-layer, .dsh-point-ext-toast, .dsh-point-ext-region-kept')) {
    stale.remove()
  }
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout', onMouseOut, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('scroll', onScrollOrResize)
  window.addEventListener('resize', onScrollOrResize)
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', onScrollOrResize)
    vv.addEventListener('scroll', onScrollOrResize)
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'TOGGLE_MARKING') {
      setMarking(!state.marking)
      sendResponse({ marking: state.marking })
      return false
    }
    if (message?.type === 'SET_MARKING') {
      setMarking(!!message.marking)
      sendResponse({ marking: state.marking })
      return false
    }
    if (message?.type === 'UPDATE_MARK') {
      updateMark(message.index, message.patch)
      sendResponse({})
      return false
    }
    if (message?.type === 'REMOVE_MARK') {
      removeMark(message.index)
      sendResponse({})
      return false
    }
    if (message?.type === 'CLEAR_MARKS') {
      clearMarks()
      sendResponse({})
      return false
    }
    if (message?.type === 'GET_STATE') {
      sendResponse({
        marking: state.marking,
        marks: state.marks.map(m => ({
          index: m.index,
          selector: m.selector,
          text: m.text,
          source: m.source,
          screenshotLen: m.screenshot.length,
          screenshotError: m.screenshotError,
          hasExternalImage: m.hasExternalImage,
          status: m.status,
        })),
      })
      return false
    }
    if (message?.type === 'START_DRAWING') {
      enterDrawingMode()
      sendResponse({ drawing: drawingMode })
      return false
    }
    if (message?.type === 'FOCUS_MARK') {
      sendResponse(focusMark(message.index))
      return false
    }
    return false
  })

  ;(window as unknown as Record<string, unknown>).__dshPointExt = {
    toggle: () => setMarking(!state.marking),
    getState: () => state,
  }
}

mount()
