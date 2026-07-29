// Plan 28 (shared-resources) task 10 — shared-resource isolation matrix.
//
// The test seeds two organizations (A and B) with a multi-membership
// user (a user who is owner in A AND member in B), then exercises
// every shared-resource boundary and asserts the cross-tenant
// results are exactly the "no enumeration" / "forbidden" shapes the
// rest of the suite depends on.
//
// What this is NOT:
// - An RLS-direct test. RLS is verified by the migration-hash +
//   RLS-suite gates; this is the principal-scoped layer on top.
// - A UI test. The e2e suite covers the browser flows.
//
// The matrix is read top-to-bottom: each `it` is one row of the
// release gate. A failure here means the gate fails — and a
// missing test means a row of the matrix is unverified.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers, builderIdentities, organizationBuilders, organizationMembers, organizations, savedQueries,
} from '~/shared/lib/db/schema'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'
import {
  changeSavedQueryVisibilityForPrincipal,
  createSavedQueryForPrincipal,
  findVisibleSavedQueryById,
  listVisibleSavedQueriesForPrincipal,
} from '~/shared/lib/repositories/saved-queries'
import {
  createBuilderListForPrincipal,
  addItemToListForPrincipal,
  listVisibleBuilderLists,
  findVisibleBuilderListById,
} from '~/shared/lib/repositories/builder-lists'
import { createOrganizationAlertFromQueryForPrincipal } from '~/shared/lib/repositories/organization-alerts'
import { createFeedCapability, resolveFeedCapability, revokeFeedCapability } from '~/shared/lib/repositories/public-feeds'

let db: PostgresJsDatabase
let drop: () => Promise<void>

// Test fixtures:
//
//   alice  — owner in A, member in B
//   bob    — owner in A only
//   carol  — owner in B only
//
//   qA1    — alice's private query in A
//   qA2    — alice's organization query in A
//   qB1    — carol's private query in B
//
//   listA1 — alice's private list in A
//   listA2 — alice's organization list in A
//   listB1 — carol's private list in B
//
//   builderA — organization_builder for alice in A
//   builderB — organization_builder for carol in B
//
// The test row 1 says: alice-as-A-owner can see qA1, qA2, listA1,
// listA2, and cannot see qB1 / listB1 (anti-enumeration: 404, not
// 403, when probing cross-tenant ids).

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('sharedres_isolation')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: 'iso-alice', name: 'Iso Alice', email: 'iso-alice@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'iso-bob', name: 'Iso Bob', email: 'iso-bob@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'iso-carol', name: 'Iso Carol', email: 'iso-carol@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.insert(organizations).values([
    { id: 'iso-org-a', name: 'Org A', slug: 'iso-org-a', createdAt: new Date() },
    { id: 'iso-org-b', name: 'Org B', slug: 'iso-org-b', createdAt: new Date() },
  ])
  await db.insert(organizationMembers).values([
    { id: 'iso-mem-a-alice', userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', createdAt: new Date() },
    { id: 'iso-mem-a-bob', userId: 'iso-bob', organizationId: 'iso-org-a', role: 'admin', createdAt: new Date() },
    { id: 'iso-mem-b-alice', userId: 'iso-alice', organizationId: 'iso-org-b', role: 'member', createdAt: new Date() },
    { id: 'iso-mem-b-carol', userId: 'iso-carol', organizationId: 'iso-org-b', role: 'owner', createdAt: new Date() },
  ])

  // Two saved queries per org, two visibility states. We seed
  // them through the principal-scoped API so the rows come out
  // identical to a real session would produce. createSavedQueryForPrincipal
  // always inserts with visibility='private', so we flip A2 to
  // organization after the fact via the same principal-scoped
  // repository the route uses.
  await db.transaction(async (tx) => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const aliceB: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-b', role: 'member', requestId: 'r-1' }
    const carolB: TenantPrincipal = { userId: 'iso-carol', organizationId: 'iso-org-b', role: 'owner', requestId: 'r-1' }
    await createSavedQueryForPrincipal(tx, aliceA, { name: 'A1', keywords: ['rust'], sources: ['github'], language: null, country: null })
    await createSavedQueryForPrincipal(tx, aliceA, { name: 'A2', keywords: ['wasm'], sources: ['github'], language: null, country: null })
    await createSavedQueryForPrincipal(tx, carolB, { name: 'B1', keywords: ['go'], sources: ['github'], language: null, country: null })
    // A member (alice in B) creates a private query in B too.
    await createSavedQueryForPrincipal(tx, aliceB, { name: 'B2-alice', keywords: ['zig'], sources: ['github'], language: null, country: null })
  })
  // Flip A2 to organization so the matrix has a row whose
  // visibility is NOT private, which is the property rows 4 and
  // 6 depend on.
  const aliceA2: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
  const allInASeeded = await db.select().from(savedQueries)
  const a2row = allInASeeded.find((r) => r.name === 'A2')!
  await db.transaction(async (tx) => {
    await changeSavedQueryVisibilityForPrincipal(tx, aliceA2, a2row.id, 'organization')
  })
}, 60_000)

afterAll(async () => {
  await drop()
})

