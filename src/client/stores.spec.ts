/**
 * stores.ts 标记仓库回归测试（2026-08-24）。
 *
 * 复现的 bug：engine 连点/点已标记元素时并发跑 captureElement，两份捕获读同一个
 * state.nextIndex，产生同 index 的重复 mark。engine 侧已加 captureInFlight +
 * KEPT_FLAG 重开 popup 双闸；本用例守最后一道防线——store 的 addMark 同 index
 * 必须替换而非追加，保证不变量「index 在 marks 内唯一」不被任何路径击穿。
 */
import { describe, expect, it } from 'vitest'
import { createMarkingStore, type Mark } from './stores.ts'

function fakeMark(index: number, text = 't'): Mark {
  return {
    index,
    selector: 'div',
    text,
    html: '',
    source: '页面',
    frameKind: 'main',
    screenshot: '',
    hasExternalImage: false,
    time: '2026-08-24T00:00:00Z',
    status: 'draft',
  }
}

describe('marking store addMark 防重复（2026-08-24）', () => {
  it('同 index 再次 addMark：替换旧条目而非追加，编号不被重复占用', () => {
    const store = createMarkingStore().create()
    store.actions.addMark(fakeMark(1, 'first'))
    store.actions.addMark(fakeMark(1, 'second'))
    const s = store.getSnapshot()
    expect(s.marks).toHaveLength(1)
    expect(s.marks[0]?.text).toBe('second')
    // 编号仍然单调推进，不回退
    expect(s.nextIndex).toBe(2)
    // 新 mark 成为活动弹窗目标
    expect(s.activeIndex).toBe(1)
  })

  it('正常追加不受影响：不同 index 各自保留', () => {
    const store = createMarkingStore().create()
    store.actions.addMark(fakeMark(1))
    store.actions.addMark(fakeMark(2))
    const s = store.getSnapshot()
    expect(s.marks.map((m) => m.index)).toEqual([1, 2])
    expect(s.nextIndex).toBe(3)
  })
})
