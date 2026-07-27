import { readFile } from 'node:fs/promises'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { createSavedQuery, listLegacySavedQueries, listSavedQueries } from '~/shared/lib/repositories/saved-queries'

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
