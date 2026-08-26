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

vi.mock('../../src/client/drawing.ts', async (importOriginal) => ({
  // 2026-08-25: 部分 mock——只替换合成/绘制，eraseStrokes 等几何纯函数用真实实现
  ...(await importOriginal<typeof import('../../src/client/drawing.ts')>()),
  composeScreenshot: vi.fn(async (_screenshot: string, strokes: unknown[]) =>
    Array.isArray(strokes) && strokes.length > 0 ? 'composed-screenshot' : null),
  drawStrokes: vi.fn(),
}))

type MessageListener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean

interface Harness {
  sendMessage: ReturnType<typeof vi.fn>
  fireMessage: (msg: unknown) => unknown
  runtime: { id: string }
  /** 2026-08-26: 有后端的 storage.local mock——白板笔迹持久化断言用 */
  localStore: Record<string, unknown>
}

function setup(): Harness {
  let messageListener: MessageListener | null = null
  // 2026-08-25: 支持回调形式（发送路径用 sendMessage(msg, cb)），更贴近真实 runtime
  const sendMessage = vi.fn((_msg?: unknown, cb?: (res?: unknown) => void) => {
    if (typeof cb === 'function') cb({ ok: true })
    return Promise.resolve({ ok: true })
  })
  const runtime = {
    id: 'test-ext',
    onMessage: { addListener: (fn: MessageListener) => { messageListener = fn } },
    sendMessage,
  }
  const localStore: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    runtime,
    storage: {
      local: {
        get: (key?: string) => Promise.resolve(
          typeof key === 'string' ? { [key]: localStore[key] } : { ...localStore },
        ),
        set: (items: Record<string, unknown>) => { Object.assign(localStore, items); return Promise.resolve() },
        remove: (key: string) => { delete localStore[key]; return Promise.resolve() },
      },
      onChanged: { addListener: () => {} },
    },
  })
  return {
    sendMessage,
    runtime,
    localStore,
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

  it('窗口外松开鼠标（mouseup 丢失）：悬停时按键已松开则自愈复位（2026-08-25：用户操作不像机器人精准）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    // 拖拽开始（mousedown+mousemove），但没有 mouseup——用户在窗口外松开了鼠标
    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 20 },
      { type: 'mousemove', clientX: 40, clientY: 60 },
    ])
    expect(document.querySelector('.dsh-point-ext-region-rect')).not.toBeNull()

    // 下一个悬停事件（按键已松开，buttons=0）触发自愈：拖拽态复位、选区矩形回收
    const other = document.createElement('div')
    other.id = 'ext-after-stuck'
    other.textContent = 'y'
    document.body.appendChild(other)
    other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 0 }))

    expect(document.querySelector('.dsh-point-ext-region-rect')).toBeNull()
    // 复位后悬停高亮恢复工作（卡死时这里不会有高亮）
    expect(other.style.outline).toBe('2px solid #ff2d55')
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
    // 不断言共享 body 类名——存活旧实例的弹窗暂停（2026-08-25）会把类名摘掉；
    // 改断言本实例状态：拖拽中 Esc 只取消框选，不退出标记
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marking: boolean }
    expect(s.marking).toBe(true)
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

    // popup 已打开且带只读截图预览（评论窗白板已移除，想续画用页面白板）
    expect(document.querySelector('.dsh-point-ext-popup-shot')).not.toBeNull()

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

  it('橡皮擦过笔画中段：笔画被切成两段而非整条删除（2026-08-25 用户拍板：整条删=撤销）', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    // 画一条水平长线
    drawPenStroke(canvas, [100, 100], [300, 100])
    // 切橡皮工具，在 x=200 处竖着擦一刀
    const eraserBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '橡皮')
    expect(eraserBtn).toBeDefined()
    eraserBtn!.click()
    drawPenStroke(canvas, [200, 90], [200, 110])

    // 完成 + 发送：合成管线收到的应是两段 pen 笔画（中段被切掉）
    finishButton().click()
    await flushAsync()
    await flushAsync()
    const sendBtn = document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!
    sendBtn.click()
    await flushAsync()

    expect(vi.mocked(composeScreenshot)).toHaveBeenCalledTimes(1)
    const strokes = vi.mocked(composeScreenshot).mock.calls[0]![1] as Array<{ tool: string; points: number[] }>
    expect(strokes).toHaveLength(2)
    for (const s of strokes) expect(s.tool).toBe('pen')
  })

  it('撤销覆盖橡皮擦除：擦断的笔画一键复原（2026-08-26 用户要求）', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    drawPenStroke(canvas, [100, 100], [300, 100])
    const eraserBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '橡皮')!
    eraserBtn.click()
    drawPenStroke(canvas, [200, 90], [200, 110]) // 擦成两段

    const undoBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '撤销')!
    undoBtn.click()

    finishButton().click()
    await flushAsync()
    await flushAsync()
    const sendBtn = document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!
    sendBtn.click()
    await flushAsync()

    // 撤销橡皮后应恢复成一条完整 pen 笔画，而不是两段
    const strokes = vi.mocked(composeScreenshot).mock.calls[0]![1] as Array<{ tool: string; points: number[] }>
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.tool).toBe('pen')
  })

  it('撤销覆盖清空：误清可救回', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    drawPenStroke(canvas, [100, 100], [300, 100])
    const clearBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '清空')!
    clearBtn.click()
    // 清空后完成应提示无内容
    finishButton().click()
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-toast')?.textContent).toContain('还没有涂抹内容')

    const undoBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '撤销')!
    undoBtn.click()
    finishButton().click()
    await flushAsync()
    await flushAsync()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
  })

  it('文本工具：点画布出输入框，Enter 提交落成 text 笔画参与合成（图文结合）', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    const textBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '文本')!
    textBtn.click()
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 120, clientY: 200, button: 0, bubbles: true }))
    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-board-text')
    expect(ta).not.toBeNull()
    ta!.value = '往右移 20px'
    ta!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.querySelector('.dsh-point-ext-board-text')).toBeNull() // 提交后输入框消失

    finishButton().click()
    await flushAsync()
    await flushAsync()
    const sendBtn = document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn.primary')[0]!
    sendBtn.click()
    await flushAsync()

    const strokes = vi.mocked(composeScreenshot).mock.calls[0]![1] as Array<{ tool: string; text?: string; font?: number }>
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.tool).toBe('text')
    expect(strokes[0]!.text).toBe('往右移 20px')
    expect(strokes[0]!.font).toBeGreaterThan(0)
  })

  it('文本工具：Esc 取消不落字', async () => {
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '文本')!.click()
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 120, clientY: 200, button: 0, bubbles: true }))
    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-board-text')!
    ta.value = '不要这句'
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    finishButton().click()
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-toast')?.textContent).toContain('还没有涂抹内容')
  })

  it('笔迹持久化：退出即落盘，重进白板自动恢复，清空删档', async () => {
    const h = setup()
    await import('./content.ts')
    const key = `board:${location.origin}${location.pathname}`
    const canvas = startBoard(h)
    drawPenStroke(canvas, [100, 100], [300, 100])

    // 退出（显式按钮）→ flush 落盘，笔迹入存档
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '退出')!.click()
    await flushAsync()
    const saved = h.localStore[key] as { strokes: unknown[] } | undefined
    expect(saved?.strokes).toHaveLength(1)

    // 重进白板 → 自动恢复 + toast 明示（误刷新/续画同一条路径）
    startBoard(h)
    await flushAsync()
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-toast')?.textContent).toContain('已恢复上次笔迹')

    // 清空 = 唯一删档入口
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '清空')!.click()
    await flushAsync()
    expect(h.localStore[key]).toBeUndefined()
  })

  it('暂存区白板 mark 再编辑：EDIT_BOARD 载入笔迹，完成后原位更新并重新暂存', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(composeScreenshot).mockClear()
    const h = setup()
    await import('./content.ts')
    const canvas = startBoard(h)

    drawPenStroke(canvas, [100, 100], [150, 120])
    finishButton().click()
    await flushAsync()
    await flushAsync()

    // 评论窗点「暂存」→ mark pending
    const stageBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup-btn'))
      .find(b => b.textContent === '暂存')!
    stageBtn.click()
    await flushAsync()
    h.sendMessage.mockClear()

    // 侧栏点「改图」→ EDIT_BOARD → 白板重开并载入笔迹
    const res = h.fireMessage({ type: 'EDIT_BOARD', index: 1 }) as { ok: boolean }
    expect(res.ok).toBe(true)
    const canvas2 = document.querySelector<HTMLCanvasElement>('.dsh-point-ext-board')!
    expect(canvas2).not.toBeNull()

    // 加画一笔后完成 → 原位更新 #1（不新建 mark），并重新 STAGE_MARK
    drawPenStroke(canvas2, [200, 200], [260, 220])
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-board-toolbar button'))
      .find(b => b.textContent === '完成')!.click()
    await flushAsync()
    await flushAsync()
    await flushAsync()

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ index: number; selector: string }> }
    expect(s.marks).toHaveLength(1) // 原位更新，不新增
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { index: number } }).mark.index).toBe(1)
  })

  it('EDIT_BOARD 对不存在的 mark 如实失败（页面刷新后笔迹已销毁的设计）', async () => {
    const h = setup()
    await import('./content.ts')
    const res = h.fireMessage({ type: 'EDIT_BOARD', index: 99 }) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('重新标记')
    expect(document.querySelector('.dsh-point-ext-board')).toBeNull()
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

  // 2026-08-25 契约更新（用户实机报告：点画笔后仍处标记态、只能用标记）：
  // 两模式从「并存」改为「互斥」——进白板自动退标记并同步 background，反之亦然。
  // 已有标记的边框/角标保持显示（两模式互证不变），互斥的只是输入捕获态。
  it('Esc 退出白板：画布移除、无 mark、标记保持退出（互斥契约）', async () => {
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
    expect(s.marking).toBe(false)
    expect(s.marks).toHaveLength(0)
  })

  it('进入白板自动退出标记态并同步 background（互斥：侧栏按钮不停在「退出标记」）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    startBoard(h)

    const s = h.fireMessage({ type: 'GET_STATE' }) as { marking: boolean }
    expect(s.marking).toBe(false)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: false })
  })

  it('白板中开启标记：白板退出（互斥反向）', async () => {
    const h = setup()
    await import('./content.ts')
    startBoard(h)

    h.fireMessage({ type: 'TOGGLE_MARKING' })

    expect(document.querySelector('.dsh-point-ext-board')).toBeNull()
    expect(document.querySelector('.dsh-point-ext-board-toolbar')).toBeNull()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marking: boolean }
    expect(s.marking).toBe(true)
  })

  it('白板模式下画布接管点击，不触发元素捕获', async () => {
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


describe('标记态点击拦截（2026-08-25：点链接/按钮不触发页面行为）', () => {
  it('标记态点击链接：拦截默认导航与页面 click 监听器，正常完成捕获', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const a = document.createElement('a')
    a.href = 'https://example.com/'
    a.id = 'ext-link'
    a.textContent = 'link'
    document.body.appendChild(a)
    const pageListener = vi.fn()
    a.addEventListener('click', pageListener)

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(evt)
    await flushAsync()

    expect(evt.defaultPrevented).toBe(true)
    expect(pageListener).not.toHaveBeenCalled()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toBe('#ext-link')
  })

  it('拖拽框选起于链接：mouseup 后的 click 同样被拦截（suppressClick 路径）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const a = document.createElement('a')
    a.href = 'https://example.com/'
    a.style.display = 'block'
    a.style.width = '500px'
    a.style.height = '500px'
    document.body.appendChild(a)
    const pageListener = vi.fn()
    a.addEventListener('click', pageListener)

    dispatchMouseSequence(a, [
      { type: 'mousedown', clientX: 10, clientY: 20 },
      { type: 'mousemove', clientX: 40, clientY: 60 },
      { type: 'mouseup', clientX: 40, clientY: 60 },
    ])
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
    a.dispatchEvent(evt)
    await flushAsync()

    expect(evt.defaultPrevented).toBe(true)
    expect(pageListener).not.toHaveBeenCalled()
    // 框选 region mark 照常生成
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ selector: string }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.selector).toMatch(/^region:/)
  })

  it('非标记态不拦截页面点击（页面行为不受扩展影响）', async () => {
    setup()
    await import('./content.ts')
    // jsdom 里存活旧实例共享 document 且标记态可能为 true——真实浏览器中扩展重载后
    // 旧实例因 chrome.runtime.id 失效（undefined）而静默，这里复刻同一失效机制，
    // 隔离出「无标记态干扰下的页面点击」契约（整删 chrome 会让旧实例抛 ReferenceError）
    vi.stubGlobal('chrome', { runtime: { id: undefined } })
    const a = document.createElement('a')
    document.body.appendChild(a)
    const pageListener = vi.fn()
    a.addEventListener('click', pageListener)

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(false)
    expect(pageListener).toHaveBeenCalledTimes(1)
  })
})

