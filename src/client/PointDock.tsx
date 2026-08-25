/**
 * Outbox footer entry for dsh-point: lists staged marks in the preview panel
 * footer as a collapsible section and offers batch send, per-item send, delete,
 * and "edit in composer".
 */
import { createElement, useCallback, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { Mark, MarkingActions, MarkingState } from './stores.ts'
import type { MarkingUseStore } from './MarkButton.tsx'

/** Injected send/edit callbacks from the plugin apply closure. */
interface PointDockInjected {
  sendMark(mark: Mark, comment: string): Promise<void>
  sendAll(marks: readonly Mark[]): Promise<void>
  editInComposer(mark: Mark, comment: string): Promise<void>
}

/** Props for the footer entry: store share + session standard kit + injected callbacks. */
export interface PointDockProps {
  sessionId: string
  useStore: MarkingUseStore
  actions: MarkingActions
  sendMark(mark: Mark, comment: string): Promise<void>
  sendAll(marks: readonly Mark[]): Promise<void>
  editInComposer(mark: Mark, comment: string): void
}

function formatOne(mark: Mark): string {
  const comment = mark.comment ?? ''
  const lines: string[] = []
  lines.push(`[所指 #${mark.index}] 来源：${mark.source}`)
  if (mark.text) lines.push(`文本摘录：${mark.text}`)
  if (mark.selector) lines.push(`选择器：${mark.selector}`)
  if (comment) lines.push(`评论：${comment}`)
  return lines.join('\n')
}

export function PointDock({ useStore, actions, sendMark, sendAll, editInComposer }: PointDockProps): unknown {
  const marks = useStore((s: MarkingState) => s.marks)
  const pending = useMemo(() => marks.filter((m): m is Mark & { status: 'pending' } => m.status === 'pending'), [marks])
  const [busyAll, setBusyAll] = useState(false)
  const [busyOne, setBusyOne] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(true)

  const notify = useCallback((text: string) => {
    const el = document.createElement('div')
    el.className = 'dsh-point-toast'
    el.textContent = text
    document.body.appendChild(el)
    window.setTimeout(() => { el.remove() }, 5000)
  }, [])

  if (pending.length === 0) return null

  const sendSingle = async (mark: Mark): Promise<void> => {
    setBusyOne(mark.index)
    try {
      await sendMark(mark, mark.comment ?? '')
      actions.updateMark(mark.index, { status: 'sent' })
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      notify(`发送失败：${reason}。请检查网络或会话状态后重试。`)
    } finally {
      setBusyOne(null)
    }
  }

  const sendBatchUnified = async (): Promise<void> => {
    setBusyAll(true)
    try {
      await sendAll(pending)
      for (const m of pending) actions.updateMark(m.index, { status: 'sent' })
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      notify(`统一发送失败：${reason}。部分所指可能未送达，请检查后再试。`)
    } finally {
      setBusyAll(false)
    }
  }

  const sendBatchSequential = async (): Promise<void> => {
    setBusyAll(true)
    try {
      for (const m of pending) {
        await sendMark(m, m.comment ?? '')
        actions.updateMark(m.index, { status: 'sent' })
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      notify(`逐条发送中断：${reason}。已成功的所指已标记为已发送，未成功的仍留在待发列表。`)
    } finally {
      setBusyAll(false)
    }
  }

  const style: Record<string, unknown> = {
    padding: '8px 12px',
    background: '#fffbeb',
    borderTop: '1px solid #fcd34d',
    font: '13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    color: '#1f2328',
  }

  const headerStyle: Record<string, unknown> = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontWeight: 600,
  }

  const rowStyle: Record<string, unknown> = {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    padding: '6px 0',
    borderTop: '1px solid #fef3c7',
  }

  const previewStyle: Record<string, unknown> = {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  const btn = (label: string, onClick: () => void, disabled = false, danger = false): ReactElement =>
    createElement('button', {
      type: 'button',
      disabled,
      onClick,
      style: {
        padding: '3px 8px',
        border: `1px solid ${danger ? '#fca5a5' : '#d1d5db'}`,
        borderRadius: '4px',
        background: danger ? '#fef2f2' : '#ffffff',
        color: danger ? '#dc2626' : '#374151',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        font: 'inherit',
      },
    }, label)

  return createElement('div', { style },
    createElement('div', { style: headerStyle },
      createElement('span', {}, `待发所指（${pending.length}）`),
      createElement('span', { style: { display: 'flex', gap: '8px' } },
        btn(expanded ? '收起' : '展开', () => { setExpanded(!expanded) }),
        // 2026-08-24: any in-flight send (single or batch) disables every send
        // path — otherwise a single send and a batch send can run concurrently
        // and double-deliver the same mark.
        btn('统一发送', () => { void sendBatchUnified() }, busyAll || busyOne !== null),
        btn('逐条发送', () => { void sendBatchSequential() }, busyAll || busyOne !== null),
      ),
    ),
    expanded
      ? pending.map(mark =>
        createElement('div', { key: mark.index, style: rowStyle },
          createElement('span', { style: previewStyle }, `#${mark.index} ${mark.source}：${mark.comment || mark.text || '（无备注）'}`),
          btn('发送', () => { void sendSingle(mark) }, busyAll || busyOne !== null),
          btn('回输入框', async () => {
            try {
              await editInComposer(mark, mark.comment ?? '')
              actions.updateMark(mark.index, { status: 'draft' })
            } catch (error: unknown) {
              const reason = error instanceof Error ? error.message : String(error)
              notify(`无法插入草稿：${reason}。`)
            }
          }, busyAll || busyOne !== null),
          btn('删除', () => { actions.removeMark(mark.index) }, busyAll || busyOne !== null, true),
        ),
      )
      : null,
  )
}
