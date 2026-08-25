/**
 * Pure whiteboard drawing primitives for the mark comment popup.
 *
 * Strokes are stored as ratios (0..1) relative to the original screenshot so
 * they survive display-size changes and can be composed onto the source image
 * before sending. This module has no DOM dependencies beyond the canvas API.
 */

/** Supported drawing tools. */
export type DrawTool = 'pen' | 'arrow' | 'rect'

/** One stroke: tool kind + normalized point pairs [x1, y1, x2, y2, ...]. */
export interface Stroke {
  tool: DrawTool
  points: number[]
}

/** 2-D point used by arrow-head geometry. */
export interface Point {
  x: number
  y: number
}

/** Fixed drawing style. */
const STROKE_COLOR = '#ff2d55'
const LINE_WIDTH = 3

/**
 * Compute the two base points of a solid triangular arrow head.
 * @param tip - arrow tip (end of the line).
 * @param tail - arrow tail (start of the line).
 * @param headLength - length of each side of the triangle.
 * @returns the left and right base points.
 */
export function getArrowHead(tip: Point, tail: Point, headLength: number): { left: Point; right: Point } {
  const dx = tail.x - tip.x
  const dy = tail.y - tip.y
  const angle = Math.atan2(dy, dx)
  return {
    left: {
      x: tip.x + headLength * Math.cos(angle + Math.PI / 6),
      y: tip.y + headLength * Math.sin(angle + Math.PI / 6),
    },
    right: {
      x: tip.x + headLength * Math.cos(angle - Math.PI / 6),
      y: tip.y + headLength * Math.sin(angle - Math.PI / 6),
    },
  }
}

function toPixel(points: number[], width: number, height: number): number[] {
  const out: number[] = []
  for (let i = 0; i < points.length; i += 2) {
    out.push(points[i] * width, (points[i + 1] ?? 0) * height)
  }
  return out
}

/** Draw a set of normalized strokes onto a canvas 2-D context. */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.strokeStyle = STROKE_COLOR
  ctx.fillStyle = STROKE_COLOR
  ctx.lineWidth = LINE_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    const pts = toPixel(stroke.points, width, height)
    if (pts.length < 4) continue
    switch (stroke.tool) {
      case 'pen': {
        ctx.beginPath()
        ctx.moveTo(pts[0], pts[1])
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
        ctx.stroke()
        break
      }
      case 'arrow': {
        const [x1, y1, x2, y2] = pts
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        const head = getArrowHead({ x: x2, y: y2 }, { x: x1, y: y1 }, LINE_WIDTH * 3)
        ctx.beginPath()
        ctx.moveTo(x2, y2)
        ctx.lineTo(head.left.x, head.left.y)
        ctx.lineTo(head.right.x, head.right.y)
        ctx.closePath()
        ctx.fill()
        break
      }
      case 'rect': {
        const [x1, y1, x2, y2] = pts
        const left = Math.min(x1, x2)
        const top = Math.min(y1, y2)
        const w = Math.abs(x2 - x1)
        const h = Math.abs(y2 - y1)
        if (w > 0 && h > 0) ctx.strokeRect(left, top, w, h)
        break
      }
    }
  }
  ctx.restore()
}

/**
 * Compose strokes on top of the original screenshot.
 * @param screenshot - PNG data URL of the screenshot.
 * @param strokes - normalized strokes to overlay.
 * @returns a new PNG data URL, or `null` if the image cannot be loaded.
 */
export async function composeScreenshot(screenshot: string, strokes: readonly Stroke[]): Promise<string | null> {
  if (!screenshot || strokes.length === 0) return screenshot || null
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(null)
        return
      }
      ctx.drawImage(img, 0, 0)
      drawStrokes(ctx, strokes, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      resolve(null)
    }
    img.src = screenshot
  })
}
