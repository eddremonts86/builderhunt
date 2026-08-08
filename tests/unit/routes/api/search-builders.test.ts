/**
 * The bounded-page contract behind `POST /api/search/builders`.
 *
 * The test targets `pageBuilderSearch` in `src/lib/search.ts` rather than anything exported from
 * the route file, deliberately. A route module that exports a helper drags whatever that helper
 * imports into the client bundle — `search.ts` reaches `postgres` through
 * `repositories/search-sources` — and the route stays a thin auth-then-serialize wrapper precisely
 * so this logic is testable without that. `builders.ts` itself is covered end to end by
 * `tests/e2e/search.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawBuilder } from '~/lib/sources/types'

const partitionRequestedSources = vi.fn()
const searchGitHub = vi.fn()
const searchHN = vi.fn()

vi.mock('~/shared/lib/repositories/search-sources', () => ({
  partitionRequestedSources: (sources: string[]) => partitionRequestedSources(sources),
}))
vi.mock('~/lib/sources/github', () => ({ searchGitHub: (...args: unknown[]) => searchGitHub(...args) }))
vi.mock('~/lib/sources/hn', () => ({ searchHN: (...args: unknown[]) => searchHN(...args) }))
// No Redis in a unit test: the module falls through to its in-memory cache, which is what makes a
// second slice of the same provider page cost no upstream call.
vi.mock('~/shared/lib/redis', () => ({ getRedis: async () => null }))
vi.mock('~/shared/lib/profile-suppression', () => ({ filterSuppressed: async (rows: RawBuilder[]) => rows }))

const { pageBuilderSearch, SEARCH_MAX_PROVIDER_PAGES } = await import('~/lib/search')
const { SearchContinuationError } = await import('~/lib/search-continuation')
const { TABLE_PAGE_SIZE } = await import('~/shared/lib/table/constants')

/** No `metadata.lastSeen`, so `scoreBuilders` never reads the clock and the ranking is stable. */
function rows(source: string, label: string, count: number, followersBase: number): RawBuilder[] {
  return Array.from({ length: count }, (_, index) => ({
    source,
    sourceId: `${label}-${index}`,
    username: `${label}-${index}`,
    kind: 'person',
    profileUrl: `https://example.test/${label}-${index}`,
    topics: [],
    followersCount: followersBase - index,
    metadata: {},
  })) as unknown as RawBuilder[]
}

/** A fresh keyword set per test, so the module's in-memory cache cannot leak between them. */
let probe = 0
function keywords(): string[] {
  probe += 1
  return [`probe${probe}`]
}

const base = { scope: 'org_alpha', mode: 'keyword' as const, sources: ['github', 'hn'] }

