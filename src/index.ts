/**
 * dsh-point plugin, node half.
 *
 * Registers a system-prompt section that teaches the model how to read the
 * structured referent messages produced by the browser extension. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

interface SystemPromptRegistry {
  section(opts: { name: string; order: number; text: string }): void
}

/** Services required for model guidance paired with the browser renderer. */
export const inject = ['systemPrompt']

const REFERENT_PROMPT = 'The user may send "referent" messages that point to a specific element or region. '
  + 'Each referent is introduced by `[所指 #N]` and contains a fenced JSON block with: '
  + 'source URL/title, CSS selector, visible text excerpt, user comment, index, and sent time. '
  + 'A region screenshot is usually attached as an image. '
  + 'Use the selector, excerpt, comment, and screenshot together to identify what the user is pointing at before answering.'

/**
 * Register model guidance for the referent renderer shipped by this package.
 * @param ctx - host context carrying the system-prompt registry.
 */
export function apply(ctx: { systemPrompt?: SystemPromptRegistry }): void {
  if (ctx.systemPrompt === undefined) return
  ctx.systemPrompt.section({
    name: 'dsh-point:referent-format',
    order: 200,
    text: REFERENT_PROMPT,
  })
}
