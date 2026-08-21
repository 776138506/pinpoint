/**
 * dsh-point 扩展设置（2026-08-21，五问审视「不器」整改）。
 *
 * 参数分三级：
 *  - L1 用户级：实例地址、标记快捷键（快捷键走独立 customShortcut 键，不在本模块）
 *  - L2 高级：各类超时/轮询间隔——可调但改错影响功能，UI 折叠并附提示
 *  - L3 系统常量（不开放）：协议名、选择器、消息类型——器于局部，合法成器
 *
 * 存储：chrome.storage.local 的 'settings' 键；读取方各自缓存并监听 onChanged。
 */
export interface ExtSettings {
  /** dsh 实例地址（L1） */
  baseUrl: string
  /** background RPC 超时 ms（L2） */
  rpcTimeoutMs: number
  /** 评论窗发送看门狗 ms（L2，content） */
  sendWatchdogMs: number
  /** 截图超时 ms（L2，content） */
  screenshotTimeoutMs: number
  /** 侧栏→tab 消息超时 ms（L2，sidepanel） */
  tabMessageTimeoutMs: number
  /** 健康轮询间隔 ms（L2，sidepanel） */
  healthPollMs: number
}

export const DEFAULT_SETTINGS: ExtSettings = {
  baseUrl: 'http://localhost:8897',
  rpcTimeoutMs: 15000,
  sendWatchdogMs: 10000,
  screenshotTimeoutMs: 8000,
  tabMessageTimeoutMs: 1500,
  healthPollMs: 5000,
}

export const SETTINGS_KEY = 'settings'

interface FieldSpec {
  min?: number
  max?: number
  validate?: (v: string) => string | null // 返回错误消息，null 为合法
}

/** 每字段的合法域（权限分级的另一半：不仅谁能改，还有改成什么样算合法） */
const FIELD_SPECS: Record<keyof ExtSettings, FieldSpec> = {
  baseUrl: {
    validate: (v) => {
      const m = /^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.exec(v.trim())
      if (!m) return '格式应为 http://主机[:端口]'
      const port = /:(\d+)$/.exec(v.trim())
      if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) return '端口范围 1–65535'
      return null
    },
  },
  rpcTimeoutMs: { min: 1000, max: 120000 },
  sendWatchdogMs: { min: 2000, max: 60000 },
  screenshotTimeoutMs: { min: 1000, max: 30000 },
  tabMessageTimeoutMs: { min: 500, max: 10000 },
  healthPollMs: { min: 1000, max: 60000 },
}

export function validateField(key: keyof ExtSettings, raw: string): { ok: true; value: string | number } | { ok: false; error: string } {
  const spec = FIELD_SPECS[key]
  if (spec.validate) {
    const err = spec.validate(raw)
    if (err) return { ok: false, error: err }
    return { ok: true, value: raw.trim() }
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false, error: '必须是数字' }
  if (spec.min !== undefined && n < spec.min) return { ok: false, error: `不能小于 ${spec.min}` }
  if (spec.max !== undefined && n > spec.max) return { ok: false, error: `不能大于 ${spec.max}` }
  return { ok: true, value: n }
}

/** 合入存储值并回退默认：类型不符的字段丢弃（脏数据容错） */
export function normalizeSettings(raw: unknown): ExtSettings {
  const out = { ...DEFAULT_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.baseUrl === 'string' && validateField('baseUrl', r.baseUrl).ok) out.baseUrl = r.baseUrl.trim()
  for (const k of ['rpcTimeoutMs', 'sendWatchdogMs', 'screenshotTimeoutMs', 'tabMessageTimeoutMs', 'healthPollMs'] as const) {
    const v = r[k]
    if (typeof v === 'number' && validateField(k, String(v)).ok) out[k] = v
  }
  return out
}

export async function loadSettings(): Promise<ExtSettings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY)
    return normalizeSettings(data[SETTINGS_KEY])
  } catch (e) {
    console.error('[dsh-point-ext] load settings failed, using defaults:', e)
    return { ...DEFAULT_SETTINGS }
  }
}

/** 订阅设置变更（三容器各自调用，保持本地缓存新鲜） */
export function onSettingsChanged(cb: (s: ExtSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return
    cb(normalizeSettings(changes[SETTINGS_KEY].newValue))
  })
}

export async function saveSettings(patch: Partial<ExtSettings>): Promise<void> {
  const current = await loadSettings()
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } })
}
