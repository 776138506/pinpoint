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
  tabsQuery: ReturnType<typeof vi.fn>
  sessionGet: ReturnType<typeof vi.fn>
  sessionSet: ReturnType<typeof vi.fn>
}

function setup(): Harness {
  const listeners: Record<string, Listener[]> = {}
  const on = (name: string) => ({
    addListener: (fn: Listener) => { (listeners[name] ??= []).push(fn) },
  })
  const portMessages: unknown[] = []
  const sendMessage = vi.fn<(tabId: number, msg: unknown) => Promise<unknown>>()
  const executeScript = vi.fn<() => Promise<unknown>>()
  const tabsQuery = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([{ id: 7 }])) // 活动 tab = 不支持页
  const sessionGet = vi.fn<() => Promise<Record<string, unknown>>>(() => Promise.resolve({}))
  const sessionSet = vi.fn<() => Promise<void>>(() => Promise.resolve())

  const chromeStub = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    runtime: {
      onConnect: on('connect'),
      onMessage: on('message'),
    },
    commands: { onCommand: on('command') },
    tabs: {
      query: tabsQuery,
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
      session: { get: sessionGet, set: sessionSet },
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
    tabsQuery,
    sessionGet,
    sessionSet,
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

describe('侧栏（重）连时探测活动 tab 真实标记态（2026-08-24）', () => {
  it('探到标记中 → 侧栏按钮同步为退出标记', async () => {
    const h = setup()
    h.sendMessage.mockResolvedValue({ marking: true }) // GET_STATE 响应
    await import('./background.ts')
    h.fireConnect()
    await flush()
    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states.at(-1)).toMatchObject({ marking: true })
    // 探测结果进跟踪表：随后整页导航应出清并回推 false
    h.portMessages.length = 0
    h.fireTabUpdated(7, { status: 'loading', url: 'chrome://version' })
    await flush()
    const after = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(after.at(-1)).toMatchObject({ marking: false })
  })

  it('活动页无 content script（不支持页）→ 探测失败不回推，保持默认', async () => {
    const h = setup()
    h.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'))
    await import('./background.ts')
    h.fireConnect()
    await flush()
    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states).toHaveLength(0)
  })
})

/** 构造一个最小合法 Mark（字段齐全即可，值不参与断言的从简） */
function fakeMark(index: number, text = 't'): Record<string, unknown> {
  return {
    index, selector: 'div', text, html: '', source: '页面', frameKind: 'main',
    screenshot: '', hasExternalImage: false, time: '2026-08-24T00:00:00Z', status: 'pending',
  }
}

describe('暂存队列恢复合并与去重（2026-08-24 数据丢失修复）', () => {
  it('SW 重启恢复完成前到达的新 STAGE_MARK 不再导致已持久化暂存被丢弃', async () => {
    const h = setup()
    // 恢复挂起，模拟 SW 重启后 storage 读取尚未完成
    let resolveGet!: (v: Record<string, unknown>) => void
    h.sessionGet.mockImplementation(() => new Promise<Record<string, unknown>>((res) => { resolveGet = res }))
    await import('./background.ts')
    // 恢复完成前，新标记到达且侧栏未连 → 入内存队列
    h.fireContentMessage({ type: 'STAGE_MARK', mark: fakeMark(2, 'new') }, { tab: { id: 5 } })
    resolveGet({ stagedQueue: [{ mark: fakeMark(1, 'persisted'), tabId: 5 }] })
    await flush()
    h.fireConnect()
    await flush()
    const staged = h.portMessages.filter((m) => (m as { type?: string }).type === 'STAGE_MARK')
    const indexes = staged.map((m) => (m as { mark: { index: number } }).mark.index).sort()
    expect(indexes).toEqual([1, 2])
  })

  it('恢复数据与内存队列按 (tabId, index) 去重，内存中新到的为准', async () => {
    const h = setup()
    let resolveGet!: (v: Record<string, unknown>) => void
    h.sessionGet.mockImplementation(() => new Promise<Record<string, unknown>>((res) => { resolveGet = res }))
    await import('./background.ts')
    h.fireContentMessage({ type: 'STAGE_MARK', mark: fakeMark(1, 'newer') }, { tab: { id: 5 } })
    resolveGet({ stagedQueue: [{ mark: fakeMark(1, 'stale'), tabId: 5 }] })
    await flush()
    h.fireConnect()
    await flush()
    const staged = h.portMessages.filter((m) => (m as { type?: string }).type === 'STAGE_MARK')
    expect(staged).toHaveLength(1)
    expect((staged[0] as { mark: { text: string } }).mark.text).toBe('newer')
  })

  it('无侧栏时重复暂存同一 (tabId, index)：缓冲只保留最新一条', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireContentMessage({ type: 'STAGE_MARK', mark: fakeMark(1, 'first') }, { tab: { id: 5 } })
    h.fireContentMessage({ type: 'STAGE_MARK', mark: fakeMark(1, 'second') }, { tab: { id: 5 } })
    await flush()
    h.fireConnect()
    await flush()
    const staged = h.portMessages.filter((m) => (m as { type?: string }).type === 'STAGE_MARK')
    expect(staged).toHaveLength(1)
    expect((staged[0] as { mark: { text: string } }).mark.text).toBe('second')
  })
})

