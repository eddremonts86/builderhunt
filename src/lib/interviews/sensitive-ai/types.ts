/**
 * Sensitive-text AI provider contract (plan: calendar-scheduling-interview-intelligence, spec.md
 * "AI task contracts": "All three tasks are `server-only` ... and routed only through
 * `SensitiveAIProvider`."). No I/O, no vendor SDK import — the three AI tasks
 * (interview-brief-generate, interview-followup-suggest, interview-report-generate) call this
 * interface, never an Azure OpenAI client directly. spec.md: "Sensitive tasks do not fall through
 * to MiniMax or browser AI" — a `SensitiveAIProvider` implementation must never silently degrade
 * to a different, non-regional model.
 */

export interface SensitiveAICompletionRequest<TInput = unknown> {
  taskId: string
  promptVersion: string
  input: TInput
}

export interface SensitiveAICompletionUsage {
  inputTokens: number
  outputTokens: number
}

export interface SensitiveAICompletionResult<TOutput = unknown> {
  output: TOutput
  model: string
  promptVersion: string
  usage: SensitiveAICompletionUsage
}

export type SensitiveAIErrorCode = 'provider_unavailable' | 'invalid_configuration' | 'rate_limited' | 'content_filtered' | 'malformed_output'

export class SensitiveAIProviderError extends Error {
  constructor(message: string, readonly code: SensitiveAIErrorCode) {
    super(message)
    this.name = 'SensitiveAIProviderError'
  }
}

export interface SensitiveAIProvider {
  completeStructured<TInput, TOutput>(request: SensitiveAICompletionRequest<TInput>): Promise<SensitiveAICompletionResult<TOutput>>
}
