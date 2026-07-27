import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('~/shared/lib/env', () => ({
  env: {
    MINIMAX_API_KEY: 'test-key',
    MINIMAX_BASE_URL: 'https://api.example.com/v1',
    MINIMAX_MODEL: 'MiniMax-M3',
  },
}))

import { AIParseError, AIProviderError } from '~/shared/lib/ai/errors'
import { minimaxChat } from '~/shared/lib/ai/minimax'

const schema = z.object({ pong: z.literal(true) })

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), { status: init?.status ?? 200 })
}

function chatCompletion(content: string, usage?: { prompt_tokens: number, completion_tokens: number }) {
  return jsonResponse({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('minimaxChat', () => {
  it('parses a valid JSON response on the first call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('{"pong":true}'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })

    expect(result).toEqual({ pong: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('strips a <think> reasoning block that itself contains brace-shaped text before parsing (real M3 behavior)', async () => {
    // Confirmed via a live smoke test against MiniMax M3: it answers with a
    // <think>...</think> block (which may quote the requested JSON back,
    // producing extra braces) followed by the real JSON answer.
    const raw = '<think>The user wants exactly the JSON {"pong": true} and nothing else.</think>\n\n{"pong": true}'
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion(raw))
    vi.stubGlobal('fetch', fetchMock)

    const result = await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })

    expect(result).toEqual({ pong: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends MiniMax-M3 and does not claim provider-side JSON Schema enforcement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('{"pong":true}'))
    vi.stubGlobal('fetch', fetchMock)

    await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('MiniMax-M3')
    expect(body).not.toHaveProperty('response_format')
  })

  it('retries once with a correction turn when the first response fails schema validation, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletion('not json at all'))
      .mockResolvedValueOnce(chatCompletion('{"pong":true}'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })

    expect(result).toEqual({ pong: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws AIParseError when both attempts fail schema validation', async () => {
    const fetchMock = vi.fn(async () => chatCompletion('still not valid'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })).rejects.toThrow(
      AIParseError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws AIProviderError on a non-2xx HTTP response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('server exploded', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 })).rejects.toThrow(
      AIProviderError,
    )
  })

  it('reports the response usage via onUsage (abuse-and-usage-integrity "G7" cost capture)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('{"pong":true}', { prompt_tokens: 42, completion_tokens: 8 }))
    vi.stubGlobal('fetch', fetchMock)
    const onUsage = vi.fn()

    await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32, onUsage })

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 42, completionTokens: 8 })
  })

  it('defaults usage to 0/0 when the provider response omits the usage field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletion('{"pong":true}'))
    vi.stubGlobal('fetch', fetchMock)
    const onUsage = vi.fn()

    await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32, onUsage })

    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 0, completionTokens: 0 })
  })

  it('reports usage for BOTH calls on a correction retry — each is a separately-billed provider call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletion('not json at all', { prompt_tokens: 10, completion_tokens: 5 }))
      .mockResolvedValueOnce(chatCompletion('{"pong":true}', { prompt_tokens: 15, completion_tokens: 3 }))
    vi.stubGlobal('fetch', fetchMock)
    const onUsage = vi.fn()

    await minimaxChat({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32, onUsage })

    expect(onUsage).toHaveBeenCalledTimes(2)
    expect(onUsage).toHaveBeenNthCalledWith(1, { promptTokens: 10, completionTokens: 5 })
    expect(onUsage).toHaveBeenNthCalledWith(2, { promptTokens: 15, completionTokens: 3 })
  })
})

describe('minimaxChat without an API key', () => {
  it('throws AIDisabledError', async () => {
    vi.doMock('~/shared/lib/env', () => ({
      env: { MINIMAX_API_KEY: '', MINIMAX_BASE_URL: 'https://api.example.com/v1', MINIMAX_MODEL: 'MiniMax-M3' },
    }))
    vi.resetModules()
    const { minimaxChat: minimaxChatNoKey } = await import('~/shared/lib/ai/minimax')
    const { AIDisabledError: AIDisabledErrorFresh } = await import('~/shared/lib/ai/errors')

    await expect(
      minimaxChatNoKey({ system: 'sys', prompt: 'ping', schema, maxOutputTokens: 32 }),
    ).rejects.toThrow(AIDisabledErrorFresh)
  })
})
