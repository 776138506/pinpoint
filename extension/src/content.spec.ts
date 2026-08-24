/**
 * content.ts 状态机边界回归（2026-08-24，jsdom）。
 *
 * 覆盖两个真实缺口：
 *  ① Esc 退出标记此前不同步 background/侧栏 → 侧栏按钮停在「退出标记」，
 *    再点反而重新打开（状态撕裂）
 *  ② onMouseOut 缺失效守卫——扩展重载后旧实例会擦掉新实例的悬停高亮
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
