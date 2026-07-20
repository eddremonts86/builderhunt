import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/shared/lib/env', () => ({
  env: {
    AI_EMBEDDING_URL: 'http://localhost:1234/v1/embeddings',
    AI_EMBEDDING_MODEL: 'test-embed-model',
    AI_EMBEDDING_API_KEY: '',
    AI_EMBEDDING_DIM: 4,
    AI_EMBEDDING_TIMEOUT_MS: 5000,
  },
}))

import { AIDimensionMismatchError, AIProviderError } from './errors'
import { embedTexts } from './embeddings'

function embeddingResponse(vectors: number[][]) {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) }),
    { status: 200 },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('embedTexts', () => {
  it('throws AIEmbeddingUnavailableError when unconfigured', async () => {
    vi.doMock('~/shared/lib/env', () => ({
      env: { AI_EMBEDDING_URL: '', AI_EMBEDDING_MODEL: '', AI_EMBEDDING_API_KEY: '', AI_EMBEDDING_DIM: 4, AI_EMBEDDING_TIMEOUT_MS: 5000 },
    }))
    vi.resetModules()
    const { embedTexts: embedTextsUnconfigured } = await import('./embeddings')
    const { AIEmbeddingUnavailableError: AIEmbeddingUnavailableErrorFresh } = await import('./errors')

    await expect(embedTextsUnconfigured(['hello'])).rejects.toThrow(AIEmbeddingUnavailableErrorFresh)
  })

  it('returns an empty array for empty input without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts([])

    expect(result).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('batches more than 64 inputs into multiple requests, preserving order', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `text-${i}`)
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { input: string[] }
      const vectors = body.input.map(() => [1, 2, 3, 4])
      return embeddingResponse(vectors)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts(texts)

    expect(result).toHaveLength(70)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBatchInput = (JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { input: string[] }).input
    const secondBatchInput = (JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as { input: string[] }).input
    expect(firstBatchInput).toHaveLength(64)
    expect(secondBatchInput).toHaveLength(6)
  })

  it('sorts an unordered data[] response by index before returning', async () => {
    const response = new Response(
      JSON.stringify({
        data: [
          { embedding: [0, 0, 0, 2], index: 2 },
          { embedding: [0, 0, 0, 0], index: 0 },
          { embedding: [0, 0, 0, 1], index: 1 },
        ],
      }),
      { status: 200 },
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await embedTexts(['a', 'b', 'c'])

    expect(result).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 1],
      [0, 0, 0, 2],
    ])
  })

  it('throws AIProviderError on a non-2xx HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })))

    await expect(embedTexts(['hello'])).rejects.toThrow(AIProviderError)
  })

  it('throws AIDimensionMismatchError when a vector length does not match AI_EMBEDDING_DIM', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(embeddingResponse([[1, 2, 3]])))

    await expect(embedTexts(['hello'])).rejects.toThrow(AIDimensionMismatchError)
  })
})
