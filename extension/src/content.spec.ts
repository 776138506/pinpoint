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
    await vi.waitFor(() => {}) // 等 storage.local.get 微任务
    await Promise.resolve()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    expect(document.body.classList.contains('dsh-point-ext-marking')).toBe(true)
    expect(h.sendMessage).toHaveBeenCalledWith({ type: 'MARKING_STATE_SYNC', marking: true })
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
