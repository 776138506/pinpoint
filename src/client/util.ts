import type { Mark } from './stores.ts'
import { formatMark } from '../schema/mark-format.ts'
export { parseMarkText, extractReferents } from '../schema/mark-format.ts'
export type { ReferentPayload } from '../schema/mark-format.ts'

/**
 * Convert an image data URL to a browser File for the conversation attachment
 * pipeline. The name is deterministic per mark so repeated staging does not
 * mint confusing new identities.
 */
export function dataUrlToFile(dataUrl: string, filename: string): File {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl)
  if (match === null) {
    throw new Error(`截图格式不是预期的图片 data URL（实际前缀：${dataUrl.slice(0, 40)}…），无法作为附件发送`)
  }
  const [, mime, base64] = match
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], filename, { type: mime })
}

/**
 * Serialize one mark into the model-visible structured text block.
 * Delegates to the shared schema so the dsh client plugin and the browser
 * extension produce identical referent messages.
 */
export function formatMarkText(mark: Mark, comment: string): string {
  return formatMark(mark, comment)
}
