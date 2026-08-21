// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  cssPath,
  visibleText,
  snippet,
  detectExternalImages,
  cloneForScreenshot,
  documentRectOf,
  xpathFor,
  textFragmentFor,
  codeLocationFor,
} from './mark-utils.ts'

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  Object.defineProperty(window, 'location', {
    value: { pathname: '/plain/page' },
    configurable: true,
  })
})

function makeEl(html: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  const first = wrap.firstElementChild as HTMLElement | null
  if (!first) throw new Error('makeEl: no element')
  document.body.appendChild(first)
  return first
}

describe('cssPath', () => {
  it('returns empty string for non-element input', () => {
    expect(cssPath(null as unknown as Element)).toBe('')
    expect(cssPath(document.createTextNode('x') as unknown as Element)).toBe('')
  })

  it('uses CSS-escaped id when present', () => {
    const el = makeEl('<div id="my:box">x</div>')
    expect(cssPath(el)).toBe('#my\\:box')
  })

  it('stops at body/html and uses nth-of-type for siblings', () => {
    document.body.innerHTML = `
      <section>
        <p>a</p>
        <p><span>b</span></p>
      </section>
    `
    const span = document.querySelector('span')!
    expect(cssPath(span)).toBe('section > p:nth-of-type(2) > span')
  })
})

describe('visibleText', () => {
  it('prefers innerText and collapses whitespace', () => {
    const el = makeEl('<div>  hello   world  </div>')
    expect(visibleText(el)).toBe('hello world')
  })

  it('falls back to textContent then attributes', () => {
    const el = makeEl('<img alt="pic" title="hint" aria-label="label" src="http://x.com/a.png">')
    // visibleText checks aria-label before alt.
    expect(visibleText(el)).toBe('label')
  })

  it('falls back through title/alt/src when innerText absent', () => {
    const el1 = makeEl('<div title="only title"></div>')
    expect(visibleText(el1)).toBe('only title')
    const el2 = makeEl('<div src="http://x"></div>')
    expect(visibleText(el2)).toBe('http://x')
  })

  it('truncates to 200 characters', () => {
    const long = 'a'.repeat(300)
    const el = makeEl(`<div>${long}</div>`)
    expect(visibleText(el)).toHaveLength(200)
  })
})

describe('snippet', () => {
  it('collapses whitespace and trims', () => {
    expect(snippet('  a  \n  b  ')).toBe('a b')
  })

  it('truncates long snippets with ellipsis', () => {
    const long = 'x'.repeat(3000)
    expect(snippet(long, 2000)).toHaveLength(2002)
    expect(snippet(long, 2000).endsWith(' …')).toBe(true)
  })

  it('handles empty/nullish input', () => {
    expect(snippet('')).toBe('')
    expect(snippet(null as unknown as string)).toBe('')
  })
})

describe('detectExternalImages', () => {
  it('detects http(s) images in subtree', () => {
    const el = makeEl('<div><img src="https://x.com/a.png"><span><img src="/local.png"></span></div>')
    expect(detectExternalImages(el)).toBe(true)
  })

  it('detects when the element itself is an external image', () => {
    const el = makeEl('<img src="http://x.com/a.png">')
    expect(detectExternalImages(el)).toBe(true)
  })

  it('returns false for local-only images', () => {
    const el = makeEl('<div><img src="/local.png"></div>')
    expect(detectExternalImages(el)).toBe(false)
  })
})

describe('cloneForScreenshot', () => {
  it('clones element and removes host on cleanup', () => {
    const el = makeEl('<div id="src" style="color:red;"><span>hi</span></div>')
    const { clone, cleanup } = cloneForScreenshot(el)
    expect(clone.tagName).toBe('DIV')
    expect(clone.id).toBe('src')
    // clone lives inside the off-screen host which is attached to body.
    expect(document.body.contains(clone)).toBe(true)
    cleanup()
    expect(document.querySelectorAll('[style*="left: -9999px"]').length).toBe(0)
  })
})

describe('documentRectOf', () => {
  it('returns undefined for invalid or zero-size elements', () => {
    expect(documentRectOf(null as unknown as Element)).toBeUndefined()
    const empty = makeEl('<div></div>')
    Object.defineProperty(empty, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    })
    expect(documentRectOf(empty)).toBeUndefined()
  })

  it('rounds rect and adds scroll offset', () => {
    const el = makeEl('<div style="width:100.6px;height:50.4px;">x</div>')
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ x: 10, y: 20, width: 100.6, height: 50.4, top: 20, left: 10, right: 110.6, bottom: 70.4 }),
    })
    window.scrollX = 5
    window.scrollY = 7
    expect(documentRectOf(el)).toEqual({ x: 15, y: 27, width: 101, height: 50 })
  })
})

describe('xpathFor', () => {
  it('returns empty string for non-element input', () => {
    expect(xpathFor(null as unknown as Element)).toBe('')
  })

  it('produces absolute xpath with indices', () => {
    document.body.innerHTML = `
      <main>
        <article><p>a</p><p>b</p></article>
      </main>
    `
    const p2 = document.querySelectorAll('p')[1]
    expect(xpathFor(p2)).toBe('/html[1]/body[1]/main[1]/article[1]/p[2]')
  })
})

describe('textFragmentFor', () => {
  it('returns undefined for short text', () => {
    const el = makeEl('<div>short</div>')
    expect(textFragmentFor(el)).toBeUndefined()
  })

  it('generates single text= for medium text', () => {
    const el = makeEl('<div>Hello world example</div>')
    expect(textFragmentFor(el)).toBe('text=Hello%20world%20example')
  })

  it('encodes special chars and uses start,end for long text', () => {
    const start = 'a'.repeat(40)
    const end = 'z'.repeat(40)
    const el = makeEl(`<div>${start}---${end}</div>`)
    const frag = textFragmentFor(el)
    expect(frag).toMatch(/^text=.+,.+$/)
    // The separator comma is added after encoding; encodeURIComponent never produces it here.
    expect(frag).not.toContain('%2C')
    expect(frag).toContain('aaaaaaaaaa,zzzzzzzzzz')
  })
})

describe('codeLocationFor', () => {
  it('extracts file path from GitHub blob URL', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/owner/repo/blob/main/src/index.ts' },
      configurable: true,
    })
    const el = makeEl('<div></div>')
    expect(codeLocationFor(el)).toEqual({ file: 'src/index.ts' })
  })

  it('extracts line from data-line-number', () => {
    const el = makeEl('<div data-line-number="42"><span>code</span></div>')
    expect(codeLocationFor(el)).toEqual({ lineStart: 42 })
  })

  it('extracts line from id L12 on ancestor', () => {
    const el = makeEl('<table><tr id="L12"><td>code</td></tr></table>')
    expect(codeLocationFor(el.querySelector('td')!)).toEqual({ lineStart: 12 })
  })

  it('returns undefined when no code context exists', () => {
    Object.defineProperty(window, 'location', {
      value: { pathname: '/plain/page' },
      configurable: true,
    })
    const el = makeEl('<div>plain</div>')
    expect(codeLocationFor(el)).toBeUndefined()
  })
})
