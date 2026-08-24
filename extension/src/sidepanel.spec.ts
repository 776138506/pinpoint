/**
 * sidepanel.ts 异常边界回归（2026-08-24，jsdom）。
 *
 * 覆盖的缺口：
 *  ① port 断开瞬间在飞的发送永远等不到 SEND_RESULT → 卡「发送中」按钮永久禁用；
 *    修复：断开时 sending 项如实降级为 error（不自动重发，session.prompt 非幂等）
 *  ② port 断开后自动重连（1s），重连成功补发 HEALTH_CHECK/LIST_SESSIONS
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: never[]) => unknown

interface PortStub {
  postMessage: ReturnType<typeof vi.fn>
  fireMessage: (msg: unknown) => void
  fireDisconnect: () => void
}

interface Harness {
  connect: ReturnType<typeof vi.fn>
  ports: PortStub[]
}

const PANEL_DOM = `
  <div id="status" class="status checking"></div>
  <select id="session-select"></select>
  <button id="create-session"></button>
  <button id="refresh-sessions"></button>
  <button id="toggle-marking"></button>
  <div id="mark-hint"></div>
  <div id="outbox"></div>
  <button id="send-all"></button>
  <button id="clear-all"></button>
  <div id="empty-hint"></div>
  <button id="open-options"></button>
`

function setup(): Harness {
  const ports: PortStub[] = []
  const connect = vi.fn(() => {
    const messageListeners: Listener[] = []
    const disconnectListeners: Listener[] = []
    const stub: PortStub = {
      postMessage: vi.fn(),
      fireMessage: (msg) => { for (const fn of messageListeners) fn(msg as never) },
      fireDisconnect: () => { for (const fn of disconnectListeners) fn() },
    }
    ports.push(stub)
    return {
      postMessage: stub.postMessage,
      onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn: Listener) => disconnectListeners.push(fn) },
    }
  })
  vi.stubGlobal('chrome', {
    runtime: { connect, openOptionsPage: vi.fn() },
    storage: {
      local: { get: () => Promise.resolve({}) },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: () => Promise.resolve({}),
    },
  })
  document.body.innerHTML = PANEL_DOM
  return { connect, ports }
}

const MARK = {
  index: 1,
  selector: '#x',
  text: 'hello',
  html: '<div>x</div>',
  source: '页',
  sourceUrl: 'https://example.com',
  sourceTitle: '页',
  frameKind: 'main',
  screenshot: '',
  hasExternalImage: false,
  time: '2026-08-24T00:00:00Z',
  status: 'draft',
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('port 断开的在飞发送（sending 卡死修复）', () => {
  it('断开时 sending 项降级为 error 且可手动重发，不自动重发', async () => {
    const h = setup()
    await import('./sidepanel.ts')
    const port = h.ports[0]

    // 一个会话 + 一个暂存项
    port.fireMessage({ type: 'SESSIONS', sessions: [{ sessionId: 's1', updatedAt: 1, title: '测试会话' }] })
    port.fireMessage({ type: 'STATUS', connected: true })
    port.fireMessage({ type: 'STAGE_MARK', mark: { ...MARK }, tabId: 5 })
    await flush()
    expect(document.querySelector('.outbox-meta')?.textContent).toContain('待发送')

    // 点「发送」→ sending
    const sendBtn = document.querySelector<HTMLButtonElement>('.outbox-actions button')!
    sendBtn.click()
    await flush()
    expect(document.querySelector('.outbox-meta')?.textContent).toContain('发送中')
    const sendCallsBefore = port.postMessage.mock.calls.filter(c => (c[0] as { type?: string }).type === 'SEND_MARK').length
    expect(sendCallsBefore).toBe(1)

    // port 断开（SW 死亡）：在飞发送必须降级，不得永久卡 sending
    port.fireDisconnect()
    await flush()
    const meta = document.querySelector('.outbox-meta')?.textContent ?? ''
    expect(meta).toContain('失败')
    expect(meta).toContain('连接中断')
    // 不自动重发：SEND_MARK 仍只有 1 次
    expect(port.postMessage.mock.calls.filter(c => (c[0] as { type?: string }).type === 'SEND_MARK')).toHaveLength(1)
    // 吸收本用例触发的重连定时器，避免泄漏到下一个用例（共享全局 chrome stub）
    await new Promise(r => setTimeout(r, 1300))
  })
})

describe('port 断线自动重连', () => {
  it('断开后 1s 内重连并补发健康检查与会话列表', async () => {
    const h = setup()
    await import('./sidepanel.ts')
    expect(h.connect).toHaveBeenCalledTimes(1)
    h.ports[0].fireDisconnect()
    await new Promise(r => setTimeout(r, 1300))
    await flush()
    expect(h.connect).toHaveBeenCalledTimes(2)
    const posted = h.ports[1].postMessage.mock.calls.map(c => (c[0] as { type?: string }).type)
    expect(posted).toContain('HEALTH_CHECK')
    expect(posted).toContain('LIST_SESSIONS')
  }, 10000)
})

describe('connect 持续失败（扩展失效）的退避与放弃（2026-08-24）', () => {
  it('指数退避重试，连续失败 10 次后放弃并提示重开侧边栏', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.connect.mockImplementation(() => { throw new Error('Extension context invalidated') })
      await import('./sidepanel.ts')
      // 退避序列 1s,2s,4s,8s,16s,30s×4 ≈ 121s，一次推完
      await vi.advanceTimersByTimeAsync(200000)
      expect(h.connect).toHaveBeenCalledTimes(10)
      const status = document.getElementById('status')?.textContent ?? ''
      expect(status).toContain('扩展已失效')
      // 放弃后不再重试
      await vi.advanceTimersByTimeAsync(120000)
      expect(h.connect).toHaveBeenCalledTimes(10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('首次 connect 失败后恢复：退避重试成功即正常工作', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      let fail = true
      h.connect.mockImplementation(() => {
        if (fail) throw new Error('Extension context invalidated')
        // 恢复后走正常 stub（mockImplementation 需返回 port 形态——复用原实现不可行，手工还原）
        const messageListeners: Listener[] = []
        const disconnectListeners: Listener[] = []
        const stub: PortStub = {
          postMessage: vi.fn(),
          fireMessage: (msg) => { for (const fn of messageListeners) fn(msg as never) },
          fireDisconnect: () => { for (const fn of disconnectListeners) fn() },
        }
        h.ports.push(stub)
        return {
          postMessage: stub.postMessage,
          onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
          onDisconnect: { addListener: (fn: Listener) => disconnectListeners.push(fn) },
        }
      })
      await import('./sidepanel.ts')
      expect(h.connect).toHaveBeenCalledTimes(1)
      fail = false
      await vi.advanceTimersByTimeAsync(1100) // 第一次退避 1s
      expect(h.connect).toHaveBeenCalledTimes(2)
      const posted = h.ports.at(-1)!.postMessage.mock.calls.map(c => (c[0] as { type?: string }).type)
      expect(posted).toContain('HEALTH_CHECK')
    } finally {
      vi.useRealTimers()
    }
  })
})
