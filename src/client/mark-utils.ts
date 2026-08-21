/**
 * Pure, DOM-only helpers shared between the dsh client plugin marking engine
 * (`engine.ts`) and the browser extension content script. No React, no Cordis,
 * no extension APIs — just element → structured referent + screenshot.
 */

/** CSS selector path from an element up to (but excluding) BODY/HTML. */
export function cssPath(el: Element): string {
  if (!el || el.nodeType !== 1) return ''
  if (el.id) return '#' + CSS.escape(el.id)
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    if (cur.id) {
      parts.unshift('#' + CSS.escape(cur.id))
      break
    }
    let sel = cur.tagName.toLowerCase()
    const parent = cur.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter(c => c.tagName === cur!.tagName)
      if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
    }
    parts.unshift(sel)
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

/** Best-effort visible text for an element, truncated to 200 chars. */
export function visibleText(el: Element): string {
  let t = ''
  if ('innerText' in el) t = (el as HTMLElement).innerText ?? ''
  if (!t && el.textContent) t = el.textContent
  if (!t && el.getAttribute) {
    t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('src') || ''
  }
  return (t || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Collapse whitespace and truncate an HTML snippet. */
export function snippet(html: string, n = 2000): string {
  const s = (html || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + ' …' : s
}

/** True when the element subtree has an http(s) image (html2canvas may drop it). */
export function detectExternalImages(el: Element): boolean {
  const imgs: Element[] = []
  if (el.tagName === 'IMG') imgs.push(el)
  imgs.push(...Array.from(el.querySelectorAll('img')))
  return imgs.some(img => /^https?:\/\//i.test(img.getAttribute('src') || ''))
}

/**
 * Clone an element for screenshotting outside of its original document context.
 * html2canvas can struggle with same-origin iframe elements or flex/grid
 * ancestors, so we copy the subtree and inline computed styles into a hidden
 * top-level container and capture the clone instead.
 */
export function cloneForScreenshot(el: Element): { clone: HTMLElement; cleanup: () => void } {
  const clone = el.cloneNode(true) as HTMLElement
  const win = el.ownerDocument.defaultView
  if (win) {
    const w = win
    function inline(src: Element, dst: Element) {
      const computed = w.getComputedStyle(src)
      const target = dst as HTMLElement
      target.style.cssText = computed.cssText
      // Force block layout so the clone has non-zero dimensions even when the
      // original is inline or inside a flex/grid context that does not survive.
      if (computed.display === 'inline') target.style.display = 'inline-block'
    }
    function walk(src: Element, dst: Element) {
      inline(src, dst)
      for (let i = 0; i < src.children.length; i += 1) {
        walk(src.children[i], dst.children[i])
      }
    }
    walk(el, clone)
  }

  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-9999px'
  host.style.top = '0'
  host.style.opacity = '0'
  host.style.pointerEvents = 'none'
  host.appendChild(clone)
  document.body.appendChild(host)

  return { clone, cleanup: () => host.remove() }
}

/* ---------- precision anchors（2026-08-20：所指精准定位，避免接收方反复查找） ---------- */

/** 元素在文档坐标系中的矩形（CSS px，相对文档左上角，整数）。 */
export function documentRectOf(el: Element): { x: number; y: number; width: number; height: number } | undefined {
  if (!el || el.nodeType !== 1) return undefined
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return undefined
  return {
    x: Math.round(r.left + window.scrollX),
    y: Math.round(r.top + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

/** XPath 绝对路径（/html[1]/body[1]/div[2]/…），与 CSS selector 互补的重定位手段。 */
export function xpathFor(el: Element): string {
  if (!el || el.nodeType !== 1) return ''
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase()
    const parent: Element | null = cur.parentElement
    if (!parent) {
      parts.unshift(`${tag}[1]`)
      break
    }
    const sameTag = Array.from(parent.children).filter(c => c.tagName === cur!.tagName)
    parts.unshift(sameTag.length > 1 ? `${tag}[${sameTag.indexOf(cur) + 1}]` : `${tag}[1]`)
    cur = parent
  }
  return '/' + parts.join('/')
}

/**
 * Chrome Text Fragments 锚（https://wicg.github.io/scroll-to-text-fragment/）。
 * 拼到 URL 后即可直接滚动定位并高亮：url#:~:text=开头,结尾。
 * 文本太短（<6 字符）时不生成——锚没有区分度。
 */
export function textFragmentFor(el: Element): string | undefined {
  const raw = visibleText(el)
  if (raw.length < 6) return undefined
  const enc = (s: string) => encodeURIComponent(s.replace(/[-,%.]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')))
  const start = raw.slice(0, 40)
  const end = raw.length > 40 ? raw.slice(-40) : ''
  return end ? `text=${enc(start)},${enc(end)}` : `text=${enc(start)}`
}

/**
 * 代码位置的尽力识别：文件路径取自 GitHub/GitLab 风格的 /blob/<ref>/<path> URL，
 * 行号取自最近的 data-line-number 属性或 id="L12"/"LC12" 形式的祖先/自身。
 * 非代码页面返回 undefined，不生成噪音字段。
 */
export function codeLocationFor(el: Element): { file?: string; lineStart?: number } | undefined {
  let file: string | undefined
  const m = /\/(?:blob|raw)\/[^/]+\/(.+)$/.exec(location.pathname)
  if (m) {
    try { file = decodeURIComponent(m[1]) } catch { file = m[1] }
  }
  let lineStart: number | undefined
  const byAttr = el.closest('[data-line-number]')
  if (byAttr) {
    const n = Number(byAttr.getAttribute('data-line-number'))
    if (Number.isFinite(n) && n > 0) lineStart = n
  }
  if (lineStart === undefined) {
    let cur: Element | null = el
    for (let depth = 0; cur && depth < 6; depth += 1, cur = cur.parentElement) {
      const idm = /^L(?:C)?(\d+)$/.exec(cur.id || '')
      if (idm) { lineStart = Number(idm[1]); break }
      // GitHub 新 React 代码视图的行号单元格
      const cell = cur.querySelector?.(':scope > [id^="L"], :scope > [data-line-number]')
      if (cell) {
        const cid = /^L(?:C)?(\d+)$/.exec(cell.id || '')
        const cattr = cell.getAttribute?.('data-line-number')
        const n = cid ? Number(cid[1]) : Number(cattr)
        if (Number.isFinite(n) && n > 0) { lineStart = n; break }
      }
    }
  }
  if (!file && lineStart === undefined) return undefined
  return { file, lineStart }
}
