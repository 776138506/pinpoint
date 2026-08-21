/**
 * Header "标记" button: toggles marking mode via the shared marking store.
 * Pure presentation — reads `useStore(s => s.marking)` and writes through
 * `actions.setMarking`; no ctx, no DOM side effects.
 */
import { createElement } from 'react'
import type { MarkingActions, MarkingState } from './stores.ts'

/** Minimal selector-hook face the framework binds to the store instance. */
export type MarkingUseStore = <S>(sel: (s: MarkingState) => S, eq?: (a: S, b: S) => boolean) => S

/** Props for the header button (the PropsStore share + nothing else). */
export interface MarkButtonProps {
  useStore: MarkingUseStore
  actions: MarkingActions
}

/**
 * The header toggle button.
 * @param props.useStore - marking store selector hook.
 * @param props.actions - marking store write set.
 */
export function MarkButton({ useStore, actions }: MarkButtonProps): unknown {
  const marking = useStore(s => s.marking)
  return createElement('button', {
    type: 'button',
    title: marking ? '退出标记模式（Esc）' : '进入标记模式：悬停高亮、点击捕获所指',
    onClick: () => { actions.setMarking(!marking) },
    style: {
      padding: '4px 10px',
      border: '1px solid #2563eb',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '13px',
      background: marking ? '#2563eb' : 'transparent',
      color: marking ? '#ffffff' : '#2563eb',
    },
  }, marking ? '退出标记' : '标记')
}
