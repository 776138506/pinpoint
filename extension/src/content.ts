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
import { BUILTIN_SHORTCUT, comboFromEvent } from './shortcut.ts'
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type ExtSettings } from './settings.ts'
import type { Mark, MarkStatus } from '../../src/client/stores.ts'

const STYLE_ID = 'dsh-point-ext-style'
const OVERLAY_ID = 'dsh-point-ext-overlay'
const POPUP_LAYER_ID = 'dsh-point-ext-popup-layer'
const KEPT_FLAG = '__dshPointExtKept'
const HOVER_OUTLINE = '2px solid #ff2d55'
const KEPT_OUTLINE = '2px solid #2563eb'

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
let lastHintAt = 0
let captureInFlight = false

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
const OWN_UI_SELECTOR = '.dsh-point-ext-overlay, .dsh-point-ext-badge, .dsh-point-ext-popup-layer, .dsh-point-ext-popup, .dsh-point-ext-toast'

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
  const rec = el as HTMLElement & { __dshPointExtOrigOutline?: string }
  if ((el as unknown as Record<string, unknown>)[KEPT_FLAG]) {
    delete rec.__dshPointExtOrigOutline
    rec.style.outline = KEPT_OUTLINE
    rec.style.outlineOffset = '1px'
    return
  }
  if (rec.__dshPointExtOrigOutline !== undefined) {
    rec.style.outline = rec.__dshPointExtOrigOutline
    delete rec.__dshPointExtOrigOutline
  } else {
    rec.style.outline = ''
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
  if (!state.marking) return
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

function onClick(e: MouseEvent): void {
  if (!chrome.runtime?.id) return // 同上：失效旧实例静默
  if (!state.marking) return
  const el = e.target as Element
  if (!el || el.nodeType !== 1) return
  if ((el as Element).closest(OWN_UI_SELECTOR)) return
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
  if (e.key === 'Escape' && state.marking) {
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
    repositionBadges()
    repositionPopup()
  })
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
    const staged: Mark = { ...draft, comment, status: 'pending' }
    updateMark(draft.index, { comment, status: 'pending' })
    chrome.runtime.sendMessage({ type: 'STAGE_MARK', mark: staged, sendNow: false })
      .catch((e) => console.error('[dsh-point-ext] auto-stage failed:', e))
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
    mark.screenshot = canvas.toDataURL('image/png')
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[dsh-point-ext] screenshot failed:', e)
    mark.screenshotError = reason
    showToast(`截图失败：${reason}。仍可发送纯文本所指。`)
  } finally {
    prepared.cleanup()
  }

  addMark(mark)
  openMark(mark.index)

  if (mark.hasExternalImage) {
    showToast('提示：该区域含外部图片，若截图中缺图，是图片服务器未允许跨域加载。')
  }
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

function setMarking(on: boolean): void {
  // 2026-08-21: 退出标记态也要了结草稿（Esc/快捷键/侧栏按钮路径）——
  // 不变量「页面高亮 ⇔ 暂存区有记录」对退出路径同样成立，否则孤儿高亮长期残留
  if (!on) {
    settleDraft()
    if (state.activeIndex !== null) openMark(null)
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
  setState({ ...state, marks: [], activeIndex: null, nextIndex: 1 })
}

function openMark(index: number | null): void {
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
    if (!wanted.has(index)) badge.remove()
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
        openMark(state.activeIndex === mark.index ? null : mark.index)
      })
      layer.appendChild(badge)
    }
    badge.classList.toggle('sent', mark.status === 'sent')
    badge.classList.toggle('pending', mark.status === 'pending')
    badge.title = mark.status === 'sent' ? '已发送' : '点击打开评论'
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
  repositionBadges()
}

function repositionBadges(): void {
  if (overlay === null) return
  for (const mark of state.marks) {
    const badge = overlay.querySelector<HTMLElement>(`.dsh-point-ext-badge[data-index="${mark.index}"]`)
    if (badge === null) continue
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
function focusMark(index: number): { ok: boolean; error?: string } {
  const mark = state.marks.find(m => m.index === index)
  if (!mark) return { ok: false, error: '页面上不存在该标记（可能已删除或页面已刷新）' }
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
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
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

/* ---------- popup ---------- */

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
  layer.textContent = ''
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
    // 2026-08-21: 草稿态（未暂存/未发送）关闭评论窗 = 放弃该标记，
    // 否则页面留孤儿高亮而暂存区无记录，再点同元素还会重复捕获
    if (mark.status === 'draft') removeMark(mark.index)
    else openMark(null)
  })
  header.appendChild(closeBtn)
  container.appendChild(header)

  const textarea = document.createElement('textarea')
  textarea.className = 'dsh-point-ext-popup-textarea'
  textarea.placeholder = mark.status === 'sent' ? '（已发送）' : '在此写下对所指对象的评论…'
  textarea.value = mark.comment ?? ''
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
      const staged: Mark = { ...mark, comment, status: 'pending' }
      updateMark(mark.index, { comment, status: 'pending' })
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
      })
    })

    const stageBtn = document.createElement('button')
    stageBtn.type = 'button'
    stageBtn.className = 'dsh-point-ext-popup-btn'
    stageBtn.textContent = '暂存'
    stageBtn.disabled = popupBusy
    stageBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const staged: Mark = { ...mark, comment: textarea.value.trim(), status: 'pending' }
      chrome.runtime.sendMessage({ type: 'STAGE_MARK', mark: staged, sendNow: false })
        .then(() => {
          updateMark(mark.index, { comment: staged.comment, status: 'pending' })
          openMark(null)
        })
        .catch((err) => {
          console.error('[dsh-point-ext] stage failed:', err)
          showToast(`暂存失败：${err?.message || '未知错误'}。请重试。`)
        })
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
  const el = resolveElement(mark)
  if (el === null || !el.isConnected) {
    container.style.display = 'none'
    return
  }
  container.style.display = ''
  const r = el.getBoundingClientRect()
  const pad = 8
  let top = r.bottom + pad
  let left = r.left
  const vw = window.innerWidth
  const vh = window.innerHeight
  const bw = container.offsetWidth
  const bh = container.offsetHeight
  if (left + bw > vw) left = Math.max(pad, vw - bw - pad)
  if (top + bh > vh && r.top - bh - pad > 0) top = r.top - bh - pad
  container.style.top = `${top + window.scrollY}px`
  container.style.left = `${left + window.scrollX}px`
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
}
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
`
  document.head.appendChild(style)
}

/* ---------- messaging ---------- */

function mount(): void {
  // 2026-08-21: 扩展重载后按需注入的新实例会撞见旧实例残留 DOM（角标/弹窗层，同 id）。
  // mount 时清掉，避免双 overlay 与僵尸角标。ponytail: 旧实例留在元素上的内联 outline
  // 无法枚举（JS 属性不可查询），随页面刷新自然消失，不另做清理
  for (const stale of document.querySelectorAll('.dsh-point-ext-overlay, .dsh-point-ext-popup-layer, .dsh-point-ext-toast')) {
    stale.remove()
  }
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout', onMouseOut, true)
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
