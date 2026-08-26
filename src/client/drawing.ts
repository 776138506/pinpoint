/**
 * Pure whiteboard drawing primitives for the mark comment popup.
 *
 * Strokes are stored as ratios (0..1) relative to the original screenshot so
 * they survive display-size changes and can be composed onto the source image
 * before sending. This module has no DOM dependencies beyond the canvas API.
 */

/** Supported drawing tools. */
export type DrawTool = 'pen' | 'arrow' | 'rect' | 'text'

/**
 * One stroke: tool kind + normalized point pairs [x1, y1, x2, y2, ...].
 * `text` strokes carry the literal text plus `font` — font size in the SAME
 * unit space as `points` (normalized strokes → ratio of the height basis,
 * like y coordinates), so it scales with whatever canvas it is drawn onto.
 */
export interface Stroke {
  tool: DrawTool
  points: number[]
  /** Literal text content (text strokes only). May contain newlines. */
  text?: string
  /** Font size in the points' coordinate space (text strokes only). */
  font?: number
}

/** 2-D point used by arrow-head geometry. */
export interface Point {
  x: number
  y: number
}

/** Fixed drawing style. */
const STROKE_COLOR = '#ff2d55'
const LINE_WIDTH = 3

/** Default font size for text strokes, as a ratio of the canvas height (≈16px on an 800px-tall canvas). */
const DEFAULT_FONT_RATIO = 0.02
/** Line-height factor for multi-line text. */
const TEXT_LINE_HEIGHT = 1.2

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
    // 文本笔画只有锚点（2 个坐标值），必须先于「<4 跳过」分支处理
    if (stroke.tool === 'text') {
      if (!stroke.text) continue
      const [ax, ay] = toPixel(stroke.points, width, height)
      if (ax === undefined || ay === undefined) continue
      const fontPx = (stroke.font ?? DEFAULT_FONT_RATIO) * height
      ctx.font = `${fontPx}px sans-serif`
      ctx.textBaseline = 'top'
      const lines = stroke.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i]!, ax, ay + i * fontPx * TEXT_LINE_HEIGHT)
      }
      continue
    }
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

/* ---------- 像素级橡皮（2026-08-25：矢量切割实现） ----------
 * 橡皮不做「整条删除」（那和撤销没区别），而是把笔画在擦除交点处切断成
 * 子笔画——矢量模型不变，drawStrokes / composeScreenshot / 归一化管线零改动。
 * 箭头/矩形被擦到时先转成等效折线（pen），再统一切割。
 * ponytail: 箭头头部填充三角转成轮廓折线后视觉略有差异（空心化），
 * 白板是快速标注场景，可接受；要完全保真需引入填充图元的切割。 */

/** Distance from point (px, py) to segment (ax, ay)-(bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Expand a stroke into plain polylines: pen stays itself; arrow becomes shaft +
 * head triangle outline (3 polylines); rect becomes its 4-edge closed polyline.
 * Text strokes have no outline — they are handled by bounding-box deletion instead.
 */
function strokeToPolylines(stroke: Stroke): number[][] {
  const pts = stroke.points
  if (stroke.tool === 'pen' || pts.length < 4) return pts.length >= 4 ? [pts] : []
  const [x1, y1, x2, y2] = pts as [number, number, number, number]
  if (stroke.tool === 'rect') {
    return [[x1, y1, x2, y1, x2, y2, x1, y2, x1, y1]]
  }
  // arrow：箭杆 + 头部三角轮廓（与 drawStrokes 的箭头几何同款）
  const head = getArrowHead({ x: x2, y: y2 }, { x: x1, y: y1 }, LINE_WIDTH * 3)
  return [
    [x1, y1, x2, y2],
    [x2, y2, head.left.x, head.left.y, head.right.x, head.right.y, x2, y2],
  ]
}

function polylineHitsSegment(pl: number[], ex1: number, ey1: number, ex2: number, ey2: number, radius: number): boolean {
  for (let i = 0; i + 3 < pl.length; i += 2) {
    // 线段相交判定：采样足够密（切割采样 2px），任一端点或中点落入半径即算命中
    const mx = (pl[i]! + pl[i + 2]!) / 2
    const my = (pl[i + 1]! + pl[i + 3]!) / 2
    if (
      distToSegment(pl[i]!, pl[i + 1]!, ex1, ey1, ex2, ey2) <= radius
      || distToSegment(mx, my, ex1, ey1, ex2, ey2) <= radius
      || distToSegment(pl[i + 2]!, pl[i + 3]!, ex1, ey1, ex2, ey2) <= radius
    ) return true
  }
  return false
}

/**
 * Cut one polyline by the eraser capsule (segment + radius). Returns the kept
 * runs (each ≥ 2 points). Segments are resampled at ~2px so the cut boundary
 * follows the eraser edge instead of the coarse pen-sampling points.
 */
