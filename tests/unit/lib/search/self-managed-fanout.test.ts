/**
 * How the fan-out treats an internal origin (plan: phase-2/07-perfiles-autogestionados, Phase 3).
 *
 * Everything is mocked here, including the origin itself, and that is the point: what these prove
 * is that `self-managed` never reaches the operator register, never asks for a credential, and
 * still reports health like any other origin. A test that let it touch a real database or a real
 * host could not distinguish "did not consult the register" from "consulted it and was allowed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawBuilder } from '~/lib/sources/types'

const partitionRequestedSources = vi.fn()
const searchSelfManaged = vi.fn()
const searchGitHub = vi.fn()

/**
 * The feature flag is on for this suite, stated rather than inherited.
 *
 * `SELF_MANAGED_PROFILES_ENABLED` defaults to `false` — production inherits no `.env`, so every
 * flag in `env.ts` is off unless somebody turns it on. These tests are about what the feature does
 * when it exists; what it does when it does not is `tests/e2e/self-managed-flag.spec.ts`, and
 * asserting both from one file would mean neither could set the flag at module load.
 */
vi.mock('~/shared/lib/self-managed/feature-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/self-managed/feature-flag')>()
  return { ...actual, isSelfManagedEnabled: () => true, selfManagedDisabledResponse: () => null }
})

vi.mock('~/shared/lib/repositories/search-sources', () => ({
  partitionRequestedSources: (sources: string[]) => partitionRequestedSources(sources),
}))
vi.mock('~/lib/sources/self-managed', () => ({
  searchSelfManaged: (...args: unknown[]) => searchSelfManaged(...args),
}))
vi.mock('~/lib/sources/github', () => ({ searchGitHub: (...args: unknown[]) => searchGitHub(...args) }))
vi.mock('~/shared/lib/redis', () => ({ getRedis: async () => null }))
vi.mock('~/shared/lib/profile-suppression', () => ({ filterSuppressed: async (rows: RawBuilder[]) => rows }))

const { searchBuildersWithStatus, resolveContactableSources } = await import('~/lib/search')

/** A fresh keyword per test, so `search.ts`'s in-memory cache cannot leak between them. */
let probe = 0
function keywords(): string[] {
  probe += 1
  return [`smprobe${probe}`]
}

function row(sourceId: string): RawBuilder {
  return {
    id: `self-managed-${sourceId}`,
    kind: 'person',
    source: 'self-managed',
    sourceId,
    username: sourceId,
    profileUrl: `/u/${sourceId}`,
    topics: [],
    metadata: { isSelfManaged: true },
  }
}

beforeEach(() => {
  partitionRequestedSources.mockImplementation(async (requested: string[]) => ({
    allowed: requested,
    refused: [],
  }))
  searchSelfManaged.mockResolvedValue([])
  searchGitHub.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveContactableSources', () => {
  it('contacts the internal origin without asking the register about it', async () => {
    const resolved = await resolveContactableSources(['self-managed', 'github'])

    expect(resolved.contacted).toContain('self-managed')
    // The register was asked about the network source and *only* the network source. A register
    // row for an origin with no host is a row somebody has to remember to add, and the failure
    // when they forget reads as "disabled" — an operator decision nobody made.
    expect(partitionRequestedSources).toHaveBeenCalledWith(['github'])
  })

  it('keeps answering for the internal origin when the register refuses everything', async () => {
    // What a register outage looks like: `partitionRequestedSources` refuses the lot.
    partitionRequestedSources.mockResolvedValue({ allowed: [], refused: ['github'] })

    const resolved = await resolveContactableSources(['self-managed', 'github'])

    expect(resolved.contacted).toEqual(['self-managed'])
    expect(resolved.notContacted.map((status) => status.health)).toEqual(['disabled'])
  })

  it('does not contact it when nobody asked for it', async () => {
    const resolved = await resolveContactableSources(['github'])
    expect(resolved.contacted).not.toContain('self-managed')
    expect(searchSelfManaged).not.toHaveBeenCalled()
  })
})

describe('health reporting', () => {
  it('reports ok with a result count, like any other origin', async () => {
    searchSelfManaged.mockResolvedValue([row('prof-1'), row('prof-2')])

    const { builders, sources } = await searchBuildersWithStatus({ keywords: keywords(), sources: ['self-managed'] })

    expect(builders).toHaveLength(2)
    expect(sources).toEqual([
      expect.objectContaining({ source: 'self-managed', health: 'ok', resultCount: 2 }),
    ])
  })

  it('reports failed when the origin throws, and the search still answers', async () => {
    searchSelfManaged.mockRejectedValue(new Error('relation "self_managed_profiles" does not exist'))
    searchGitHub.mockResolvedValue([])

    const { builders, sources } = await searchBuildersWithStatus({
      keywords: keywords(),
      sources: ['self-managed', 'github'],
    })

    const status = sources.find((entry) => entry.source === 'self-managed')!
    expect(status.health).toBe('failed')
    // The detail is a fixed string. A database error message can carry a query, a column list or a
    // connection string, and this one reaches the search UI.
    expect(status.detail).toBe('Source unavailable')
    expect(JSON.stringify(status)).not.toContain('self_managed_profiles')
    // One broken origin does not take the search down with it.
    expect(builders).toEqual([])
    expect(sources.find((entry) => entry.source === 'github')?.health).toBe('ok')
  })

  it('never reports unconfigured — there is no credential for it to be missing', async () => {
    const { sources } = await searchBuildersWithStatus({ keywords: keywords(), sources: ['self-managed'] })
    expect(sources.map((status) => status.health)).not.toContain('unconfigured')
  })
})

describe('inclusion is requested, never assumed', () => {
  it('is absent from the default source set until the inclusion policy owns that decision', async () => {
    const { DEFAULT_SEARCH_SOURCES } = await import('~/lib/search')
    // Deliberate: turning it on for every search before the shared policy and its opt-out exist
    // would put self-managed rows in front of everyone with no way to say no. The plan's inclusion
    // task changes this line, and its toggle is what makes that safe.
    expect(DEFAULT_SEARCH_SOURCES as readonly string[]).not.toContain('self-managed')
  })
})
