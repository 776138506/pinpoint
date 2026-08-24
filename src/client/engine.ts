/**
 * Imperative marking engine (browser half). Owns everything that is not a
 * React component: the document/iframe event listeners (hover highlight +
 * click capture), the html2canvas region screenshot, the numbered-badge
 * overlay, cross-origin iframe notices, and the toast surface.
 *
 * The engine is deliberately React-free and driven by the MarkingEngine
 * component: `sync()` receives the latest store snapshot on every state
 * change, and the two write callbacks (`addMark`/`removeMark`) route captures
 * back into the store. This keeps the store as the single source of truth
 * while the engine does the DOM work a component cannot.
 *
 * D10 lessons encoded here:
 *  - iframe MouseEvent.clientX/Y are iframe-viewport coordinates — feed them
 *    straight into `doc.elementFromPoint` (no parent-rect subtraction).
 *  - html2canvas with `useCORS:true` is the screenshot path; non-CORS external
 *    images are dropped silently, so flag the element and warn the user.
 */
import html2canvas from 'html2canvas'
import { cloneForScreenshot, cssPath, detectExternalImages, snippet, visibleText } from './mark-utils.ts'
import type { Mark, MarkingState } from './stores.ts'

/** Write callbacks the engine uses to reach the store (wired by the component). */
export interface MarkingControllerDeps {
  setMarking(on: boolean): void
  addMark(mark: Mark): void
  removeMark(index: number): void
  openMark(index: number | null): void
  updateMark(index: number, patch: Partial<Omit<Mark, 'index'>>): void
  sendMark(mark: Mark, comment: string): Promise<void>
}

/** The engine's imperative surface. */
export interface MarkingController {
  mount(): void
  dispose(): void
  sync(state: MarkingState): void
}

const HOVER_OUTLINE = '2px solid #ff2d55'
const KEPT_OUTLINE = '2px solid #2563eb'
const OVERLAY_ID = 'dsh-point-badge-layer'
const CROSS_ID = 'dsh-point-cross-layer'
const STYLE_ID = 'dsh-point-style'
const REGION_RECT_CLASS = 'dsh-point-region-rect'
const REGION_KEPT_CLASS = 'dsh-point-region-kept'
const DRAG_THRESHOLD = 6

// Element data attributes written by the engine (never read back for logic
// beyond the flags that prevent double-highlighting a kept mark).
const KEPT_FLAG = '__dshPointKept'


/**
 * Create the marking engine.
 * @param deps - write callbacks into the marking store.
 * @returns the controller.
 */
