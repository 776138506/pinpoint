/**
 * Single source of truth for the dsh-point referent message format.
 *
 * A referent message carries a machine-readable JSON block inside a Markdown
 * fenced code block plus a short Chinese human summary. Both the browser
 * extension (sender) and the dsh client plugin (renderer) consume these helpers.
 */

/** Version token for the v1 referent schema. */
export const REFERENT_VERSION = 'dsh-point/referent@1'

/** Source location of a captured element. */
export interface ReferentSource {
  /** Page URL when available. */
  url?: string
  /** Page or frame title when available. */
  title?: string
}

/** Machine-readable body of one referent message. */
export interface ReferentPayload {
  /** Schema version; parsed messages must exactly match {@link REFERENT_VERSION}. */
  version: string
  /** Where the marked element lives. */
  source: ReferentSource
  /** CSS selector path captured at mark time. */
  selector: string
  /** Visible text excerpt from the marked element. */
  quote: string
  /** User-written comment about the referent. */
  comment: string
  /** 1-based monotonic index assigned by the marker. */
  index: number
  /** ISO-8601 instant when the mark was sent. */
  sentAt: string
  /** Precision anchors for relocating the referent without back-and-forth. */
  anchor?: ReferentAnchor
}

/**
 * Precision anchors captured at mark time (2026-08-20).
 * 多通道冗余：坐标（人看截图对应区域）、XPath（与 CSS selector 互补的重定位）、
 * 文本锚（拼 URL 直接滚动高亮）、代码位置（代码托管页面的文件+行号）。
 * 全部可选，拿不到的通道不生成。
 */
export interface ReferentAnchor {
  /** 文档坐标系矩形（CSS px，相对文档左上角）。 */
  rect?: { x: number; y: number; width: number; height: number }
  /** XPath 绝对路径。 */
  xpath?: string
  /** Text Fragments 锚体（text=开头,结尾），拼为 url#:~:text=… 直接定位。 */
  textFragment?: string
  /** 代码位置（尽力识别，仅代码托管/编辑器类页面有值）。 */
  code?: { file?: string; lineStart?: number }
}

/** Minimal input shape accepted by {@link formatMark}. */
export interface MarkLike {
  index: number
  selector: string
  text: string
  /** Legacy source label kept for backward compatibility. */
  source?: string
  sourceUrl?: string
  sourceTitle?: string
  time?: string
  anchor?: ReferentAnchor
}

const FENCED_JSON_RE = /^```(?:json)?\n([\s\S]*?)\n```$/m
const FENCED_JSON_RE_G = new RegExp(FENCED_JSON_RE.source, 'gm')

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Strip control characters, escape HTML metacharacters, and collapse whitespace to a single line. */
function sanitizeSummary(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
    .replace(/\s+/g, ' ')
    .trim()
}

function formatSourceLabel(source: ReferentSource): string {
  if (!source.title && !source.url) return ''
  const titlePart = source.title ?? ''
  const urlPart = source.url ? `（${source.url}）` : ''
  return `来源：${titlePart}${urlPart}`.trimEnd()
}

/**
 * Serialize one mark into the model-visible referent text.
 * @param mark - captured referent data.
 * @param comment - user-written comment.
 * @returns text containing a fenced JSON block plus a Chinese summary.
 */