beforeEach(() => {
  partitionRequestedSources.mockImplementation(async (requested: string[]) => ({
    allowed: requested,
    refused: [],
  }))
  searchGitHub.mockResolvedValue([])
  searchHN.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('bounded keyword pages', () => {
  it('clamps a fan-out wider than one page and keeps the ordering across slices', async () => {
    // 30 + 30 = 60 fused rows for a single provider page. The old response returned all 60.
    searchGitHub.mockResolvedValue(rows('github', 'gh', 30, 12_000))
    searchHN.mockResolvedValue(rows('hn', 'hn', 30, 9_500))
    const words = keywords()

    const first = await pageBuilderSearch({ ...base, keywords: words })
    expect(first.builders).toHaveLength(TABLE_PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()
    expect(first.total).toBeNull()
    expect(first.consistency).toBe('provider-best-effort')

    const second = await pageBuilderSearch({ ...base, keywords: words, cursor: first.nextCursor })
    expect(second.builders).toHaveLength(60 - TABLE_PAGE_SIZE)

    // The two slices are the old single response, in the same order and with nothing repeated.
    const ids = [...first.builders, ...second.builders].map((builder) => `${builder.source}:${builder.sourceId}`)
    expect(new Set(ids).size).toBe(60)

    // Both slices came out of one fan-out — the second page cost no upstream request.
    expect(searchGitHub).toHaveBeenCalledTimes(1)
  })

  it('advances to the next provider page once the current one is spent', async () => {
    searchGitHub.mockResolvedValue(rows('github', 'gh', 30, 12_000))
    const words = keywords()

    const first = await pageBuilderSearch({ ...base, keywords: words, sources: ['github'] })
    expect(first.builders).toHaveLength(30)
    expect(first.nextCursor).not.toBeNull()

    searchGitHub.mockResolvedValue(rows('github', 'gh-p2', 30, 8_000))
    const second = await pageBuilderSearch({ ...base, keywords: words, sources: ['github'], cursor: first.nextCursor })
    expect(second.builders.map((builder) => builder.sourceId)[0]).toMatch(/^gh-p2-/)
    // Provider page two, asked of the connector rather than sliced out of page one.
    expect(searchGitHub).toHaveBeenLastCalledWith(words, expect.objectContaining({ page: 2, perPage: 30 }))
  })

  it('ends the walk when a provider page comes back empty', async () => {
    const words = keywords()
    const page = await pageBuilderSearch({ ...base, keywords: words, sources: ['github'] })
    expect(page.builders).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('stops at the provider-page cap even when upstream keeps answering', async () => {
    // A connector that ignores its `page` parameter answers forever. Dedup runs within one fan-out,
    // never across them, so nothing else would ever end this walk.
    searchGitHub.mockResolvedValue(rows('github', 'gh', 30, 12_000))
    const words = keywords()

    let cursor: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof pageBuilderSearch>> =
        await pageBuilderSearch({ ...base, keywords: words, sources: ['github'], cursor })
      cursor = page.nextCursor
      pages += 1
      expect(pages).toBeLessThanOrEqual(SEARCH_MAX_PROVIDER_PAGES + 1)
    } while (cursor)

    expect(pages).toBe(SEARCH_MAX_PROVIDER_PAGES)
  })
})

describe('continuation rejection at the search boundary', () => {
  async function firstCursor(words: string[], overrides: Partial<Parameters<typeof pageBuilderSearch>[0]> = {}) {
    searchGitHub.mockResolvedValue(rows('github', 'gh', 30, 12_000))
    searchHN.mockResolvedValue(rows('hn', 'hn', 30, 9_500))
    const page = await pageBuilderSearch({ ...base, keywords: words, ...overrides })
    expect(page.nextCursor).not.toBeNull()
    return page.nextCursor!
  }

  it('refuses a cursor presented with different keywords', async () => {
    const words = keywords()
    const cursor = await firstCursor(words)
    await expect(pageBuilderSearch({ ...base, keywords: keywords(), cursor }))
      .rejects.toThrow(SearchContinuationError)
  })

  it('refuses a cursor presented with a different source selection', async () => {
    const words = keywords()
    const cursor = await firstCursor(words)
    await expect(pageBuilderSearch({ ...base, keywords: words, sources: ['github'], cursor }))
      .rejects.toThrow(/query or filter mismatch/)
  })

  it('refuses a cursor presented with a different country filter', async () => {
    const words = keywords()
    const cursor = await firstCursor(words)
    await expect(pageBuilderSearch({ ...base, keywords: words, country: 'DE', cursor }))
      .rejects.toThrow(/query or filter mismatch/)
  })

  it('refuses a cursor presented in another organization', async () => {
    const words = keywords()
    const cursor = await firstCursor(words)
    await expect(pageBuilderSearch({ ...base, keywords: words, scope: 'org_beta', cursor }))
      .rejects.toThrow(/access scope mismatch/)
  })

  /**
   * The spec's resolved edge case: an operator disables a source between pages. The request still
   * *asks* for both — the selection in the UI has not changed — so the query fingerprint matches
   * and only the snapshot catches it. Restarting at page one is what keeps a cache entry written
   * while the source was enabled from serving its rows afterwards.
   */
  it('refuses a cursor after a source is switched off in the register', async () => {
    const words = keywords()
    const cursor = await firstCursor(words)
    partitionRequestedSources.mockImplementation(async (requested: string[]) => ({
      allowed: requested.filter((source) => source !== 'hn'),
      refused: requested.filter((source) => source === 'hn'),
    }))
    await expect(pageBuilderSearch({ ...base, keywords: words, cursor }))
      .rejects.toThrow(/source snapshot mismatch/)
  })
})

describe('source health', () => {
  it('reports a disabled source without contacting it, and still serves the rest', async () => {
    searchGitHub.mockResolvedValue(rows('github', 'gh', 5, 12_000))
    partitionRequestedSources.mockImplementation(async (requested: string[]) => ({
      allowed: requested.filter((source) => source !== 'hn'),
      refused: requested.filter((source) => source === 'hn'),
    }))

    const page = await pageBuilderSearch({ ...base, keywords: keywords() })
    expect(searchHN).not.toHaveBeenCalled()
    expect(page.builders).toHaveLength(5)
    expect(page.degraded).toBe(true)
    expect(page.sources).toContainEqual(expect.objectContaining({ source: 'hn', health: 'disabled', resultCount: 0 }))
  })

  it('serves partial results with a truthful status when one connector fails', async () => {
    searchGitHub.mockResolvedValue(rows('github', 'gh', 5, 12_000))
    searchHN.mockRejectedValue(new Error('upstream 503'))

    const page = await pageBuilderSearch({ ...base, keywords: keywords() })
    expect(page.builders).toHaveLength(5)
    expect(page.degraded).toBe(true)
    const hn = page.sources.find((status) => status.source === 'hn')
    expect(hn?.health).toBe('failed')
    // Never the upstream's own message — connectors can echo response bodies.
    expect(hn?.detail).toBe('Source unavailable')
  })

  it('reports a degraded empty result rather than an empty success when nothing can be contacted', async () => {
    partitionRequestedSources.mockImplementation(async (requested: string[]) => ({
      allowed: [],
      refused: requested,
    }))
    const page = await pageBuilderSearch({ ...base, keywords: keywords() })
    expect(page.builders).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(page.degraded).toBe(true)
    expect(searchGitHub).not.toHaveBeenCalled()
  })
})
