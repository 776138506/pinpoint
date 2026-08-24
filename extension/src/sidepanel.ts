/**
 * dsh-point browser extension side panel.
 *
 * - Connection status to localhost:8897.
 * - Target session selector + create new session.
 * - Outbox of staged marks (send all / send one / delete).
 * - Two-way sync with the content script of the active tab.
 */
import type { Mark, MarkStatus } from '../../src/client/stores.ts'
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type ExtSettings } from './settings.ts'

// 2026-08-21: 可调参数缓存（不器整改），初值默认，加载后刷新
let extSettings: ExtSettings = { ...DEFAULT_SETTINGS }

interface OutboxItem {
  mark: Mark
  status: MarkStatus | 'sending' | 'error'
  error?: string
  downgraded?: boolean
  // 2026-08-21: 标记来源标签页，用于跳转定位与跨 tab 删除/同步
  tabId?: number
}

interface PanelState {
  connected: boolean | null
  statusError?: string
  sessions: Array<{ sessionId: string; updatedAt: number; blank?: boolean; title?: string | null }>
  selectedSessionId: string | null
  outbox: OutboxItem[]
}

const state: PanelState = {
  connected: null,
  sessions: [],
  selectedSessionId: null,
  outbox: [],
}

// 2026-08-21: 暂存项身份 = (tabId, index) 复合键（index 仅 tab 内唯一）
function itemKey(i: { tabId?: number; index: number }): string {
  return `${i.tabId ?? 'legacy'}:${i.index}`
}

// 2026-08-24: port 断线自动重连（复归整改）。MV3 SW 空闲即死、port 随之断开；
// 面板作后台 tab 时健康轮询被 Chrome 节流，撞死 port 后点击按钮静默无反应。
let port: chrome.runtime.Port | null = null

function connectPort(): void {
  let p: chrome.runtime.Port
  try {
    p = chrome.runtime.connect({ name: 'dsh-point-panel' })
  } catch (e) {
    // 扩展重载/更新后旧页面上下文失效，connect 会抛——过 1s 再试
    console.warn('[dsh-point-ext] connect failed, retry in 1s:', e)
    setTimeout(connectAndResync, 1000)
    return
  }
  p.onMessage.addListener(onPortMessage)
  p.onDisconnect.addListener(() => {
    if (port !== p) return
    port = null
    state.connected = false
    state.statusError = '与后台连接已断开，重连中…'
    updateUi()
    setTimeout(connectAndResync, 1000)
  })
  port = p
}

function connectAndResync(): void {
  connectPort()
  // 重连后补齐状态（标记按钮态由后续 toggle/切 tab 事件刷新）
  safePost({ type: 'HEALTH_CHECK' })
  safePost({ type: 'LIST_SESSIONS' })
}

function safePost(message: unknown): void {
  try { port?.postMessage(message) } catch (e) { console.warn('[dsh-point-ext] post to background failed:', e) }
}

connectPort()

function reqEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`[dsh-point-ext] missing #${id} in panel DOM`)
  return el as T
}

