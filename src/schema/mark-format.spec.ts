import { describe, it, expect, vi } from 'vitest'
import { formatMark, parseMarkText, extractReferents, REFERENT_VERSION } from './mark-format.ts'

function sampleMark(overrides?: Partial<Parameters<typeof formatMark>[0]>): Parameters<typeof formatMark>[0] {
  return {
    index: 1,
    selector: 'body > div:nth-of-type(2) > p',
    text: 'Hello world',
    source: '页面',
    sourceUrl: 'https://example.com/page',
    sourceTitle: 'Example Page',
    time: '2026-08-20T08:48:45.719Z',
    ...overrides,
  }
}

describe('formatMark / parseMarkText round-trip', () => {
  it('produces a fenced JSON block and parses back identical fields', () => {
    const text = formatMark(sampleMark(), 'Looks wrong')
    expect(text).toContain('[所指 #1]')
    expect(text).toContain('```json')
    expect(text).toContain('Example Page（https://example.com/page）')

    const parsed = parseMarkText(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(REFERENT_VERSION)
    expect(parsed!.index).toBe(1)
    expect(parsed!.source.title).toBe('Example Page')
    expect(parsed!.source.url).toBe('https://example.com/page')
    expect(parsed!.selector).toBe('body > div:nth-of-type(2) > p')
    expect(parsed!.quote).toBe('Hello world')
    expect(parsed!.comment).toBe('Looks wrong')
    expect(parsed!.sentAt).toBe('2026-08-20T08:48:45.719Z')
  })

  it('fills in defaults for missing optional fields', () => {
    const text = formatMark({ index: 2, selector: '', text: '' }, '')
    const parsed = parseMarkText(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.version).toBe(REFERENT_VERSION)
    expect(parsed!.index).toBe(2)
    expect(parsed!.source.url).toBe('')
    expect(parsed!.source.title).toBe('')
    expect(parsed!.selector).toBe('')
    expect(parsed!.quote).toBe('')
    expect(parsed!.comment).toBe('')
    expect(parsed!.sentAt).toMatch(/^\d{4}-/)
  })

  it('falls back to legacy source label when URL/title are absent', () => {
    const text = formatMark(sampleMark({ sourceUrl: undefined, sourceTitle: undefined }), '')
    expect(text).toContain('来源：页面')
    const parsed = parseMarkText(text)
    expect(parsed!.source.title).toBe('页面')
  })

  it('escapes HTML metacharacters in the human summary but keeps raw values in JSON', () => {
    const text = formatMark(
      sampleMark({ selector: 'body > div', text: '<script>alert(1)</script>' }),
      'x < y'
    )
    // Human-readable summary is escaped.
    expect(text).toContain('选择器：body &gt; div')
    expect(text).toContain('文本摘录：&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(text).toContain('评论：x &lt; y')
    // JSON block keeps the raw selector for machine consumption.
    const parsed = parseMarkText(text)
    expect(parsed!.selector).toBe('body > div')
    expect(parsed!.quote).toBe('<script>alert(1)</script>')
    expect(parsed!.comment).toBe('x < y')
  })

  it('encodes backticks in JSON so user content cannot break the Markdown fence', () => {
    const text = formatMark(sampleMark({ text: 'run ```rm -rf /``` now' }), '')
    expect(text).toContain('run \\u0060\\u0060\\u0060rm -rf /\\u0060\\u0060\\u0060 now')
    const parsed = parseMarkText(text)
    expect(parsed!.quote).toBe('run ```rm -rf /``` now')
  })
})

describe('parseMarkText tolerance', () => {
  it('returns null for plain user text', () => {
    expect(parseMarkText('Hello, how are you?')).toBeNull()
  })

  it('returns null for fenced JSON that is not a referent', () => {
    expect(parseMarkText('```json\n{"version":"other"}\n```')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseMarkText('[所指 #1]\n```json\n{not json}\n```')).toBeNull()
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('tolerates missing fields inside a valid referent block', () => {
    const text = '```json\n{"version":"' + REFERENT_VERSION + '"}\n```'
    const parsed = parseMarkText(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.selector).toBe('')
  })
})

describe('precision anchors', () => {
  const anchor = {
    rect: { x: 120, y: 480, width: 640, height: 48 },
    xpath: '/html[1]/body[1]/div[2]/pre[1]',
    textFragment: 'text=Hello%20world',
    code: { file: 'src/main.ts', lineStart: 42 },
  }

  it('round-trips the anchor through format/parse and surfaces it in the summary', () => {
    const text = formatMark(sampleMark({ anchor }), 'fix this line')
    expect(text).toContain('代码位置：src/main.ts:L42')
    expect(text).toContain('定位：https://example.com/page#:~:text=Hello%20world')
    const parsed = parseMarkText(text)
    expect(parsed!.anchor).toEqual(anchor)
  })

  it('omits the anchor field when all channels are empty', () => {
    const text = formatMark(sampleMark({ anchor: {} }), '')
    expect(text).not.toContain('"anchor"')
    const parsed = parseMarkText(text)
    expect(parsed!.anchor).toBeUndefined()
  })

  it('falls back to coordinates when no text fragment is available', () => {
    const text = formatMark(sampleMark({ anchor: { rect: anchor.rect } }), '')
    expect(text).toContain('坐标：(120, 480) 640×48')
  })
})

describe('extractReferents', () => {
  it('pulls multiple referent payloads from one message', () => {
    const a = formatMark(sampleMark({ index: 1, text: 'First' }), 'one')
    const b = formatMark(sampleMark({ index: 2, text: 'Second' }), 'two')
    const combined = `${a}\n\n${b}`
    const refs = extractReferents(combined)
    expect(refs).toHaveLength(2)
    expect(refs[0].index).toBe(1)
    expect(refs[1].index).toBe(2)
  })

  it('returns an empty array when no fenced block exists', () => {
    expect(extractReferents('plain text without fence')).toEqual([])
    expect(extractReferents('')).toEqual([])
  })

  it('skips malformed fenced JSON and keeps valid ones', () => {
    const valid = formatMark(sampleMark({ index: 1 }), 'ok')
    const combined = '```json\n{not json}\n```\n\n' + valid
    const refs = extractReferents(combined)
    expect(refs).toHaveLength(1)
    expect(refs[0].index).toBe(1)
  })

  it('preserves duplicate payloads in document order', () => {
    const a = formatMark(sampleMark({ index: 1, text: 'Same' }), '')
    const refs = extractReferents(`${a}\n\n${a}`)
    expect(refs).toHaveLength(2)
    expect(refs[0].index).toBe(1)
    expect(refs[1].index).toBe(1)
    expect(refs[0]).toEqual(refs[1])
  })

  it('keeps an empty anchor object when present in JSON', () => {
    const text = '```json\n{"version":"' + REFERENT_VERSION + '","anchor":{}}\n```'
    const refs = extractReferents(text)
    expect(refs).toHaveLength(1)
    expect(refs[0].anchor).toEqual({})
  })
})

describe('parseMarkText boundary cases', () => {
  it('returns null for empty string', () => {
    expect(parseMarkText('')).toBeNull()
  })

  it('returns null for text with broken fence markers', () => {
    expect(parseMarkText('``json\n{"version":"' + REFERENT_VERSION + '"}\n``')).toBeNull()
    expect(parseMarkText('```\n{"version":"' + REFERENT_VERSION + '"}\n``')).toBeNull()
  })

  it('returns null for JSON arrays / primitives', () => {
    expect(parseMarkText('```json\n[]\n```')).toBeNull()
    expect(parseMarkText('```json\n"string"\n```')).toBeNull()
    expect(parseMarkText('```json\n42\n```')).toBeNull()
  })

  it('rejects wrong version but accepts exact version', () => {
    expect(parseMarkText('```json\n{"version":"dsh-point/referent@2"}\n```')).toBeNull()
    expect(parseMarkText('```json\n{"version":"' + REFERENT_VERSION + '"}\n```')).not.toBeNull()
  })

  it('tolerates missing required fields and fills defaults', () => {
    const text = '```json\n{"version":"' + REFERENT_VERSION + '"}\n```'
    const parsed = parseMarkText(text)
    expect(parsed).toMatchObject({
      version: REFERENT_VERSION,
      selector: '',
      quote: '',
      comment: '',
      index: 0,
      sentAt: '',
      source: { url: '', title: '' },
    })
  })

  it('ignores unknown top-level fields', () => {
    const text = '```json\n{"version":"' + REFERENT_VERSION + '","extra":"surprise","count":99}\n```'
    const parsed = parseMarkText(text)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('extra')
    expect(parsed).not.toHaveProperty('count')
  })

  it('passes unknown anchor fields through', () => {
    const text = '```json\n{"version":"' + REFERENT_VERSION + '","anchor":{"unknown":true,"rect":{"x":1}}}\n```'
    const parsed = parseMarkText(text)
    expect(parsed!.anchor).toMatchObject({ unknown: true, rect: { x: 1 } })
  })

  it('returns null for completely invalid JSON and logs once per block', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseMarkText('```json\n{trailing,}\n```')).toBeNull()
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('parses only the first fenced block and ignores later blocks', () => {
    const a = formatMark(sampleMark({ index: 1, text: 'First' }), '')
    const b = formatMark(sampleMark({ index: 2, text: 'Second' }), '')
    const parsed = parseMarkText(`${a}\n\n${b}`)
    expect(parsed).not.toBeNull()
    expect(parsed!.index).toBe(1)
  })

  it('handles nested code fences in the human summary gracefully', () => {
    const text = formatMark(sampleMark({ text: 'nested ```code``` example' }), '')
    const parsed = parseMarkText(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.quote).toBe('nested ```code``` example')
  })
})