describe('评论窗长截图溢出（2026-08-25：暂存/发送按钮须始终可达）', () => {
  it('截图装入独立滚动容器，弹窗整体限高，按钮留在可视区', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-tall'
    div.textContent = 'tall'
    document.body.appendChild(div)

    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    const wrap = document.querySelector('.dsh-point-ext-popup-shot-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap!.querySelector('img.dsh-point-ext-popup-shot')).not.toBeNull()
    // 按钮容器在 DOM 上位于截图容器之后，不被挤出弹窗
    const popup = document.querySelector('.dsh-point-ext-popup')!
    const children = Array.from(popup.children).map(c => c.className)
    expect(children.indexOf('dsh-point-ext-popup-shot-wrap')).toBeGreaterThan(-1)
    expect(children.indexOf('dsh-point-ext-popup-actions')).toBeGreaterThan(children.indexOf('dsh-point-ext-popup-shot-wrap'))
    // 样式含视口上限与滚动容器
    const styleText = Array.from(document.querySelectorAll('style')).map(s => s.textContent ?? '').join('\n')
    expect(styleText).toContain('.dsh-point-ext-popup-shot-wrap')
    expect(styleText).toContain('max-height: calc(100vh - 16px)')
  })
})

describe('捕获即暂停、了结即恢复（2026-08-25：评论子流程不与标记态叠加）', () => {
  function captureDiv(h: Harness, id = 'ext-pause'): HTMLDivElement {
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = id
    div.textContent = 'x'
    document.body.appendChild(div)
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return div
  }
  function popupButton(text: string): HTMLButtonElement {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup button'))
      .find(b => b.textContent === text)
    expect(btn).toBeDefined()
    return btn!
  }
  function getState(h: Harness): { marking: boolean; marks: Array<{ index: number; status: string }> } {
    return h.fireMessage({ type: 'GET_STATE' }) as { marking: boolean; marks: Array<{ index: number; status: string }> }
  }

  it('点击捕获元素后：标记暂停、同步 background、评论窗打开', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const s = getState(h)
    expect(s.marks).toHaveLength(1)
    expect(s.marking).toBe(false)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: false })
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()
  })

  it('暂停期间点击页面元素不产生新捕获（评论子流程独占输入）', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const other = document.createElement('div')
    other.id = 'ext-other'
    document.body.appendChild(other)
    other.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    expect(getState(h).marks).toHaveLength(1)
  })

  it('暂存后恢复标记并同步 background', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '评论内容'
    popupButton('暂存').click()
    await flushAsync()
    await flushAsync()

    expect(getState(h).marking).toBe(true)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: true })
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
  })

  it('发送后恢复标记', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '评论内容'
    popupButton('发送').click()
    await flushAsync()
    await flushAsync()

    expect(getState(h).marking).toBe(true)
    expect(getState(h).marks[0]!.status).toBe('sent')
  })

  it('删除草稿后恢复标记', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    popupButton('删除').click()
    await flushAsync()

    expect(getState(h).marks).toHaveLength(0)
    expect(getState(h).marking).toBe(true)
  })

  it('重开已标记元素的评论窗同样暂停（2026-08-25 用户补充：重开也要暂停）', async () => {
    const h = setup()
    await import('./content.ts')
    const div = captureDiv(h)
    await flushAsync()
    // 暂存 → 恢复标记
    popupButton('暂存').click()
    await flushAsync()
    await flushAsync()
    expect(getState(h).marking).toBe(true)

    // 再点已标记元素 → 重开评论窗 → 再次暂停
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    expect(getState(h).marking).toBe(false)
    expect(getState(h).marks).toHaveLength(1)
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()
  })

  it('暂停中按 Esc：已输入的评论进暂存区不丢失（2026-08-25 用户拍板），不恢复标记', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '写到一半的评论'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()

    // 草稿了结进暂存区，评论不丢
    const s = getState(h)
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.status).toBe('pending')
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { comment: string } }).mark.comment).toBe('写到一半的评论')
    // 弹窗关闭、标记不恢复（明确退出优先）
    expect(s.marking).toBe(false)
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
  })

  it('暂停中按 Esc（未输入评论）：放弃该标记，不恢复标记', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-esc-hl'
    div.textContent = 'x'
    document.body.appendChild(div)
    // 同族全入口覆盖：先悬停再点击（hover 是 orig 污染的触发前提）
    div.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()

    expect(getState(h).marks).toHaveLength(0)
    expect(div.style.outline).toBe('') // Esc 路径同样不许残留高亮
    expect(getState(h).marking).toBe(false)
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
    // 没有出现恢复同步
    const syncTrue = h.sendMessage.mock.calls.filter(
      c => JSON.stringify(c[0]) === JSON.stringify({ type: 'MARKING_STATE_SYNC', marking: true }),
    )
    expect(syncTrue).toHaveLength(0)
  })

  it('关闭按钮（×）：已输入评论默认暂存不丢失（2026-08-25 用户拍板，与 Esc 同语义）', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '写到一半的评论'
    document.querySelector<HTMLButtonElement>('.dsh-point-ext-popup-close')!.click()
    await flushAsync()

    const s = getState(h)
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.status).toBe('pending')
    const stageCalls = h.sendMessage.mock.calls.filter(
      c => (c[0] as { type?: string }).type === 'STAGE_MARK',
    )
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { comment: string } }).mark.comment).toBe('写到一半的评论')
    // 关闭属「了结」：恢复被暂停的标记
    expect(s.marking).toBe(true)
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
  })

  it('关闭按钮（×）未输入评论：撤销该标记（无孤儿高亮），恢复标记', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()

    document.querySelector<HTMLButtonElement>('.dsh-point-ext-popup-close')!.click()
    await flushAsync()

    expect(getState(h).marks).toHaveLength(0)
    expect(getState(h).marking).toBe(true)
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
  })

  it('×关闭（未输入评论）：元素 outline 高亮同步回收（2026-08-25 实机复现：高亮残留）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-xhl'
    div.textContent = 'x'
    document.body.appendChild(div)

    // 复刻真实操作序列：先悬停（hover 高亮）→ 点击捕获 → 不写评论直接点 ×
    div.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()
    expect(div.style.outline).not.toBe('') // 捕获后 KEPT 高亮在
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('.dsh-point-ext-popup-close')!.click()
    await flushAsync()

    expect(getState(h).marks).toHaveLength(0)
    expect(div.style.outline).toBe('') // 高亮必须随标记一起消失
    expect((div as unknown as Record<string, unknown>)['__dshPointExtKept']).toBeUndefined()
  })

  it('标记本就关闭时打开/关闭评论窗（角标路径）：不产生意外标记态', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()
    popupButton('暂存').click()
    await flushAsync()
    await flushAsync()
    // 显式退出标记（Esc）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(getState(h).marking).toBe(false)

    // 点角标重开评论窗 → 标记关着，无暂停可言；关闭后也不得自动恢复
    const badge = document.querySelector<HTMLElement>('.dsh-point-ext-badge')!
    badge.click()
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('.dsh-point-ext-popup-close')!.click()
    await flushAsync()
    expect(getState(h).marking).toBe(false)
  })

  it('角标关闭（未输入评论）：撤销该标记，不留孤儿高亮（2026-08-25 实机报告）', async () => {
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-badge-hl'
    div.textContent = 'x'
    document.body.appendChild(div)
    // 与 × 测试同样先悬停再点击——hover 是 orig 污染的触发前提，必须覆盖
    div.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    // 评论窗打开（标记被暂停），直接点角标关窗，不写任何评论
    const badge = document.querySelector<HTMLElement>('.dsh-point-ext-badge')!
    badge.click()
    await flushAsync()

    expect(getState(h).marks).toHaveLength(0)
    expect(div.style.outline).toBe('') // 高亮随评论窗一起回收
    expect(getState(h).marking).toBe(true) // 了结后恢复被暂停的标记
    expect(document.querySelector('.dsh-point-ext-popup')).toBeNull()
  })

  it('评论窗打开期间点击页面链接：拦截导航，页面监听器收不到（2026-08-25 实机报告点穿跳转）', async () => {
    const h = setup()
    await import('./content.ts')
    captureDiv(h)
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()

    const a = document.createElement('a')
    a.href = 'https://example.com/'
    a.textContent = 'link'
    document.body.appendChild(a)
    const pageListener = vi.fn()
    a.addEventListener('click', pageListener)

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(evt)
    await flushAsync()

    expect(evt.defaultPrevented).toBe(true)
    expect(pageListener).not.toHaveBeenCalled()
    // 屏蔽只是拦行为，不产生新捕获
    expect(getState(h).marks).toHaveLength(1)
  })
})