/* ---------- DOM refs ---------- */
const statusEl = reqEl<HTMLDivElement>('status')
const sessionSelect = reqEl<HTMLSelectElement>('session-select')
const createSessionBtn = reqEl<HTMLButtonElement>('create-session')
const refreshSessionsBtn = reqEl<HTMLButtonElement>('refresh-sessions')
const toggleMarkingBtn = reqEl<HTMLButtonElement>('toggle-marking')
const markHintEl = reqEl<HTMLDivElement>('mark-hint')
const outboxEl = reqEl<HTMLDivElement>('outbox')
const sendAllBtn = reqEl<HTMLButtonElement>('send-all')
const clearAllBtn = reqEl<HTMLButtonElement>('clear-all')
const emptyHint = reqEl<HTMLDivElement>('empty-hint')
// 2026-08-21: 设置统一迁入扩展选项页（options.html），侧栏只留入口
reqEl<HTMLButtonElement>('open-options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

/* ---------- render ---------- */

function renderStatus(): void {
  // 2026-08-21: 显示配置的实例地址（不器整改前写死 8897）
  const endpoint = extSettings.baseUrl.replace(/^https?:\/\//, '')
  if (state.connected === null) {
    statusEl.textContent = '连接状态：检测中…'
    statusEl.className = 'status checking'
  } else if (state.connected) {
    statusEl.textContent = `连接状态：已连接 ${endpoint}`
    statusEl.className = 'status ok'
  } else {
    statusEl.textContent = `连接状态：未连接 ${endpoint}${state.statusError ? `（${state.statusError}）` : ''}`
    statusEl.className = 'status error'
  }
}

function renderSessions(): void {
  const current = sessionSelect.value
  sessionSelect.innerHTML = ''
  const placeholder = document.createElement('option')
  placeholder.textContent = '请选择目标会话'
  placeholder.value = ''
  placeholder.disabled = true
  placeholder.selected = true
  sessionSelect.appendChild(placeholder)

  const sorted = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const s of sorted) {
    const opt = document.createElement('option')
    opt.value = s.sessionId
    // 2026-08-20: 优先显示会话名称，无标题时回退到 id 尾 8 位
    const name = s.title?.trim()
    opt.textContent = name ? name : `未命名会话 ${s.sessionId.slice(-8)}${s.blank ? '（空白）' : ''}`
    sessionSelect.appendChild(opt)
  }

  if (state.selectedSessionId && sorted.some(s => s.sessionId === state.selectedSessionId)) {
    sessionSelect.value = state.selectedSessionId
  } else if (sorted.length > 0 && !state.selectedSessionId) {
    // Default to the most recently updated session.
    state.selectedSessionId = sorted[0].sessionId
    sessionSelect.value = state.selectedSessionId
  }
}

function renderOutbox(): void {
  outboxEl.innerHTML = ''
  if (state.outbox.length === 0) {
    emptyHint.style.display = ''
    sendAllBtn.disabled = true
    clearAllBtn.disabled = true
    return
  }
  emptyHint.style.display = 'none'
  sendAllBtn.disabled = state.connected !== true
  clearAllBtn.disabled = false

  for (const item of state.outbox) {
    const row = document.createElement('div')
    row.className = 'outbox-item'

    const info = document.createElement('div')
    info.className = 'outbox-info'
    info.textContent = `#${item.mark.index} · ${item.mark.text || '（无可见文本）'}`
    // 2026-08-21: 点击跳转到页面中的标记位置并闪烁提醒
    info.title = '点击跳转到页面中的标记位置'
    info.addEventListener('click', () => focusItem(item))
    row.appendChild(info)

    const meta = document.createElement('div')
    meta.className = 'outbox-meta'
    const statusText =
      item.status === 'pending' ? '待发送' :
      item.status === 'sending' ? '发送中…' :
      item.status === 'sent' ? '已发送' :
      item.status === 'error' ? `失败：${item.error || ''}` :
      '草稿'
    meta.textContent = statusText + (item.downgraded ? ' · 图片已降级为纯文本' : '')
    row.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'outbox-actions'

    const sendBtn = document.createElement('button')
    sendBtn.textContent = '发送'
    sendBtn.disabled = item.status === 'sending' || item.status === 'sent' || state.connected !== true
    sendBtn.addEventListener('click', () => sendItem(item))

    // 2026-08-21: 暂存区内二次编辑评论（已发送的不可再改，改动不影响已发出的消息）
    const editBtn = document.createElement('button')
    editBtn.textContent = '编辑'
    editBtn.disabled = item.status === 'sending' || item.status === 'sent'
    editBtn.addEventListener('click', () => toggleEditor(row, item))

    const delBtn = document.createElement('button')
    delBtn.textContent = '删除'
    delBtn.className = 'danger'
    delBtn.disabled = item.status === 'sending'
    delBtn.addEventListener('click', () => removeItem(item))

    actions.appendChild(sendBtn)
    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    row.appendChild(actions)
    outboxEl.appendChild(row)
  }
}

function updateUi(): void {
  renderStatus()
  renderSessions()
  renderOutbox()
}

/* ---------- actions ---------- */

// 2026-08-21: 行内编辑器。注意：任何 updateUi() 全量重渲染会丢弃未保存的编辑内容
// （ponytail: 冲突窗口小，保存即落库，不加草稿保护；真有需要再做脏检查）
function toggleEditor(row: HTMLDivElement, item: OutboxItem): void {
  const existing = row.querySelector('.outbox-editor')
  if (existing) { existing.remove(); return }
  const editor = document.createElement('div')
  editor.className = 'outbox-editor'
  const ta = document.createElement('textarea')
  ta.value = item.mark.comment ?? ''
  ta.placeholder = '编辑评论…'
  const btns = document.createElement('div')
  btns.className = 'outbox-actions'
  const saveBtn = document.createElement('button')
  saveBtn.textContent = '保存'
  saveBtn.addEventListener('click', () => {
    item.mark.comment = ta.value.trim()
    // 同步页面侧评论窗内容（best-effort：页面可能已关闭/导航）
    void sendToTab(item.tabId, { type: 'UPDATE_MARK', index: item.mark.index, patch: { comment: item.mark.comment } })
    updateUi()
  })
  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = '取消'
  cancelBtn.addEventListener('click', () => editor.remove())
  btns.appendChild(saveBtn)
  btns.appendChild(cancelBtn)
  editor.appendChild(ta)
  editor.appendChild(btns)
  row.appendChild(editor)
  ta.focus()
}

// 2026-08-21: 点击暂存项跳转到标记位置（跨 tab 激活 + 页面内滚动闪烁）
function focusItem(item: OutboxItem): void {
  if (typeof item.tabId !== 'number') {
    markHintEl.textContent = '该标记缺少来源页面信息（可能来自旧版本暂存），无法跳转'
    markHintEl.style.color = '#d97706'
    return
  }
  safePost({ type: 'FOCUS_MARK', tabId: item.tabId, index: item.mark.index })
}

function sendItem(item: OutboxItem): void {
  const sessionId = state.selectedSessionId
  if (!sessionId) {
    item.status = 'error'
    item.error = '未选择目标会话'
    updateUi()
    return
  }
  item.status = 'sending'
  item.error = undefined
  item.downgraded = false
  updateUi()
  safePost({
    type: 'SEND_MARK',
    sessionId,
    mark: item.mark,
    comment: item.mark.comment ?? '',
    // 2026-08-21: 携带 tabId，background 在 SEND_RESULT 原样透传，供复合键定位
    tabId: item.tabId,
  })
}

function removeItem(item: OutboxItem): void {
  state.outbox = state.outbox.filter(i => i !== item)
  updateUi()
  // 2026-08-21: 删除时向标记来源页（而非活动页）发 REMOVE_MARK，避免跨 tab 残留高亮
  void sendToTab(item.tabId, { type: 'REMOVE_MARK', index: item.mark.index })
}

// tabId 缺省时回退到活动标签页（兼容无来源信息的旧暂存）
async function sendToTab(tabId: number | undefined, message: unknown): Promise<unknown> {
  let id = tabId
  if (id === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    id = tab?.id
  }
  if (!id) return undefined
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(id, message),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), extSettings.tabMessageTimeoutMs)),
    ])
  } catch (e) {
    // 2026-08-20: 页面未注入 content script（先于扩展加载）或已导航；删除/清空类调用尽力而为即可
    console.warn('[dsh-point-ext] sendToTab failed:', e)
    return undefined
  }
}

