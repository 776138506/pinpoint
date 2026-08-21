/**
 * Marking store: the single source of truth for dsh-point's marking state.
 * `marking` (mode on/off), `marks` (captured referents), and `nextIndex`
 * (monotonic numbering that never reuses an index after deletion) live here
 * so they survive component remounts and session switches.
 *
 * This is a hand-rolled, dependency-free store: the dsh client bundle for a
 * third-party plugin can only `require()` the browser platform modules
 * (react, cordis, ui-slots, ...), and `@deepseek-ai/dsh-client-runtime/client`
 * (which owns `defineStore`) is NOT among them. The handle still satisfies the
 * `StoreHandle` contract the slot renderer consumes: `spec.init`, `create()`
 * returning `{ actions, getSnapshot, subscribe, clearPersisted }`.
 */

/** Where a captured element lives: inside a preview iframe, the office renderer, or the main document. */
export type FrameKind = 'iframe' | 'office' | 'main'

/** Lifecycle of one captured referent. */
export type MarkStatus = 'draft' | 'pending' | 'sent'

/** One captured referent (mark). Plain serializable data — no DOM references. */
export interface Mark {
  /** 1-based monotonic index; never reused after deletion (holes stay). */
  index: number
  /** CSS selector path within the element's document. */
  selector: string
  /** Visible text, truncated to 200 chars. */
  text: string
  /** outerHTML snippet, truncated to 2000 chars. */
  html: string
  /** Source label: iframe title, office extension, or '页面'. */
  source: string
  /** Source URL when the mark was captured (extension / main document). */
  sourceUrl?: string
  /** Source page or frame title when the mark was captured. */
  sourceTitle?: string
  /** Which document owns the element (for re-resolution). */
  frameKind: FrameKind
  /** iframe title used to re-find the frame (iframe marks only). */
  frameTitle?: string
  /** Region screenshot as a PNG data URL; empty string when the shot failed. */
  screenshot: string
  /** Set when html2canvas failed to export (kept so the mark still exists). */
  screenshotError?: string
  /** True when the element subtree contains an http(s) image (CORS may drop it). */
  hasExternalImage: boolean
  /** ISO-8601 capture instant. */
  time: string
  /** User-written comment for this mark. */
  comment?: string
  /** Lifecycle: draft = just captured and the comment popup is active; pending = staged in the outbox; sent = already delivered to the session. */
  status: MarkStatus
  /** 2026-08-20: 精准定位锚点（坐标/XPath/文本锚/代码行号），见 schema ReferentAnchor。 */
  anchor?: import('../schema/mark-format.ts').ReferentAnchor
}

/** The marking store state shape. */
export interface MarkingState {
  /** Marking mode on/off. */
  marking: boolean
  /** Captured marks in capture order. */
  marks: Mark[]
  /** Next index to assign; monotonic, never decremented. */
  nextIndex: number
  /** Index of the mark whose popup is currently open, or null. */
  activeIndex: number | null
}

/** Baked write set exposed to components via `props.actions`. */
export interface MarkingActions {
  setMarking(on: boolean): void
  addMark(mark: Mark): void
  removeMark(index: number): void
  updateMark(index: number, patch: Partial<Omit<Mark, 'index'>>): void
  openMark(index: number | null): void
}

/** A live store instance: bare observable + baked actions (no React hook). */
export interface MarkingStoreInstance {
  actions: MarkingActions
  getSnapshot(): MarkingState
  subscribe(fn: () => void): () => void
  clearPersisted(): void
}

/** The registration-side store handle. */
export interface MarkingStoreHandle {
  spec: { init: () => MarkingState }
  create(scopeKey?: string): MarkingStoreInstance
}

/**
 * Create the marking store handle. The factory is shared in `apply` (one
 * handle passed to every register that needs it); the framework creates and
 * caches one live instance per session scope, which is what makes marks
 * survive a session switch.
 * @returns the store handle.
 */
export function createMarkingStore(): MarkingStoreHandle {
  return {
    spec: {
      init: (): MarkingState => ({ marking: false, marks: [], nextIndex: 1, activeIndex: null }),
    },
    create(_scopeKey?: string): MarkingStoreInstance {
      let state: MarkingState = { marking: false, marks: [], nextIndex: 1, activeIndex: null }
      const listeners = new Set<() => void>()
      const setState = (next: MarkingState): void => {
        if (next === state) return
        state = next
        for (const fn of [...listeners]) fn()
      }
      const actions: MarkingActions = {
        setMarking: (on) => { setState({ ...state, marking: on }) },
        addMark: (mark) => {
          setState({
            ...state,
            marks: [...state.marks, { ...mark, status: mark.status ?? 'draft' }],
            nextIndex: Math.max(state.nextIndex, mark.index + 1),
            activeIndex: mark.index,
          })
        },
        removeMark: (index) => {
          setState({
            ...state,
            marks: state.marks.filter(m => m.index !== index),
            activeIndex: state.activeIndex === index ? null : state.activeIndex,
          })
        },
        updateMark: (index, patch) => {
          setState({
            ...state,
            marks: state.marks.map(m => m.index === index ? { ...m, ...patch } : m),
          })
        },
        openMark: (index) => { setState({ ...state, activeIndex: index }) },
      }
      return {
        actions,
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        clearPersisted: () => {
          // No localStorage persistence in phase one; nothing to drop.
        },
      }
    },
  }
}