export function createMarkingController(deps: MarkingControllerDeps): MarkingController {
  let state: MarkingState = { marking: false, marks: [], nextIndex: 1, activeIndex: null }
  let overlay: HTMLDivElement | null = null
  let crossLayer: HTMLDivElement | null = null
  let hoveredEl: Element | null = null
  let disposed = false
  let rafPending = false
  let domObserver: MutationObserver | null = null

  const attachedFrames = new Set<HTMLIFrameElement>()
  const crossFrames = new Set<HTMLIFrameElement>()
  // mark.index -> the currently-highlighted element (kept outline applied).
  const keptEls = new Map<number, Element>()
  const attachedOffices = new Set<HTMLElement>()
  const officeListeners = new WeakMap<HTMLElement, { over: EventListener; out: EventListener; click: EventListener }>()
  let lastHintAt = 0
  // 2026-08-24: re-entrancy guard — rapid double-clicks would otherwise run two
  // captures concurrently against the same state.nextIndex, producing duplicate
  // marks sharing one index.
  let captureInFlight = false

  // 2026-08-24: region drag state. mousedown starts a drag; mousemove beyond
  // DRAG_THRESHOLD draws the selection rect; mouseup either captures the region
  // (if dragged) or falls through to the click handler (if not).
  interface DragState {
    startX: number
    startY: number
    doc: Document
    frame?: HTMLIFrameElement
    officeContainer?: HTMLElement
  }
  let dragState: DragState | null = null
  let dragRectEl: HTMLElement | null = null
  let suppressClick = false

  // 2026-08-24: region marks have no DOM element, so we keep a persistent
  // border div per mark that follows scroll/resize via repositionAll().
  const regionEls = new Map<number, HTMLElement>()

  ensureStyle()

  /* ---------- toast ---------- */

  function showToast(message: string): void {
    const el = document.createElement('div')
    el.className = 'dsh-point-toast'
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

  function highlight(el: Element): void {
    if (!el || el.nodeType !== 1) return
    if (!(el instanceof HTMLElement)) return
    const rec = el as HTMLElement & { __dshPointOrigOutline?: string }
    if (rec.__dshPointOrigOutline === undefined) {
      rec.__dshPointOrigOutline = el.style.outline || ''
    }
    rec.style.outline = HOVER_OUTLINE
    rec.style.outlineOffset = '1px'
  }

  function unhighlight(el: Element): void {
    if (!el || el.nodeType !== 1) return
    if (!(el instanceof HTMLElement)) return
    const rec = el as HTMLElement & { __dshPointOrigOutline?: string }
    // A kept mark owns its outline: releasing a transient hover must not wipe it.
    if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) {
      delete rec.__dshPointOrigOutline
      rec.style.outline = KEPT_OUTLINE
      rec.style.outlineOffset = '1px'
      return
    }
    if (rec.__dshPointOrigOutline !== undefined) {
      rec.style.outline = rec.__dshPointOrigOutline
      delete rec.__dshPointOrigOutline
    } else {
      rec.style.outline = ''
    }
  }

  function clearHover(): void {
    if (hoveredEl) { unhighlight(hoveredEl); hoveredEl = null }
  }

  /* ---------- region drag ---------- */

  // 2026-08-24: exclude the engine's own UI from starting a region drag, so
  // users can still interact with badges/popups/toasts/cross notices.
  function isOwnUI(el: Element): boolean {
    return el.closest(
      '.dsh-point-badge, .dsh-point-toast, .dsh-point-cross, .dsh-point-popup, .dsh-point-popup-layer, .dsh-point-region-rect, .dsh-point-region-kept',
    ) !== null
  }

  function startDrag(e: MouseEvent, doc: Document, frame?: HTMLIFrameElement): void {
    const el = e.target as Element
    if (!el || el.nodeType !== 1) return
    if (isOwnUI(el)) return
    const officeContainer = !frame ? (el.closest('div[data-office]') as HTMLElement | null) ?? undefined : undefined
    dragState = { startX: e.clientX, startY: e.clientY, doc, frame, officeContainer }
  }

  function updateDrag(e: MouseEvent): void {
    if (!dragState) return
    const dx = e.clientX - dragState.startX
    const dy = e.clientY - dragState.startY
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) {
      removeDragRect()
      return
    }
    // 2026-08-24: 拖拽中阻止文本选择，避免页面内容被高亮。
    e.preventDefault()
    const doc = dragState.doc
    const win = doc.defaultView
    const left = Math.min(dragState.startX, e.clientX) + (win?.scrollX ?? 0)
    const top = Math.min(dragState.startY, e.clientY) + (win?.scrollY ?? 0)
    const width = Math.abs(dx)
    const height = Math.abs(dy)
    if (dragRectEl === null) {
      dragRectEl = document.createElement('div')
      dragRectEl.className = REGION_RECT_CLASS
      // Append to the document being marked so coordinates are 1:1 and the
      // rect scrolls with the content.
      doc.body.appendChild(dragRectEl)
    }
    dragRectEl.style.left = `${left}px`
    dragRectEl.style.top = `${top}px`
    dragRectEl.style.width = `${width}px`
    dragRectEl.style.height = `${height}px`
  }

  function endDrag(e: MouseEvent): void {
    if (!dragState) return
    const dx = e.clientX - dragState.startX
    const dy = e.clientY - dragState.startY
    const dragged = Math.hypot(dx, dy) > DRAG_THRESHOLD
    removeDragRect()
    if (dragged) {
      suppressClick = true
      const doc = dragState.doc
      const win = doc.defaultView
      const left = Math.min(dragState.startX, e.clientX) + (win?.scrollX ?? 0)
      const top = Math.min(dragState.startY, e.clientY) + (win?.scrollY ?? 0)
      const rect = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(Math.abs(dx)),
        height: Math.round(Math.abs(dy)),
      }
      void captureRegion(rect, dragState.frame, dragState.officeContainer)
    }
    dragState = null
  }

  function removeDragRect(): void {
    if (dragRectEl !== null) {
      dragRectEl.remove()
      dragRectEl = null
    }
  }

  /* ---------- frame listeners ---------- */

  /**
   * Walk up from `el` to an ancestor carrying KEPT_FLAG and return that mark's
   * index. Clicking an already-marked element reopens its comment popup instead
   * of capturing a duplicate mark (aligned with the extension's findMarkedAncestor).
   */
  function findKeptMarkIndex(el: Element): number | null {
    let cur: Element | null = el
    while (cur !== null) {
      if ((cur as unknown as Record<string, unknown>)[KEPT_FLAG]) {
        for (const [idx, kept] of keptEls) {
          if (kept === cur) return idx
        }
        return null
      }
      cur = cur.parentElement
    }
    return null
  }

  function attachDocListeners(doc: Document, frame: HTMLIFrameElement): void {
    doc.addEventListener('mouseover', (e: MouseEvent) => {
      if (!state.marking) return
      const el = e.target as Element
      if (!el || el.nodeType !== 1) return
      if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) return
      if (hoveredEl && hoveredEl !== el) unhighlight(hoveredEl)
      hoveredEl = el
      highlight(el)
    }, true)
    doc.addEventListener('mouseout', (e: MouseEvent) => {
      if (!state.marking) return
      const el = e.target as Element
      if (el === hoveredEl) { unhighlight(el); hoveredEl = null }
    }, true)
    doc.addEventListener('mousedown', (e: MouseEvent) => {
      if (!state.marking) return
      startDrag(e, doc, frame)
    }, true)
    doc.addEventListener('mousemove', (e: MouseEvent) => {
      if (!state.marking) return
      updateDrag(e)
    }, true)
    doc.addEventListener('mouseup', (e: MouseEvent) => {
      if (!state.marking) return
      endDrag(e)
    }, true)
    doc.addEventListener('click', (e: MouseEvent) => {
      if (!state.marking) return
      // 2026-08-24: a region drag consumes the click; do not also capture the
      // element under the mouseup.
      if (suppressClick) {
        suppressClick = false
        return
      }
      // D10: iframe-local coordinates feed elementFromPoint directly.
      const raw = doc.elementFromPoint(e.clientX, e.clientY) ?? e.target
      if (!(raw instanceof Element)) return
      const el = raw
      if (el.nodeType !== 1) return
      if (el.closest('.dsh-point-badge, .dsh-point-toast, .dsh-point-cross')) return
      const keptIndex = findKeptMarkIndex(el)
      if (keptIndex !== null) { deps.openMark(keptIndex); return }
      void captureElement(el, frame)
    }, true)
    // Iframe-internal scroll must reposition the parent-page badges.
    doc.addEventListener('scroll', onScrollOrResize, true)
    // 2026-08-24: Esc 落点补齐——焦点在预览 iframe 内时，按键事件只进 iframe 文档，
    // 主文档的 keydown 听不到，标记模式无法退出（侧栏按钮卡「退出标记」）
    // 拖拽中按 Esc 取消本次拖拽（不退出标记模式）；非拖拽状态 Esc 退出标记。
    doc.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.repeat) return
      if (e.key !== 'Escape' || !state.marking) return
      if (dragState !== null) {
        dragState = null
        removeDragRect()
        return
      }
      deps.setMarking(false)
    }, true)
  }

  function tryAttachContent(frame: HTMLIFrameElement): void {
    let doc: Document | null
    try {
      doc = frame.contentDocument
    } catch (e) {
      // Cross-origin frame: contentDocument access throws. This is the known
      // phase-one limitation (D6) — surface a failure notice, never retry.
      console.error('[dsh-point] cross-origin iframe.contentDocument access:', e)
      frame.__dshPointCrossOrigin = true
      crossFrames.add(frame)
      return
    }
    if (doc === null) {
      // contentDocument is null for cross-origin (or sandbox-without-same-origin)
      // frames after they have loaded. Treat it as the known phase-one limitation
      // (D6) and surface a failure notice.
      console.error('[dsh-point] iframe.contentDocument is null (cross-origin/sandboxed)')
      frame.__dshPointCrossOrigin = true
      crossFrames.add(frame)
      return
    }
    if (frame.__dshPointAttached) return
    // A fresh srcdoc/URL iframe starts as an about:blank placeholder that is
    // replaced when the real content loads; binding now would strand the
    // listeners on the doomed document. Attach on the 'load' event instead.
    if (doc.location.href === 'about:blank') return
    frame.__dshPointAttached = true
    attachDocListeners(doc, frame)
  }

  function onFrameLoad(e: Event): void {
    const frame = e.target as HTMLIFrameElement | null
    if (!frame) return
    // 2026-08-24: a load event means the iframe navigated (or refreshed). Any
    // listeners bound to the previous document are stranded on a dead document,
    // and a stale cross-origin verdict may no longer hold. Reset the flags so
    // tryAttachContent binds the fresh document.
    frame.__dshPointAttached = false
    frame.__dshPointCrossOrigin = false
    crossFrames.delete(frame)
    tryAttachContent(frame)
    renderCrossNotices()
  }

  function syncFrames(): void {
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="web-preview-frame"]'))
    for (const frame of frames) {
      if (!attachedFrames.has(frame)) {
        attachedFrames.add(frame)
        frame.addEventListener('load', onFrameLoad)
        tryAttachContent(frame)
      }
    }
    // Rebuild the cross-origin set from currently-connected frames so removed
    // frames (preview switch) do not leave stale notices behind.
    crossFrames.clear()
    for (const frame of attachedFrames) {
      if (frame.__dshPointCrossOrigin) crossFrames.add(frame)
    }
    for (const frame of [...attachedFrames]) {
      if (!frame.isConnected) attachedFrames.delete(frame)
    }
  }

  /* ---------- office container listeners (D12: only inside preview panel) ---------- */

  function isInsidePreview(el: Element): boolean {
    return el.closest('div[data-office], iframe[data-testid="web-preview-frame"]') !== null
  }

  function onOfficeMouseOver(e: MouseEvent): void {
    if (!state.marking) return
    const el = e.target as Element
    if (!el || el.nodeType !== 1) return
    if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) return
    if (hoveredEl && hoveredEl !== el) unhighlight(hoveredEl)
    hoveredEl = el
    highlight(el)
  }

  function onOfficeMouseOut(e: MouseEvent): void {
    if (!state.marking) return
    const el = e.target as Element
    if (el === hoveredEl) { unhighlight(el); hoveredEl = null }
  }

  function onOfficeClick(e: MouseEvent): void {
    if (!state.marking) return
    if (suppressClick) { suppressClick = false; return }
    const el = e.target as Element
    if (!el || el.nodeType !== 1) return
    if ((el as Element).closest('.dsh-point-badge, .dsh-point-toast, .dsh-point-cross')) return
    const keptIndex = findKeptMarkIndex(el)
    if (keptIndex !== null) { deps.openMark(keptIndex); return }
    void captureElement(el, undefined)
  }

  function attachOfficeContainer(container: HTMLElement): void {
    if (attachedOffices.has(container)) return
    attachedOffices.add(container)
    const over: EventListener = onOfficeMouseOver as EventListener
    const out: EventListener = onOfficeMouseOut as EventListener
    const click: EventListener = onOfficeClick as EventListener
    officeListeners.set(container, { over, out, click })
    container.addEventListener('mouseover', over, true)
    container.addEventListener('mouseout', out, true)
    container.addEventListener('click', click, true)
  }

  function detachOfficeContainer(container: HTMLElement): void {
    if (!attachedOffices.has(container)) return
    const listeners = officeListeners.get(container)
    if (listeners) {
      container.removeEventListener('mouseover', listeners.over, true)
      container.removeEventListener('mouseout', listeners.out, true)
      container.removeEventListener('click', listeners.click, true)
    }
    attachedOffices.delete(container)
    officeListeners.delete(container)
  }

  function syncOfficeContainers(): void {
    const containers = Array.from(document.querySelectorAll<HTMLElement>('div[data-office]'))
    for (const container of containers) attachOfficeContainer(container)
    for (const container of [...attachedOffices]) {
      if (!container.isConnected) detachOfficeContainer(container)
    }
  }

  /* ---------- capture ---------- */

  async function captureElement(el: Element, frame: HTMLIFrameElement | undefined): Promise<void> {
    if (captureInFlight) return
    captureInFlight = true
    try {
      await captureElementInner(el, frame)
    } finally {
      captureInFlight = false
    }
  }

  async function captureElementInner(el: Element, frame: HTMLIFrameElement | undefined): Promise<void> {
    let frameKind: 'iframe' | 'office' | 'main' = 'main'
    let source = '页面'
    let frameTitle: string | undefined
    if (frame !== undefined) {
      frameKind = 'iframe'
      frameTitle = frame.title || frame.getAttribute('title') || '网页预览'
      source = frameTitle
    } else {
      const office = el.closest('div[data-office]')
      if (office !== null) {
        frameKind = 'office'
        source = office.getAttribute('data-office') || 'office'
      }
    }

    // Clone the element so the transient hover outline does not leak into the
    // captured outerHTML (the hover highlight is still active at click time).
    const clone = el.cloneNode(true) as HTMLElement
    clone.style.outline = ''
    clone.style.outlineOffset = ''
    const mark: Mark = {
      index: state.nextIndex,
      selector: cssPath(el),
      text: visibleText(el),
      html: snippet(clone.outerHTML || ''),
      source,
      sourceUrl: frameKind === 'iframe' && frame !== undefined
        ? (frame.contentWindow?.location.href ?? undefined)
        : (document.defaultView?.location.href ?? undefined),
      sourceTitle: frameKind === 'iframe' && frameTitle !== undefined
        ? frameTitle
        : (document.defaultView?.document.title ?? source),
      frameKind,
      frameTitle,
      screenshot: '',
      hasExternalImage: detectExternalImages(el),
      time: new Date().toISOString(),
      status: 'draft',
    }

    let captureEl: HTMLElement = el as HTMLElement
    let cleanup: (() => void) | undefined
    if (frame !== undefined || el.closest('div[data-office]') !== null) {
      const prepared = cloneForScreenshot(el)
      captureEl = prepared.clone
      cleanup = prepared.cleanup
    }

    try {
      if (typeof html2canvas !== 'function') {
        throw new Error('html2canvas 不可用（未随 client bundle 打包）')
      }
      const canvas = await html2canvas(captureEl, {
        backgroundColor: '#ffffff',
        scale: 1,
        logging: false,
        useCORS: true,
        allowTaint: false,
      })
      mark.screenshot = canvas.toDataURL('image/png')
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.error('[dsh-point] 区域截图失败:', e)
      mark.screenshotError = reason
      showToast(`截图失败：${reason}。可能是元素已从页面移除或渲染内容无法导出。请重新点击，或换一个元素再试。`)
    } finally {
      cleanup?.()
    }

    deps.addMark(mark)

    if (mark.hasExternalImage) {
      showToast('提示：该元素含外部图片，若截图中缺图，是图片服务器未允许跨域加载（CORS）。内容仍可发送，仅图片可能缺失。')
    }
  }

  async function captureRegion(
    rect: { x: number; y: number; width: number; height: number },
    frame: HTMLIFrameElement | undefined,
    officeContainer: HTMLElement | undefined,
  ): Promise<void> {
    if (captureInFlight) return
    captureInFlight = true
    try {
      await captureRegionInner(rect, frame, officeContainer)
    } finally {
      captureInFlight = false
    }
  }

  async function captureRegionInner(
    rect: { x: number; y: number; width: number; height: number },
    frame: HTMLIFrameElement | undefined,
    officeContainer: HTMLElement | undefined,
  ): Promise<void> {
    let frameKind: 'iframe' | 'office' | 'main' = 'main'
    let source = '页面'
    let frameTitle: string | undefined
    let captureDoc: Document = document
    if (frame !== undefined) {
      frameKind = 'iframe'
      frameTitle = frame.title || frame.getAttribute('title') || '网页预览'
      source = frameTitle
      try {
        const d = frame.contentDocument
        if (d !== null) captureDoc = d
      } catch (e) {
        console.error('[dsh-point] region capture iframe access failed:', e)
      }
    } else if (officeContainer !== undefined) {
      frameKind = 'office'
      source = officeContainer.getAttribute('data-office') || 'office'
    }

    const mark: Mark = {
      index: state.nextIndex,
      selector: `region:${rect.x},${rect.y},${rect.width},${rect.height}`,
      text: '',
      html: '',
      source,
      sourceUrl: frameKind === 'iframe' && frame !== undefined
        ? (frame.contentWindow?.location.href ?? undefined)
        : (document.defaultView?.location.href ?? undefined),
      sourceTitle: frameKind === 'iframe' && frameTitle !== undefined
        ? frameTitle
        : (document.defaultView?.document.title ?? source),
      frameKind,
      frameTitle,
      screenshot: '',
      hasExternalImage: false,
      time: new Date().toISOString(),
      status: 'draft',
      anchor: { rect },
    }

    try {
      if (typeof html2canvas !== 'function') {
        throw new Error('html2canvas 不可用（未随 client bundle 打包）')
      }
      const canvas = await html2canvas(captureDoc.documentElement, {
        backgroundColor: '#ffffff',
        scale: 1,
        logging: false,
        useCORS: true,
        allowTaint: false,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
      mark.screenshot = canvas.toDataURL('image/png')
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      console.error('[dsh-point] 区域截图失败:', e)
      mark.screenshotError = reason
      showToast(`截图失败：${reason}。可能是元素已从页面移除或渲染内容无法导出。请重新框选，或换一个区域再试。`)
    }

    deps.addMark(mark)
  }

  /* ---------- badges + cross-origin notices ---------- */

  /**
   * Visual scale of a proxied web iframe (fit-width mode applies a CSS
   * transform). `getBoundingClientRect()` already includes the transform, but
   * the element rects inside the iframe are in the unscaled iframe coordinate
   * system, so badge/popup positions must multiply local offsets by this factor.
   */
  function frameVisualScale(frame: HTMLIFrameElement): number {
    const rect = frame.getBoundingClientRect()
    const inner = frame.contentWindow?.innerWidth
    if (rect.width > 0 && inner !== undefined && inner > 0) {
      return rect.width / inner
    }
    return 1
  }

  function parseRegionSelector(selector: string): { x: number; y: number; width: number; height: number } | null {
    const m = /^region:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(selector)
    if (!m) return null
    const [, xs, ys, ws, hs] = m
    const rect = { x: Number(xs), y: Number(ys), width: Number(ws), height: Number(hs) }
    if (rect.width <= 0 || rect.height <= 0) return null
    return rect
  }

  function resolveMarkElement(mark: Mark): { el: Element | null; rect: { x: number; y: number; width: number; height: number } | null; frameRect: DOMRect | null; scale: number } | null {
    let doc: Document = document
    let frameRect: DOMRect | null = null
    let scale = 1
    if (mark.frameKind === 'iframe' && mark.frameTitle !== undefined) {
      const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="web-preview-frame"]'))
        .find(f => (f.title || f.getAttribute('title') || '') === mark.frameTitle)
      if (frame === undefined) return null
      try {
        const d = frame.contentDocument
        if (d === null) return null
        doc = d
        frameRect = frame.getBoundingClientRect()
        scale = frameVisualScale(frame)
      } catch (e) {
        console.error('[dsh-point] 重新解析 iframe 标记时 contentDocument 访问失败:', e)
        return null
      }
    }
    const regionRect = parseRegionSelector(mark.selector)
    if (regionRect !== null) {
      return { el: null, rect: regionRect, frameRect, scale }
    }
    try {
      const el = doc.querySelector(mark.selector)
      if (el === null) return null
      return { el, rect: null, frameRect, scale }
    } catch (e) {
      // A selector can become invalid only if it was built against a vanished
      // document; treat as "element gone" and hide the badge.
      console.error('[dsh-point] 选择器解析失败:', e)
      return null
    }
  }

  function markViewportRect(
    mark: Mark,
    resolved: { el: Element | null; rect: { x: number; y: number; width: number; height: number } | null; frameRect: DOMRect | null; scale: number },
  ): { left: number; top: number; width: number; height: number } {
    if (resolved.el !== null) {
      const r = resolved.el.getBoundingClientRect()
      if (mark.frameKind === 'iframe' && resolved.frameRect !== null) {
        // Parent-viewport coords = iframe rect (already parent-relative, including
        // any fit-width transform) + the element's iframe-viewport rect scaled by
        // the same factor.
        return {
          left: resolved.frameRect.left + r.left * resolved.scale,
          top: resolved.frameRect.top + r.top * resolved.scale,
          width: r.width * resolved.scale,
          height: r.height * resolved.scale,
        }
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }
    if (resolved.rect !== null) {
      const r = resolved.rect
      const win = document.defaultView
      const scrollX = win?.scrollX ?? 0
      const scrollY = win?.scrollY ?? 0
      if (mark.frameKind === 'iframe' && resolved.frameRect !== null) {
        // Region coords are document coords inside the iframe; convert to
        // parent viewport coords by subtracting iframe scroll and scaling.
        return {
          left: resolved.frameRect.left + (r.x - scrollX) * resolved.scale,
          top: resolved.frameRect.top + (r.y - scrollY) * resolved.scale,
          width: r.width * resolved.scale,
          height: r.height * resolved.scale,
        }
      }
      // Main/office region: document coords → viewport coords.
      return { left: r.x - scrollX, top: r.y - scrollY, width: r.width, height: r.height }
    }
    return { left: 0, top: 0, width: 0, height: 0 }
  }

  function ensureOverlay(): HTMLDivElement {
    if (overlay === null) {
      overlay = document.createElement('div')
      overlay.id = OVERLAY_ID
      overlay.className = 'dsh-point-overlay'
      document.body.appendChild(overlay)
    }
    return overlay
  }

  function ensureCrossLayer(): HTMLDivElement {
    if (crossLayer === null) {
      crossLayer = document.createElement('div')
      crossLayer.id = CROSS_ID
      crossLayer.className = 'dsh-point-overlay'
      document.body.appendChild(crossLayer)
    }
    return crossLayer
  }

  function renderBadges(): void {
    const layer = ensureOverlay()
    const wanted = new Set(state.marks.map(m => m.index))
    // Remove badges (and their kept outline / region border) whose mark is gone.
    for (const badge of Array.from(layer.children)) {
      const index = Number((badge as HTMLElement).dataset.index)
      if (!wanted.has(index)) {
        const kept = keptEls.get(index)
        if (kept && kept instanceof HTMLElement) {
          delete (kept as unknown as Record<string, unknown>)[KEPT_FLAG]
          kept.style.outline = ''
          keptEls.delete(index)
        }
        const regionBorder = regionEls.get(index)
        if (regionBorder) {
          regionBorder.remove()
          regionEls.delete(index)
        }
        badge.remove()
      }
    }
    // Ensure a badge exists for every current mark, and keep the element
    // highlighted / region bordered. Position is set in repositionAll().
    for (const mark of state.marks) {
      let badge = layer.querySelector<HTMLElement>(`.dsh-point-badge[data-index="${mark.index}"]`)
      if (badge === null) {
        badge = document.createElement('div')
        badge.className = 'dsh-point-badge'
        badge.dataset.index = String(mark.index)
        badge.textContent = String(mark.index)
        badge.addEventListener('click', (e) => {
          e.stopPropagation()
          deps.openMark(state.activeIndex === mark.index ? null : mark.index)
        })
        layer.appendChild(badge)
      }
      badge.classList.toggle('sent', mark.status === 'sent')
      badge.classList.toggle('pending', mark.status === 'pending')
      badge.title = mark.status === 'sent' ? '已发送：点击打开查看' : '点击打开评论'
      const resolved = resolveMarkElement(mark)
      if (resolved === null) continue
      if (resolved.el !== null && resolved.el.isConnected && resolved.el instanceof HTMLElement) {
        resolved.el.style.outline = KEPT_OUTLINE
        resolved.el.style.outlineOffset = '1px'
        ;(resolved.el as unknown as Record<string, unknown>)[KEPT_FLAG] = true
        keptEls.set(mark.index, resolved.el)
      } else if (resolved.rect !== null) {
        // Region mark: keep a persistent border in the marked document so it
        // scrolls with the content and is visually anchored to the selection.
        let border = regionEls.get(mark.index)
        const ownerDoc = resolved.frameRect !== null ? (() => {
          try {
            const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="web-preview-frame"]'))
              .find(f => (f.title || f.getAttribute('title') || '') === mark.frameTitle)
            return frame?.contentDocument ?? document
          } catch { return document }
        })() : document
        if (border === undefined || border.ownerDocument !== ownerDoc) {
          border?.remove()
          border = ownerDoc.createElement('div')
          border.className = REGION_KEPT_CLASS
          border.dataset.index = String(mark.index)
          ownerDoc.body.appendChild(border)
          regionEls.set(mark.index, border)
        }
        border.style.left = `${resolved.rect.x}px`
        border.style.top = `${resolved.rect.y}px`
        border.style.width = `${resolved.rect.width}px`
        border.style.height = `${resolved.rect.height}px`
      }
    }
    repositionBadges()
  }

  function repositionBadges(): void {
    if (overlay === null) return
    for (const mark of state.marks) {
      const badge = overlay.querySelector<HTMLElement>(`.dsh-point-badge[data-index="${mark.index}"]`)
      if (badge === null) continue
      const resolved = resolveMarkElement(mark)
      if (resolved === null) {
        badge.style.display = 'none'
        continue
      }
      const visible = resolved.el !== null ? resolved.el.isConnected : true
      if (!visible) {
        // Element disappeared (preview switch / remount): hide the badge but
        // keep the mark in the store (holes preserved, numbering unchanged).
        badge.style.display = 'none'
        continue
      }
      const { left, top } = markViewportRect(mark, resolved)
      badge.style.display = ''
      badge.style.left = `${left}px`
      badge.style.top = `${top}px`
    }
  }

  const POPUP_ID = 'dsh-point-popup-layer'
  let popupLayer: HTMLDivElement | null = null
  let popupBusy = false

  function ensurePopupLayer(): HTMLDivElement {
    if (popupLayer === null) {
      popupLayer = document.createElement('div')
      popupLayer.id = POPUP_ID
      popupLayer.className = 'dsh-point-popup-layer'
      document.body.appendChild(popupLayer)
    }
    return popupLayer
  }

  function renderPopup(): void {
    const layer = ensurePopupLayer()
    layer.textContent = ''
    if (state.activeIndex === null) return
    const mark = state.marks.find(m => m.index === state.activeIndex)
    if (mark === undefined) {
      deps.openMark(null)
      return
    }

    const container = document.createElement('div')
    container.className = 'dsh-point-popup'

    const header = document.createElement('div')
    header.className = 'dsh-point-popup-header'
    header.textContent = `所指 #${mark.index} · ${mark.source}`

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'dsh-point-popup-close'
    closeBtn.textContent = '×'
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.openMark(null)
    })
    header.appendChild(closeBtn)
    container.appendChild(header)

    const textarea = document.createElement('textarea')
    textarea.className = 'dsh-point-popup-textarea'
    textarea.placeholder = mark.status === 'sent' ? '（已发送，不可编辑）' : '在此写下对所指对象的评论…'
    textarea.value = mark.comment ?? ''
    textarea.disabled = mark.status === 'sent' || popupBusy
    container.appendChild(textarea)

    if (mark.status !== 'sent' && mark.hasExternalImage) {
      const hint = document.createElement('div')
      hint.className = 'dsh-point-popup-hint'
      hint.textContent = '提示：该区域含外部图片，截图可能因跨域策略缺失。'
      container.appendChild(hint)
    }
    if (mark.screenshotError !== undefined) {
      const err = document.createElement('div')
      err.className = 'dsh-point-popup-hint'
      err.textContent = `截图未生成：${mark.screenshotError}。仍可发送纯文本。`
      container.appendChild(err)
    }

    const meta = document.createElement('div')
    meta.className = 'dsh-point-popup-meta'
    meta.textContent = `文本：${mark.text || '（无可见文本）'}`
    container.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'dsh-point-popup-actions'

    const sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'dsh-point-popup-btn primary'
    sendBtn.textContent = '发送'
    sendBtn.disabled = popupBusy || mark.status === 'sent'
    sendBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const comment = textarea.value.trim()
      if (comment === '') {
        const ok = window.confirm('评论为空，确认直接发送所指内容？')
        if (!ok) return
      }
      popupBusy = true
      renderPopup()
      deps.sendMark(mark, comment).then(
        () => {
          popupBusy = false
          deps.updateMark(mark.index, { status: 'sent', comment })
          deps.openMark(null)
        },
        (error: unknown) => {
          popupBusy = false
          renderPopup()
          const reason = error instanceof Error ? error.message : String(error)
          showToast(`发送失败：${reason}。请检查网络或会话状态后重试。`)
        },
      )
    })

    const stageBtn = document.createElement('button')
    stageBtn.type = 'button'
    stageBtn.className = 'dsh-point-popup-btn'
    stageBtn.textContent = '暂存'
    stageBtn.disabled = popupBusy || mark.status === 'sent'
    stageBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.updateMark(mark.index, { status: 'pending', comment: textarea.value.trim() })
      deps.openMark(null)
    })

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'dsh-point-popup-btn danger'
    delBtn.textContent = '删除'
    delBtn.disabled = popupBusy
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      deps.removeMark(mark.index)
      deps.openMark(null)
    })

    if (mark.status !== 'sent') {
      actions.appendChild(sendBtn)
      actions.appendChild(stageBtn)
    }
    actions.appendChild(delBtn)
    container.appendChild(actions)

    layer.appendChild(container)
    repositionPopup()
  }

  function repositionPopup(): void {
    if (popupLayer === null || state.activeIndex === null) return
    const container = popupLayer.querySelector<HTMLElement>('.dsh-point-popup')
    if (container === null) return
    const mark = state.marks.find(m => m.index === state.activeIndex)
    if (mark === undefined) return
    const resolved = resolveMarkElement(mark)
    if (resolved === null) {
      container.style.display = 'none'
      return
    }
    const visible = resolved.el !== null ? resolved.el.isConnected : true
    if (!visible) {
      container.style.display = 'none'
      return
    }
    container.style.display = ''
    const rect = markViewportRect(mark, resolved)
    const pad = 8
    let top = rect.top + rect.height + pad
    let left = rect.left
    const vw = window.innerWidth
    const vh = window.innerHeight
    const bw = container.offsetWidth
    const bh = container.offsetHeight
    if (left + bw > vw) left = Math.max(pad, vw - bw - pad)
    if (top + bh > vh && rect.top - bh - pad > 0) top = rect.top - bh - pad
    container.style.top = `${top + window.scrollY}px`
    container.style.left = `${left + window.scrollX}px`
  }

  function renderCrossNotices(): void {
    if (crossLayer === null) return
    crossLayer.textContent = ''
    if (!state.marking) return
    for (const frame of crossFrames) {
      if (!frame.isConnected) continue
      const notice = document.createElement('div')
      notice.className = 'dsh-point-cross'
      notice.textContent = '⚠ 外部网页预览：浏览器安全策略禁止读取其内部内容，无法在此标记。'
      notice.addEventListener('click', (e) => {
        e.stopPropagation()
        showToast('无法标记此区域：这是一个外部网页（跨源），浏览器禁止读取其内部内容。请改用同源的内联网页或 Office 文档进行标记。')
      })
      crossLayer.appendChild(notice)
    }
    repositionCrossNotices()
  }

  function repositionCrossNotices(): void {
    if (crossLayer === null) return
    const notices = Array.from(crossLayer.children) as HTMLElement[]
    const frames = [...crossFrames].filter(f => f.isConnected)
    notices.forEach((notice, i) => {
      const frame = frames[i]
      if (frame === undefined) { notice.style.display = 'none'; return }
      const r = frame.getBoundingClientRect()
      notice.style.display = ''
      notice.style.left = `${r.left}px`
      notice.style.top = `${r.top}px`
      notice.style.width = `${r.width}px`
    })
  }

  /* ---------- scroll / resize repositioning ---------- */

  function onScrollOrResize(): void {
    if (rafPending || disposed) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      repositionBadges()
      repositionCrossNotices()
      repositionPopup()
    })
  }

  /* ---------- document listeners ---------- */

  function onDocClick(e: MouseEvent): void {
    if (!state.marking) return
    const el = e.target as Element
    if (!el || el.nodeType !== 1) return
    if (el.closest('.dsh-point-badge, .dsh-point-toast, .dsh-point-cross')) return
    if (isInsidePreview(el)) return
    // Allow normal interaction with host controls (header buttons, inputs, etc.)
    // without spamming the hint; only background/panel clicks educate the user.
    if (el.closest('button, a, input, textarea, [role="button"]')) return
    // Host UI click outside the preview panel: be informative, but do not block
    // the underlying UI from processing the event.
    showHint('只能标记预览面板里的内容')
  }

  function onDocMouseDown(e: MouseEvent): void {
    if (!state.marking) return
    startDrag(e, document)
  }

  function onDocMouseMove(e: MouseEvent): void {
    if (!state.marking) return
    updateDrag(e)
  }

  function onDocMouseUp(e: MouseEvent): void {
    if (!state.marking) return
    endDrag(e)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat || e.key !== 'Escape' || !state.marking) return
    if (dragState !== null) {
      dragState = null
      removeDragRect()
      return
    }
    deps.setMarking(false)
  }

  /* ---------- lifecycle ---------- */

  function mount(): void {
    ensureOverlay()
    ensureCrossLayer()
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScrollOrResize, true)
    // 2026-08-24: main-document drag handles main-page and office-container
    // region selection; iframe drag listeners are attached per iframe document.
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('mousemove', onDocMouseMove, true)
    document.addEventListener('mouseup', onDocMouseUp, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    const vv = window.visualViewport
    if (vv !== null && typeof vv !== 'undefined') {
      vv.addEventListener('resize', onScrollOrResize)
      vv.addEventListener('scroll', onScrollOrResize)
    }
    // Re-attach listeners when preview containers/iframes are (re)mounted. The
    // observer must be disconnected on dispose: otherwise a session-scoped
    // controller keeps watching the shared document after unmount, claims newly
    // mounted iframes first, and blocks the live controller's own attachment.
    domObserver = new MutationObserver(() => { syncFrames(); syncOfficeContainers() })
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    syncFrames()
    syncOfficeContainers()
    renderBadges()
    renderCrossNotices()
    // Read-only debug surface for ego-browser verification: expose a summary of
    // captured marks (screenshot lengths, never the raw data URL) so the test
    // can assert the capture pipeline end to end.
    ;(window as unknown as Record<string, unknown>).__dshPoint = {
      getMarkSummary: () => state.marks.map(m => ({
        index: m.index,
        selector: m.selector,
        text: m.text,
        html: m.html,
        source: m.source,
        frameKind: m.frameKind,
        frameTitle: m.frameTitle,
        screenshotLen: m.screenshot.length,
        screenshotError: m.screenshotError,
        hasExternalImage: m.hasExternalImage,
      })),
      isMarking: () => state.marking,
    }
  }

  function dispose(): void {
    disposed = true
    clearHover()
    dragState = null
    removeDragRect()
    delete (window as unknown as Record<string, unknown>).__dshPoint
    document.removeEventListener('click', onDocClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', onScrollOrResize, true)
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('mousemove', onDocMouseMove, true)
    document.removeEventListener('mouseup', onDocMouseUp, true)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
    const vv = window.visualViewport
    if (vv !== null && typeof vv !== 'undefined') {
      vv.removeEventListener('resize', onScrollOrResize)
      vv.removeEventListener('scroll', onScrollOrResize)
    }
    for (const container of [...attachedOffices]) detachOfficeContainer(container)
    if (domObserver !== null) { domObserver.disconnect(); domObserver = null }
    for (const el of keptEls.values()) {
      if (!(el instanceof HTMLElement)) continue
      delete (el as unknown as Record<string, unknown>)[KEPT_FLAG]
      el.style.outline = ''
    }
    keptEls.clear()
    for (const border of regionEls.values()) border.remove()
    regionEls.clear()
    if (overlay !== null) { overlay.remove(); overlay = null }
    if (crossLayer !== null) { crossLayer.remove(); crossLayer = null }
    if (popupLayer !== null) { popupLayer.remove(); popupLayer = null }
  }

  function sync(next: MarkingState): void {
    const marksChanged = next.marks !== state.marks
    const markingChanged = next.marking !== state.marking
    const activeChanged = next.activeIndex !== state.activeIndex
    state = next
    if (markingChanged) {
      document.body.classList.toggle('dsh-point-marking', next.marking)
      if (!next.marking) clearHover()
      renderCrossNotices()
    }
    if (marksChanged) {
      renderBadges()
    }
    if (activeChanged || marksChanged) {
      renderPopup()
    }
    repositionPopup()
  }

  return { mount, dispose, sync }
}

