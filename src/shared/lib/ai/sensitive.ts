/**
 * The sensitive-AI boundary: the only way candidate material reaches a model (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## Why this is separate from `client.ts`
 *
 * `client.ts` implements a local-first ladder that falls back to MiniMax. Nothing on that ladder may
 * ever see a candidate's CV. The two are separate modules with separate kill switches precisely so
 * that a change to the general AI path cannot quietly acquire a route into interview data — and so
 * that switching sensitive AI off does not switch off unrelated features, or vice versa.
 *
 * **There is no fallback here.** If the sensitive provider is unavailable, the caller gets an error
 * and shows a deterministic manual path. Falling back to a non-EU or non-agreed model would move
 * candidate data outside the residency the candidate was told about, which is not a degraded
 * experience — it is a different processing operation with no lawful basis.
 *
 * ## Mistral is primary, and the plan text saying "Azure" is out of date
 *
 * `tasks.md` still names an "Azure regional sensitive AI adapter". The decision was revised on
 * 2026-07-26 (`docs/operations/interview-provider-register.md`: "Mistral (La Plateforme) becomes
 * primary; the provisioned Azure resource stays as a fallback") after Azure provisioning hit a
 * zero-quota wall and a residency regression, and `env.ts` has defaulted `SENSITIVE_AI_PROVIDER` to
 * `mistral` since. Three sources agree and one document lags; this follows the three.
 *
 * ## What never leaves this module
 *
 * Prompts and completions. `redactedTelemetry` returns counts, durations and model ids — never a
 * fragment of either. A log line containing a CV excerpt is a copy of candidate data in a system with
 * its own retention, its own access rules, and no consent record.
 */
import type { z } from 'zod'
import { env } from '~/shared/lib/env'
import { AIDisabledError, AIProviderError } from './errors'
import { mistralStructuredCompletion } from './mistral'

export interface SensitiveAIUsage {
  promptTokens: number
  completionTokens: number
}

export interface SensitiveAICompletionResult<TOutput> {
  output: TOutput
  /** Which provider actually ran, for the audit trail — never inferred from configuration later. */
  provider: 'mistral' | 'azure'
  /**
   * The exact model id that produced this. Recorded because `env.ts` pins a dated id rather than a
   * floating alias: an unannounced model change that shifts how candidates are assessed is a fairness
   * and auditability problem, and "which model wrote this assessment" has to be answerable per record,
   * not per deployment.
   */
  model: string
  usage: SensitiveAIUsage
  durationMs: number
}

export interface SensitiveAICompletionInput<TOutput> {
  system: string
  prompt: string
  schema: z.ZodType<TOutput>
  maxOutputTokens: number
  /** Caller-supplied deadline. Composed with the adapter's own, so neither can outlive the other. */
  signal?: AbortSignal
}

/**
 * Telemetry shaped so it *cannot* carry content.
 *
 * The fields are all numbers and identifiers. This is a type, not a convention: a future caller that
 * wants to log "the prompt that failed" has to change this interface to do it, which is a change a
 * reviewer will see rather than a string concatenation nobody notices.
 */
export interface SensitiveAITelemetry {
  provider: string
  model: string
  outcome: 'ok' | 'invalid_output' | 'timeout' | 'rate_limited' | 'provider_error' | 'aborted'
  durationMs: number
  promptTokens: number
  completionTokens: number
  attempts: number
  /** Byte lengths, so a size problem is diagnosable without the content that caused it. */
  promptBytes: number
  outputBytes: number
}

export function isSensitiveAIEnabled(): boolean {
  // Its own switch, deliberately not `AI_ENABLED`. An operator turning off interview AI after a
  // provider incident must not also lose search ranking, and an operator turning off general AI must
  // not silently keep sending CVs to a model.
  return env.SENSITIVE_AI_ENABLED === 'true'
}

/**
 * Defense in depth against a non-EU endpoint.
 *
 * `env.ts` already rejects anything but `https://api.mistral.ai` at boot. This checks again at call
 * time because the two failures are different: a boot check protects against a bad deployment, and
 * this protects against anything that mutates configuration afterwards. Mistral's US endpoint is an
 * opt-in, so the safe posture is to accept exactly the one known-EU host and refuse every other
 * string rather than pattern-matching for something that looks European.
 */
export function assertRegionalConfiguration(): void {
  if (env.SENSITIVE_AI_PROVIDER === 'mistral') {
    if (env.MISTRAL_BASE_URL.replace(/\/+$/, '') !== 'https://api.mistral.ai') {
      throw new AIProviderError(0, 'sensitive AI base URL is not the EU Mistral endpoint')
    }
    return
  }
  // Azure is the retained fallback. Its residency is a property of the resource's region, which only
  // the endpoint hostname reveals, so a non-regional endpoint is refused rather than trusted.
  const endpoint = env.AZURE_OPENAI_ENDPOINT ?? ''
  if (!/^https:\/\/[a-z0-9-]+\.openai\.azure\.com\/?$/i.test(endpoint)) {
    throw new AIProviderError(0, 'sensitive AI endpoint is not a regional Azure OpenAI endpoint')
  }
}

/**
 * Runs one sensitive completion.
 *
 * The order matters: kill switch, then configuration, then the provider. A disabled feature must not
 * be able to fail with a configuration error, because an operator reading that error would go and fix
 * configuration that was never the problem.
 */
export async function sensitiveCompletion<TOutput>(
  input: SensitiveAICompletionInput<TOutput>,
  onTelemetry?: (telemetry: SensitiveAITelemetry) => void,
): Promise<SensitiveAICompletionResult<TOutput>> {
  if (!isSensitiveAIEnabled()) {
    throw new AIDisabledError('sensitive AI is disabled')
  }
  assertRegionalConfiguration()

  if (env.SENSITIVE_AI_PROVIDER === 'azure') {
    // Deliberately not implemented rather than silently routed to Mistral. An operator who set
    // `SENSITIVE_AI_PROVIDER=azure` believes their data is going to Azure, and honouring that belief
    // with a different provider is the one failure mode this whole module exists to prevent.
    throw new AIProviderError(0, 'the azure sensitive provider is configured but not implemented; set SENSITIVE_AI_PROVIDER=mistral')
  }

  return mistralStructuredCompletion(input, onTelemetry)
}
