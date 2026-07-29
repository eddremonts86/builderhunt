import { readFile } from 'node:fs/promises'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizationMembers, organizations } from '~/shared/lib/db/schema'
import {
  changeSavedQueryVisibilityForPrincipal,
  createSavedQuery,
  createSavedQueryForPrincipal,
  deleteSavedQueryForPrincipal,
  findVisibleSavedQueryById,
  listLegacySavedQueries,
  listSavedQueries,
  listVisibleSavedQueriesForPrincipal,
  updateSavedQueryForPrincipal,
} from '~/shared/lib/repositories/saved-queries'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

describe('saved query tenant boundary', () => {
  it('requires a tenant principal and transaction-scoped repository', async () => {
    const source = await readFile('src/routes/api/queries/index.ts', 'utf8')

    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain('requireTenantPrincipal')
    expect(source).toContain('withTenantContext')
    expect(source).toContain('resolveTenantReadMode')
    expect(source).toContain("~/shared/lib/repositories/saved-queries")
    expect(source).not.toContain('organizationId } = body')
  })
})

describe('listLegacySavedQueries — cross-org isolation', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('savedqueries')
    db = disposable.db
    drop = disposable.drop

    await db.insert(authUsers).values({
      id: 'legacy-read-user', name: 'Legacy Read User', email: 'legacy-read-user@test.invalid',
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    })
    await db.insert(organizations).values([
      { id: 'legacy-read-org-a', name: 'Org A', slug: 'legacy-read-org-a', createdAt: new Date() },
      { id: 'legacy-read-org-b', name: 'Org B', slug: 'legacy-read-org-b', createdAt: new Date() },
    ])
  }, 60_000)

  afterAll(async () => {
    await drop()
  })

  it("does not leak a user's saved search from one organization into another organization the same user belongs to", async () => {
    // Regression test: `listLegacySavedQueries` used to filter by userId only
    // (a leftover from before organizationId existed on this table), so a
    // user who owns 2+ organizations — the ordinary personal-workspace +
    // team case — saw every org's saved searches merged together regardless
    // of which organization was active. Confirmed live via the browser
    // during this session's functional QA pass, then fixed by adding the
    // organizationId filter below.
    await db.transaction((tx) => createSavedQuery(tx, {
      id: 'legacy-read-query-a',
      organizationId: 'legacy-read-org-a',
      createdByUserId: 'legacy-read-user',
      name: 'Org A search',
      keywords: ['rust'],
      sources: ['github'],
      language: null,
      country: null,
    }))

    const fromOrgA = await db.transaction((tx) => listLegacySavedQueries(tx, 'legacy-read-user', 'legacy-read-org-a'))
    expect(fromOrgA).toHaveLength(1)
    expect(fromOrgA[0].name).toBe('Org A search')

    const fromOrgB = await db.transaction((tx) => listLegacySavedQueries(tx, 'legacy-read-user', 'legacy-read-org-b'))
    expect(fromOrgB).toHaveLength(0)

    // The canonical path was never affected — asserted here too so a future
    // change can't silently make both paths wrong in the same way.
    const canonicalOrgB = await db.transaction((tx) => listSavedQueries(tx, 'legacy-read-org-b'))
    expect(canonicalOrgB).toHaveLength(0)
  })
})

// ── Plan 28 task 3: visibility-aware tenant repository ─────────────────────

function principal(userId: string, organizationId: string, role: TenantPrincipal['role']): TenantPrincipal {
  return { userId, organizationId, role, requestId: 'req-test' }
}

