// Server-side MiniMax M3 chat client. Never import from client-side code —
// this module reads MINIMAX_API_KEY and must only run on the server.
//
// Endpoint: MiniMax's OpenAI-compatible chat completions endpoint. Per current
// MiniMax docs (platform.minimax.io/docs/guides/text-generation), the
// OpenAI-compatible base URL already includes `/v1` (e.g. `https://api.minimax.io/v1`)
// and the path is `/chat/completions` (NOT the older `/v1/text/chatcompletion_v2`
// endpoint). `chatCompletionUrl()` handles both a base with and without a
// trailing `/v1` so it works regardless of how MINIMAX_BASE_URL is configured.
import type { z } from 'zod'
import { env } from '~/shared/lib/env'
import { AIDisabledError, AIParseError, AIProviderError } from './errors'

const REQUEST_TIMEOUT_MS = 30_000

export interface MinimaxUsage {
  promptTokens: number
  completionTokens: number
}

export interface MinimaxChatOptions<O> {
  system: string
  prompt: string
  schema: z.ZodType<O>
  maxOutputTokens: number
  /**
   * Optional observer for the raw token usage of every underlying provider call, including the
   * JSON-correction retry below if one happens (each is a real, separately-billed provider call).
   * Never required — omitting it changes nothing about the call itself. Exists for the
   * abuse-and-usage-integrity "G7" margin monitor (`abuse/margin.ts`) to estimate provider cost once
   * a caller wires it to a real credit charge; no production caller does that yet (confirmed: none
   * of the 3 current `minimaxChat` call sites use the dollar-based credit ledger, only the
   * call-count `checkAndConsumeBudget`), so this is intentionally inert until one does.
   */
  onUsage?: (usage: MinimaxUsage) => void
}

interface MinimaxChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number, completion_tokens?: number }
}

function chatCompletionUrl(): string {
  const base = env.MINIMAX_BASE_URL.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

async function callMinimax(system: string, prompt: string, maxOutputTokens: number): Promise<{ content: string, usage: MinimaxUsage }> {
  let response: Response
  try {
    response = await fetch(chatCompletionUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MINIMAX_MODEL,
        temperature: 0.2,
        max_tokens: maxOutputTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new AIProviderError(0, error instanceof Error ? error.message : 'MiniMax request failed')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new AIProviderError(response.status, body.slice(0, 500) || `MiniMax returned HTTP ${response.status}`)
  }

  const json = (await response.json()) as MinimaxChatCompletionResponse
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new AIProviderError(502, 'MiniMax response is missing choices[0].message.content')
  }
  const usage: MinimaxUsage = {
    promptTokens: typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : 0,
    completionTokens: typeof json.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : 0,
  }
  return { content, usage }
}

function extractJson(text: string): unknown {
  // MiniMax M3 emits a `<think>...</think>` reasoning block before its actual
  // answer (confirmed via a live smoke test). That block can itself contain
  // brace-shaped text (e.g. quoting the requested JSON back), which would
  // confuse a naive greedy brace match — so strip think blocks first.
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  try {
    return JSON.parse(withoutThinking)
  } catch {
    const match = withoutThinking.match(/\{[\s\S]*\}/)
    if (!match) throw new SyntaxError('No JSON object found in MiniMax response')
    return JSON.parse(match[0])
  }
}

function tryParseOutput<O>(text: string, schema: z.ZodType<O>): O | null {
  let value: unknown
  try {
    value = extractJson(text)
  } catch {
    return null
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/**
 * Calls MiniMax M3, zod-validates the result against `schema`, and retries
 * once with a JSON-correction turn on parse/schema failure before throwing
 * `AIParseError`. Never relies on provider-side `response_format` — the
 * caller's `prompt` (via each task's `buildPrompt`) must already embed the
 * JSON Schema instructions.
 */
export async function minimaxChat<O>({ system, prompt, schema, maxOutputTokens, onUsage }: MinimaxChatOptions<O>): Promise<O> {
  if (!env.MINIMAX_API_KEY) throw new AIDisabledError('MINIMAX_API_KEY is not configured')

  const first = await callMinimax(system, prompt, maxOutputTokens)
  onUsage?.(first.usage)
  const firstResult = tryParseOutput(first.content, schema)
  if (firstResult !== null) return firstResult

  const correctionPrompt = `${prompt}\n\nYour previous response did not match the required JSON schema. Return ONLY valid JSON matching the schema, with no other text.`
  const second = await callMinimax(system, correctionPrompt, maxOutputTokens)
  onUsage?.(second.usage)
  const secondResult = tryParseOutput(second.content, schema)
  if (secondResult !== null) return secondResult

  throw new AIParseError('MiniMax response did not match the expected schema after one retry')
}
