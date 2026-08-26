/**
 * drawing.ts 纯函数回归测试（2026-08-24，jsdom）。
 *
 * 覆盖：
 *  ① 箭头头部几何计算
 *  ② 比例坐标 → 像素坐标换算
 *  ③ 各工具绘制指令正确
 *  ④ 合成截图：无 strokes 短路、有 strokes 产出新 data URL、加载失败返回 null
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { composeScreenshot, drawStrokes, eraseStrokes, getArrowHead, textStrokeBBox } from './drawing.ts'
import type { Stroke } from './drawing.ts'

const FAKE_SCREENSHOT = 'data:image/png;base64,fake'

function makeFakeCtx() {
  const calls: { method: string; args: unknown[] }[] = []
  const push = (method: string) => (...args: unknown[]) => { calls.push({ method, args }) }
  return {
    calls,
    save: push('save'),
    restore: push('restore'),
    beginPath: push('beginPath'),
    closePath: push('closePath'),
    moveTo: push('moveTo'),
    lineTo: push('lineTo'),
    stroke: push('stroke'),
    fill: push('fill'),
    strokeRect: push('strokeRect'),
    clearRect: push('clearRect'),
    drawImage: push('drawImage'),
    fillText: push('fillText'),
    font: '',
    textBaseline: '',
  }
}

class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  naturalWidth = 100
  naturalHeight = 80
  complete = false
}

beforeEach(() => {
  vi.stubGlobal('Image', vi.fn(() => new MockImage()))
})

describe('getArrowHead', () => {
  it('水平向右箭头头部关于中线对称', () => {
    const headLength = 12
    const { left, right } = getArrowHead({ x: 100, y: 50 }, { x: 0, y: 50 }, headLength)
    // 30° 夹角：x 偏移 = cos(30°)*L，y 偏移 = sin(30°)*L
    const dx = (Math.sqrt(3) / 2) * headLength
    const dy = headLength / 2
    expect(left.x).toBeCloseTo(100 - dx)
    expect(left.y).toBeCloseTo(50 - dy)
    expect(right.x).toBeCloseTo(100 - dx)
    expect(right.y).toBeCloseTo(50 + dy)
  })
})

describe('drawStrokes', () => {
  it('将比例坐标按画布尺寸换算为像素坐标并绘制 pen 路径', () => {
    const fake = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as unknown as CanvasRenderingContext2D)
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    drawStrokes(ctx, [{ tool: 'pen', points: [0, 0, 0.5, 0.5, 1, 0] }], 200, 100)
    const moves = fake.calls.filter(c => c.method === 'moveTo')
    const lines = fake.calls.filter(c => c.method === 'lineTo')
    expect(moves).toHaveLength(1)
    expect(moves[0].args).toEqual([0, 0])
    expect(lines.map(c => c.args)).toEqual([[100, 50], [200, 0]])
  })

  it('绘制 arrow 与 rect 使用正确像素坐标', () => {
    const fake = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as unknown as CanvasRenderingContext2D)
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    drawStrokes(ctx, [
      { tool: 'arrow', points: [0, 0, 1, 1] },
      { tool: 'rect', points: [0.2, 0.2, 0.8, 0.8] },
    ], 100, 100)
    const strokeRects = fake.calls.filter(c => c.method === 'strokeRect')
    expect(strokeRects).toHaveLength(1)
    expect(strokeRects[0].args).toEqual([20, 20, 60, 60])
  })

  it('忽略点数不足的 stroke', () => {
    const fake = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as unknown as CanvasRenderingContext2D)
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    drawStrokes(ctx, [{ tool: 'pen', points: [0, 0] }], 100, 100)
    expect(fake.calls.filter(c => c.method === 'beginPath')).toHaveLength(0)
  })
})

describe('composeScreenshot', () => {
  it('无 strokes 时直接返回原截图', async () => {
    const result = await composeScreenshot(FAKE_SCREENSHOT, [])
    expect(result).toBe(FAKE_SCREENSHOT)
  })

  it('无截图时返回 null', async () => {
    const result = await composeScreenshot('', [{ tool: 'pen', points: [0, 0, 1, 1] }])
    expect(result).toBeNull()
  })

  it('有 strokes 时合成并返回新的 data URL', async () => {
    const fake = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,composed')
    const Img = globalThis.Image as unknown as ReturnType<typeof vi.fn>
    let instance: MockImage | null = null
    Img.mockImplementation(() => {
      instance = new MockImage()
      return instance
    })
    const promise = composeScreenshot(FAKE_SCREENSHOT, [{ tool: 'pen', points: [0, 0, 1, 1] }])
    await Promise.resolve()
    instance?.onload?.()
    const result = await promise
    expect(result).toBe('data:image/png;base64,composed')
    expect(fake.calls.some(c => c.method === 'drawImage')).toBe(true)
  })

  it('图片加载失败时返回 null', async () => {
    const fake = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as unknown as CanvasRenderingContext2D)
    const Img = globalThis.Image as unknown as ReturnType<typeof vi.fn>
    let instance: MockImage | null = null
    Img.mockImplementation(() => {
      instance = new MockImage()
      return instance
    })
    const promise = composeScreenshot(FAKE_SCREENSHOT, [{ tool: 'pen', points: [0, 0, 1, 1] }])
    await Promise.resolve()
    instance?.onerror?.()
    const result = await promise
    expect(result).toBeNull()
  })
})

describe('eraseStrokes 像素级橡皮（2026-08-25：矢量切割，不整条删）', () => {
  const PEN: Stroke = { tool: 'pen', points: [0, 50, 100, 50] } // 水平线

  it('擦中间一段：一条笔画切成两条，其余部分保留', () => {
    const { strokes, changed } = eraseStrokes([PEN], 50, 40, 50, 60, 10)
    expect(changed).toBe(true)
    expect(strokes).toHaveLength(2)
    for (const s of strokes) expect(s.tool).toBe('pen')
    // 左段在 x≈40 以内，右段从 x≈60 起
    const xs = strokes.map(s => s.points.filter((_, i) => i % 2 === 0))
    expect(Math.max(...xs[0]!)).toBeLessThan(50)
    expect(Math.min(...xs[1]!)).toBeGreaterThan(50)
  })

  it('整段擦除：笔画被删干净', () => {
    const { strokes } = eraseStrokes([PEN], 0, 50, 100, 50, 10)
    expect(strokes).toHaveLength(0)
  })

  it('未命中：笔画原样保留（同一对象引用，不重画）', () => {
    const { strokes, changed } = eraseStrokes([PEN], 0, 200, 100, 200, 10)
    expect(changed).toBe(false)
    expect(strokes[0]).toBe(PEN)
  })

  it('矩形被擦到：先转等效折线再切割，结果全是 pen', () => {
    const rect: Stroke = { tool: 'rect', points: [10, 10, 90, 90] }
    const { strokes, changed } = eraseStrokes([rect], 50, 5, 50, 20, 8) // 擦上边
    expect(changed).toBe(true)
    expect(strokes.length).toBeGreaterThan(0)
    for (const s of strokes) expect(s.tool).toBe('pen')
    // 上边（y=10）被擦带（x∈[42,58]，半径 8）内不得有保留点
    for (const s of strokes) {
      for (let i = 0; i < s.points.length; i += 2) {
        const inErasedBand = Math.abs(s.points[i + 1]! - 10) < 3 && s.points[i]! > 44 && s.points[i]! < 56
        expect(inErasedBand).toBe(false)
      }
    }
  })

  it('箭头被擦到：箭杆与头部轮廓各自独立切割', () => {
    const arrow: Stroke = { tool: 'arrow', points: [0, 0, 100, 0] }
    const { strokes, changed } = eraseStrokes([arrow], 50, -10, 50, 10, 8) // 擦箭杆中段
    expect(changed).toBe(true)
    for (const s of strokes) expect(s.tool).toBe('pen')
    // 箭杆被切成两段 + 头部三角轮廓保留（未被擦到）
    const hasHeadPart = strokes.some(s => s.points.some((v, i) => i % 2 === 0 && v > 85))
    expect(hasHeadPart).toBe(true)
  })

  it('多笔画混合：只切命中的，未命中原样', () => {
    const other: Stroke = { tool: 'pen', points: [0, 500, 100, 500] }
    const { strokes } = eraseStrokes([PEN, other], 50, 40, 50, 60, 10)
    expect(strokes.filter(s => s === other)).toHaveLength(1)
    expect(strokes.length).toBe(3) // PEN 切成 2 + other 原样
  })

  it('文本笔画：擦到包围盒整删（字形无法切割），未擦到原样', () => {
    const text: Stroke = { tool: 'text', points: [100, 100], text: '往右移', font: 16 } // 文档 px
    // 从文字上方竖擦（穿过包围盒：宽≈4字×16=64，高≈19.2）
    const hit = eraseStrokes([text], 110, 90, 110, 130, 10)
    expect(hit.changed).toBe(true)
    expect(hit.strokes).toHaveLength(0)
    // 远处擦不动它（同一对象引用）
    const miss = eraseStrokes([text], 400, 400, 420, 420, 10)
    expect(miss.changed).toBe(false)
    expect(miss.strokes[0]).toBe(text)
  })
})

describe('textStrokeBBox（2026-08-26 文本工具）', () => {
  it('CJK 按 1em、ASCII 按 0.55em 估算宽度，多行累加高度', () => {
    const bb = textStrokeBBox({ tool: 'text', points: [10, 20], text: 'ab\n中文', font: 10 })
    expect(bb).not.toBeNull()
    expect(bb!.x).toBe(10)
    expect(bb!.y).toBe(20)
    expect(bb!.width).toBeCloseTo(2 * 10, 5) // 「中文」2 字 × 1em × 10px
    expect(bb!.height).toBeCloseTo(2 * 10 * 1.2, 5)
  })

  it('归一化坐标经 heightBasis 换算成像素', () => {
    const bb = textStrokeBBox({ tool: 'text', points: [0.1, 0.2], text: 'ab', font: 0.02 }, 800)
    expect(bb!.x).toBeCloseTo(80, 5)
    expect(bb!.y).toBeCloseTo(160, 5)
    expect(bb!.width).toBeCloseTo(2 * 0.55 * 0.02 * 800, 5) // 17.6
  })

  it('非文本笔画 / 空文本返回 null', () => {
    expect(textStrokeBBox({ tool: 'pen', points: [0, 0, 1, 1] })).toBeNull()
    expect(textStrokeBBox({ tool: 'text', points: [0, 0], text: '' })).toBeNull()
  })
})

describe('drawStrokes 文本渲染（2026-08-26）', () => {
  it('文本笔画按高度基准换算字号，多行逐行 fillText', () => {
    const ctx = makeFakeCtx()
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, [
      { tool: 'text', points: [0.5, 0.25], text: '第一行\n第二行', font: 0.02 },
    ], 200, 100)
    const fills = ctx.calls.filter(c => c.method === 'fillText')
    expect(fills).toHaveLength(2)
    expect(fills[0]!.args).toEqual(['第一行', 100, 25])
    // 第二行 y = 25 + fontPx(2) × 1.2
    expect(fills[1]!.args[0]).toBe('第二行')
    expect(fills[1]!.args[2]).toBeCloseTo(25 + 2 * 1.2, 5)
  })

  it('空文本笔画安全跳过', () => {
    const ctx = makeFakeCtx()
    drawStrokes(ctx as unknown as CanvasRenderingContext2D, [
      { tool: 'text', points: [0.5, 0.25], text: '' },
      { tool: 'pen', points: [0, 0, 1, 1] },
    ], 200, 100)
    expect(ctx.calls.filter(c => c.method === 'fillText')).toHaveLength(0)
    expect(ctx.calls.filter(c => c.method === 'stroke')).toHaveLength(1) // pen 照常
  })
})
