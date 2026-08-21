// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { comboFromEvent, BUILTIN_SHORTCUT } from './shortcut.ts'

function keyEvent(props: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    bubbles: true,
    cancelable: true,
    ...props,
  })
}

describe('comboFromEvent', () => {
  it('returns null for bare modifier keys', () => {
    expect(comboFromEvent(keyEvent({ key: 'Control' }))).toBeNull()
    expect(comboFromEvent(keyEvent({ key: 'Shift' }))).toBeNull()
    expect(comboFromEvent(keyEvent({ key: 'Alt' }))).toBeNull()
    expect(comboFromEvent(keyEvent({ key: 'Meta' }))).toBeNull()
  })

  it('returns null for a single character key without modifiers', () => {
    expect(comboFromEvent(keyEvent({ key: 'm' }))).toBeNull()
    expect(comboFromEvent(keyEvent({ key: 'A' }))).toBeNull()
  })

  it('builds combos in fixed modifier order Ctrl/Meta/Alt/Shift + main key', () => {
    expect(comboFromEvent(keyEvent({ key: 'm', altKey: true, shiftKey: true }))).toBe('Alt+Shift+M')
    expect(comboFromEvent(keyEvent({ key: 's', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+S')
    expect(comboFromEvent(keyEvent({ key: 'p', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }))).toBe('Ctrl+Meta+Alt+Shift+P')
  })

  it('uppercases single-character main keys', () => {
    expect(comboFromEvent(keyEvent({ key: 'm', altKey: true }))).toBe('Alt+M')
    expect(comboFromEvent(keyEvent({ key: 'M', altKey: true }))).toBe('Alt+M')
  })

  it('keeps non-character keys as-is', () => {
    expect(comboFromEvent(keyEvent({ key: 'F5', ctrlKey: true }))).toBe('Ctrl+F5')
    expect(comboFromEvent(keyEvent({ key: 'ArrowUp', altKey: true }))).toBe('Alt+ArrowUp')
    expect(comboFromEvent(keyEvent({ key: 'Escape', shiftKey: true }))).toBe('Shift+Escape')
    expect(comboFromEvent(keyEvent({ key: 'Enter', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Enter')
  })

  it('matches the built-in shortcut constant', () => {
    const ev = keyEvent({ key: 'm', altKey: true, shiftKey: true })
    expect(comboFromEvent(ev)).toBe(BUILTIN_SHORTCUT)
  })
})
