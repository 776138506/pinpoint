/**
 * Minimal-invasive renderer for dsh-point referent messages inside dsh chat.
 *
 * dsh's `conversation.chat.node` keyed slot has no child hole for message body
 * content, so this module enhances the already-rendered DOM: it watches for
 * user/steering message rows whose text contains a dsh-point referent block,
 * then replaces the raw text bubble with a structured card that reuses the
 * host-rendered screenshot gallery.
 *
 * ponytail: this is a deliberate DOM-side fallback. It depends on the current
 * UserStyleBubble structure (bubble div inside a flex column userStack). If
 * that structure changes, the card will degrade to the plain text fallback.
 */

import { extractReferents, parseMarkText } from '../schema/mark-format.ts'
import type { ReferentPayload } from '../schema/mark-format.ts'

const PROCESSED_ATTR = 'data-dsh-point-card-processed'
const KINDS = new Set(['user', 'steering'])
const MARKER = '[所指 #'

let mounted = false
let observer: MutationObserver | null = null

/** Inject the card stylesheet exactly once. */
function ensureStyles(): void {
  if (document.getElementById('dsh-point-referent-card-styles') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-point-referent-card-styles'
  style.textContent = `
    .dsh-point-referent-cards {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      max-width: 100%;
    }
    .dsh-point-referent-card {
      max-width: min(525px, 82vw);
      background: var(--dsw-specific-bubble, #f3f4f6);
      border: 1px solid var(--dsw-alias-separator, #e5e7eb);
      border-radius: 16px;
      color: var(--dsw-alias-label-primary, #1f2328);
      font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    }
    .dsh-point-referent-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--dsw-alias-separator, #e5e7eb);
      font-weight: 600;
      color: #2563eb;
      background: rgba(37, 99, 235, 0.06);
    }
    .dsh-point-referent-thumb {
      display: flex;
      align-items: center;
      justify-content: center;
      max-height: 240px;
      overflow: hidden;
      background: #f9fafb;
    }
    .dsh-point-referent-thumb img {
      max-width: 100%;
      max-height: 240px;
      object-fit: contain;
    }
    .dsh-point-referent-thumb:empty { display: none; }
    .dsh-point-referent-meta {
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .dsh-point-referent-row {
      word-break: break-all;
    }
    .dsh-point-referent-label {
      color: #6b7280;
      font-size: 12px;
      margin-right: 4px;
    }
    .dsh-point-referent-source a {
      color: #2563eb;
      text-decoration: none;
    }
    .dsh-point-referent-footer {
      padding: 0 12px 8px;
      font-size: 11px;
      color: #9ca3af;
      text-align: right;
    }
  `
  document.head.appendChild(style)
}

/** Build a structured card DOM for one referent payload. */
function buildCard(payload: ReferentPayload): HTMLElement {
  const card = document.createElement('div')
  card.className = 'dsh-point-referent-card'

  const header = document.createElement('div')
  header.className = 'dsh-point-referent-header'
  header.textContent = `所指 #${payload.index}`
  card.appendChild(header)

  const thumb = document.createElement('div')
  thumb.className = 'dsh-point-referent-thumb'
  card.appendChild(thumb)

  const meta = document.createElement('div')
  meta.className = 'dsh-point-referent-meta'

  const row = (label: string, content: string | HTMLElement, cls?: string): void => {
    const wrap = document.createElement('div')
    wrap.className = `dsh-point-referent-row${cls ? ` ${cls}` : ''}`
    const lab = document.createElement('span')
    lab.className = 'dsh-point-referent-label'
    lab.textContent = label
    wrap.appendChild(lab)
    if (typeof content === 'string') {
      wrap.appendChild(document.createTextNode(content))
    } else {
      wrap.appendChild(content)
    }
    meta.appendChild(wrap)
  }

  if (payload.source.title || payload.source.url) {
    // 2026-08-24: the URL comes from message content — only http(s) may become
    // a link; javascript:/data: and unparseable values render as plain text.
    let safeUrl: string | null = null
    if (payload.source.url) {
      try {
        const u = new URL(payload.source.url)
        if (u.protocol === 'http:' || u.protocol === 'https:') safeUrl = payload.source.url
      } catch {
        safeUrl = null
      }
    }
    if (safeUrl !== null) {
      const link = document.createElement('a')
      link.href = safeUrl
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.title = safeUrl
      link.textContent = payload.source.title || safeUrl
      row('来源：', link, 'dsh-point-referent-source')
    } else {
      row('来源：', payload.source.title || payload.source.url!, 'dsh-point-referent-source')
    }
  }
  if (payload.selector) row('选择器：', payload.selector)
  if (payload.quote) row('文本摘录：', payload.quote)
  if (payload.comment) row('评论：', payload.comment)
  card.appendChild(meta)

  if (payload.sentAt) {
    const footer = document.createElement('div')
    footer.className = 'dsh-point-referent-footer'
    try {
      footer.textContent = new Date(payload.sentAt).toLocaleString('zh-CN')
    } catch {
      footer.textContent = payload.sentAt
    }
    card.appendChild(footer)
  }

  return card
}

/** Locate the text bubble element inside a message container. */
function findBubble(messageContainer: Element): Element | null {
  let deepest: Element | null = null
  function walk(el: Element): void {
    if (!el.textContent?.includes(MARKER)) return
    deepest = el
    for (const child of el.children) walk(child)
  }
  for (const child of messageContainer.children) walk(child)
  if (deepest === null) return null

  // Walk back up to the bubble container. The bubble div has a large border
  // radius (22px in the current dsh design); this is the most stable signal
  // for the text container without depending on hashed CSS-module class names.
  let el: Element | null = deepest
  while (el !== null && el !== messageContainer) {
    const style = window.getComputedStyle(el)
    const radius = parseFloat(style.borderRadius)
    if (radius >= 12) return el
    el = el.parentElement as Element | null
  }
  return null
}

/** Transform one chat message row if it carries a referent payload. */
function processMessage(messageContainer: Element): void {
  if (messageContainer.hasAttribute(PROCESSED_ATTR)) return
  const kind = messageContainer.getAttribute('data-chat-flow-kind')
  if (!kind || !KINDS.has(kind)) return

  const bubble = findBubble(messageContainer)
  if (bubble === null) return

  const text = bubble.textContent ?? ''
  const payloads = extractReferents(text)
  if (payloads.length === 0) return

  messageContainer.setAttribute(PROCESSED_ATTR, 'true')

  const stack = bubble.parentElement
  const gallery = bubble.previousElementSibling

  const cards = document.createElement('div')
  cards.className = 'dsh-point-referent-cards'
  for (let i = 0; i < payloads.length; i += 1) {
    const card = buildCard(payloads[i])
    if (i === 0 && gallery !== null) {
      const thumb = card.querySelector('.dsh-point-referent-thumb')
      if (thumb !== null) thumb.appendChild(gallery)
    }
    cards.appendChild(card)
  }

  if (stack !== null) {
    stack.replaceChild(cards, bubble)
  } else {
    bubble.parentNode?.insertBefore(cards, bubble)
    bubble.remove()
  }
}

/** Scan a node and its descendants for chat message rows. */
function scanNode(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  if (el.matches?.('[data-chat-flow-kind]')) {
    processMessage(el)
    return
  }
  for (const child of el.querySelectorAll('[data-chat-flow-kind]')) {
    processMessage(child)
  }
}

/** Mount the DOM enhancer. Idempotent. */
export function mountReferentCardEnhancer(): () => void {
  if (mounted) return () => {}
  mounted = true
  ensureStyles()

  const target = document.body || document.documentElement
  scanNode(target)

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) scanNode(node)
    }
  })
  observer.observe(target, { childList: true, subtree: true })

  return () => {
    observer?.disconnect()
    observer = null
    mounted = false
  }
}

/** Convenience: parse one referent from a text string (exported for tests). */
export { parseMarkText }
