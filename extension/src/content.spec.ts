/**
 * content.ts 状态机边界回归（2026-08-24，jsdom）。
 *
 * 覆盖两个真实缺口：
 *  ① Esc 退出标记此前不同步 background/侧栏 → 侧栏按钮停在「退出标记」，
 *    再点反而重新打开（状态撕裂）
 *  ② onMouseOut 缺失效守卫——扩展重载后旧实例会擦掉新实例的悬停高亮
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html2canvas from 'html2canvas'
import { composeScreenshot } from '../../src/client/drawing.ts'

const FAKE_SCREENSHOT = 'data:image/png;base64,fake'

vi.mock('html2canvas', () => ({
  default: vi.fn(async (_el: unknown, opts?: Record<string, unknown>) => {
    const canvas = document.createElement('canvas')
    if (opts && typeof opts.width === 'number' && typeof opts.height === 'number') {
      canvas.width = opts.width as number
      canvas.height = opts.height as number
    } else {
      canvas.width = 100
      canvas.height = 100
    }
    return {
      toDataURL: () => FAKE_SCREENSHOT,
      width: canvas.width,
      height: canvas.height,
    }
  }),
}))

vi.mock('../../src/client/drawing.ts', () => ({
  composeScreenshot: vi.fn(async (_screenshot: string, strokes: unknown[]) =>
    Array.isArray(strokes) && strokes.length > 0 ? 'composed-screenshot' : null),
  drawStrokes: vi.fn(),
}))

type MessageListener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean

interface Harness {
  sendMessage: ReturnType<typeof vi.fn>
  fireMessage: (msg: unknown) => unknown
  runtime: { id: string }
}

function setup(): Harness {
  let messageListener: MessageListener | null = null
  const sendMessage = vi.fn(() => Promise.resolve({ ok: true }))
  const runtime = {
    id: 'test-ext',
    onMessage: { addListener: (fn: MessageListener) => { messageListener = fn } },
    sendMessage,
  }
  vi.stubGlobal('chrome', {
    runtime,
    storage: {
      local: { get: () => Promise.resolve({}) },
      onChanged: { addListener: () => {} },
    },
  })
  return {
    sendMessage,
    runtime,
    fireMessage: (msg) => {
      let response: unknown
      messageListener?.(msg, {}, (r) => { response = r })
      return response
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.body.className = ''
})

describe('Esc 退出同步（状态撕裂修复）', () => {
  it('Esc 退出标记后向 background 同步 MARKING_STATE_SYNC', async () => {
    const h = setup()
    await import('./content.ts')
    // 进入标记态
    const res = h.fireMessage({ type: 'TOGGLE_MARKING' }) as { marking: boolean }
    expect(res.marking).toBe(true)
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    h.sendMessage.mockClear()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(false)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: false })
  })

  it('自定义快捷键路径同样走统一同步函数', async () => {
    const h = setup()
    // 预设自定义快捷键 Ctrl+Shift+K
    vi.stubGlobal('chrome', {
      runtime: h.runtime,
      storage: {
        local: { get: (key: string) => Promise.resolve(key === 'customShortcut' ? { customShortcut: 'Ctrl+Shift+K' } : {}) },
        onChanged: { addListener: () => {} },
      },
    })
    await import('./content.ts')
    // 等 storage.local.get 微任务链走完（显式 flush，不用空 waitFor 假等待）
    for (let i = 0; i < 10; i++) await Promise.resolve()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: true })
  })
})

describe('长按 repeat 守卫（2026-08-24）', () => {
  it('repeat 的 Esc 不重复触发退出同步', async () => {
    const h = setup()
    await import('./content.ts')
    const res = h.fireMessage({ type: 'TOGGLE_MARKING' }) as { marking: boolean }
    expect(res.marking).toBe(true)
    h.sendMessage.mockClear()

    // 长按 Esc：repeat 事件必须被忽略，只认第一次按下
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    expect(h.sendMessage).not.toHaveBeenCalled()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(false)
    // 同文件早前用例的 content 实例仍挂在 document 上且读同一个全局 chrome stub，
    // 退出同步可能多发；只断言「至少一条退出同步且 repeat 不产生增量」（上面的
    // not.toHaveBeenCalled 已锁住 repeat 路径）
    const exitSyncs = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string; marking?: boolean }).type === 'MARKING_STATE_SYNC'
        && (c[0] as { marking?: boolean }).marking === false,
    )
    expect(exitSyncs.length).toBeGreaterThanOrEqual(1)
  })

  it('repeat 的自定义快捷键不反复 toggle', async () => {
    const h = setup()
    vi.stubGlobal('chrome', {
      runtime: h.runtime,
      storage: {
        local: { get: (key: string) => Promise.resolve(key === 'customShortcut' ? { customShortcut: 'Ctrl+Shift+K' } : {}) },
        onChanged: { addListener: () => {} },
      },
    })
    await import('./content.ts')
    for (let i = 0; i < 10; i++) await Promise.resolve()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    // 长按产生的 repeat 事件不得把标记态又切回去
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, repeat: true, bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
  })
})

describe('双实例干扰守卫（扩展重载场景）', () => {
  it('上下文失效后 mouseout 不再擦掉高亮', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' }) // marking on
    const el = document.createElement('div')
    document.body.appendChild(el)

    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(el.style.outline).toContain('#ff2d55')

    // 模拟扩展重载：本实例上下文失效
    h.runtime.id = '' as never
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    // 失效实例必须静默——高亮保留（由新实例全权管理）
    expect(el.style.outline).toContain('#ff2d55')
  })
})

function dispatchMouseSequence(
  target: HTMLElement,
  events: Array<{ type: 'mousedown' | 'mousemove' | 'mouseup' | 'click'; clientX: number; clientY: number }>,
): void {
  for (const ev of events) {
    target.dispatchEvent(new MouseEvent(ev.type, {
      clientX: ev.clientX,
      clientY: ev.clientY,
      bubbles: true,
    }))
  }
}

async function flushAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('扩展侧区域框选（2026-08-24）', () => {
  it('拖拽 > 6px 生成 region mark（本地草稿，未自动暂存）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 20 },
      { type: 'mousemove', clientX: 40, clientY: 60 },
      { type: 'mouseup', clientX: 40, clientY: 60 },
    ])
    await flushAsync()

    // 捕获只生成本地草稿；暂存/发送需要用户在弹窗里点按钮，不会自动 STAGE_MARK。
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(0)

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string; text: string; screenshotLen: number; hasExternalImage: boolean; status: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toMatch(/^region:10,20,30,40$/)
    expect(s.marks[0]!.text).toBe('')
    expect(s.marks[0]!.screenshotLen).toBeGreaterThan(0)
    expect(s.marks[0]!.hasExternalImage).toBe(false)
    expect(s.marks[0]!.status).toBe('draft')
  })

  it('拖拽 ≤ 6px 走点击元素捕获', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.id = 'ext-target'
    target.textContent = 'ext'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()

    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(0)

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string; text: string; status: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toBe('#ext-target')
    expect(s.marks[0]!.text).toBe('ext')
    expect(s.marks[0]!.status).toBe('draft')
  })

  it('拖拽中 Esc 取消，不产出 mark', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 0, clientY: 0 },
      { type: 'mousemove', clientX: 100, clientY: 100 },
    ])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    dispatchMouseSequence(target, [
      { type: 'mouseup', clientX: 100, clientY: 100 },
    ])

    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(0)
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    expect(document.querySelector('.dsh-point-ext-region-rect')).toBeNull()
  })

  it('起始于 badge 不触发框选', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const badge = document.createElement('div')
    badge.className = 'dsh-point-ext-badge'
    document.body.appendChild(badge)

    dispatchMouseSequence(badge, [
      { type: 'mousedown', clientX: 0, clientY: 0 },
      { type: 'mousemove', clientX: 100, clientY: 100 },
      { type: 'mouseup', clientX: 100, clientY: 100 },
    ])

    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(0)
  })

  it('FOCUS_MARK 对 region 滚动并闪烁边框', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 10 },
      { type: 'mousemove', clientX: 60, clientY: 60 },
      { type: 'mouseup', clientX: 60, clientY: 60 },
    ])
    await flushAsync()

    const res = h.fireMessage({ type: 'FOCUS_MARK', index: 1 }) as { ok: boolean }
    expect(res.ok).toBe(true)
    // 跨实例残留边框可能让 querySelector 拿到不带 flash 的 stale 元素，直接查组合类名。
    const border = document.querySelector('.dsh-point-ext-region-kept.dsh-point-ext-flash')
    expect(border).not.toBeNull()
  })
})

describe('扩展侧框选坐标换算（2026-08-25：滚动漂移 / 超界钳制）', () => {
  function stubScroll(x: number, y: number): void {
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => x })
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
  }
  function stubDocSize(w: number, h: number): void {
    Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, get: () => w })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => h })
  }
  afterEach(() => { stubScroll(0, 0); stubDocSize(0, 0) })

  it('拖拽中页面滚动：起点用滚动快照换算，区域边界不随页面漂移', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    document.body.appendChild(target)

    stubScroll(0, 0)
    target.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 20, bubbles: true }))
    stubScroll(0, 500)
    target.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 120, bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 120, bubbles: true }))
    await flushAsync()

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toBe('region:10,20,50,600')
  })

  it('框选超出文档范围：钳制到文档边界', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    stubDocSize(800, 600)
    const target = document.createElement('div')
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 10 },
      { type: 'mousemove', clientX: 1000, clientY: 1000 },
      { type: 'mouseup', clientX: 1000, clientY: 1000 },
    ])
    await flushAsync()

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toBe('region:10,10,790,590')
  })

  it('完全拖出文档范围：不产出 mark', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    stubDocSize(100, 100)
    const target = document.createElement('div')
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 200, clientY: 200 },
      { type: 'mousemove', clientX: 300, clientY: 300 },
      { type: 'mouseup', clientX: 300, clientY: 300 },
    ])
    await flushAsync()

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(0)
  })
})

describe('扩展侧评论窗绘画层（2026-08-24）', () => {
  it('有截图的草稿标记弹出绘画工具栏与画布', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.id = 'draw-target'
    target.textContent = 'x'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()

    expect(document.querySelector('.dsh-point-ext-drawing')).not.toBeNull()
    expect(document.querySelector('.dsh-point-ext-drawing-canvas')).not.toBeNull()
    const buttons = document.querySelectorAll('.dsh-point-ext-drawing-toolbar button')
    expect(buttons.length).toBe(5)
    expect(Array.from(buttons).map(b => b.textContent)).toEqual(['画笔', '箭头', '矩形', '撤销', '清空'])
  })

  it('Esc 层级：工具态下只退出工具，不退出标记模式', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.id = 'esc-target'
    target.textContent = 'x'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()

    const penBtn = document.querySelector<HTMLButtonElement>('.dsh-point-ext-drawing-toolbar button[data-tool="pen"]')!
    penBtn.click()
    await flushAsync()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()

    // 工具态 Esc 应只退出工具（画笔按钮不再 active）并保留弹窗/画布；
    // 不判断 MARKING_STATE_SYNC，因为同文件早前用例的 content 实例监听器未清理。
    const penBtnAfter = document.querySelector<HTMLButtonElement>('.dsh-point-ext-drawing-toolbar button[data-tool="pen"]')!
    expect(penBtnAfter.classList.contains('active')).toBe(false)
    expect(document.querySelector('.dsh-point-ext-drawing-canvas')).not.toBeNull()
  })

  it('发送前合成 strokes 到截图', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.id = 'send-target'
    target.textContent = 'x'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()

    // 选中画笔并在画布上画一笔
    const penBtn = document.querySelector<HTMLButtonElement>('.dsh-point-ext-drawing-toolbar button[data-tool="pen"]')!
    penBtn.click()
    await flushAsync()
    const canvas = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-drawing-canvas')!
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 20, clientY: 20, bubbles: true }))

    vi.mocked(composeScreenshot).mockClear()
    const sendBtn = document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!
    sendBtn.click()
    await flushAsync()

    expect(vi.mocked(composeScreenshot)).toHaveBeenCalledTimes(1)
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { screenshot: string } }).mark.screenshot).toBe('composed-screenshot')
  })
})

describe('扩展侧内层滚动容器锚定（2026-08-25：dsh 类应用内层滚动失锚 / popup 按钮看不到）', () => {
  // jsdom 无 pretendToBeVisual 时没有 requestAnimationFrame，同步执行即可
  function stubRaf(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  }
  function stubScroll(x: number, y: number): void {
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => x })
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
  }
  afterEach(() => { stubScroll(0, 0) })

  it('内层容器滚动后 region 边框按 delta 跟随内容；FOCUS_MARK 复原锚点滚动', async () => {
    const h = setup()
    stubRaf()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const scroller = document.createElement('div')
    scroller.style.overflow = 'auto'
    const target = document.createElement('div')
    scroller.appendChild(target)
    document.body.appendChild(scroller)

    // 独特坐标 33x41，避开同文件早前用例残留在 documentElement 上的边框
    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 17, clientY: 23 },
      { type: 'mousemove', clientX: 50, clientY: 64 },
      { type: 'mouseup', clientX: 50, clientY: 64 },
    ])
    await flushAsync()

    // 同文件早前用例的 content 实例仍挂在 document 上且标记态未关，本次拖拽会
    // 被每个存活实例各捕获一次、各挂一个 33x41 边框；本实例最后注册、边框最后
    // 挂载，取最后一个匹配（第一个可能是旧实例的，FOCUS_MARK 只修正本实例的）
    const matches = Array.from(document.querySelectorAll<HTMLElement>('.dsh-point-ext-region-kept'))
      .filter(b => b.style.width === '33px' && b.style.height === '41px')
    const border = matches[matches.length - 1]
    expect(border).toBeDefined()
    expect(border!.style.top).toBe('23px')

    // 内层容器滚动 100px：内容上移，边框必须跟上（否则视觉上边框"跟着页面滑"）
    scroller.scrollTop = 100
    scroller.dispatchEvent(new Event('scroll'))
    await flushAsync()
    expect(border!.style.top).toBe('-77px')

    // 暂存列表跳转：复原锚点滚动位置，边框回到原始位置
    const res = h.fireMessage({ type: 'FOCUS_MARK', index: 1 }) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(scroller.scrollTop).toBe(0)
    expect(border!.style.top).toBe('23px')
  })

  it('window 滚动后 popup 用视口坐标且钳进视口（不重复加滚动量）', async () => {
    const h = setup()
    stubRaf()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    stubScroll(0, 300)
    const target = document.createElement('div')
    target.id = 'ext-popup-clamp-target'
    target.textContent = 'x'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()

    const popup = document.querySelector<HTMLElement>('.dsh-point-ext-popup')
    expect(popup).not.toBeNull()
    // jsdom 中 getBoundingClientRect 全 0：r.bottom=0 → top=pad=8；
    // 修复前会再 +window.scrollY=300 变成 308px 被推出视口
    expect(popup!.style.top).toBe('8px')
    expect(popup!.style.left).toBe('0px')
  })
})

describe('扩展侧页面白板模式（2026-08-25：画笔涂抹 → 截图发 dsh）', () => {
  // 白板画布挂在 documentElement（body.innerHTML 清不到）且旧实例可能保持
  // drawingMode——每个用例后物理清除残留画布/工具条，防跨用例干扰断言
  afterEach(() => {
    document.querySelectorAll('.dsh-point-ext-board, .dsh-point-ext-board-toolbar').forEach(el => el.remove())
  })

  function startBoard(h: Harness): HTMLCanvasElement {
    const res = h.fireMessage({ type: 'START_DRAWING' }) as { drawing: boolean }
    expect(res.drawing).toBe(true)
    const canvas = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-board')
    expect(canvas).not.toBeNull()
    return canvas!
  }
  function finishButton(): HTMLButtonElement {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '完成')
    expect(btn).toBeDefined()
    return btn!
  }
  function drawPenStroke(canvas: HTMLElement, from: [number, number], to: [number, number]): void {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: from[0], clientY: from[1], button: 0, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: to[0], clientY: to[1], bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: to[0], clientY: to[1], bubbles: true }))
  }

  it('画笔涂抹一笔 → 完成生成笔迹包围盒 region mark，发送时合成笔迹', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    drawPenStroke(canvas, [100, 100], [150, 120])
    finishButton().click()
    await flushAsync()
    await flushAsync()

    // 画布已撤（避免笔迹截进底图双重叠加），mark = 包围盒 +16 边距
    expect(document.querySelector('.dsh-point-ext-board')).toBeNull()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toBe('region:84,84,82,52')

    // popup 已打开且带白板绘画层（笔迹可见可续画）
    expect(document.querySelector('.dsh-point-ext-drawing-canvas')).not.toBeNull()

    // 发送：笔迹合成进截图
    const sendBtn = document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!
    sendBtn.click()
    await flushAsync()
    expect(vi.mocked(composeScreenshot)).toHaveBeenCalledTimes(1)
    const strokes = vi.mocked(composeScreenshot).mock.calls[0]![1] as Array<{ tool: string; points: number[] }>
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.tool).toBe('pen')
    // 归一化到包围盒坐标系：(100-84)/82
    expect(strokes[0]!.points[0]).toBeCloseTo(16 / 82, 5)
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { screenshot: string } }).mark.screenshot).toBe('composed-screenshot')
  })

  it('空白板点完成：提示且不产出 mark，白板保持', async () => {
    const h = setup()
    await import('./content.ts')
    startBoard(h)

    finishButton().click()
    await flushAsync()

    expect(document.querySelector('.dsh-point-ext-toast')?.textContent).toContain('还没有涂抹内容')
    expect(document.querySelector('.dsh-point-ext-board')).not.toBeNull()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: unknown[] }
    expect(s.marks).toHaveLength(0)
  })

  it('Esc 退出白板：画布移除、无 mark、标记态不受影响', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const canvas = startBoard(h)
    drawPenStroke(canvas, [10, 10], [50, 50])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.querySelector('.dsh-point-ext-board')).toBeNull()
    expect(document.querySelector('.dsh-point-ext-board-toolbar')).toBeNull()
    // 标记态不断言 body 类名——存活旧实例也会响应 Esc 把共享 body 类名摘掉；
    // 改断言本实例状态（GET_STATE 是实例级的，不受串扰）
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marking: boolean; marks: unknown[] }
    expect(s.marking).toBe(true)
    expect(s.marks).toHaveLength(0)
  })

  it('白板模式下画布接管点击，不触发元素捕获（两模式并存不互抢）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const canvas = startBoard(h)

    drawPenStroke(canvas, [10, 10], [50, 50])
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 30, clientY: 30, bubbles: true }))
    await flushAsync()

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: unknown[] }
    expect(s.marks).toHaveLength(0)
  })

  it('工具切换：箭头/矩形按钮激活态互斥', async () => {
    const h = setup()
    await import('./content.ts')
    startBoard(h)

    const arrowBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.dataset.tool === 'arrow')!
    arrowBtn.click()
    expect(arrowBtn.classList.contains('active')).toBe(true)
    const penBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.dataset.tool === 'pen')!
    expect(penBtn.classList.contains('active')).toBe(false)
  })
})

describe('扩展侧性能路径（2026-08-25：视口快速截图 / 落笔采样）', () => {
  function stubScroll(x: number, y: number): void {
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => x })
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
  }
  function stubDocSize(w: number, h: number): void {
    Object.defineProperty(document.documentElement, 'scrollWidth', { configurable: true, get: () => w })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => h })
  }
  afterEach(() => { stubScroll(0, 0); stubDocSize(0, 0) })

  it('视口内区域：视口窗口 + 视口坐标裁剪（快速路径，不撑整文档）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    stubScroll(0, 100)
    const target = document.createElement('div')
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 20 },
      { type: 'mousemove', clientX: 40, clientY: 60 },
      { type: 'mouseup', clientX: 40, clientY: 60 },
    ])
    await flushAsync()

    const opts = vi.mocked(html2canvas).mock.calls.at(-1)?.[1] as Record<string, unknown>
    // 文档坐标 rect=(10,120,30,40)，裁剪换算回视口坐标；不传 windowWidth/Height
    expect(opts.x).toBe(10)
    expect(opts.y).toBe(20)
    expect(opts.width).toBe(30)
    expect(opts.height).toBe(40)
    expect(opts.windowWidth).toBeUndefined()
    expect(opts.windowHeight).toBeUndefined()
  })

  it('拖拽中滚动导致区域跨视口：整文档窗口 + 文档坐标（慢速兜底）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    stubDocSize(1000, 2000)
    const target = document.createElement('div')
    document.body.appendChild(target)

    stubScroll(0, 0)
    target.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 20, bubbles: true }))
    stubScroll(0, 500)
    target.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 120, bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 120, bubbles: true }))
    await flushAsync()

    const opts = vi.mocked(html2canvas).mock.calls.at(-1)?.[1] as Record<string, unknown>
    // rect=(10,20,50,600)，起点已滚出视口 → 慢速路径
    expect(opts.x).toBe(10)
    expect(opts.y).toBe(20)
    expect(opts.windowWidth).toBe(1000)
    expect(opts.windowHeight).toBe(2000)
  })

  it('画笔落笔采样：<2px 移动不产生新点', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'START_DRAWING' })
    const canvas = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-board')!

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 101, clientY: 100, bubbles: true })) // 距 1px，丢弃
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 103, clientY: 100, bubbles: true })) // 距起点 3px，采
    canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 104, clientY: 100, bubbles: true }))   // 距上点 1px，不补

    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '完成')!.click()
    await flushAsync()
    await flushAsync()

    document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!.click()
    await flushAsync()

    const strokes = vi.mocked(composeScreenshot).mock.calls[0]?.[1] as Array<{ points: number[] }>
    // [down(100,100)×2, 采样点(103,100)] = 6 个数；1px 抖动与结尾小位移都被采掉
    expect(strokes[0]!.points).toHaveLength(6)
  })
})

describe('扩展侧评论窗绘画层修复（2026-08-25：工具切换丢评论 / 画笔无预览 / 画布错位）', () => {
  async function openPopupMark(h: Harness): Promise<void> {
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.id = 'draw-fix-target'
    target.textContent = 'x'
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)
    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 105 },
      { type: 'mouseup', clientX: 103, clientY: 105 },
      { type: 'click', clientX: 103, clientY: 105 },
    ])
    await flushAsync()
  }
  function penButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('.dsh-point-ext-drawing-toolbar button[data-tool="pen"]')!
  }

  it('点击绘画工具不重建评论窗：正在输入的评论保留', async () => {
    const h = setup()
    await import('./content.ts')
    await openPopupMark(h)
    const textarea = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    textarea.value = '还没写完的评论'

    penButton().click()

    expect(document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!.value).toBe('还没写完的评论')
    expect(penButton().classList.contains('active')).toBe(true)
  })

  it('Esc 退出工具同样保留评论', async () => {
    const h = setup()
    await import('./content.ts')
    await openPopupMark(h)
    penButton().click()
    const textarea = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    textarea.value = 'Esc 前的评论'

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(penButton().classList.contains('active')).toBe(false)
    expect(document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!.value).toBe('Esc 前的评论')
  })

  it('画笔拖动有实时预览（redraw 携带未完成笔迹）', async () => {
    // jsdom 无 2d 上下文，stub 一个最小 ctx 让 redraw 走到 drawStrokes
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: () => {} } as never)
    const h = setup()
    await import('./content.ts')
    await openPopupMark(h)
    // jsdom 不加载图片，手动触发 load 让画布完成初始化
    const img = document.querySelector<HTMLImageElement>('.dsh-point-ext-drawing-img')!
    img.dispatchEvent(new Event('load'))
    const { drawStrokes } = await import('../../src/client/drawing.ts')
    vi.mocked(drawStrokes).mockClear()

    penButton().click()
    const canvas = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-drawing-canvas')!
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, bubbles: true }))

    const calls = vi.mocked(drawStrokes).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    // 预览调用必须包含未完成笔迹（committed 0 + preview 1 = 1 条）
    expect((calls.at(-1)![1] as unknown[]).length).toBe(1)
    vi.restoreAllMocks()
  })

  it('画布只覆盖图片区域（与工具条分离），坐标不纵向错位', async () => {
    const h = setup()
    await import('./content.ts')
    await openPopupMark(h)
    const canvas = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-drawing-canvas')!
    // 画布必须挂在只含 img 的相对容器内；挂在含工具条的 wrapper 下会被拉长
    expect(canvas.parentElement!.classList.contains('dsh-point-ext-drawing-view')).toBe(true)
    expect(canvas.parentElement!.querySelector('.dsh-point-ext-drawing-toolbar')).toBeNull()
  })
})