/* ---------- injected styles ---------- */

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
body.dsh-point-marking { cursor: not-allowed; }
body.dsh-point-marking div[data-office],
body.dsh-point-marking iframe[data-testid="web-preview-frame"] { cursor: crosshair; }
body.dsh-point-marking .dsh-point-badge,
body.dsh-point-marking .dsh-point-cross { cursor: pointer; }
.dsh-point-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
}
.dsh-point-badge {
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
  cursor: pointer;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.dsh-point-badge:hover { background: #1d4ed8; }
.dsh-point-cross {
  position: absolute;
  pointer-events: auto;
  padding: 8px 10px;
  background: rgba(31, 35, 40, 0.85);
  color: #fff;
  font: 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-point-toast {
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
.dsh-point-popup-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483002;
}
.dsh-point-popup {
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
}
.dsh-point-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: #f3f4f6;
  font-weight: 600;
}
.dsh-point-popup-close {
  border: none;
  background: transparent;
  font: 18px/1 sans-serif;
  color: #6b7280;
  cursor: pointer;
}
.dsh-point-popup-textarea {
  width: 100%;
  min-height: 72px;
  padding: 10px 12px;
  border: none;
  border-bottom: 1px solid #e5e7eb;
  resize: vertical;
  font: inherit;
  outline: none;
}
.dsh-point-popup-textarea:disabled { background: #f9fafb; color: #6b7280; }
.dsh-point-popup-hint {
  padding: 6px 12px;
  font-size: 12px;
  color: #b45309;
  background: #fffbeb;
}
.dsh-point-popup-meta {
  padding: 8px 12px;
  font-size: 12px;
  color: #4b5563;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-point-popup-actions {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  justify-content: flex-end;
  border-top: 1px solid #e5e7eb;
}
.dsh-point-popup-btn {
  padding: 5px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  cursor: pointer;
  font: inherit;
}
.dsh-point-popup-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-point-popup-btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
.dsh-point-popup-btn.danger { color: #dc2626; border-color: #fca5a5; }
.dsh-point-badge.pending { background: #d97706; }
.dsh-point-badge.sent { background: #6b7280; }
.dsh-point-badge.sent::after { content: '✓'; margin-left: 2px; }
.dsh-point-region-rect {
  position: absolute;
  border: 2px dashed #2563eb;
  background: rgba(37, 99, 235, 0.08);
  pointer-events: none;
  z-index: 2147483000;
}
.dsh-point-region-kept {
  position: absolute;
  border: 2px dashed #2563eb;
  background: rgba(37, 99, 235, 0.04);
  pointer-events: none;
  z-index: 2147482999;
}
`
  document.head.appendChild(style)
}

// TypeScript declarations for the transient flags written onto DOM elements.
declare global {
  interface HTMLIFrameElement {
    __dshPointAttached?: boolean
    __dshPointCrossOrigin?: boolean
  }
}
