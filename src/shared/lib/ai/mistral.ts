/**
 * Mistral La Plateforme adapter for sensitive interview work. Server-only — reads `MISTRAL_API_KEY`.
 *
 * Reached exclusively through `sensitive.ts`, which owns the kill switch and the residency assertion.
 * Nothing should import this module directly: doing so bypasses both.
 *
 * ## Retries are bounded and only for the failures a retry can fix
 *
 * A 429 or a 5xx is worth one more attempt. A schema violation is not retried at all, and that is a
 * deliberate difference from `minimax.ts`, which re-prompts once on unparseable JSON. Here the output
 * is candidate-evaluation material: a model that produced something structurally wrong has told us it
 * misunderstood the task, and asking again spends real credits to roll the dice on an assessment
 * somebody will act on. The caller shows the deterministic manual path instead.
 *
 * ## Nothing here configures retention or training
 *
 * There is no `store`, no fine-tuning reference, no dataset id — and that absence is the point, so it
 * is stated rather than left to be inferred from what the request happens not to contain. Mistral does
 * not train on La Plateforme API traffic; the organisation-level opt-out is a real switch and is
 * recorded in `docs/operations/interview-provider-register.md`. This module must never grow a
 * parameter that changes either.
 *
 * `AIProviderError` carries an HTTP status as its first argument. A `0` means no HTTP response
 * happened at all — a timeout, an abort, or a socket failure — which is a different thing from a
 * provider that answered badly, and callers deciding whether to retry need to tell them apart.
 */
import type { z } from 'zod'
import { env } from '~/shared/lib/env'
import { AIParseError, AIProviderError } from './errors'
import type {
  SensitiveAICompletionInput,
  SensitiveAICompletionResult,
  SensitiveAITelemetry,
} from './sensitive'

const REQUEST_TIMEOUT_MS = 60_000
/** One retry, for transient statuses only. Two would double the worst-case latency of a UI action. */
const MAX_ATTEMPTS = 2
const RETRY_BASE_DELAY_MS = 500

interface MistralChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function chatCompletionUrl(): string {
  return `${env.MISTRAL_BASE_URL.replace(/\/+$/, '')}/v1/chat/completions`
}

/** 429 and 5xx are worth another attempt; a 4xx is a request we built wrong and will build wrong again. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600)
}

function outcomeForStatus(status: number): SensitiveAITelemetry['outcome'] {
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}

export async function mistralStructuredCompletion<TOutput>(
  input: SensitiveAICompletionInput<TOutput>,
  onTelemetry?: (telemetry: SensitiveAITelemetry) => void,
): Promise<SensitiveAICompletionResult<TOutput>> {
  const startedAt = Date.now()
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8')
  const model = env.MISTRAL_MODEL ?? ''
  let attempts = 0

  const emit = (
    outcome: SensitiveAITelemetry['outcome'],
    extra: { promptTokens?: number; completionTokens?: number; outputBytes?: number } = {},
  ) => {
    onTelemetry?.({
      provider: 'mistral',
      model,
      outcome,
      durationMs: Date.now() - startedAt,
      promptTokens: extra.promptTokens ?? 0,
      completionTokens: extra.completionTokens ?? 0,
      attempts,
      promptBytes,
      outputBytes: extra.outputBytes ?? 0,
    })
  }

  let lastStatus = 0
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1

    // The adapter's own deadline, composed with the caller's. `AbortSignal.any` means whichever fires
    // first wins and neither can outlive the other — a caller cancelling a request must actually stop
    // the socket, and an adapter timeout must fire even for a caller that passed no signal.
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('sensitive completion timed out')), REQUEST_TIMEOUT_MS)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal

    let response: Response
    try {
      response = await fetch(chatCompletionUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.MISTRAL_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model,
          // Low but not zero: an assessment should be reproducible in substance without being a
          // degenerate single-path completion.
          temperature: 0.2,
          max_tokens: input.maxOutputTokens,
          // Structured output. Without this the model is free to wrap JSON in prose and every call
          // becomes a parsing gamble.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
        }),
        signal,
      })
    } catch (error) {
      clearTimeout(timer)
      // A caller-initiated abort is not a provider failure and must not be retried — the caller asked
      // us to stop, and trying again would be ignoring them.
      if (input.signal?.aborted) {
        emit('aborted')
        throw new AIProviderError(0, 'sensitive completion aborted by the caller')
      }
      if (attempts >= MAX_ATTEMPTS) {
        emit('timeout')
        throw new AIProviderError(
          0,
          `sensitive completion failed after ${attempts} attempts: ${error instanceof Error ? error.name : 'unknown'}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempts))
      continue
    }
    clearTimeout(timer)

    if (!response.ok) {
      lastStatus = response.status
      if (isRetryableStatus(response.status) && attempts < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempts))
        continue
      }
      emit(outcomeForStatus(response.status))
      // Status only. A provider error body can echo the prompt back, and this message reaches logs.
      throw new AIProviderError(response.status, `sensitive provider returned ${response.status}`)
    }

    let payload: MistralChatResponse
    try {
      payload = await response.json() as MistralChatResponse
    } catch {
      emit('provider_error')
      throw new AIProviderError(response.status, 'sensitive provider returned a non-JSON envelope')
    }

    const content = payload.choices?.[0]?.message?.content ?? ''
    const usage = {
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
    }
    const outputBytes = Buffer.byteLength(content, 'utf8')

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      emit('invalid_output', { ...usage, outputBytes })
      // Not retried. See the module header: a re-prompt spends credits to re-roll an assessment
      // somebody will act on.
      throw new AIParseError('sensitive provider returned content that is not JSON')
    }

    const validated = input.schema.safeParse(parsed)
    if (!validated.success) {
      emit('invalid_output', { ...usage, outputBytes })
      // Zod's issue paths name fields, not values — safe to log. `validated.error.message` would
      // include the offending content, so it is deliberately not used.
      throw new AIParseError(
        `sensitive provider output failed validation at: ${validated.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      )
    }

    emit('ok', { ...usage, outputBytes })
    return {
      output: validated.data,
      provider: 'mistral',
      // The provider's own answer, not our configuration — if they served a different model than we
      // asked for, the record should say what actually ran.
      model: payload.model ?? model,
      usage,
      durationMs: Date.now() - startedAt,
    }
  }

  emit(lastStatus === 429 ? 'rate_limited' : 'provider_error')
  throw new AIProviderError(lastStatus, `sensitive completion exhausted ${MAX_ATTEMPTS} attempts`)
}
