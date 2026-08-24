/**
 * background.ts 标记态回归测试（2026-08-24）。
 *
 * 复现的 bug：在支持页开启标记后，导航到/切到不支持页面（chrome://、应用店、
 * PDF 查看器——content script 无法注入），侧栏按钮卡在「退出标记」，点击只会
 * 收到 MARKING_ERROR，永远无法退出（留白缺口：不支持页没有状态落点）。
 *
 * chrome API 全部以 stub 注入，通过动态 import 让每个用例拿到全新模块实例。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: never[]) => unknown

interface Harness {
  portMessages: unknown[]
  fireConnect: () => void
  firePanelMessage: (msg: unknown) => void
  fireContentMessage: (msg: unknown, sender: { tab?: { id: number } }) => void
  fireTabUpdated: (tabId: number, changeInfo: { status?: string; url?: string }) => void
  sendMessage: ReturnType<typeof vi.fn>
  executeScript: ReturnType<typeof vi.fn>
}

function setup(): Harness {
  const listeners: Record<string, Listener[]> = {}
  const on = (name: string) => ({
    addListener: (fn: Listener) => { (listeners[name] ??= []).push(fn) },
  })
  const portMessages: unknown[] = []
  const sendMessage = vi.fn<(tabId: number, msg: unknown) => Promise<unknown>>()
  const executeScript = vi.fn<() => Promise<unknown>>()

  const chromeStub = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    runtime: {
      onConnect: on('connect'),
      onMessage: on('message'),
    },
    commands: { onCommand: on('command') },
    tabs: {
      query: () => Promise.resolve([{ id: 7 }]), // 活动 tab = 不支持页
      get: (tabId: number) => Promise.resolve({ id: tabId }),
      update: () => Promise.resolve({}),
      sendMessage,
      onUpdated: on('tabUpdated'),
      onRemoved: on('tabRemoved'),
      onActivated: on('tabActivated'),
    },
    windows: { update: () => Promise.resolve({}) },
    scripting: { executeScript },
    storage: {
      local: { get: () => Promise.resolve({}) },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: on('storageChanged'),
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
  }
  vi.stubGlobal('chrome', chromeStub)
  // 连接检查会走 fetch，立即失败即可（走 STATUS 分支，不影响断言）
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no server in test'))))

  const port = {
    name: 'dsh-point-panel',
    postMessage: (msg: unknown) => { portMessages.push(msg) },
    onDisconnect: on('portDisconnect'),
    onMessage: on('portMessage'),
  }

  return {
    portMessages,
    sendMessage,
    executeScript,
    fireConnect: () => { for (const fn of listeners.connect ?? []) fn(port as never) },
    firePanelMessage: (msg: unknown) => { for (const fn of listeners.portMessage ?? []) void fn(msg as never) },
    fireContentMessage: (msg: unknown, sender: { tab?: { id: number } }) => {
      for (const fn of listeners.message ?? []) fn(msg as never, sender as never, (() => false) as never)
    },
    fireTabUpdated: (tabId: number, changeInfo: { status?: string; url?: string }) => {
      for (const fn of listeners.tabUpdated ?? []) fn(tabId as never, changeInfo as never)
    },
  }
}

/** 等待异步消息处理链走完 */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('标记态在不支持页面的复归（2026-08-24 bug）', () => {
  it('活动页不支持标记但仍有 tab 在标记：toggle 视为退出，不报 MARKING_ERROR', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0

    // tab 5（支持页）进入标记态
    h.fireContentMessage({ type: 'MARKING_STATE_SYNC', marking: true }, { tab: { id: 5 } })
    await flush()

    // 切到不支持页（活动 tab 7：sendMessage 与注入都失败），点「退出标记」
    h.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'))
    h.executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'))
    h.firePanelMessage({ type: 'TOGGLE_MARKING' })
    await flush()

    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    const errors = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_ERROR')
    expect(errors).toHaveLength(0)
    expect(states.at(-1)).toMatchObject({ marking: false })
    // 仍在标记的 tab 5 应收到强制退出
    expect(h.sendMessage).toHaveBeenCalledWith(5, { type: 'SET_MARKING', marking: false })
  })

  it('标记中的 tab 整页导航后：状态出清并同步侧栏按钮', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0

    h.fireContentMessage({ type: 'MARKING_STATE_SYNC', marking: true }, { tab: { id: 5 } })
    await flush()
    h.portMessages.length = 0

    // tab 5 导航到不支持页（整页加载，content script 重建后标记态必为 false）
    h.fireTabUpdated(5, { status: 'loading', url: 'chrome://extensions' })
    await flush()

    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states.at(-1)).toMatchObject({ marking: false })

    // 之后在任意不支持页点 toggle：无标记残留，走原错误提示而非卡死
    h.portMessages.length = 0
    h.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'))
    h.executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'))
    h.firePanelMessage({ type: 'TOGGLE_MARKING' })
    await flush()
    const errors = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_ERROR')
    expect(errors).toHaveLength(1)
  })

  it('SPA 导航（仅 url 变化无 loading）不误清标记态', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireConnect()
    await flush()

    h.fireContentMessage({ type: 'MARKING_STATE_SYNC', marking: true }, { tab: { id: 5 } })
    await flush()
    h.portMessages.length = 0

    h.fireTabUpdated(5, { url: 'https://spa.example/another-route' })
    await flush()
    // 不应向侧栏推送 marking=false
    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states).toHaveLength(0)
  })

  it('正常 toggle 成功路径仍会更新按 tab 跟踪的状态', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0

    // 活动 tab 7 是支持页：toggle 成功进入标记
    h.sendMessage.mockResolvedValue({ marking: true })
    h.firePanelMessage({ type: 'TOGGLE_MARKING' })
    await flush()
    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states.at(-1)).toMatchObject({ marking: true })

    // tab 7 随后整页导航 → 状态出清、侧栏收到 marking=false
    h.portMessages.length = 0
    h.fireTabUpdated(7, { status: 'loading', url: 'https://example.com/next' })
    await flush()
    const after = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(after.at(-1)).toMatchObject({ marking: false })
  })
})