describe('saved query tenant repository — visibility-aware (plan 28 task 3)', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('sharedresources')
    db = disposable.db
    drop = disposable.drop

    // Two users in two orgs; one user is a member of both orgs.
    await db.insert(authUsers).values([
      { id: 'sr-u-a', name: 'A', email: 'sr-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'sr-u-b', name: 'B', email: 'sr-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'sr-u-m', name: 'M', email: 'sr-m@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await db.insert(organizations).values([
      { id: 'sr-org-a', name: 'OrgA', slug: 'sr-org-a', createdAt: new Date() },
      { id: 'sr-org-b', name: 'OrgB', slug: 'sr-org-b', createdAt: new Date() },
    ])
    // M is a member of both orgs.
    await db.insert(organizationMembers).values([
      { id: 'sr-m-a', organizationId: 'sr-org-a', userId: 'sr-u-m', role: 'owner', createdAt: new Date() },
      { id: 'sr-m-b', organizationId: 'sr-org-b', userId: 'sr-u-m', role: 'owner', createdAt: new Date() },
    ])
  }, 60_000)

  afterAll(async () => {
    await drop()
  })

  it('creator sees their own private query; a peer does not', async () => {
    const created = await db.transaction((tx) => createSavedQuery(tx, {
      id: 'sr-q-private-1',
      organizationId: 'sr-org-a',
      createdByUserId: 'sr-u-a',
      name: 'A private search',
      keywords: ['rust'],
      sources: ['github'],
      language: null,
      country: null,
    }))
    // Default visibility is 'private' from the schema default.
    expect(created.visibility).toBe('private')

    const asCreator = await db.transaction((tx) =>
      findVisibleSavedQueryById(tx, principal('sr-u-a', 'sr-org-a', 'owner'), 'sr-q-private-1'))
    expect(asCreator?.name).toBe('A private search')

    // B is in the same org but is a peer. The can() check on resource:read
    // returns false (creatorUserId != principal.userId AND visibility != 'organization'),
    // so the read returns null. The DELETE / UPDATE paths also return null
    // (their first step is findVisibleSavedQueryById), so a peer can neither
    // read nor mutate a private row they did not create.
    const asPeer = await db.transaction((tx) =>
      findVisibleSavedQueryById(tx, principal('sr-u-b', 'sr-org-a', 'member'), 'sr-q-private-1'))
    expect(asPeer).toBeNull()
  })

  it("flipping visibility to 'organization' lets every org member read it; admins can mutate", async () => {
    await db.transaction((tx) => createSavedQueryForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner'), {
      name: 'A shared search',
      keywords: ['typescript'],
      sources: ['github'],
      language: null,
      country: null,
    }))

    const queries = await db.transaction((tx) =>
      listVisibleSavedQueriesForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner')))
    const q = queries.find((r) => r.name === 'A shared search')
    expect(q).toBeDefined()

    // Initially private: peer B sees nothing.
    const peerBefore = await db.transaction((tx) =>
      findVisibleSavedQueryById(tx, principal('sr-u-b', 'sr-org-a', 'member'), q!.id))
    expect(peerBefore).toBeNull()

    // Flip to organization-visible. Only the creator (or an owner) can.
    const updated = await db.transaction((tx) =>
      changeSavedQueryVisibilityForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner'), q!.id, 'organization'))
    expect(updated?.visibility).toBe('organization')

    const peerAfter = await db.transaction((tx) =>
      findVisibleSavedQueryById(tx, principal('sr-u-b', 'sr-org-a', 'member'), q!.id))
    expect(peerAfter?.name).toBe('A shared search')
  })

  it('a member cannot flip visibility on a query they did not create', async () => {
    await db.transaction((tx) => createSavedQueryForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner'), {
      name: 'Owner-only',
      keywords: ['go'],
      sources: ['github'],
      language: null,
      country: null,
    }))
    const queries = await db.transaction((tx) =>
      listVisibleSavedQueriesForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner')))
    const q = queries.find((r) => r.name === 'Owner-only')!

    // B is a peer member. can(principal, 'resource:share', { creatorUserId: 'sr-u-a', visibility: 'private' })
    // is false, so the visibility change must throw.
    await expect(
      db.transaction((tx) => changeSavedQueryVisibilityForPrincipal(tx, principal('sr-u-b', 'sr-org-a', 'member'), q.id, 'organization')),
    ).rejects.toBeInstanceOf(SharedResourceError)
  })

  it('multi-org member sees only the active org\'s queries (A/B isolation)', async () => {
    // M is a member of both orgs. Create one query in each.
    await db.transaction((tx) => createSavedQueryForPrincipal(tx, principal('sr-u-m', 'sr-org-a', 'owner'), {
      name: 'M-in-A',
      keywords: ['rust'],
      sources: ['github'],
      language: null,
      country: null,
    }))
    await db.transaction((tx) => createSavedQueryForPrincipal(tx, principal('sr-u-m', 'sr-org-b', 'owner'), {
      name: 'M-in-B',
      keywords: ['python'],
      sources: ['github'],
      language: null,
      country: null,
    }))

    const aList = await db.transaction((tx) =>
      listVisibleSavedQueriesForPrincipal(tx, principal('sr-u-m', 'sr-org-a', 'owner')))
    const bList = await db.transaction((tx) =>
      listVisibleSavedQueriesForPrincipal(tx, principal('sr-u-m', 'sr-org-b', 'owner')))
    expect(aList.some((q) => q.name === 'M-in-A')).toBe(true)
    expect(aList.some((q) => q.name === 'M-in-B')).toBe(false)
    expect(bList.some((q) => q.name === 'M-in-B')).toBe(true)
    expect(bList.some((q) => q.name === 'M-in-A')).toBe(false)
  })

  it('update + delete paths throw on a query the principal cannot see', async () => {
    await db.transaction((tx) => createSavedQueryForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner'), {
      name: 'A private again',
      keywords: ['rust'],
      sources: ['github'],
      language: null,
      country: null,
    }))
    const q = (await db.transaction((tx) =>
      listVisibleSavedQueriesForPrincipal(tx, principal('sr-u-a', 'sr-org-a', 'owner'))))
      .find((r) => r.name === 'A private again')!

    // B is a peer; cannot read → cannot update → cannot delete. All throw not_found
    // (not forbidden) so a probe by id cannot enumerate.
    await expect(db.transaction((tx) =>
      updateSavedQueryForPrincipal(tx, principal('sr-u-b', 'sr-org-a', 'member'), q.id, { name: 'hijack' }),
    )).rejects.toBeInstanceOf(SharedResourceError)

    await expect(db.transaction((tx) =>
      deleteSavedQueryForPrincipal(tx, principal('sr-u-b', 'sr-org-a', 'member'), q.id),
    )).rejects.toBeInstanceOf(SharedResourceError)
  })
})
