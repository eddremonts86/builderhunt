/**
 * Unified client entry point for AI features: `ai(taskId, input, opts?)`.
 *
 * Implements the local-first ladder from plans/phase-1/20-ai-expansion/spec.md:
 *   1. Task `local-first` + prompt capability `available` (and the user
 *      hasn't opted into `forceServer`/the `bh-ai-prefer-server` preference)
 *      -> `promptLocal`. Success -> `{ output, via: 'local' }`.
 *   2. Local unavailable/failed, or task `server-only`
 *      -> `POST /api/ai/complete` -> `{ output, via: 'server', cached }`.
 *   3. Server 4xx/5xx -> throws `AIUnavailableError { reason }`.
 * Rung 3 (rule-based v1 fallback) and rung 4 (hide AI UI) are feature-owned:
 * callers catch `AIUnavailableError` and degrade themselves.
 */
import { getAICapability } from './capabilities'
import { promptLocal } from './local'
import { getTask, type AITaskId } from './tasks'
import { AIUnavailableError } from './errors'

const PREFER_SERVER_STORAGE_KEY = 'bh-ai-prefer-server'

export interface AiOptions {
  signal?: AbortSignal
  forceServer?: boolean
}

export interface AiResult<O> {
  output: O
  via: 'local' | 'server'
  cached?: boolean
}

function prefersServer(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(PREFER_SERVER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function mapErrorReason(status: number, errorCode: string): 'disabled' | 'plan' | 'budget' | 'error' {
  if (errorCode === 'ai_disabled' || errorCode === 'ai_unconfigured') return 'disabled'
  if (status === 429 && (errorCode === 'plan' || errorCode === 'budget')) return errorCode
  return 'error'
}

async function callServer<O>(taskId: AITaskId, input: unknown, signal: AbortSignal | undefined): Promise<AiResult<O>> {
  let response: Response
  try {
    response = await fetch('/api/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ taskId, input }),
      signal,
    })
  } catch (error) {
    throw new AIUnavailableError('error', error instanceof Error ? error.message : 'AI request failed')
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown }
    const errorCode = typeof body.error === 'string' ? body.error : ''
    throw new AIUnavailableError(mapErrorReason(response.status, errorCode), errorCode || `HTTP ${response.status}`)
  }

  const body = (await response.json()) as { output: O; cached: boolean }
  return { output: body.output, via: 'server', cached: body.cached }
}

export async function ai<O = unknown>(taskId: AITaskId, input: unknown, opts: AiOptions = {}): Promise<AiResult<O>> {
  const task = getTask(taskId)
  if (!task) throw new AIUnavailableError('error', `Unknown AI task: ${taskId}`)

  const parsedInput = task.inputSchema.safeParse(input)
  if (!parsedInput.success) throw new AIUnavailableError('error', `Invalid input for task "${taskId}"`)

  if (task.tier === 'local-first' && !opts.forceServer && !prefersServer()) {
    const capability = await getAICapability('prompt')
    if (capability === 'available') {
      try {
        const output = await promptLocal<O>({
          system: task.system,
          prompt: task.buildPrompt(parsedInput.data),
          schema: task.outputSchema,
        })
        return { output, via: 'local' }
      } catch {
        // Local execution failed — fall through to the server tier.
      }
    }
  }

  return callServer<O>(taskId, parsedInput.data, opts.signal)
}
