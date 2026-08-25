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
import { composeScreenshot, drawStrokes, getArrowHead } from './drawing.ts'

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
