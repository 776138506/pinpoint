import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings, validateField } from './settings.ts'

describe('validateField', () => {
  it('accepts valid baseUrl forms', () => {
    expect(validateField('baseUrl', 'http://localhost:8897').ok).toBe(true)
    expect(validateField('baseUrl', 'https://dsh.example.com').ok).toBe(true)
    expect(validateField('baseUrl', 'http://127.0.0.1:3000 ').ok).toBe(true) // 空格容忍
  })
  it('rejects invalid baseUrl', () => {
    expect(validateField('baseUrl', 'localhost:8897').ok).toBe(false) // 缺协议
    expect(validateField('baseUrl', 'ftp://x.com').ok).toBe(false)
    expect(validateField('baseUrl', 'http://x:0').ok).toBe(false) // 端口越界
    expect(validateField('baseUrl', 'http://x:65536').ok).toBe(false)
    expect(validateField('baseUrl', '').ok).toBe(false)
  })
  it('enforces numeric bounds', () => {
    expect(validateField('rpcTimeoutMs', '15000').ok).toBe(true)
    expect(validateField('rpcTimeoutMs', '999').ok).toBe(false) // 低于下限
    expect(validateField('rpcTimeoutMs', '999999').ok).toBe(false) // 高于上限
    expect(validateField('rpcTimeoutMs', 'abc').ok).toBe(false) // 非数字
    expect(validateField('rpcTimeoutMs', 'NaN').ok).toBe(false)
  })
  it('returns numeric value for number fields', () => {
    const r = validateField('healthPollMs', '3000')
    expect(r).toEqual({ ok: true, value: 3000 })
  })
})

describe('normalizeSettings', () => {
  it('falls back to defaults on garbage input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('junk')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
  })
  it('drops fields with wrong types or out-of-range values', () => {
    const r = normalizeSettings({
      baseUrl: 'not a url',
      rpcTimeoutMs: 'fast', // 字符串不是数字
      screenshotTimeoutMs: -5, // 越界
      healthPollMs: 3000, // 合法
    })
    expect(r.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(r.rpcTimeoutMs).toBe(DEFAULT_SETTINGS.rpcTimeoutMs)
    expect(r.screenshotTimeoutMs).toBe(DEFAULT_SETTINGS.screenshotTimeoutMs)
    expect(r.healthPollMs).toBe(3000)
  })
  it('keeps valid partial overrides', () => {
    const r = normalizeSettings({ baseUrl: 'http://localhost:9999', sendWatchdogMs: 5000 })
    expect(r.baseUrl).toBe('http://localhost:9999')
    expect(r.sendWatchdogMs).toBe(5000)
    expect(r.rpcTimeoutMs).toBe(DEFAULT_SETTINGS.rpcTimeoutMs)
  })
  it('ignores unknown fields', () => {
    const r = normalizeSettings({ evil: 'inject', baseUrl: 'http://localhost:1' })
    expect('evil' in r).toBe(false)
    expect(r.baseUrl).toBe('http://localhost:1')
  })
})
