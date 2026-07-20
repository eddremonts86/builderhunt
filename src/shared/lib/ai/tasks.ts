/**
 * AI task registry — the single integration surface for every AI feature.
 *
 * This module is pure (no I/O, no Redis/DB/provider imports) so it can be
 * imported from both client and server code and unit-tested in isolation.
 *
 * How feature plans register a task:
 * 1. Add a new entry to `AI_TASKS` with a unique `id`.
 * 2. Pick a `tier`: `'local-first'` for interactive/ephemeral/this-user-only
 *    work (Chrome AI first, MiniMax fallback via `/api/ai/complete`), or
 *    `'server-only'` for persisted, shared, or background work.
 * 3. Define `inputSchema`/`outputSchema` (zod) — every model output is
 *    validated against `outputSchema` with one retry on parse failure.
 * 4. Write `system` (the system prompt) and `buildPrompt` (pure, wraps any
 *    untrusted external content via `wrapUntrusted`).
 * 5. Set `cacheTtlSeconds` (`null` disables caching for that task) and
 *    `allowances` (calls/user/day per plan tier — `0` gates the task off).
 *
 * See plans/_meta/ai-policy.md for the full platform contract.
 */
import { z } from 'zod'
import type { PlanTier } from '~/shared/lib/billing-shared'
import { SOURCE_NAMES } from '~/lib/sources/types'

export type AITaskId = string
export type AITier = 'local-first' | 'server-only'

export interface AITaskDefinition<I = unknown, O = unknown> {
  id: AITaskId
  tier: AITier
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  system: string
  buildPrompt: (input: I) => string
  cacheTtlSeconds: number | null
  allowances: Record<PlanTier, number>
  maxOutputTokens: number
}

const pingTask: AITaskDefinition<Record<string, never>, { pong: true }> = {
  id: 'ping',
  tier: 'server-only',
  inputSchema: z.object({}),
  outputSchema: z.object({ pong: z.literal(true) }),
  system: 'You are a smoke-test endpoint. Always respond with the exact JSON {"pong": true} and nothing else.',
  buildPrompt: () => 'Respond with {"pong": true}.',
  cacheTtlSeconds: null,
  allowances: { free: 5, pro: 20, team: 20 },
  // MiniMax M3 is a reasoning model: it always emits a `<think>...</think>`
  // block before its actual answer. A live smoke test showed ~110 reasoning
  // tokens for this trivial prompt alone — a small budget like 32 truncates
  // mid-think (finish_reason: "length") and the real JSON answer never
  // arrives, so every completion fails to parse. 300 leaves headroom.
  maxOutputTokens: 300,
}

export interface QueryTranslation {
  keywords: string[]
  language?: string
  country?: string
  sources?: (typeof SOURCE_NAMES)[number][]
}

const queryTranslationOutputSchema: z.ZodType<QueryTranslation> = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(8),
  language: z.string().optional(),
  country: z.string().optional(),
  sources: z.array(z.enum(SOURCE_NAMES)).optional(),
})

// Plan: semantic-search. Translates a natural-language sourcing query into
// search keywords + optional filters, used by the query engine's
// degradation ladder (semantic-search.ts) when the local vector index has
// too few matches. Runs client-side first (Chrome AI, free); the server
// re-validates with this same schema regardless of where it ran.
const queryTranslateTask: AITaskDefinition<{ query: string }, QueryTranslation> = {
  id: 'query-translate',
  tier: 'local-first',
  inputSchema: z.object({ query: z.string().min(3).max(300) }),
  outputSchema: queryTranslationOutputSchema,
  system:
    'You translate a natural-language developer-sourcing query into search keywords and '
    + 'optional filters. Keywords must be technologies or domain nouns actually present or '
    + 'clearly implied by the query (1-8 keywords). Never invent a language, country, or '
    + 'source filter that is not implied by the query — omit the field instead. Respond with '
    + 'JSON only, matching the schema exactly.',
  buildPrompt: (input) => `Query: ${input.query}\n\nRespond with JSON: { "keywords": string[], "language"?: string, "country"?: string, "sources"?: string[] }`,
  cacheTtlSeconds: 86400,
  // Pro feature — free is gated to 0.
  allowances: { free: 0, pro: 200, team: 500 },
  maxOutputTokens: 256,
}

// Individual task definitions keep their precise I/O generics (see `pingTask`
// above); the registry itself is necessarily heterogeneous, so it is keyed as
// `AITaskDefinition<any, any>` — callers narrow the schema at the call site.
export const AI_TASKS: Record<AITaskId, AITaskDefinition<any, any>> = {
  [pingTask.id]: pingTask,
  [queryTranslateTask.id]: queryTranslateTask,
}

export function getTask(id: string): AITaskDefinition<any, any> | null {
  return AI_TASKS[id] ?? null
}

interface AIEnvFlags {
  AI_DISABLED: 'true' | 'false'
  AI_DISABLED_TASKS: string
}

export function isTaskDisabled(id: string, env: AIEnvFlags): boolean {
  if (env.AI_DISABLED === 'true') return true
  const disabledList = env.AI_DISABLED_TASKS.split(',').map((entry) => entry.trim()).filter(Boolean)
  return disabledList.includes(id)
}

const UNTRUSTED_OPEN = '<untrusted>'
const UNTRUSTED_CLOSE = '</untrusted>'

/**
 * Wraps external/untrusted content (bios, READMEs, posts, etc.) in explicit
 * delimiters so prompts can instruct the model to treat it as inert data.
 * Escapes any literal occurrences of the closing delimiter so untrusted
 * content can never prematurely terminate the block.
 */
export function wrapUntrusted(text: string): string {
  const escaped = text.split(UNTRUSTED_CLOSE).join('&lt;/untrusted&gt;')
  return `${UNTRUSTED_OPEN}\n${escaped}\n${UNTRUSTED_CLOSE}`
}