describe('点击即开评论窗（2026-08-25：截图异步回填，用户要求 ms 级响应）', () => {
  // 让 html2canvas 变成可控的未决承诺：截图完成前验证评论窗已开
  function deferredH2c(): { resolve: () => void } {
    let resolveFn: () => void = () => {}
    vi.mocked(html2canvas).mockImplementationOnce(
      () => new Promise((res) => {
        resolveFn = () => res({ toDataURL: () => FAKE_SCREENSHOT, width: 100, height: 100 })
      }) as ReturnType<typeof html2canvas>,
    )
    return { resolve: () => resolveFn() }
  }

  it('截图未完成时评论窗已打开（标记+弹窗不等待 html2canvas）', async () => {
    const d = deferredH2c()
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-fast'
    div.textContent = 'fast'
    document.body.appendChild(div)

    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    // 截图还挂着，评论窗已开、mark 已建
    expect(document.querySelector('.dsh-point-ext-popup')).not.toBeNull()
    const s = h.fireMessage({ type: 'GET_STATE' }) as { marks: Array<{ screenshotLen: number }> }
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]!.screenshotLen).toBe(0)
    // 有「生成中」反馈
    expect(document.querySelector('.dsh-point-ext-popup')!.textContent).toContain('截图生成中')

    // 截图完成 → 回填进弹窗
    d.resolve()
    await flushAsync()
    await flushAsync()
    expect(document.querySelector('.dsh-point-ext-popup-shot')).not.toBeNull()
  })

  it('暂存等待在途截图：截图未完成不产出 STAGE_MARK，完成后带截图暂存', async () => {
    const d = deferredH2c()
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-fast2'
    div.textContent = 'fast'
    document.body.appendChild(div)
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '评论'
    Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-point-ext-popup button'))
      .find(b => b.textContent === '暂存')!.click()
    await flushAsync()

    // 截图未决：尚未暂存
    expect(h.sendMessage.mock.calls.filter(c => (c[0] as { type?: string }).type === 'STAGE_MARK')).toHaveLength(0)

    d.resolve()
    await flushAsync()
    await flushAsync()
    await flushAsync()

    const stageCalls = h.sendMessage.mock.calls.filter(c => (c[0] as { type?: string }).type === 'STAGE_MARK')
    expect(stageCalls).toHaveLength(1)
    expect((stageCalls[0]![0] as { mark: { screenshot: string } }).mark.screenshot).toBe(FAKE_SCREENSHOT)
  })

  it('截图回填重渲染不清空已输入的评论', async () => {
    const d = deferredH2c()
    const h = setup()
    await import('./content.ts')
    h.fireMessage({ type: 'TOGGLE_MARKING' })
    const div = document.createElement('div')
    div.id = 'ext-fast3'
    div.textContent = 'fast'
    document.body.appendChild(div)
    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushAsync()

    const ta = document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!
    ta.value = '正在输入的评论'

    d.resolve()
    await flushAsync()
    await flushAsync()

    expect(document.querySelector<HTMLTextAreaElement>('.dsh-point-ext-popup-textarea')!.value).toBe('正在输入的评论')
    expect(document.querySelector('.dsh-point-ext-popup-shot')).not.toBeNull()
  })
})
