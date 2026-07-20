/**
 * On-device prompting via Chrome's Prompt API (`LanguageModel`). Client-only —
 * never import from server code. See
 * https://developer.chrome.com/docs/ai/prompt-api.
 *
 * Callers keep prompts under ~4k tokens (Chrome's on-device context window is
 * roughly 6k) — this module does not truncate or chunk input itself.
 */
import { z } from 'zod'
import { AIParseError } from './errors'

export interface PromptLocalOptions<O> {
  system: string
  prompt: string
  schema: z.ZodType<O>
}

interface LanguageModelSession {
  prompt(input: string, options?: { responseConstraint?: unknown }): Promise<string>
  destroy(): void
}

interface LanguageModelConstructor {
  create(options: {
    initialPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  }): Promise<LanguageModelSession>
}

function getLanguageModel(): LanguageModelConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (globalThis as unknown as { LanguageModel?: LanguageModelConstructor }).LanguageModel
  return ctor ?? null
}

function tryParse<O>(text: string, schema: z.ZodType<O>): O | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/**
 * Creates a short-lived on-device session, prompts once, validates the
 * result against `schema`, and retries once with a correction turn on parse
 * failure before throwing `AIParseError`. The session is always destroyed,
 * even on failure.
 */
export async function promptLocal<O>({ system, prompt, schema }: PromptLocalOptions<O>): Promise<O> {
  const LanguageModel = getLanguageModel()
  if (!LanguageModel) throw new AIParseError('Chrome LanguageModel is not available in this browser')

  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: system }],
  })

  try {
    const responseConstraint = z.toJSONSchema(schema)

    const first = await session.prompt(prompt, { responseConstraint })
    const firstResult = tryParse(first, schema)
    if (firstResult !== null) return firstResult

    const correction = `${prompt}\n\nYour previous response did not match the required JSON schema. Return ONLY valid JSON matching the schema, with no other text.`
    const second = await session.prompt(correction, { responseConstraint })
    const secondResult = tryParse(second, schema)
    if (secondResult !== null) return secondResult

    throw new AIParseError('Local model response did not match the expected schema after one retry')
  } finally {
    session.destroy()
  }
}
