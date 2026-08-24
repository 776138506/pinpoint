/**
 * dsh-point browser extension service worker (background).
 *
 * Responsibilities:
 *  - Hold the long-lived port to the side panel.
 *  - Relay staged marks from content scripts to the side panel.
 *  - Fetch against localhost:8897 on behalf of the side panel (session.list,
 *    session.create, session.prompt).
 *  - Downgrade to text-only when an image attachment is rejected by harness.
 */
import { formatMark } from '../../src/schema/mark-format.ts'
import type { Mark } from '../../src/client/stores.ts'
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type ExtSettings } from './settings.ts'

// 2026-08-21: 实例地址等参数可调（不器整改），SW 侧缓存 + storage 变更热更新
let settings: ExtSettings = { ...DEFAULT_SETTINGS }
void loadSettings().then((s) => { settings = s })
onSettingsChanged((s) => { settings = s })

// 2026-08-20: 点击工具栏图标直接打开侧边栏（无需右键菜单）
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[dsh-point-ext] setPanelBehavior failed:', e))
}

interface RpcEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface RpcError {
  code: string
  message: string
  details: Record<string, unknown>
}

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

let panelPort: chrome.runtime.Port | null = null

async function rpc<T>(method: string, payload: unknown): Promise<RpcResult<T>> {
  const rpcId = crypto.randomUUID()
  const envelope: RpcEnvelope = { type: 'client-request', rpcId, method, payload }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), settings.rpcTimeoutMs)
  try {
    const res = await fetch(`${settings.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: ctl.signal,
    })
    if (!res.ok) {
      // 2026-08-21: 错误体截断——非 dsh 服务会回整页 HTML，原样显示会撑爆状态栏
      const text = (await res.text().catch(() => '')).slice(0, 120)
      return { ok: false, error: { code: 'transport', message: `HTTP ${res.status}: ${text}`, details: {} } }
    }
    const full = await res.json() as { type: 'server-response'; rpcId: string; result: RpcResult<T> }
    if (full.rpcId !== rpcId) {
      return { ok: false, error: { code: 'transport', message: `rpcId mismatch for ${method}`, details: {} } }
    }
    return full.result
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: { code: 'transport', message: `rpc ${method} timed out after ${settings.rpcTimeoutMs}ms`, details: {} } }
    }
    return { ok: false, error: { code: 'transport', message: err instanceof Error ? err.message : String(err), details: {} } }
  } finally {
    clearTimeout(timer)
  }
}

async function checkConnection(): Promise<{ connected: boolean; error?: string }> {
  const result = await rpc('session.list', {})
  return result.ok
    ? { connected: true }
    : { connected: false, error: result.error.message }
}

/**
 * 2026-08-20: 切换标记模式，content script 未注入时按需注入后重试一次。
 * 页面先于扩展安装/重载打开时，MV3 不会自动补注入，直接 sendMessage 会
 * "Receiving end does not exist" 静默失败（侧栏点击「开始标记」无反应的根因）。
 */
async function toggleMarkingOnTab(tabId: number): Promise<{ marking?: boolean; error?: string }> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_MARKING' }) as { marking?: boolean }
    return { marking: res?.marking }
  } catch (e) {
    console.debug('[dsh-point-ext] initial sendMessage failed, injecting content script:', e)
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] })
      const res = await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_MARKING' }) as { marking?: boolean }
      return { marking: res?.marking }
    } catch (e) {
      console.error('[dsh-point-ext] toggle marking failed:', e)
      return { error: '当前页面不支持标记（浏览器内部页 / PDF 查看器 / 扩展页），或刷新该网页后重试' }
    }
  }
}

/**
 * 2026-08-24: 标记态按 tab 跟踪（复归整改）。
 * 用户痛点：在支持页开启标记后切到/导航到不支持页（chrome://、应用店、PDF），
 * 退出无路——toggle 以活动 tab 为目标，注入失败即报错，侧栏按钮卡在「退出标记」。
 * 修复三件套：①map 跟踪哪些 tab 在标记 ②整页导航/关 tab 自动出清并同步侧栏
 * ③活动页不支持标记但仍有 tab 在标记时，toggle 视为「退出全部标记」而非报错。
 * ponytail: 纯内存，SW 死亡会丢跟踪——代价是退回旧行为（报错提示），可接受。
 */
const markingTabs = new Set<number>()

function setTabMarking(tabId: number | undefined, marking: boolean | undefined): void {
  if (tabId === undefined || typeof marking !== 'boolean') return
  if (marking) markingTabs.add(tabId); else markingTabs.delete(tabId)
}

/** 强制退出所有仍在标记的 tab（best-effort：页面已导航的由 onUpdated 兜底出清） */
async function forceExitMarking(): Promise<void> {
  const tabs = [...markingTabs]
  markingTabs.clear()
  for (const id of tabs) {
    try {
      await chrome.tabs.sendMessage(id, { type: 'SET_MARKING', marking: false })
    } catch (e) {
      console.debug('[dsh-point-ext] force exit: tab unreachable (navigated?), cleared locally:', e)
    }
  }
}

// 整页加载后 content script 重建、标记态必为 false——出清并同步侧栏按钮。
// 只认 status:'loading'：SPA 的 pushState 只带 url 不带 loading，误清会丢真标记态
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && markingTabs.delete(tabId)) {
    postToPanel({ type: 'MARKING_STATE', marking: false })
  }
})
chrome.tabs.onRemoved.addListener((tabId) => { markingTabs.delete(tabId) })
// 切 tab 后侧栏按钮反映新活动 tab 的标记态（未知即未标记）
chrome.tabs.onActivated.addListener(({ tabId }) => {
  postToPanel({ type: 'MARKING_STATE', marking: markingTabs.has(tabId) })
})

function extractBase64(dataUrl: string): string | null {
  const m = /^data:image\/[a-zA-Z0-9.+]+;base64,(.+)$/s.exec(dataUrl)
  return m ? m[1] : null
}

function contentParts(mark: Mark, comment: string): { type: string; text?: string; mediaType?: string; data?: string; name?: string }[] {
  const parts: { type: string; text?: string; mediaType?: string; data?: string; name?: string }[] = [
    { type: 'text', text: formatMark(mark, comment) },
  ]
  if (mark.screenshot) {
    const data = extractBase64(mark.screenshot)
    if (data) {
      parts.push({ type: 'image', mediaType: 'image/png', data, name: `point-${mark.index}.png` })
    }
  }
  return parts
}

async function sendPrompt(sessionId: string, mark: Mark, comment: string): Promise<{ ok: boolean; error?: string; downgraded?: boolean }> {
  const parts = contentParts(mark, comment)
  const imagePart = parts.find(p => p.type === 'image')
  const result = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: parts,
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  if (result.ok) return { ok: true }
  if (imagePart && result.error.code === 'attachment-error') {
    // Downgrade to text-only and surface the downgrade explicitly.
    const textResult = await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: formatMark(mark, comment) }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    return textResult.ok
      ? { ok: true, downgraded: true }
      : { ok: false, error: textResult.error.message }
  }
  return { ok: false, error: result.error.message }
}

/**
 * 2026-08-21: 跳转定位——激活标记所在标签页并让 content script 滚动+闪烁。
 * content script 缺失时按需注入重试一次（注入后标记状态为空，会如实回报不存在）。
 */
async function focusMarkOnTab(tabId: number, index: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId)
    await chrome.tabs.update(tabId, { active: true })
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true })
  } catch (e) {
    return { ok: false, error: '标记所在的标签页已关闭' }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'FOCUS_MARK', index }) as { ok?: boolean; error?: string }
      return res?.ok ? { ok: true } : { ok: false, error: res?.error || '定位失败' }
    } catch (e) {
      if (attempt === 0) {
        console.debug('[dsh-point-ext] focus sendMessage failed, injecting content script:', e)
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] })
        } catch (e2) {
          console.error('[dsh-point-ext] focus inject failed:', e2)
          return { ok: false, error: '无法定位（页面已刷新或导航，标记已失效）' }
        }
      } else {
        console.error('[dsh-point-ext] focus mark failed:', e)
        return { ok: false, error: '无法定位（页面已刷新或导航，标记已失效）' }
      }
    }
  }
  return { ok: false, error: '定位失败' }
}

function postToPanel(message: unknown): void {
  if (panelPort) {
    try { panelPort.postMessage(message) } catch (e) { console.error('[dsh-point-ext] post to panel failed:', e) }
  }
}

// Side panel connection.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-point-panel') return
  panelPort = port
  checkConnection()
    .then(status => postToPanel({ type: 'STATUS', ...status }))
    .catch(e => postToPanel({ type: 'STATUS', connected: false, error: String(e) }))
  // 冲刷侧栏关闭期间缓冲的标记（等恢复完成再冲，见 queueReady 注释）
  void queueReady.then(() => {
    while (stagedQueue.length > 0) {
      const item = stagedQueue.shift()
      postToPanel({ type: 'STAGE_MARK', mark: item?.mark, sendNow: item?.sendNow, tabId: item?.tabId })
    }
    void persistQueue()
  })
  // 2026-08-21: 多窗口可各开一个侧栏（多个 port），只有当前持有的 port 断开才置空，
  // 否则关掉旧侧栏会把新侧栏的引用一起清空，后续标记误入缓冲队列
  port.onDisconnect.addListener(() => { if (panelPort === port) panelPort = null })
  port.onMessage.addListener(async (message) => {
    if (!message || typeof message !== 'object') return
    try {
      switch (message.type) {
        case 'HEALTH_CHECK': {
          const status = await checkConnection()
          postToPanel({ type: 'STATUS', ...status })
          break
        }
        case 'LIST_SESSIONS': {
          const result = await rpc('session.list', {})
          if (!result.ok) {
            postToPanel({ type: 'SESSIONS_ERROR', error: result.error.message })
            break
          }
          // 2026-08-20: 会话标题在 projections.values.title，顶层没有 title 字段
          type SessionItem = { sessionId: string; updatedAt: number; blank?: boolean; projections?: { values?: { title?: string } } }
          const value = result.value as { items?: unknown }
          if (!Array.isArray(value.items)) {
            postToPanel({ type: 'SESSIONS_ERROR', error: 'malformed session.list payload' })
            break
          }
          const sessions = (value.items as SessionItem[]).map(item => ({
            sessionId: item.sessionId,
            updatedAt: item.updatedAt,
            blank: item.blank,
            title: item.projections?.values?.title ?? null,
          }))
          postToPanel({ type: 'SESSIONS', sessions })
          break
        }
        case 'CREATE_SESSION': {
          const result = await rpc('session.create', {})
          if (!result.ok) {
            postToPanel({ type: 'SESSION_CREATED', error: result.error.message })
            break
          }
          const value = result.value as { sessionId?: unknown }
          if (typeof value.sessionId !== 'string') {
            postToPanel({ type: 'SESSION_CREATED', error: 'malformed session.create payload' })
            break
          }
          postToPanel({ type: 'SESSION_CREATED', sessionId: value.sessionId })
          break
        }
        case 'SEND_MARK': {
          const m = message as Partial<{ sessionId: string; mark: Mark; comment: string; tabId: number }>
          if (typeof m.sessionId !== 'string' || !m.mark || typeof m.comment !== 'string') {
            postToPanel({ type: 'SEND_RESULT', markIndex: -1, ok: false, error: 'malformed SEND_MARK' })
            break
          }
          const outcome = await sendPrompt(m.sessionId, m.mark, m.comment)
          // 2026-08-21: 透传 tabId，侧栏按 (tabId, index) 复合键定位暂存项
          postToPanel({ type: 'SEND_RESULT', markIndex: m.mark.index, tabId: m.tabId, ...outcome })
          break
        }
        case 'TOGGLE_MARKING': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (!tab?.id) {
            postToPanel({ type: 'MARKING_ERROR', error: '没有活动标签页' })
            break
          }
          const outcome = await toggleMarkingOnTab(tab.id)
          if (outcome.error) {
            // 2026-08-24: 活动页不支持标记但仍有 tab 在标记——用户意图是退出，强制出清
            if (markingTabs.size > 0) {
              await forceExitMarking()
              postToPanel({ type: 'MARKING_STATE', marking: false })
            } else {
              postToPanel({ type: 'MARKING_ERROR', error: outcome.error })
            }
          } else {
            setTabMarking(tab.id, outcome.marking)
            postToPanel({ type: 'MARKING_STATE', marking: outcome.marking })
          }
          break
        }
        case 'FOCUS_MARK': {
          const m = message as Partial<{ tabId: number; index: number }>
          if (typeof m.tabId !== 'number' || typeof m.index !== 'number') {
            postToPanel({ type: 'FOCUS_RESULT', index: -1, ok: false, error: 'malformed FOCUS_MARK' })
            break
          }
          const outcome = await focusMarkOnTab(m.tabId, m.index)
          postToPanel({ type: 'FOCUS_RESULT', index: m.index, ...outcome })
          break
        }
        default:
          break
      }
    } catch (err) {
      console.error('[dsh-point-ext] panel message handler failed:', err)
      postToPanel({ type: 'STATUS', connected: false, error: '内部错误，请刷新侧栏' })
    }
  })
})

// 2026-08-20: 侧栏关闭期间暂存的标记，侧栏重连时冲刷（配合快捷键标记，不要求侧栏常开）
// 2026-08-21: 携带 tabId（标记来源页），供暂存列表跳转定位
// 2026-08-21: 持久化到 chrome.storage.session——MV3 的 SW 随时被杀死，
// 纯内存队列会在 SW 死亡时丢暂存、页面残留高亮（不变量破）。
// ponytail: 截图 dataURL 可能超 storage.session 配额（10MB），超限时只记日志退回纯内存
const stagedQueue: Array<{ mark: Mark; sendNow?: boolean; tabId?: number }> = []
const STAGED_KEY = 'stagedQueue'

// 2026-08-21: 恢复是异步的，冲刷队列前必须 await 它——否则 SW 重启后侧栏快速重连，
// 会用尚未恢复的空队列覆盖 storage 里已持久化的暂存（数据丢失，本次实测踩中）
const queueReady: Promise<void> = chrome.storage.session.get(STAGED_KEY).then((data) => {
  const saved = data[STAGED_KEY]
  if (Array.isArray(saved) && stagedQueue.length === 0) {
    stagedQueue.push(...saved as typeof stagedQueue)
  }
}).catch((e) => console.error('[dsh-point-ext] restore staged queue failed:', e))

function persistQueue(): void {
  chrome.storage.session.set({ [STAGED_KEY]: stagedQueue })
    .catch((e) => console.error('[dsh-point-ext] persist staged queue failed (quota?):', e))
}

// Content script -> background -> panel relay.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  if (message.type === 'STAGE_MARK') {
    const mark = message.mark as Mark | undefined
    if (!mark || typeof mark.index !== 'number') {
      sendResponse({ ok: false, error: 'malformed mark' })
      return false
    }
    const tabId = sender.tab?.id
    if (!panelPort) {
      stagedQueue.push({ mark, sendNow: message.sendNow, tabId })
      persistQueue()
      sendResponse({ ok: true, buffered: true })
      return false
    }
    postToPanel({ type: 'STAGE_MARK', mark, sendNow: message.sendNow, tabId })
    sendResponse({ ok: true })
    return false
  }
  if (message.type === 'MARKING_STATE_SYNC') {
    // content script 内自定义快捷键切换后同步侧栏按钮状态
    // 2026-08-24: 同步进按 tab 跟踪（切 tab/导航出清的前提）
    setTabMarking(sender.tab?.id, message.marking)
    postToPanel({ type: 'MARKING_STATE', marking: message.marking })
    sendResponse({ ok: true })
    return false
  }
  return false
})

// 2026-08-20: 全局快捷键 Alt+Shift+M 开始/退出标记（manifest commands）。
// 失败时用角标「!」提示（快捷键场景没有面板可显示错误）。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-marking') return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    const outcome = await toggleMarkingOnTab(tab.id)
    if (outcome.error) {
      // 2026-08-24: 与侧栏路径同一语义——仍有 tab 在标记时视为退出全部
      if (markingTabs.size > 0) {
        await forceExitMarking()
        postToPanel({ type: 'MARKING_STATE', marking: false })
      } else {
        await chrome.action.setBadgeText({ text: '!' })
        await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
        setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 3000)
      }
    } else {
      setTabMarking(tab.id, outcome.marking)
      postToPanel({ type: 'MARKING_STATE', marking: outcome.marking })
    }
  } catch (e) {
    console.error('[dsh-point-ext] command handler failed:', e)
  }
})
