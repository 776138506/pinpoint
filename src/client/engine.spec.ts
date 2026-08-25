/**
 * engine.ts 区域框选标记回归测试（2026-08-24，jsdom）。
 *
 * 覆盖规格：
 *  ① mousedown + 拖拽 > 6px 产生 region mark（selector / screenshot / text/html 空）
 *  ② 拖拽 ≤ 6px 视为单击，走元素捕获逻辑
 *  ③ 拖拽中 Esc 取消本次拖拽（不退出标记模式，不产出 mark）
 *  ④ 起始于 badge/popup/toast/cross 等 overlay 不触发框选
 *  ⑤ region mark 的 resolveMarkElement 返回正确 rect，badge/popup 定位分支可用
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkingController } from './engine.ts'

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

interface Deps {
  setMarking: ReturnType<typeof vi.fn>
  addMark: ReturnType<typeof vi.fn>
  removeMark: ReturnType<typeof vi.fn>
  openMark: ReturnType<typeof vi.fn>
  updateMark: ReturnType<typeof vi.fn>
  sendMark: ReturnType<typeof vi.fn>
}

function setup() {
  const deps: Deps = {
    setMarking: vi.fn(),
    addMark: vi.fn(),
    removeMark: vi.fn(),
    openMark: vi.fn(),
    updateMark: vi.fn(),
    sendMark: vi.fn(),
  }
  return deps
}

let lastController: MarkingController | null = null

async function makeController(deps: Deps) {
  const { createMarkingController } = await import('./engine.ts')
  const controller = createMarkingController(deps)
  controller.mount()
  controller.sync({ marking: true, marks: [], nextIndex: 1, activeIndex: null })
  lastController = controller
  return controller
}

async function flushAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function dispatchMouseSequence(
  target: HTMLElement,
  events: Array<{ type: 'mousedown' | 'mousemove' | 'mouseup' | 'click'; clientX: number; clientY: number; button?: number }>,
): void {
  for (const ev of events) {
    target.dispatchEvent(new MouseEvent(ev.type, {
      clientX: ev.clientX,
      clientY: ev.clientY,
      button: ev.button ?? 0,
      bubbles: true,
    }))
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.body.className = ''
  document.head.innerHTML = ''
})

afterEach(() => {
  lastController?.dispose()
  lastController = null
})

describe('engine 区域框选', () => {
  it('拖拽 > 6px 生成 region mark', async () => {
    const deps = setup()
    await makeController(deps)
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 50, clientY: 60 },
      { type: 'mousemove', clientX: 70, clientY: 80 },
      { type: 'mouseup', clientX: 70, clientY: 80 },
    ])
    await flushAsync()

    expect(deps.addMark).toHaveBeenCalledTimes(1)
    const mark = deps.addMark.mock.calls[0]![0] as {
      selector: string
      text: string
      html: string
      screenshot: string
      hasExternalImage: boolean
      frameKind: string
      anchor?: { rect: { x: number; y: number; width: number; height: number } }
    }
    expect(mark.selector).toMatch(/^region:50,60,20,20$/)
    expect(mark.text).toBe('')
    expect(mark.html).toBe('')
    expect(mark.screenshot).toBe(FAKE_SCREENSHOT)
    expect(mark.hasExternalImage).toBe(false)
    expect(mark.frameKind).toBe('main')
    expect(mark.anchor?.rect).toEqual({ x: 50, y: 60, width: 20, height: 20 })
  })

  it('拖拽 ≤ 6px 走点击元素捕获', async () => {
    const deps = setup()
    await makeController(deps)
    const container = document.createElement('div')
    container.dataset.office = 'word'
    const target = document.createElement('div')
    target.id = 'click-target'
    target.textContent = 'hello'
    target.style.width = '500px'
    target.style.height = '500px'
    container.appendChild(target)
    document.body.appendChild(container)
    // 等待 MutationObserver 把 office container 的 click 监听器挂上
    await flushAsync()

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 100, clientY: 100 },
      { type: 'mousemove', clientX: 103, clientY: 104 },
      { type: 'mouseup', clientX: 103, clientY: 104 },
      { type: 'click', clientX: 103, clientY: 104 },
    ])
    await flushAsync()

    expect(deps.addMark).toHaveBeenCalledTimes(1)
    const mark = deps.addMark.mock.calls[0]![0] as { selector: string; text: string }
    expect(mark.selector).toBe('#click-target')
    expect(mark.text).toBe('hello')
  })

  it('拖拽中 Esc 取消，不产出 mark 且不退出标记模式', async () => {
    const deps = setup()
    await makeController(deps)
    const target = document.createElement('div')
    target.style.width = '500px'
    target.style.height = '500px'
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 10 },
      { type: 'mousemove', clientX: 50, clientY: 50 },
    ])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    dispatchMouseSequence(target, [
      { type: 'mouseup', clientX: 50, clientY: 50 },
    ])

    expect(deps.addMark).not.toHaveBeenCalled()
    expect(deps.setMarking).not.toHaveBeenCalled()
    expect(document.querySelector('.dsh-point-region-rect')).toBeNull()
  })

  it('起始于 badge 不触发框选', async () => {
    const deps = setup()
    await makeController(deps)
    // Pre-create a badge in the overlay layer.
    const badge = document.createElement('div')
    badge.className = 'dsh-point-badge'
    badge.dataset.index = '1'
    document.body.appendChild(badge)

    dispatchMouseSequence(badge, [
      { type: 'mousedown', clientX: 0, clientY: 0 },
      { type: 'mousemove', clientX: 100, clientY: 100 },
      { type: 'mouseup', clientX: 100, clientY: 100 },
    ])

    expect(deps.addMark).not.toHaveBeenCalled()
    expect(document.querySelector('.dsh-point-region-rect')).toBeNull()
  })

  it('起始于 popup 不触发框选', async () => {
    const deps = setup()
    await makeController(deps)
    const popup = document.createElement('div')
    popup.className = 'dsh-point-popup'
    document.body.appendChild(popup)

    dispatchMouseSequence(popup, [
      { type: 'mousedown', clientX: 0, clientY: 0 },
      { type: 'mousemove', clientX: 100, clientY: 100 },
      { type: 'mouseup', clientX: 100, clientY: 100 },
    ])

    expect(deps.addMark).not.toHaveBeenCalled()
  })

  it('resolveMarkElement region 分支返回 rect 且无 el', async () => {
    const deps = setup()
    const controller = await makeController(deps)
    controller.sync({
      marking: true,
      marks: [{
        index: 1,
        selector: 'region:10,20,30,40',
        text: '',
        html: '',
        source: '页面',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        frameKind: 'main',
        screenshot: '',
        hasExternalImage: false,
        time: '2026-08-24T00:00:00Z',
        status: 'draft',
        anchor: { rect: { x: 10, y: 20, width: 30, height: 40 } },
      }],
      nextIndex: 2,
      activeIndex: 1,
    })

    const badge = document.querySelector<HTMLElement>('.dsh-point-badge[data-index="1"]')
    expect(badge).not.toBeNull()
    expect(badge?.style.display).not.toBe('none')
    expect(badge?.style.left).toBe('10px')
    expect(badge?.style.top).toBe('20px')
    const border = document.querySelector('.dsh-point-region-kept')
    expect(border).not.toBeNull()
    expect((border as HTMLElement).style.left).toBe('10px')
    expect((border as HTMLElement).style.top).toBe('20px')
    expect((border as HTMLElement).style.width).toBe('30px')
    expect((border as HTMLElement).style.height).toBe('40px')
  })
})

describe('engine 框选坐标换算（2026-08-25：滚动漂移 / 超界钳制）', () => {
  // jsdom 不实现真实滚动/文档尺寸，用 defineProperty 桩；测完复位 0 防串用例
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
    const deps = setup()
    await makeController(deps)
    const target = document.createElement('div')
    document.body.appendChild(target)

    stubScroll(0, 0)
    target.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 20, bubbles: true }))
    // 拖拽中用户滚动了 500px——终点的文档坐标必须按当前滚动换算
    stubScroll(0, 500)
    target.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 120, bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { clientX: 60, clientY: 120, bubbles: true }))
    await flushAsync()

    expect(deps.addMark).toHaveBeenCalledTimes(1)
    const mark = deps.addMark.mock.calls[0]![0] as { selector: string }
    // 起点文档 y = 20 + 0；终点文档 y = 120 + 500 = 620 → 高 600
    expect(mark.selector).toBe('region:10,20,50,600')
  })

  it('框选超出文档范围：钳制到文档边界并传给截图正确的窗口尺寸', async () => {
    const deps = setup()
    await makeController(deps)
    stubDocSize(800, 600)
    const target = document.createElement('div')
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 10, clientY: 10 },
      { type: 'mousemove', clientX: 1000, clientY: 1000 },
      { type: 'mouseup', clientX: 1000, clientY: 1000 },
    ])
    await flushAsync()

    expect(deps.addMark).toHaveBeenCalledTimes(1)
    const mark = deps.addMark.mock.calls[0]![0] as { selector: string }
    expect(mark.selector).toBe('region:10,10,790,590')
    const html2canvas = (await import('html2canvas')).default as ReturnType<typeof vi.fn>
    const opts = html2canvas.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(opts.windowWidth).toBe(800)
    expect(opts.windowHeight).toBe(600)
  })

  it('完全拖出文档范围：不产出 mark', async () => {
    const deps = setup()
    await makeController(deps)
    stubDocSize(100, 100)
    const target = document.createElement('div')
    document.body.appendChild(target)

    dispatchMouseSequence(target, [
      { type: 'mousedown', clientX: 200, clientY: 200 },
      { type: 'mousemove', clientX: 300, clientY: 300 },
      { type: 'mouseup', clientX: 300, clientY: 300 },
    ])
    await flushAsync()

    expect(deps.addMark).not.toHaveBeenCalled()
  })
})

describe('engine 评论窗绘画层（2026-08-24）', () => {
  it('有截图的草稿标记弹出绘画工具栏与画布', async () => {
    const deps = setup()
    const controller = await makeController(deps)
    controller.sync({
      marking: true,
      marks: [{
        index: 1,
        selector: '#target',
        text: 'target',
        html: '<div id="target">target</div>',
        source: '页面',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        frameKind: 'main',
        screenshot: FAKE_SCREENSHOT,
        hasExternalImage: false,
        time: '2026-08-24T00:00:00Z',
        status: 'draft',
      }],
      nextIndex: 2,
      activeIndex: 1,
    })
    await flushAsync()

    expect(document.querySelector('.dsh-point-drawing')).not.toBeNull()
    expect(document.querySelector('.dsh-point-drawing-canvas')).not.toBeNull()
    const buttons = document.querySelectorAll('.dsh-point-drawing-toolbar button')
    expect(buttons.length).toBe(5)
    expect(Array.from(buttons).map(b => b.textContent)).toEqual(['画笔', '箭头', '矩形', '撤销', '清空'])
  })

  it('已发送标记不渲染绘画层', async () => {
    const deps = setup()
    const controller = await makeController(deps)
    controller.sync({
      marking: true,
      marks: [{
        index: 1,
        selector: '#target',
        text: 'target',
        html: '<div id="target">target</div>',
        source: '页面',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        frameKind: 'main',
        screenshot: FAKE_SCREENSHOT,
        hasExternalImage: false,
        time: '2026-08-24T00:00:00Z',
        status: 'sent',
      }],
      nextIndex: 2,
      activeIndex: 1,
    })
    await flushAsync()

    expect(document.querySelector('.dsh-point-drawing')).toBeNull()
  })

  it('Esc 层级：工具态下只退出工具，不退出标记模式', async () => {
    const deps = setup()
    const controller = await makeController(deps)
    controller.sync({
      marking: true,
      marks: [{
        index: 1,
        selector: '#target',
        text: 'target',
        html: '<div id="target">target</div>',
        source: '页面',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        frameKind: 'main',
        screenshot: FAKE_SCREENSHOT,
        hasExternalImage: false,
        time: '2026-08-24T00:00:00Z',
        status: 'draft',
      }],
      nextIndex: 2,
      activeIndex: 1,
    })
    await flushAsync()

    const penBtn = document.querySelector<HTMLButtonElement>('.dsh-point-drawing-toolbar button[data-tool="pen"]')!
    penBtn.click()
    await flushAsync()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushAsync()

    expect(deps.setMarking).not.toHaveBeenCalled()
    // 退出工具后重新渲染，画布应仍然存在。
    expect(document.querySelector('.dsh-point-drawing-canvas')).not.toBeNull()
  })
})
