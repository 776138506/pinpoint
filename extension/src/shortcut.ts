/**
 * 快捷键组合的统一表示与匹配（content script 与 side panel 共用）。
 * 格式："Alt+Shift+M"，修饰键顺序固定 Ctrl/Meta/Alt/Shift + 主键。
 */

export const BUILTIN_SHORTCUT = 'Alt+Shift+M'

export function comboFromEvent(e: KeyboardEvent): string | null {
  // 只按修饰键不构成组合
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey) parts.push('Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (parts.length === 0) return null // 必须至少一个修饰键，避免与页面输入冲突
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}