describe('toggle 完成后回推当前活动 tab 的标记态（2026-08-24）', () => {
  it('toggle 异步期间用户切走：侧栏显示新活动 tab 的状态而非被操作 tab 的', async () => {
    const h = setup()
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0
    h.sendMessage.mockResolvedValue({ marking: true }) // tab 7 toggle 成功进入标记
    let calls = 0
    h.tabsQuery.mockImplementation(() => {
      calls += 1
      // 第一次（toggle 目标）是 tab 7；完成时的重查返回已切到的 tab 9（未标记）
      return Promise.resolve([{ id: calls === 1 ? 7 : 9 }])
    })
    h.firePanelMessage({ type: 'TOGGLE_MARKING' })
    await flush()
    const states = h.portMessages.filter((m) => (m as { type?: string }).type === 'MARKING_STATE')
    expect(states.at(-1)).toMatchObject({ marking: false })
  })
})

describe('rpc 响应信封与输入校验（2026-08-24）', () => {
  it('200 但缺 result 字段：transport 错误而非调用方 TypeError', async () => {
    const h = setup()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      return { ok: true, json: async () => ({ type: 'server-response', rpcId }) }
    }))
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0
    h.firePanelMessage({ type: 'LIST_SESSIONS' })
    await flush()
    const errs = h.portMessages.filter((m) => (m as { type?: string }).type === 'SESSIONS_ERROR')
    expect(errs).toHaveLength(1)
    expect((errs[0] as { error: string }).error).toContain('malformed response envelope')
  })

  it('session.list 逐项过滤无 sessionId 的脏条目', async () => {
    const h = setup()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const { rpcId } = JSON.parse(init.body) as { rpcId: string }
      return {
        ok: true,
        json: async () => ({
          type: 'server-response',
          rpcId,
          result: { ok: true, value: { items: [{ sessionId: 'a', updatedAt: 1 }, { updatedAt: 2 }, null] } },
        }),
      }
    }))
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0
    h.firePanelMessage({ type: 'LIST_SESSIONS' })
    await flush()
    const msgs = h.portMessages.filter((m) => (m as { type?: string }).type === 'SESSIONS')
    expect(msgs).toHaveLength(1)
    const sessions = (msgs[0] as { sessions: Array<{ sessionId: string }> }).sessions
    expect(sessions.map((s) => s.sessionId)).toEqual(['a'])
  })

  it('SEND_MARK 缺 mark.index：malformed 且不发 rpc', async () => {
    const h = setup()
    const fetchMock = vi.fn(() => Promise.reject(new Error('no server in test')))
    vi.stubGlobal('fetch', fetchMock)
    await import('./background.ts')
    h.fireConnect()
    await flush()
    h.portMessages.length = 0
    const before = fetchMock.mock.calls.length
    h.firePanelMessage({ type: 'SEND_MARK', sessionId: 's1', mark: { selector: 'div' }, comment: 'c', tabId: 5 })
    await flush()
    const results = h.portMessages.filter((m) => (m as { type?: string }).type === 'SEND_RESULT')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, error: 'malformed SEND_MARK' })
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})