function cutPolyline(pl: number[], ex1: number, ey1: number, ex2: number, ey2: number, radius: number): number[][] {
  // 密采样展开
  const samples: number[] = []
  for (let i = 0; i + 3 < pl.length; i += 2) {
    const ax = pl[i]!
    const ay = pl[i + 1]!
    const bx = pl[i + 2]!
    const by = pl[i + 3]!
    const len = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(len / 2))
    for (let s = 0; s < steps; s++) {
      samples.push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)
    }
  }
  if (pl.length >= 2) samples.push(pl[pl.length - 2]!, pl[pl.length - 1]!)
  // 按「是否落入橡皮」切成保留段
  const runs: number[][] = []
  let run: number[] = []
  for (let i = 0; i < samples.length; i += 2) {
    const erased = distToSegment(samples[i]!, samples[i + 1]!, ex1, ey1, ex2, ey2) <= radius
    if (erased) {
      if (run.length >= 4) runs.push(run)
      run = []
    } else {
      run.push(samples[i]!, samples[i + 1]!)
    }
  }
  if (run.length >= 4) runs.push(run)
  return runs
}

/**
 * Bounding box of a text stroke in the strokes' own coordinate space.
 * `heightBasis` (default 1) is a uniform scale factor applied to x/y/font —
 * pass the canvas pixel height to convert normalized strokes to pixels
 * (anisotropy is ignored; hit-testing only needs an approximation).
 * Width is estimated (CJK ≈ 1em, ASCII ≈ 0.55em); ponytail: swap in
 * ctx.measureText if it ever mis-fires.
 */
export function textStrokeBBox(
  stroke: Stroke,
  heightBasis = 1,
): { x: number; y: number; width: number; height: number } | null {
  if (stroke.tool !== 'text' || !stroke.text) return null
  const x = stroke.points[0]
  const y = stroke.points[1]
  if (x === undefined || y === undefined) return null
  const fontPx = (stroke.font ?? DEFAULT_FONT_RATIO) * heightBasis
  const lines = stroke.text.split('\n')
  let maxUnits = 0
  for (const line of lines) {
    let units = 0
    for (const ch of line) units += ch.charCodeAt(0) > 0xff ? 1 : 0.55
    if (units > maxUnits) maxUnits = units
  }
  return {
    x: x * heightBasis,
    y: y * heightBasis,
    width: maxUnits * fontPx,
    height: lines.length * fontPx * TEXT_LINE_HEIGHT,
  }
}

/** Does the eraser capsule (segment + radius) touch the given rect? */
function segmentHitsRect(
  ex1: number, ey1: number, ex2: number, ey2: number,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
): boolean {
  const r = {
    x1: rect.x - radius, y1: rect.y - radius,
    x2: rect.x + rect.width + radius, y2: rect.y + rect.height + radius,
  }
  const len = Math.hypot(ex2 - ex1, ey2 - ey1)
  const steps = Math.max(1, Math.ceil(len / 2))
  for (let s = 0; s <= steps; s++) {
    const px = ex1 + ((ex2 - ex1) * s) / steps
    const py = ey1 + ((ey2 - ey1) * s) / steps
    if (px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2) return true
  }
  return false
}

/**
 * Erase part of `strokes` along the segment (ex1, ey1)-(ex2, ey2) with the given
 * radius. Untouched strokes keep their identity (same object). Returns
 * `{ strokes, changed }` so callers can skip redundant redraws.
 *
 * Text strokes can't be "cut" — an eraser pass over a text stroke's bounding
 * box deletes it whole (standard whiteboard behavior; partial-erasing glyphs
 * is meaningless). The bbox is computed in the strokes' own coordinate space
 * (`font` scales like y, so no unit conversion is needed).
 */
export function eraseStrokes(
  strokes: readonly Stroke[],
  ex1: number,
  ey1: number,
  ex2: number,
  ey2: number,
  radius: number,
): { strokes: Stroke[]; changed: boolean } {
  const out: Stroke[] = []
  let changed = false
  for (const stroke of strokes) {
    if (stroke.tool === 'text') {
      const bbox = textStrokeBBox(stroke)
      if (bbox !== null && segmentHitsRect(ex1, ey1, ex2, ey2, bbox, radius)) {
        changed = true
        continue
      }
      out.push(stroke)
      continue
    }
    const polylines = strokeToPolylines(stroke)
    if (!polylines.some(pl => polylineHitsSegment(pl, ex1, ey1, ex2, ey2, radius))) {
      out.push(stroke)
      continue
    }
    changed = true
    for (const pl of polylines) {
      for (const run of cutPolyline(pl, ex1, ey1, ex2, ey2, radius)) {
        out.push({ tool: 'pen', points: run })
      }
    }
  }
  return { strokes: out, changed }
}