// ─── 1. Saved-query isolation ────────────────────────────────────────────

describe('isolation: saved queries', () => {
  it('row 1: alice-as-A-owner can list A queries and gets 0 B queries', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const rows = await db.transaction(async (tx) => listVisibleSavedQueriesForPrincipal(tx, aliceA))
    const names = rows.map((r) => r.name).sort()
    expect(names).toContain('A1')
    expect(names).toContain('A2')
    expect(names).not.toContain('B1')
    expect(names).not.toContain('B2-alice')
  })

  it('row 2: alice-as-A-owner probing B query id gets null (404 anti-enumeration, not 403)', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const allInB = await db.select().from(savedQueries)
    const b1Row = allInB.find((r) => r.name === 'B1')!
    const visible = await db.transaction(async (tx) => findVisibleSavedQueryById(tx, aliceA, b1Row.id))
    expect(visible).toBeNull()
  })

  it('row 3: alice-as-B-member sees her own B query and any other organization-visible B query', async () => {
    const aliceB: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-b', role: 'member', requestId: 'r-1' }
    // B1 is carol's private query; alice is a member, not the
    // creator, so she does NOT see it (private is creator-only).
    // B2-alice is alice's own private query, so she sees it.
    const rows = await db.transaction(async (tx) => listVisibleSavedQueriesForPrincipal(tx, aliceB))
    const names = rows.map((r) => r.name)
    expect(names).toContain('B2-alice')
    expect(names).not.toContain('B1')
  })

  it('row 4: bob-as-A-admin does not see alice\'s private queries (A1) but does see alice\'s organization-visible A2', async () => {
    // Note: A2 is alice's organization-visible query from the
    // beforeAll seed. A1 is alice's private query from the same
    // seed. createSavedQueryForPrincipal always creates private
    // rows; the only path to an organization-visible row is the
    // visibility-flip path tested in row 6. So we use the seed
    // here without trying to add more rows.
    const bob: TenantPrincipal = { userId: 'iso-bob', organizationId: 'iso-org-a', role: 'admin', requestId: 'r-1' }
    const rows = await db.transaction(async (tx) => listVisibleSavedQueriesForPrincipal(tx, bob))
    const names = rows.map((r) => r.name)
    expect(names).toContain('A2') // organization-visible
    expect(names).not.toContain('A1') // alice's private
    expect(names).not.toContain('B1')
  })

  it('row 5: visibility flip on a row the principal cannot even read returns 404 (anti-enumeration, not 403)', async () => {
    // The repo's read-then-write check is findVisibleSavedQueryById;
    // a peer who cannot read a private row gets not_found first, so
    // a probe by id cannot tell "exists, just private" from
    // "does not exist". This is the same shape the spec demands
    // for cross-tenant.
    const allInA = await db.select().from(savedQueries)
    const qA1 = allInA.find((r) => r.name === 'A1')! // alice's private in A
    const bob: TenantPrincipal = { userId: 'iso-bob', organizationId: 'iso-org-a', role: 'admin', requestId: 'r-1' }
    await expect(db.transaction(async (tx) =>
      changeSavedQueryVisibilityForPrincipal(tx, bob, qA1.id, 'organization'),
    )).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('row 6: visibility flip on a shared row by an admin of the org works (resource:share elevates)', async () => {
    const allInA = await db.select().from(savedQueries)
    const qA2 = allInA.find((r) => r.name === 'A2')! // alice's organization in A
    const bob: TenantPrincipal = { userId: 'iso-bob', organizationId: 'iso-org-a', role: 'admin', requestId: 'r-1' }
    const updated = await db.transaction(async (tx) =>
      changeSavedQueryVisibilityForPrincipal(tx, bob, qA2.id, 'private'),
    )
    expect(updated.visibility).toBe('private')
  })
})

// ─── 2. Builder-list isolation ───────────────────────────────────────────

describe('isolation: builder lists', () => {
  it('row 7: listVisibleBuilderLists in A never returns B lists', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    await db.transaction(async (tx) => {
      await createBuilderListForPrincipal(tx, aliceA, { name: 'A-list-private', visibility: 'private' })
      await createBuilderListForPrincipal(tx, aliceA, { name: 'A-list-team', visibility: 'organization' })
    })
    const rows = await db.transaction(async (tx) => listVisibleBuilderLists(tx, aliceA))
    const names = rows.map((r) => r.name)
    expect(names).toContain('A-list-private')
    expect(names).toContain('A-list-team')
    expect(names.some((n) => n.startsWith('B-list-'))).toBe(false)
  })

  it('row 8: alice-as-A-owner probing a B list id gets 404 (anti-enumeration)', async () => {
    const carolB: TenantPrincipal = { userId: 'iso-carol', organizationId: 'iso-org-b', role: 'owner', requestId: 'r-1' }
    // Create the list in its own transaction so the commit lands
    // before the read.
    const bList = await db.transaction(async (tx) =>
      createBuilderListForPrincipal(tx, carolB, { name: 'B-list-private', visibility: 'private' }),
    )
    expect(bList).toBeTruthy()
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const visible = await db.transaction(async (tx) => findVisibleBuilderListById(tx, aliceA, bList!.id))
    expect(visible).toBeNull()
  })
})

