/**
 * Invisible engine component: mounts the imperative marking engine and keeps
 * it in sync with the marking store. Renders null — its whole job is the
 * document/iframe listeners, the badge overlay, and cross-origin notices.
 * Registered in the session-scoped header-actions list so the engine gets the
 * same session-scoped store instance as the MarkButton (one source of truth).
 */
import { useEffect, useRef } from 'react'
import { createMarkingController } from './engine.ts'
import type { MarkingControllerDeps } from './engine.ts'
import type { Mark, MarkingActions, MarkingState } from './stores.ts'
import type { MarkingUseStore } from './MarkButton.tsx'

/** Props for the engine (PropsStore share + session standard kit + send callback). */
export interface MarkingEngineProps {
  sessionId: string
  useStore: MarkingUseStore
  actions: MarkingActions
  sendMark(mark: Mark, comment: string): Promise<void>
}

/**
 * The engine host. All DOM work happens in the imperative controller; this
 * component only mirrors store snapshots into it.
 * @param props.useStore - marking store selector hook.
 * @param props.actions - marking store write set.
 * @param props.sendMark - send one mark + comment to the current session.
 */
export function MarkingEngine({ sessionId, useStore, actions, sendMark }: MarkingEngineProps): null {
  const marking = useStore(s => s.marking)
  const marks = useStore(s => s.marks)
  const nextIndex = useStore(s => s.nextIndex)
  const activeIndex = useStore(s => s.activeIndex)

  // `actions` is stable per store instance, but keep it in a ref so the
  // controller's write callbacks never close over a stale object.
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const sendRef = useRef(sendMark)
  sendRef.current = sendMark

  const ctrlRef = useRef<ReturnType<typeof createMarkingController> | null>(null)
  if (ctrlRef.current === null) {
    const deps: MarkingControllerDeps = {
      setMarking: (on) => { actionsRef.current.setMarking(on) },
      addMark: (mark) => { actionsRef.current.addMark(mark) },
      removeMark: (index) => { actionsRef.current.removeMark(index) },
      openMark: (index) => { actionsRef.current.openMark(index) },
      updateMark: (index, patch) => { actionsRef.current.updateMark(index, patch) },
      sendMark: (mark, comment) => sendRef.current(mark, comment),
    }
    ctrlRef.current = createMarkingController(deps)
  }

  useEffect(() => {
    ctrlRef.current?.mount()
    return () => { ctrlRef.current?.dispose() }
  }, [])

  useEffect(() => {
    ctrlRef.current?.sync({ marking, marks, nextIndex, activeIndex })
  }, [marking, marks, nextIndex, activeIndex])

  return null
}
