/**
 * dsh-point 扩展选项页（2026-08-21：设置从侧栏迁入，侧栏只留入口）。
 * 承载全部用户可调参数（实例地址 / 快捷键 / 高级超时项），校验与存储走 settings.ts。
 */
import { BUILTIN_SHORTCUT, comboFromEvent } from './shortcut.ts'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateField, type ExtSettings } from './settings.ts'

function reqEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`[dsh-point-ext] missing #${id} in options DOM`)
  return el as T
}

const hintEl = reqEl<HTMLDivElement>('settings-hint')

function showHint(text: string, kind: 'ok' | 'error' | ''): void {
  hintEl.textContent = text
  hintEl.className = 'hint' + (kind ? ` ${kind}` : '')
}

/* ---------- 参数字段（实例地址 + 高级项） ---------- */

const settingsFields: Array<{ id: string; key: keyof ExtSettings }> = [
  { id: 'setting-base-url', key: 'baseUrl' },
  { id: 'setting-rpc-timeout', key: 'rpcTimeoutMs' },
  { id: 'setting-send-watchdog', key: 'sendWatchdogMs' },
  { id: 'setting-screenshot-timeout', key: 'screenshotTimeoutMs' },
  { id: 'setting-tab-timeout', key: 'tabMessageTimeoutMs' },
  { id: 'setting-health-poll', key: 'healthPollMs' },
]

function fillSettingsInputs(s: ExtSettings): void {
  for (const f of settingsFields) {
    reqEl<HTMLInputElement>(f.id).value = String(s[f.key])
  }
}

reqEl<HTMLButtonElement>('settings-save').addEventListener('click', async () => {
  const patch: Partial<ExtSettings> = {}
  for (const f of settingsFields) {
    const raw = reqEl<HTMLInputElement>(f.id).value
    const r = validateField(f.key, raw)
    if (r.ok === false) {
      showHint(`${f.key}：${r.error}`, 'error')
      return
    }
    ;(patch as Record<string, unknown>)[f.key] = r.value
  }
  await saveSettings(patch)
  showHint('已保存（即时生效）', 'ok')
})

reqEl<HTMLButtonElement>('settings-reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('settings')
  fillSettingsInputs({ ...DEFAULT_SETTINGS })
  showHint('已恢复默认', 'ok')
})

/* ---------- 标记快捷键：按键即绑定 ---------- */

const shortcutInput = reqEl<HTMLInputElement>('shortcut-input')
const shortcutHintEl = reqEl<HTMLDivElement>('shortcut-hint')

function showShortcutHint(text: string, kind: 'ok' | 'error' | ''): void {
  shortcutHintEl.textContent = text
  shortcutHintEl.className = 'hint' + (kind ? ` ${kind}` : '')
}

async function currentShortcut(): Promise<string> {
  const data = await chrome.storage.local.get('customShortcut')
  return typeof data.customShortcut === 'string' ? data.customShortcut : BUILTIN_SHORTCUT
}

async function loadShortcut(): Promise<void> {
  shortcutInput.value = await currentShortcut()
}

// 2026-08-21: 按键即绑定——聚焦后按下组合键立即保存；无效按键给出原因反馈，不静默吞掉
shortcutInput.addEventListener('keydown', async (e) => {
  // Tab 留给焦点导航，Esc 取消录入
  if (e.key === 'Tab') return
  e.preventDefault()
  if (e.key === 'Escape') {
    shortcutInput.blur()
    showShortcutHint('已取消', '')
    return
  }
  const combo = comboFromEvent(e)
  if (!combo) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      showShortcutHint(`已按住 ${e.key === 'Meta' ? '⌘' : e.key}，请再按一个主键…`, '')
    } else {
      showShortcutHint(`「${e.key}」不能单独作为快捷键，请同时按住 Ctrl / Alt / Shift / ⌘ 之一`, 'error')
    }
    return
  }
  if (combo === await currentShortcut()) {
    shortcutInput.blur()
    showShortcutHint(`当前已是 ${combo}`, 'ok')
    return
  }
  await chrome.storage.local.set({ customShortcut: combo })
  shortcutInput.value = combo
  shortcutInput.blur()
  showShortcutHint(`已绑定：${combo}（网页内即时生效）`, 'ok')
})

reqEl<HTMLButtonElement>('shortcut-reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('customShortcut')
  shortcutInput.value = BUILTIN_SHORTCUT
  showShortcutHint(`已恢复默认 ${BUILTIN_SHORTCUT}`, 'ok')
})

// 浏览器级（全局）快捷键只能在 chrome://extensions/shortcuts 改，扩展内无权修改
reqEl<HTMLButtonElement>('shortcut-browser').addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
})

/* ---------- 初始化 ---------- */

void loadSettings().then(fillSettingsInputs)
void loadShortcut()