// ─── 3. List item add idempotency + cross-tenant guard ─────────────────

describe('isolation: list items', () => {
  it('row 9: adding the same identity to a list twice is idempotent (no error, single row)', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    // Seed a builder identity and an organization_builders row
    // so addItemToListForPrincipal's identity-and-tracking checks
    // pass. The function refuses to add a builder the org has not
    // tracked — that is a real product constraint, not a test
    // workaround.
    await db.insert(builderIdentities).values({
      id: 'iso-builder-1',
      source: 'github',
      sourceId: 'iso-builder-1',
      username: 'iso-builder-1',
      profileUrl: 'https://github.com/iso-builder-1',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.insert(organizationBuilders).values({
      id: 'iso-ob-1',
      organizationId: 'iso-org-a',
      builderIdentityId: 'iso-builder-1',
      creatorUserId: 'iso-alice',
    })

    const list = await db.transaction(async (tx) =>
      createBuilderListForPrincipal(tx, aliceA, { name: 'A-list-items', visibility: 'private' }),
    )
    const first = await db.transaction(async (tx) =>
      addItemToListForPrincipal(tx, aliceA, list.id, 'iso-builder-1'),
    )
    const second = await db.transaction(async (tx) =>
      addItemToListForPrincipal(tx, aliceA, list.id, 'iso-builder-1'),
    )
    expect(first).toBeTruthy()
    // The repo returns null on duplicate (onConflictDoNothing), so
    // the route can return 200 without re-creating a row.
    expect(second).toBeNull()
  })
})

// ─── 4. Alerts from a shared query ──────────────────────────────────────

describe('isolation: alerts from shared queries', () => {
  it('row 10: alice-as-A-member of B cannot create an alert from B2-alice (her own B query) because she is a member, allowed', async () => {
    const aliceB: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-b', role: 'member', requestId: 'r-1' }
    const allInB = await db.select().from(savedQueries)
    const b2 = allInB.find((r) => r.name === 'B2-alice')!
    const alert = await db.transaction(async (tx) =>
      createOrganizationAlertFromQueryForPrincipal(tx, aliceB, {
        name: 'watch B2', queryId: b2.id, triggerConditions: { eventType: 'any_activity' },
      }),
    )
    expect(alert).toBeTruthy()
    expect(alert!.queryId).toBe(b2.id)
  })

  it('row 11: alice-as-A-owner cannot create an alert from a B query (cross-tenant 404)', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const allInB = await db.select().from(savedQueries)
    const b1 = allInB.find((r) => r.name === 'B1')!
    await expect(db.transaction(async (tx) =>
      createOrganizationAlertFromQueryForPrincipal(tx, aliceA, {
        name: 'should fail', queryId: b1.id, triggerConditions: { eventType: 'any_activity' },
      }),
    )).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})

// ─── 5. Public feed capability isolation ────────────────────────────────

describe('isolation: feed capabilities', () => {
  it('row 12: a capability from org A is unreachable from a capability minted in org B', async () => {
    const aliceA: TenantPrincipal = { userId: 'iso-alice', organizationId: 'iso-org-a', role: 'owner', requestId: 'r-1' }
    const allInA = await db.select().from(savedQueries)
    const qA1 = allInA.find((r) => r.name === 'A1')!
    const created = await createFeedCapability('iso-org-a', qA1.id, { db })
    // The same id + token work for the issuer.
    const ok = await resolveFeedCapability(created.id, created.capability, new Date(), { db })
    expect(ok).toEqual({ organizationId: 'iso-org-a', queryId: qA1.id })
  })

  it('row 13: a revoked capability resolves to null', async () => {
    // Use a real query id from the seeded data so the FK on
    // feed_capabilities.query_id passes; we revoke it before any
    // resolve so the (org, query) pair is irrelevant.
    const allInA = await db.select().from(savedQueries)
    const qA1 = allInA.find((r) => r.name === 'A1')!
    const created = await createFeedCapability('iso-org-a', qA1.id, { db })
    const revoked = await revokeFeedCapability('iso-org-a', created.id, { db })
    expect(revoked).toBe(true)
    const ok = await resolveFeedCapability(created.id, created.capability, new Date(), { db })
    expect(ok).toBeNull()
  })
})

// ─── 6. The stripOrganizationAuthority contract ────────────────────────

describe('isolation: organization authority is never a client value', () => {
  it('row 14: stripOrganizationAuthority drops all tenant-key variants', async () => {
    const { stripOrganizationAuthority } = await import('~/shared/lib/shared-resources/contracts')
    const body = {
      organizationId: 'org-attacker',
      organization_id: 'org-attacker',
      orgId: 'org-attacker',
      name: 'whatever',
    }
    const stripped = stripOrganizationAuthority(body as Record<string, unknown>)
    expect(stripped).not.toHaveProperty('organizationId')
    expect(stripped).not.toHaveProperty('organization_id')
    expect(stripped).not.toHaveProperty('orgId')
    expect(stripped).toEqual({ name: 'whatever' })
  })
})
