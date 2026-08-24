/**
 * dsh-point plugin, browser half.
 *
 * Registrations:
 *  - Preview toolbar (`preview.toolbar` child seat, declared by ui-preview):
 *    MarkButton (toggle marking) + MarkingEngine (capture, badges, and
 *    per-mark comment popup).
 *  - Preview footer (`preview.footer` child seat, declared by ui-preview):
 *    PointDock (collapsible "outbox" of pending marks).
 *
 * All direct message sending goes through the host's scope-addressed
 * `conversation` service; the plugin never imports ui-conversation internals.
 */
import { createMarkingStore } from './stores.ts'
import { MarkButton } from './MarkButton.tsx'
import { MarkingEngine } from './MarkingEngine.tsx'
import { PointDock } from './PointDock.tsx'
import { dataUrlToFile, formatMarkText } from './util.ts'
import { mountReferentCardEnhancer } from './referent-card.ts'
import type { Mark } from './stores.ts'

/** Required services. */
export const inject = ['slots', 'sessions', 'conversation']

/** Minimal service face used by this plugin. */
interface Ctx {
  slots: {
    inject(name: string, factory: () => void): void
    register(options: Record<string, unknown>, component: unknown): void
  }
  sessions: {
    scope(sessionId: string): AgentContext | undefined
    sessionOf(actx: AgentContext): unknown | undefined
  }
  get(name: 'conversation'): ConversationFace | undefined
}

/** Cordis Context carrying one Agent identity; used only to pass into host services. */
interface AgentContext {
  get(name: 'conversation'): ConversationFace | undefined
}

/** Subset of the host conversation service that this plugin needs. */
interface ConversationFace {
  createDraftImages(files: readonly File[]): readonly { id: string; file: File }[]
  sendSession(session: unknown, text: string, imageIds: readonly string[], mode: string): Promise<void>
  input: { for(actx: AgentContext): { setDraft(text: string): void; addImages(ids: readonly string[]): boolean } }
}

function scopeChecked(ctx: Ctx, sessionId: string): { actx: AgentContext; session: unknown; conversation: ConversationFace } {
  const actx = ctx.sessions.scope(sessionId)
  if (actx === undefined) throw new Error('当前会话已关闭或不可用，无法发送所指。请重新选择会话后再试。')
  const session = ctx.sessions.sessionOf(actx)
  if (session === undefined) throw new Error('当前会话已关闭或不可用，无法发送所指。请重新选择会话后再试。')
  const conversation = actx.get('conversation')
  if (conversation === undefined) throw new Error('对话服务尚未就绪，请稍后再试。')
  return { actx, session, conversation }
}

function imageIdsFromMark(conversation: ConversationFace, mark: Mark): readonly string[] {
  if (mark.screenshot === '') return []
  const file = dataUrlToFile(mark.screenshot, `point-screenshot-${mark.index}.png`)
  return conversation.createDraftImages([file]).map(a => a.id)
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Ctx): void {
  const markingStore = createMarkingStore()

  ctx.slots.inject('preview.toolbar', () => {
    ctx.slots.register({
      name: 'preview.toolbar',
      id: 'point-mark',
      order: 40,
      store: markingStore,
    }, MarkButton)

    ctx.slots.register({
      name: 'preview.toolbar',
      id: 'point-marking-engine',
      order: 41,
      store: markingStore,
      inject: (sessionId: string) => ({
        sendMark: async (mark: Mark, comment: string) => {
          const { session, conversation } = scopeChecked(ctx, sessionId)
          const ids = imageIdsFromMark(conversation, mark)
          const text = formatMarkText(mark, comment)
          await conversation.sendSession(session, text, ids, 'queue')
        },
      }),
    }, MarkingEngine)
  })

  ctx.slots.inject('preview.footer', () => {
    ctx.slots.register({
      name: 'preview.footer',
      id: 'point-outbox',
      order: 5,
      store: markingStore,
      inject: (sessionId: string) => ({
        sendMark: async (mark: Mark, comment: string) => {
          const { session, conversation } = scopeChecked(ctx, sessionId)
          const ids = imageIdsFromMark(conversation, mark)
          const text = formatMarkText(mark, comment)
          await conversation.sendSession(session, text, ids, 'queue')
        },
        sendAll: async (marks: readonly Mark[]) => {
          const { session, conversation } = scopeChecked(ctx, sessionId)
          const ids: string[] = []
          const parts: string[] = []
          for (const mark of marks) {
            ids.push(...imageIdsFromMark(conversation, mark))
            parts.push(formatMarkText(mark, mark.comment ?? ''))
          }
          const text = parts.join('\n\n')
          await conversation.sendSession(session, text, ids, 'queue')
        },
        editInComposer: (mark: Mark, comment: string) => {
          const { actx, conversation } = scopeChecked(ctx, sessionId)
          const input = conversation.input.for(actx)
          const ids = imageIdsFromMark(conversation, mark)
          // 2026-08-24: write the text first, then the images. The old order
          // (images → setDraft) left dangling images in the composer when
          // setDraft threw after addImages had already succeeded.
          input.setDraft(formatMarkText(mark, comment))
          if (ids.length > 0 && !input.addImages(ids)) {
            throw new Error('文字已写入输入框，但截图插入失败（输入框正忙）。请稍后重试「回输入框」以补上截图。')
          }
        },
      }),
    }, PointDock)
  })

  // D2a: render structured referent cards for messages produced by the
  // extension (or the legacy preview marking engine). There is no formal slot
  // for message body content, so we enhance the rendered DOM directly.
  mountReferentCardEnhancer()
}