export function formatMark(mark: MarkLike, comment: string): string {
  const source: ReferentSource = {
    url: mark.sourceUrl ?? '',
    title: mark.sourceTitle ?? mark.source ?? '',
  }
  const payload: ReferentPayload = {
    version: REFERENT_VERSION,
    source,
    selector: mark.selector,
    quote: mark.text,
    comment,
    index: mark.index,
    sentAt: mark.time ?? new Date().toISOString(),
  }
  if (mark.anchor && Object.values(mark.anchor).some(v => v !== undefined)) {
    payload.anchor = mark.anchor
  }

  const lines: string[] = []
  lines.push(`[所指 #${payload.index}]`)
  lines.push('```json')
  // Encode backticks as \u0060 so user content cannot terminate the Markdown fence.
  lines.push(JSON.stringify(payload, null, 2).replace(/`/g, '\\u0060'))
  lines.push('```')

  const summaryParts: string[] = []
  const sourceLabel = formatSourceLabel({
    url: sanitizeSummary(source.url ?? ''),
    title: sanitizeSummary(source.title ?? ''),
  })
  if (sourceLabel) summaryParts.push(sourceLabel)
  if (payload.selector) summaryParts.push(`选择器：${sanitizeSummary(payload.selector)}`)
  if (payload.quote) summaryParts.push(`文本摘录：${sanitizeSummary(payload.quote)}`)
  // 精准定位行进摘要：代码位置优先（最有区分度），其次可点击的文本锚链接，再次文档坐标
  const anchor = payload.anchor
  if (anchor?.code && (anchor.code.file || anchor.code.lineStart)) {
    const file = anchor.code.file ?? ''
    const line = anchor.code.lineStart ? `:L${anchor.code.lineStart}` : ''
    summaryParts.push(`代码位置：${sanitizeSummary(file + line)}`)
  }
  if (anchor?.textFragment && source.url) {
    summaryParts.push(`定位：${sanitizeSummary(`${source.url}#:~:${anchor.textFragment}`)}`)
  } else if (anchor?.rect) {
    summaryParts.push(`坐标：(${anchor.rect.x}, ${anchor.rect.y}) ${anchor.rect.width}×${anchor.rect.height}`)
  }
  if (payload.comment) summaryParts.push(`评论：${sanitizeSummary(payload.comment)}`)
  if (summaryParts.length > 0) {
    lines.push('')
    lines.push(summaryParts.join(' · '))
  }

  return lines.join('\n')
}

/**
 * Parse the first fenced JSON block in a text payload.
 * @param text - message text candidate.
 * @returns the parsed referent payload, or null when the text is not a referent.
 */
export function parseMarkText(text: string): ReferentPayload | null {
  const match = FENCED_JSON_RE.exec(text)
  if (match === null) return null
  return parseBlock(match[1])
}

/**
 * Extract every referent payload embedded in a text payload.
 * Useful when several marks are concatenated into one message.
 * @param text - message text candidate.
 * @returns all successfully parsed referent payloads, in document order.
 */
export function extractReferents(text: string): ReferentPayload[] {
  const results: ReferentPayload[] = []
  for (const match of text.matchAll(FENCED_JSON_RE_G)) {
    const parsed = parseBlock(match[1])
    if (parsed !== null) results.push(parsed)
  }
  return results
}

/**
 * Parse a raw JSON string into a {@link ReferentPayload}.
 * Missing fields are tolerated and filled with type defaults, matching the
 * v1 contract used by the browser extension sender.
 */
function parseBlock(json: string): ReferentPayload | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const p = parsed as Record<string, unknown>
    if (p.version !== REFERENT_VERSION) return null
    const source = typeof p.source === 'object' && p.source !== null
      ? (p.source as Record<string, unknown>)
      : {}
    const anchor = typeof p.anchor === 'object' && p.anchor !== null
      ? (p.anchor as ReferentAnchor)
      : undefined
    return {
      version: String(p.version),
      source: {
        url: typeof source.url === 'string' ? source.url : '',
        title: typeof source.title === 'string' ? source.title : '',
      },
      selector: typeof p.selector === 'string' ? p.selector : '',
      quote: typeof p.quote === 'string' ? p.quote : '',
      comment: typeof p.comment === 'string' ? p.comment : '',
      index: typeof p.index === 'number' ? p.index : 0,
      sentAt: typeof p.sentAt === 'string' ? p.sentAt : '',
      ...(anchor ? { anchor } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse error'
    console.warn('[dsh-point/referent] parseBlock: invalid referent JSON', message)
    return null
  }
}
