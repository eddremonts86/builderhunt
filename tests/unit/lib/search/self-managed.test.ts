/**
 * The self-managed search origin (plan: phase-2/07-perfiles-autogestionados, Phase 3).
 *
 * Two halves, deliberately tested against different things.
 *
 * The origin's own query runs against a real disposable Postgres, because what could be wrong is
 * what SQL owns: which visibility states are listed, that a soft-deleted row is gone, and that the
 * read is bounded. The fan-out around it is tested with the network connectors mocked, because what
 * matters there is that an internal origin never reaches the register, the credential check or a
 * host — and a test that let it near a real one would prove the opposite of what it claims.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TenantTransaction } from '~/shared/lib/db/client'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, selfManagedProfiles } from '~/shared/lib/db/schema'
import { createProfile, searchPublicProfiles, setVisibility, softDeleteProfile } from '~/shared/lib/repositories/self-managed-profiles'
import { deduplicateBuilders } from '~/lib/dedup'
import { scoreBuilders } from '~/lib/score'
import { INTERNAL_ORIGIN_NAMES, isInternalOrigin, SOURCE_NAMES, type RawBuilder } from '~/lib/sources/types'

let db: PostgresJsDatabase
let drop: () => Promise<void>
const tx = () => db as unknown as TenantTransaction

const NOW = new Date('2027-04-01T10:00:00Z')

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('search_self_managed')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values(
    ['sm-a', 'sm-b', 'sm-c'].map((id) => ({
      id,
      name: id,
      email: `${id}@test.invalid`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(selfManagedProfiles)
})

async function seed(ownerUserId: string, handle: string, overrides: Record<string, unknown> = {}) {
  return createProfile(tx(), {
    ownerUserId,
    profile: {
      handle,
      displayName: 'Ada Lovelace',
      headline: 'Technical translator, es↔en',
      bio: 'Twelve years of documentation nobody had to reread.',
      languages: ['es', 'en'],
      services: ['translation'],
      topics: ['localization'],
      visibility: 'public',
      ...overrides,
    } as never,
    now: NOW,
  })
}

describe('the internal origin is typed apart from the network connectors', () => {
  it('is not a SourceName, and says so at the type level', () => {
    expect(INTERNAL_ORIGIN_NAMES).toEqual(['self-managed'])
    expect(SOURCE_NAMES as readonly string[]).not.toContain('self-managed')
    expect(isInternalOrigin('self-managed')).toBe(true)
    expect(isInternalOrigin('github')).toBe(false)
  })

  it('has no credential entry to be missing', async () => {
    const { CREDENTIAL_ENV_VARS, CREDENTIAL_MANDATORY_SOURCES } = await import('~/shared/lib/source-credentials')
    // The point of the separate union: an origin with no host cannot report `unconfigured`, and a
    // registry that listed it would be answering a question that does not apply to it.
    expect(Object.keys(CREDENTIAL_ENV_VARS)).not.toContain('self-managed')
    expect(CREDENTIAL_MANDATORY_SOURCES as readonly string[]).not.toContain('self-managed')
  })
})

describe('searchPublicProfiles', () => {
  it('matches declared text, the handle and both tag arrays', async () => {
    await seed('sm-a', 'ada')

    for (const keyword of ['translator', 'localization', 'translation', 'ada', 'DOCUMENTATION']) {
      const found = await searchPublicProfiles(tx(), { keywords: [keyword], limit: 30 })
      expect(found.map((row) => row.handle), keyword).toEqual(['ada'])
    }

    expect(await searchPublicProfiles(tx(), { keywords: ['nothing-matches-this'], limit: 30 })).toHaveLength(0)
  })

  it('lists public only — unlisted is reachable by link and never by search', async () => {
    await seed('sm-a', 'ada')
    expect(await searchPublicProfiles(tx(), { keywords: ['translator'], limit: 30 })).toHaveLength(1)

    await setVisibility(tx(), { ownerUserId: 'sm-a', visibility: 'unlisted', now: NOW })
    expect(await searchPublicProfiles(tx(), { keywords: ['translator'], limit: 30 })).toHaveLength(0)

    await setVisibility(tx(), { ownerUserId: 'sm-a', visibility: 'draft', now: NOW })
    expect(await searchPublicProfiles(tx(), { keywords: ['translator'], limit: 30 })).toHaveLength(0)
  })

  it('drops a soft-deleted profile immediately, without waiting for the purge', async () => {
    await seed('sm-a', 'ada')
    await softDeleteProfile(tx(), { ownerUserId: 'sm-a', now: NOW })

    expect(await searchPublicProfiles(tx(), { keywords: ['translator'], limit: 30 })).toHaveLength(0)
  })

  it('is bounded, and answers freshest first', async () => {
    await seed('sm-a', 'ada')
    await seed('sm-b', 'grace')
    await seed('sm-c', 'edith')
    // `updatedAt` decides the order, so it is set explicitly rather than left to insert order.
    await db.update(selfManagedProfiles).set({ updatedAt: new Date('2027-05-01T00:00:00Z') })
      .where(eq(selfManagedProfiles.handle, 'grace'))

    const bounded = await searchPublicProfiles(tx(), { keywords: ['translator'], limit: 2 })
    expect(bounded).toHaveLength(2)
    expect(bounded[0]!.handle).toBe('grace')
  })

  it('treats an empty keyword list as no query rather than as "everything"', async () => {
    await seed('sm-a', 'ada')
    expect(await searchPublicProfiles(tx(), { keywords: [], limit: 30 })).toHaveLength(0)
    expect(await searchPublicProfiles(tx(), { keywords: ['   '], limit: 30 })).toHaveLength(0)
  })

  it('takes a wildcard literally instead of as a pattern', async () => {
    await seed('sm-a', 'ada')
    // `%` would match every row if it reached `like` unescaped, which is how an empty search box
    // becomes a full directory dump.
    expect(await searchPublicProfiles(tx(), { keywords: ['%'], limit: 30 })).toHaveLength(0)
  })
})

describe('searchSelfManaged', () => {
  it('emits a person keyed on the profile id, with no invented signals', async () => {
    const created = await seed('sm-a', 'ada')
    vi.doMock('~/shared/lib/db/client', () => ({ publicDb: { transaction: (fn: (t: unknown) => unknown) => fn(db) } }))
    const { searchSelfManaged } = await import('~/lib/sources/self-managed')

    const [builder] = await searchSelfManaged(['translator'])

    expect(builder).toMatchObject({
      kind: 'person',
      source: 'self-managed',
      // The ULID, never the handle: a handle is renameable and re-issuable thirty days after a
      // deletion, so keying on it would let a dedup or a suppression follow the name to somebody else.
      sourceId: created.id,
      username: 'ada',
      profileUrl: '/u/ada',
    })
    expect(builder!.followersCount).toBeUndefined()
    expect(builder!.metadata.isSelfManaged).toBe(true)
    // No recency signal: `lastSeen` from `updatedAt` would let editing a bio outrank shipping.
    expect(builder!.metadata.lastSeen).toBeUndefined()
    vi.doUnmock('~/shared/lib/db/client')
  })
})

describe('dedup and ranking treat it like any other origin', () => {
  const selfManaged = (sourceId: string, username: string): RawBuilder => ({
    id: `self-managed-${sourceId}`,
    kind: 'person',
    source: 'self-managed',
    sourceId,
    username,
    displayName: username,
    profileUrl: `/u/${username}`,
    topics: ['localization'],
    metadata: { isSelfManaged: true, services: ['translation'] },
  })

  const github = (sourceId: string, username: string): RawBuilder => ({
    id: `github-${sourceId}`,
    kind: 'person',
    source: 'github',
    sourceId,
    username,
    displayName: username,
    profileUrl: `https://github.com/${username}`,
    followersCount: 1200,
    topics: ['rust'],
    metadata: {},
  })

  it('never merges a self-managed profile into a claimed builder that shares its handle', () => {
    const deduped = deduplicateBuilders([github('42', 'ada'), selfManaged('prof-1', 'ada')])

    // Two rows, because they are two identities. The key is `(source, sourceId)` and the handle is
    // not part of it — merging on the name is how one person's page absorbs another's.
    expect(deduped).toHaveLength(2)
    expect(deduped.map((row) => row.source).sort()).toEqual(['github', 'self-managed'])
  })

  it('collapses the same profile arriving twice', () => {
    expect(deduplicateBuilders([selfManaged('prof-1', 'ada'), selfManaged('prof-1', 'ada')])).toHaveLength(1)
  })

  it('scores on declared content only, and leaves the existing order alone', () => {
    const before = scoreBuilders([github('42', 'ada'), github('43', 'grace')])
    const after = scoreBuilders([github('42', 'ada'), selfManaged('prof-1', 'edith'), github('43', 'grace')])

    // The claimed builders keep their scores exactly: introducing an origin is additive, and a
    // ranking change nobody asked for is the regression this assertion exists to catch.
    expect(after.filter((row) => row.source === 'github').map((row) => row.score))
      .toEqual(before.map((row) => row.score))

    // And the declared profile does not outrank a builder with real followers behind them.
    const declared = after.find((row) => row.source === 'self-managed')!
    expect(declared.score).toBeLessThan(after.find((row) => row.sourceId === '42')!.score)
  })
})

describe('filterSuppressed covers the origin without knowing about it', () => {
  it('drops a suppressed self-managed identity by its (source, sourceId) pair', async () => {
    vi.resetModules()
    vi.doMock('~/shared/lib/repositories/profile-removal', () => ({
      listActiveSuppressions: async () => [{ id: '1', source: 'self-managed', sourceId: 'prof-1' }],
    }))
    const { filterSuppressed } = await import('~/shared/lib/profile-suppression')

    const kept = await filterSuppressed([
      { source: 'self-managed', sourceId: 'prof-1' },
      { source: 'self-managed', sourceId: 'prof-2' },
      { source: 'github', sourceId: 'prof-1' },
    ])

    // Only the exact pair goes. A suppression is per identity, and `self-managed:prof-1` is not
    // `github:prof-1` however alike the two ids look.
    expect(kept).toEqual([
      { source: 'self-managed', sourceId: 'prof-2' },
      { source: 'github', sourceId: 'prof-1' },
    ])
    vi.doUnmock('~/shared/lib/repositories/profile-removal')
    vi.resetModules()
  })
})
