// Server-side, provider-agnostic embedding adapter. Independent of minimax.ts —
// embeddings go through a separately configured OpenAI-compatible endpoint
// (AI_EMBEDDING_URL), which may be a local server (e.g. LM Studio/Ollama) in
// dev or a hosted provider in production.
import { env } from '~/shared/lib/env'
import { AIDimensionMismatchError, AIEmbeddingUnavailableError, AIProviderError } from './errors'

const BATCH_SIZE = 64

interface EmbeddingDatum {
  embedding: number[]
  index: number
}

interface EmbeddingResponse {
  data?: EmbeddingDatum[]
}

function isConfigured(): boolean {
  return Boolean(env.AI_EMBEDDING_URL && env.AI_EMBEDDING_MODEL)
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.AI_EMBEDDING_API_KEY) headers.Authorization = `Bearer ${env.AI_EMBEDDING_API_KEY}`

  let response: Response
  try {
    response = await fetch(env.AI_EMBEDDING_URL!, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: env.AI_EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(env.AI_EMBEDDING_TIMEOUT_MS),
    })
  } catch (error) {
    throw new AIProviderError(0, error instanceof Error ? error.message : 'Embedding request failed')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new AIProviderError(response.status, body.slice(0, 500) || `Embedding endpoint returned HTTP ${response.status}`)
  }

  const json = (await response.json()) as EmbeddingResponse
  const data = json.data
  if (!Array.isArray(data)) {
    throw new AIProviderError(502, 'Embedding response is missing a data[] array')
  }

  const sorted = [...data].sort((a, b) => a.index - b.index)
  return sorted.map((datum) => {
    if (datum.embedding.length !== env.AI_EMBEDDING_DIM) {
      throw new AIDimensionMismatchError(
        `Embedding vector length ${datum.embedding.length} does not match configured AI_EMBEDDING_DIM=${env.AI_EMBEDDING_DIM}`,
      )
    }
    return datum.embedding
  })
}

/**
 * Embeds `texts` in batches of ≤64, preserving input order across batches.
 * Throws `AIEmbeddingUnavailableError` when `AI_EMBEDDING_URL`/`AI_EMBEDDING_MODEL`
 * are not configured, and `AIDimensionMismatchError` if any returned vector's
 * length does not match `AI_EMBEDDING_DIM`.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!isConfigured()) {
    throw new AIEmbeddingUnavailableError('AI_EMBEDDING_URL/AI_EMBEDDING_MODEL are not configured')
  }
  if (texts.length === 0) return []

  const results: number[][] = []
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE)
    const embeddings = await embedBatch(batch)
    results.push(...embeddings)
  }
  return results
}
