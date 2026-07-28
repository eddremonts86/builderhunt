/**
 * @vitest-environment node
 *
 * A real HTTP fixture server, not a mocked `fetch`.
 *
 * Mocking fetch would let every assertion here pass against an adapter that never composes its abort
 * signal, never actually times out, and never reads a status code — the three things most likely to be
 * wrong. A socket that hangs is the only honest way to test a timeout.
 *
 * ## Why the residency check is tested separately from the transport
 *
 * `sensitiveCompletion` refuses any base URL that is not exactly `https://api.mistral.ai`, which means
 * it can never be pointed at a fixture server — by design. So the transport tests call
 * `mistralStructuredCompletion` directly, and a separate test proves that going through
 * `sensitiveCompletion` with this very localhost URL is refused. Testing the adapter in isolation is
 * only safe *because* that second test exists; without it, this file would be exercising a path
 * production can never take while the guard rotted.
 */
import http from 'node:http'
import { z } from 'zod'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  SENSITIVE_AI_ENABLED: 'true' as 'true' | 'false',
  SENSITIVE_AI_PROVIDER: 'mistral' as 'mistral' | 'azure',
  MISTRAL_API_KEY: 'test-key',
  MISTRAL_BASE_URL: 'https://api.mistral.ai',
  MISTRAL_MODEL: 'mistral-medium-2604',
  AZURE_OPENAI_ENDPOINT: undefined as string | undefined,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { mistralStructuredCompletion } = await import('~/shared/lib/ai/mistral')
const { assertRegionalConfiguration, isSensitiveAIEnabled, sensitiveCompletion } =
  await import('~/shared/lib/ai/sensitive')
const { AIDisabledError, AIParseError, AIProviderError } = await import('~/shared/lib/ai/errors')
// A static type-only import alongside the dynamic value one: `await import` binds values, so the
// classes are not usable as types without this, and `vi.mock` still governs the runtime module.
type ProviderError = import('~/shared/lib/ai/errors').AIProviderError

const schema = z.object({ summary: z.string(), score: z.number() })
type Output = z.infer<typeof schema>

/** What the fixture server does next. Reassigned per test. */
let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
let receivedBodies: string[] = []
let server: http.Server
let baseUrl = ''

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      receivedBodies.push(body)
      handler(request, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  receivedBodies = []
  mockEnv.SENSITIVE_AI_ENABLED = 'true'
  mockEnv.SENSITIVE_AI_PROVIDER = 'mistral'
  mockEnv.MISTRAL_BASE_URL = baseUrl
  mockEnv.MISTRAL_MODEL = 'mistral-medium-2604'
  handler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      model: 'mistral-medium-2604',
      choices: [{ message: { content: JSON.stringify({ summary: 'ok', score: 7 }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }))
  }
})

const call = (overrides: Partial<Parameters<typeof mistralStructuredCompletion<Output>>[0]> = {}, onTelemetry?: never) =>
  mistralStructuredCompletion<Output>({
    system: 'You assess candidates.',
    prompt: 'CANDIDATE CV: Maria is a Rust engineer.',
    schema,
    maxOutputTokens: 512,
    ...overrides,
  }, onTelemetry)

describe('a valid completion', () => {
  it('returns the parsed output with normalized usage and the model that ran', async () => {
    const result = await call()
    expect(result.output).toEqual({ summary: 'ok', score: 7 })
    expect(result.provider).toBe('mistral')
    // The provider's own answer, not our configuration: if they served a different model than we
    // asked for, the record must say what actually ran.
    expect(result.model).toBe('mistral-medium-2604')
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 40 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('asks for structured output and configures no retention or training', async () => {
    await call()
    const body = JSON.parse(receivedBodies[0]) as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_object' })
    // The absence is the assertion. A `store`, a dataset id or a fine-tune reference would each change
    // what the provider is permitted to keep, and none may appear without a deliberate edit here.
    for (const forbidden of ['store', 'dataset', 'fine_tune', 'training', 'metadata', 'user']) {
      expect(Object.keys(body), `request must not carry '${forbidden}'`).not.toContain(forbidden)
    }
  })
})

describe('bad output is not retried', () => {
  it('rejects content that is not JSON, on the first attempt', async () => {
    let calls = 0
    handler = (_request, response) => {
      calls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'Here is the brief: ...' } }] }))
    }

    await expect(call()).rejects.toBeInstanceOf(AIParseError)
    // Deliberately not retried: a re-prompt spends credits to re-roll an assessment somebody acts on.
    expect(calls).toBe(1)
  })

  it('rejects output that violates the schema, naming fields and not values', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: 'ok', score: 'not a number' }) } }],
      }))
    }

    await expect(call()).rejects.toMatchObject({ name: 'AIParseError' })
    // A plain try/catch, because `promise.catch(fn)` types the result as the union of the resolved
    // value and whatever the handler returns.
    let message = ''
    try {
      await call()
    } catch (caught) {
      message = (caught as Error).message
    }
    expect(message).toContain('score')
    // Zod's default message embeds the offending value. This must not.
    expect(message).not.toContain('not a number')
  })
})

describe('transient failures retry once, then give up', () => {
  it.each([429, 500, 503])('retries a %i and succeeds on the second attempt', async (status) => {
    let calls = 0
    handler = (_request, response) => {
      calls += 1
      if (calls === 1) {
        response.writeHead(status)
        response.end('slow down')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'ok', score: 1 }) } }] }))
    }

    const result = await call()
    expect(result.output.score).toBe(1)
    expect(calls).toBe(2)
  })

  it('gives up after two attempts and carries the status', async () => {
    let calls = 0
    handler = (_request, response) => {
      calls += 1
      response.writeHead(503)
      response.end('down')
    }

    const error = await call().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AIProviderError)
    expect((error as ProviderError).status).toBe(503)
    expect(calls, 'bounded — two would double the worst-case latency of a UI action').toBe(2)
  })

  it('does not retry a 400, which will fail identically', async () => {
    let calls = 0
    handler = (_request, response) => {
      calls += 1
      response.writeHead(400)
      response.end('bad request')
    }

    await expect(call()).rejects.toMatchObject({ status: 400 })
    expect(calls).toBe(1)
  })
})

