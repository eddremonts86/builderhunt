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
  // Wave 1 Task 4 — E2E scenario seam
  // (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
  // Only reachable when E2E_MODE=true AND a scenario is explicitly set;
  // the production path below is byte-identical otherwise.
  const e2eScenario = typeof process !== 'undefined' && process.env.E2E_MODE === 'true'
    ? process.env.E2E_EMBEDDINGS_SCENARIO
    : undefined
  if (e2eScenario) {
    return e2eEmbedTexts(texts, e2eScenario)
  }
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

/**
 * Wave 1 Task 4 — deterministic E2E stub for the embedding HTTP boundary.
 *
 * Each named scenario reproduces exactly what the production path above
 * would do for that provider response shape — same error classes, same
 * messages' shape — but with zero HTTP and zero timers ("timeout" throws
 * immediately with the timeout-shaped error, mirroring the fake billing
 * provider's convention). Never reachable outside `E2E_MODE=true`.
 */
function e2eEmbedTexts(texts: string[], scenario: string): number[][] {
  switch (scenario) {
    case 'success':
      return texts.map((text) => deterministicE2EVector(text, env.AI_EMBEDDING_DIM))
    case 'empty':
      // Provider answered 200 with `data: []` — the batch maps to nothing.
      return []
    case 'malformed':
      // Provider answered 200 with a body missing `data[]`.
      throw new AIProviderError(502, 'Embedding response is missing a data[] array')
    case 'hostile':
      // Provider returned vectors of the wrong dimensionality.
      throw new AIDimensionMismatchError(
        `Embedding vector length 3 does not match configured AI_EMBEDDING_DIM=${env.AI_EMBEDDING_DIM}`,
      )
    case 'timeout':
      // The fetch abort path — status 0, message from the AbortSignal.
      throw new AIProviderError(0, 'The operation was aborted due to timeout (E2E timeout scenario)')
    case 'rate_limited':
      throw new AIProviderError(429, 'Rate limit exceeded (E2E rate_limited scenario)')
    case 'fallback':
      // The degradation-ladder trigger — adapter reports itself unconfigured.
      throw new AIEmbeddingUnavailableError('E2E fallback scenario — embedding adapter reports unconfigured')
    default:
      throw new Error(
        'Unknown E2E_EMBEDDINGS_SCENARIO '
        + `"${scenario}" — expected one of: success, empty, malformed, hostile, timeout, rate_limited, fallback`,
      )
  }
}

/** FNV-1a-seeded, stable across processes; values in [-1, 1). */
function deterministicE2EVector(text: string, dim: number): number[] {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const vector = new Array<number>(dim)
  for (let index = 0; index < dim; index += 1) {
    hash ^= index
    hash = Math.imul(hash, 16777619)
    vector[index] = ((hash >>> 0) % 2000) / 1000 - 1
  }
  return vector
}