/* ---------- event wiring ---------- */

sessionSelect.addEventListener('change', () => {
  state.selectedSessionId = sessionSelect.value || null
})

createSessionBtn.addEventListener('click', () => {
  safePost({ type: 'CREATE_SESSION' })
})

refreshSessionsBtn.addEventListener('click', () => {
  safePost({ type: 'LIST_SESSIONS' })
})

// 2026-08-20: 切换标记改走 background（支持按需注入 content script + 与快捷键同一路径）
toggleMarkingBtn.addEventListener('click', () => {
  safePost({ type: 'TOGGLE_MARKING' })
})

sendAllBtn.addEventListener('click', () => {
  for (const item of state.outbox) {
    if (item.status !== 'sent' && item.status !== 'sending') {
      sendItem(item)
    }
  }
})

clearAllBtn.addEventListener('click', async () => {
  // 2026-08-21: 清空需覆盖所有来源页（跨 tab 标记），无来源信息时回退活动页
  const tabIds = new Set<number>()
  for (const i of state.outbox) if (typeof i.tabId === 'number') tabIds.add(i.tabId)
  state.outbox = []
  updateUi()
  if (tabIds.size === 0) {
    await sendToTab(undefined, { type: 'CLEAR_MARKS' })
    return
  }
  for (const id of tabIds) await sendToTab(id, { type: 'CLEAR_MARKS' })
})

/* ---------- background port messages ---------- */

