/**
 * Wave 1 Task 4 — discovery fake unit tests (Playwright-run, node-only).
 *
 * Exercises every named scenario of the two discovery boundaries:
 * `embedTexts` (embedding HTTP) and `e2eEnrichmentStub` (the
 * `profile-enrich` task boundary). No live HTTP anywhere — the `timeout`
 * scenario throws immediately with the timeout-shaped error (no timers,
 * per the harness's no-arbitrary-waits rule).
 */
import { test, expect } from 'playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import {
  resetDiscoveryFakes,
  setEmbeddingsScenario,
  setEnrichmentScenario,
} from './discovery'

test.afterEach(() => {
  resetDiscoveryFakes()
})

test.describe('embeddings scenarios', () => {
  test('success returns deterministic vectors of AI_EMBEDDING_DIM', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    const { env } = await import('../../../../src/shared/lib/env')
    setEmbeddingsScenario('success')

    const first = await embedTexts(['alpha', 'beta'])
    const second = await embedTexts(['alpha', 'beta'])

    expect(first).toHaveLength(2)
    expect(first[0]).toHaveLength(env.AI_EMBEDDING_DIM)
    expect(first[1]).toHaveLength(env.AI_EMBEDDING_DIM)
    // Deterministic: identical input -> identical vectors; distinct inputs differ.
    expect(second).toEqual(first)
    expect(first[0]).not.toEqual(first[1])
  })

  test('empty returns an empty result set', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('empty')
    expect(await embedTexts(['anything'])).toEqual([])
  })

  test('malformed throws the AIProviderError the real parser raises', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('malformed')
    await expect(embedTexts(['x'])).rejects.toMatchObject({ name: 'AIProviderError', status: 502 })
  })

  test('hostile throws the dimension-mismatch guard', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('hostile')
    await expect(embedTexts(['x'])).rejects.toMatchObject({ name: 'AIDimensionMismatchError' })
  })

  test('timeout throws immediately with the abort-shaped error (no real waiting)', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('timeout')
    const startedAt = Date.now()
    await expect(embedTexts(['x'])).rejects.toMatchObject({ name: 'AIProviderError', status: 0 })
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  test('rate_limited throws a 429-shaped provider error', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('rate_limited')
    await expect(embedTexts(['x'])).rejects.toMatchObject({ name: 'AIProviderError', status: 429 })
  })

  test('fallback throws AIEmbeddingUnavailableError (the degradation-ladder trigger)', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    setEmbeddingsScenario('fallback')
    await expect(embedTexts(['x'])).rejects.toMatchObject({ name: 'AIEmbeddingUnavailableError' })
  })

  test('the stub is unreachable outside E2E mode', async () => {
    const { embedTexts } = await import('../../../../src/shared/lib/ai/embeddings')
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    process.env.E2E_EMBEDDINGS_SCENARIO = 'malformed'
    try {
      // With the seam inert, the call follows the REAL code path. `.env`
      // configures a localhost embedding endpoint that is not running in
      // E2E, so the real path fails with a connection error (status 0) or —
      // if a local model server happens to be up — returns real vectors.
      // Either way it must NOT be the stub's deterministic 502.
      const outcome = await embedTexts(['x']).then(
        (vectors) => ({ kind: 'vectors' as const, vectors }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
      if (outcome.kind === 'error') {
        expect(outcome.error).not.toMatchObject({ status: 502 })
      } else {
        expect(outcome.vectors.length).toBeGreaterThan(0)
      }
    } finally {
      process.env.E2E_MODE = previous
      delete process.env.E2E_EMBEDDINGS_SCENARIO
    }
  })
})

test.describe('enrichment scenarios', () => {
  const input = { username: 'octocat', source: 'github' }

  test('success returns a schema-valid persona card', async () => {
    const { e2eEnrichmentStub, builderAIEnrichmentModelSchema } = await import('../../../../src/shared/lib/ai/enrichment')
    setEnrichmentScenario('success')
    const parsed = builderAIEnrichmentModelSchema.safeParse(e2eEnrichmentStub(input))
    expect(parsed.success).toBe(true)
  })

  test('empty and malformed both fail the existing zod schema', async () => {
    const { e2eEnrichmentStub, builderAIEnrichmentModelSchema } = await import('../../../../src/shared/lib/ai/enrichment')
    setEnrichmentScenario('empty')
    expect(builderAIEnrichmentModelSchema.safeParse(e2eEnrichmentStub(input)).success).toBe(false)
    setEnrichmentScenario('malformed')
    expect(builderAIEnrichmentModelSchema.safeParse(e2eEnrichmentStub(input)).success).toBe(false)
  })

  test('hostile parses but carries injection-shaped content (data, not directives)', async () => {
    const { e2eEnrichmentStub, builderAIEnrichmentModelSchema } = await import('../../../../src/shared/lib/ai/enrichment')
    setEnrichmentScenario('hostile')
    const payload = e2eEnrichmentStub(input)
    const parsed = builderAIEnrichmentModelSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    expect(JSON.stringify(payload).toLowerCase()).toContain('ignore')
  })

  test('timeout and rate_limited throw provider-shaped errors', async () => {
    const { e2eEnrichmentStub } = await import('../../../../src/shared/lib/ai/enrichment')
    setEnrichmentScenario('timeout')
    expect(() => e2eEnrichmentStub(input)).toThrow(/timed out/)
    setEnrichmentScenario('rate_limited')
    try {
      e2eEnrichmentStub(input)
      throw new Error('expected rate_limited to throw')
    } catch (error) {
      expect(error).toMatchObject({ name: 'AIProviderError', status: 429 })
    }
  })

  test('fallback throws AIUnavailableError so callers use the rule-based path', async () => {
    const { e2eEnrichmentStub } = await import('../../../../src/shared/lib/ai/enrichment')
    setEnrichmentScenario('fallback')
    try {
      e2eEnrichmentStub(input)
      throw new Error('expected fallback to throw')
    } catch (error) {
      expect(error).toMatchObject({ name: 'AIUnavailableError', reason: 'error' })
    }
  })

  test('the stub is unreachable outside E2E mode', async () => {
    const { e2eEnrichmentStub } = await import('../../../../src/shared/lib/ai/enrichment')
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    try {
      expect(() => e2eEnrichmentStub(input)).toThrow(/E2E-only/)
    } finally {
      process.env.E2E_MODE = previous
    }
  })
})