describe('the caller can stop it, and it stops itself', () => {
  it('stops on the caller’s abort without retrying', async () => {
    let calls = 0
    handler = () => { calls += 1 /* never respond */ }
    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    // Let the request reach the server, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AIProviderError' })
    // The caller asked us to stop. Retrying would be ignoring them.
    expect(calls).toBe(1)
  })

  it('reports status 0 when no HTTP response ever happened', async () => {
    handler = () => { /* hang */ }
    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()

    const error = await pending.catch((caught: unknown) => caught)
    // 0 distinguishes "never got an answer" from "got a bad one", which is what a caller needs to
    // decide whether retrying could help.
    expect((error as ProviderError).status).toBe(0)
  })
})

describe('telemetry carries no prompt and no completion', () => {
  it('reports counts, bytes and outcome only', async () => {
    const seen: unknown[] = []
    await mistralStructuredCompletion<Output>({
      system: 'SYSTEM-MARKER',
      prompt: 'PROMPT-MARKER Maria is a Rust engineer',
      schema,
      maxOutputTokens: 512,
    }, (telemetry) => seen.push(telemetry))

    expect(seen).toHaveLength(1)
    const serialized = JSON.stringify(seen[0])
    // The whole point of the interface being numbers and identifiers.
    expect(serialized).not.toContain('PROMPT-MARKER')
    expect(serialized).not.toContain('SYSTEM-MARKER')
    expect(serialized).not.toContain('Maria')
    expect(seen[0]).toMatchObject({
      provider: 'mistral',
      outcome: 'ok',
      promptTokens: 120,
      completionTokens: 40,
      attempts: 1,
    })
    expect((seen[0] as { promptBytes: number }).promptBytes).toBeGreaterThan(0)
  })

  it('reports the outcome for a failure without the content that caused it', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'SECRET-CV-TEXT not json' } }] }))
    }
    const seen: unknown[] = []
    await mistralStructuredCompletion<Output>(
      { system: 's', prompt: 'p', schema, maxOutputTokens: 128 },
      (telemetry) => seen.push(telemetry),
    ).catch(() => undefined)

    expect(JSON.stringify(seen[0])).not.toContain('SECRET-CV-TEXT')
    expect(seen[0]).toMatchObject({ outcome: 'invalid_output' })
  })
})

describe('the kill switch and the residency guard', () => {
  it('refuses when sensitive AI is disabled, before touching configuration', async () => {
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    // Also broken configuration. The disabled error must win: an operator reading a configuration
    // error would go and fix configuration that was never the problem.
    mockEnv.MISTRAL_BASE_URL = 'https://not-eu.example.com'

    await expect(sensitiveCompletion({ system: 's', prompt: 'p', schema, maxOutputTokens: 128 }))
      .rejects.toBeInstanceOf(AIDisabledError)
    expect(isSensitiveAIEnabled()).toBe(false)
  })

  it('refuses the fixture server’s own URL, which is the guard this file depends on', async () => {
    // `MISTRAL_BASE_URL` is the localhost fixture at this point — every transport test above used it.
    // Going through `sensitiveCompletion` must refuse it, which is what makes testing the adapter in
    // isolation safe rather than a way to exercise a path production cannot take.
    await expect(sensitiveCompletion({ system: 's', prompt: 'p', schema, maxOutputTokens: 128 }))
      .rejects.toMatchObject({ name: 'AIProviderError' })
    expect(receivedBodies, 'no request may reach a non-EU host').toEqual([])
  })

  it.each([
    'https://api.mistral.ai/us',
    'https://api.us.mistral.ai',
    'http://api.mistral.ai',
    'https://api-mistral.ai',
  ])('refuses %s rather than pattern-matching for something European', (url) => {
    mockEnv.MISTRAL_BASE_URL = url
    expect(() => assertRegionalConfiguration()).toThrow(AIProviderError)
  })

  it('accepts exactly the EU host, with or without a trailing slash', () => {
    for (const url of ['https://api.mistral.ai', 'https://api.mistral.ai/']) {
      mockEnv.MISTRAL_BASE_URL = url
      expect(() => assertRegionalConfiguration()).not.toThrow()
    }
  })

  it('refuses a non-regional azure endpoint', () => {
    mockEnv.SENSITIVE_AI_PROVIDER = 'azure'
    for (const endpoint of [undefined, '', 'https://example.com', 'http://x.openai.azure.com']) {
      mockEnv.AZURE_OPENAI_ENDPOINT = endpoint
      expect(() => assertRegionalConfiguration()).toThrow(AIProviderError)
    }
  })

  it('never routes an azure request to mistral', async () => {
    // The one failure this module exists to prevent: an operator who set `azure` believes their data
    // goes to Azure, and honouring that belief with a different provider is worse than failing.
    mockEnv.SENSITIVE_AI_PROVIDER = 'azure'
    mockEnv.AZURE_OPENAI_ENDPOINT = 'https://eu-resource.openai.azure.com'

    await expect(sensitiveCompletion({ system: 's', prompt: 'p', schema, maxOutputTokens: 128 }))
      .rejects.toMatchObject({ name: 'AIProviderError' })
    expect(receivedBodies, 'nothing may reach the mistral fixture').toEqual([])
  })
})