// port 消息为动态载荷（与 background 的约定见 protocol 注释），沿用 any 不做运行时收窄
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onPortMessage(message: any): void {
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case 'STATUS':
      state.connected = message.connected
      state.statusError = message.error
      updateUi()
      break
    case 'SESSIONS':
      state.sessions = message.sessions || []
      renderSessions()
      break
    case 'SESSIONS_ERROR':
      state.connected = false
      state.statusError = message.error
      updateUi()
      break
    case 'MARKING_STATE':
      toggleMarkingBtn.textContent = message.marking ? '退出标记' : '开始标记'
      markHintEl.textContent = message.marking
        ? '标记模式已开启：悬停高亮，点击元素捕获所指。Esc 或 Alt+Shift+M 退出。'
        : '开启后悬停高亮，点击元素捕获所指并弹评论窗。快捷键 Alt+Shift+M。'
      markHintEl.style.color = '#6b7280'
      break
    case 'MARKING_ERROR':
      markHintEl.textContent = message.error || '标记切换失败'
      markHintEl.style.color = '#dc2626'
      break
    case 'SESSION_CREATED':
      if (message.error) {
        state.statusError = message.error
      } else if (message.sessionId) {
        state.sessions.push({ sessionId: message.sessionId, updatedAt: Date.now(), blank: true })
        state.selectedSessionId = message.sessionId
      }
      updateUi()
      break
    case 'STAGE_MARK': {
      const m = message.mark as Mark | undefined
      if (!m || typeof m.index !== 'number') break
      const tabId = typeof message.tabId === 'number' ? message.tabId : undefined
      // 2026-08-21: mark.index 是 tab 内编号（各 content 实例独立从 1 起），
      // 跨 tab 标记会撞号——暂存区一律按 (tabId, index) 复合键识别
      // 2026-08-21 修复: OutboxItem 的编号在 mark.index（顶层无 index 字段），
      // 直接 itemKey(i) 会读出 undefined 导致全部 find 失配（esbuild 不做类型检查，静默通过）
      const existing = state.outbox.find(i => itemKey({ tabId: i.tabId, index: i.mark.index }) === itemKey({ tabId, index: m.index }))
      if (existing) {
        Object.assign(existing.mark, m)
        if (tabId !== undefined) existing.tabId = tabId
      } else {
        state.outbox.push({ mark: m, status: 'pending', tabId })
      }
      if (message.sendNow) {
        const item = state.outbox.find(i => itemKey({ tabId: i.tabId, index: i.mark.index }) === itemKey({ tabId, index: m.index }))
        if (item) sendItem(item)
      }
      updateUi()
      break
    }
    case 'SEND_RESULT': {
      const item = state.outbox.find(i => itemKey({ tabId: i.tabId, index: i.mark.index }) === itemKey({ tabId: message.tabId, index: message.markIndex }))
      if (item) {
        if (message.ok) {
          item.status = 'sent'
          item.downgraded = message.downgraded
        } else {
          item.status = 'error'
          item.error = message.error || '发送失败'
        }
      }
      // Sync the content script badge state.
      void sendToTab(item?.tabId, {
        type: 'UPDATE_MARK',
        index: message.markIndex,
        patch: { status: message.ok ? 'sent' : 'error' },
      })
      updateUi()
      break
    }
    case 'FOCUS_RESULT':
      if (!message.ok) {
        markHintEl.textContent = `跳转失败：${message.error || '未知错误'}`
        markHintEl.style.color = '#dc2626'
      }
      break
    default:
      break
  }
}

// Polling health so the panel reflects when the dsh instance comes/goes.
// 2026-08-21: 轮询间隔可调，设置变更时重启定时器
// 2026-08-24: port 断线不再停轮询——轮询报文既是健康检查也是重连后的 SW 唤醒器
let healthPollTimer: ReturnType<typeof setInterval> | null = null
function restartHealthPoll(): void {
  if (healthPollTimer !== null) clearInterval(healthPollTimer)
  healthPollTimer = setInterval(() => {
    safePost({ type: 'HEALTH_CHECK' })
  }, extSettings.healthPollMs)
}

// 2026-08-21: 设置已统一迁入扩展选项页（options.html），此处仅消费 settings 变更
// Initial load.
void loadSettings().then((s) => {
  extSettings = s
  renderStatus()
  restartHealthPoll()
})
onSettingsChanged((s) => {
  extSettings = s
  renderStatus()
  restartHealthPoll()
  // 实例地址可能刚被改：立即重检，不让旧连接状态顶着新地址名显示
  safePost({ type: 'HEALTH_CHECK' })
})
safePost({ type: 'HEALTH_CHECK' })
safePost({ type: 'LIST_SESSIONS' })
updateUi()
