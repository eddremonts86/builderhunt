import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderIdentities, organizationBuilders, organizationMembers, organizations } from '~/shared/lib/db/schema'
import {
  addItemToListForPrincipal,
  createBuilderListForPrincipal,
  deleteBuilderListForPrincipal,
  findVisibleBuilderListById,
  listItemsForList,
  listVisibleBuilderLists,
  removeItemFromListForPrincipal,
} from '~/shared/lib/repositories/builder-lists'
import { SharedResourceError } from '~/shared/lib/shared-resources/contracts'

function principal(userId: string, organizationId: string, role: TenantPrincipal['role']): TenantPrincipal {
  return { userId, organizationId, role, requestId: 'req-test' }
}

describe('builder lists tenant repository (plan 28 task 4)', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>
  let listIdA: string
  let listIdB: string

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('builderlists')
    db = disposable.db
    drop = disposable.drop

    // Two users in two orgs; user A and B are in org-A; M is in both.
    await db.insert(authUsers).values([
      { id: 'bl-u-a', name: 'A', email: 'bl-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'bl-u-b', name: 'B', email: 'bl-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'bl-u-m', name: 'M', email: 'bl-m@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await db.insert(organizations).values([
      { id: 'bl-org-a', name: 'OrgA', slug: 'bl-org-a', createdAt: new Date() },
      { id: 'bl-org-b', name: 'OrgB', slug: 'bl-org-b', createdAt: new Date() },
    ])
    await db.insert(organizationMembers).values([
      { id: 'bl-m-a', organizationId: 'bl-org-a', userId: 'bl-u-m', role: 'owner', createdAt: new Date() },
      { id: 'bl-m-b', organizationId: 'bl-org-b', userId: 'bl-u-m', role: 'owner', createdAt: new Date() },
    ])

    // Two tracked builders, one per org. Builder identities must exist
    // before organization_builders can reference them (FK contract).
    await db.insert(builderIdentities).values([
      { id: 'bl-bi-1', source: 'github', sourceId: 'u1', username: 'u1', displayName: 'U1', profileUrl: 'https://github.com/u1', createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date() },
      { id: 'bl-bi-2', source: 'github', sourceId: 'u2', username: 'u2', displayName: 'U2', profileUrl: 'https://github.com/u2', createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date() },
    ])
    await db.insert(organizationBuilders).values([
      { id: 'bl-ob-1', organizationId: 'bl-org-a', builderIdentityId: 'bl-bi-1', creatorUserId: 'bl-u-m', visibility: 'private', createdAt: new Date(), updatedAt: new Date() },
      { id: 'bl-ob-2', organizationId: 'bl-org-b', builderIdentityId: 'bl-bi-2', creatorUserId: 'bl-u-m', visibility: 'private', createdAt: new Date(), updatedAt: new Date() },
    ])

    listIdA = (await db.transaction((tx) => createBuilderListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), {
      name: 'A spring shortlist',
      description: null,
      visibility: 'private',
    })))!.id

    listIdB = (await db.transaction((tx) => createBuilderListForPrincipal(tx, principal('bl-u-m', 'bl-org-b', 'owner'), {
      name: 'M cross-org list',
      description: null,
      visibility: 'organization',
    })))!.id
  }, 60_000)

  afterAll(async () => {
    await drop()
  })

  it('multi-org user sees only the active org\'s lists (A/B isolation)', async () => {
    // M's view of org-a contains:
    //   - listIdA is invisible (A owns it, visibility=private, M is not the creator)
    //   - any of M's own org-a lists (none created here)
    //   - organization-visible org-a lists (none here)
    // So the list is empty for M-in-org-a. M's view of org-b contains
    //   - listIdB (M owns it, visibility=organization) — present.
    // The test is that M sees the right list in the right org, not
    // the wrong list in the wrong one.
    const aList = await db.transaction((tx) =>
      listVisibleBuilderLists(tx, principal('bl-u-m', 'bl-org-a', 'owner')))
    const bList = await db.transaction((tx) =>
      listVisibleBuilderLists(tx, principal('bl-u-m', 'bl-org-b', 'owner')))
    expect(aList.some((l) => l.id === listIdA)).toBe(false)
    expect(aList.some((l) => l.id === listIdB)).toBe(false)
    expect(bList.some((l) => l.id === listIdB)).toBe(true)
    expect(bList.some((l) => l.id === listIdA)).toBe(false)
  })

  it('peer in same org cannot read a private list they did not create', async () => {
    const seen = await db.transaction((tx) =>
      findVisibleBuilderListById(tx, principal('bl-u-b', 'bl-org-a', 'member'), listIdA))
    expect(seen).toBeNull()
  })

  it('addItemToList refuses a builder the org has not tracked (FK contract)', async () => {
    // bl-bi-2 belongs to org-B, not org-A. Adding it to an org-A list
    // must throw invalid_identity, not blow up with a 23503.
    await expect(
      db.transaction((tx) => addItemToListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA, 'bl-bi-2')),
    ).rejects.toBeInstanceOf(SharedResourceError)
  })

  it('addItemToList is idempotent on (list, builder) — duplicate add is a no-op', async () => {
    const first = await db.transaction((tx) =>
      addItemToListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA, 'bl-bi-1'))
    expect(first).not.toBeNull()
    const second = await db.transaction((tx) =>
      addItemToListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA, 'bl-bi-1'))
    expect(second).toBeNull() // duplicate, no-op
    const items = await db.transaction((tx) => listItemsForList(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA))
    expect(items).toHaveLength(1)
  })

  it('peer cannot add to a list they cannot see (not_found, not forbidden)', async () => {
    // B is a peer. They cannot read listIdA → cannot add to it.
    await expect(
      db.transaction((tx) => addItemToListForPrincipal(tx, principal('bl-u-b', 'bl-org-a', 'member'), listIdA, 'bl-bi-1')),
    ).rejects.toBeInstanceOf(SharedResourceError)
  })

  it('removeItemFromList cleans up and a second remove is idempotent', async () => {
    const before = await db.transaction((tx) =>
      listItemsForList(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA))
    expect(before).toHaveLength(1)
    const itemId = before[0].id

    await db.transaction((tx) =>
      removeItemFromListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA, itemId))
    const after = await db.transaction((tx) =>
      listItemsForList(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA))
    expect(after).toHaveLength(0)

    // Second remove is also fine — DELETE WHERE id = X is idempotent.
    await db.transaction((tx) =>
      removeItemFromListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), listIdA, itemId))
  })

  it('deleteBuilderListForPrincipal removes a private list when called by the creator', async () => {
    const id = (await db.transaction((tx) => createBuilderListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), {
      name: 'to-delete',
      description: null,
      visibility: 'private',
    })))!.id
    await db.transaction((tx) => deleteBuilderListForPrincipal(tx, principal('bl-u-a', 'bl-org-a', 'owner'), id))
    const after = await db.transaction((tx) =>
      findVisibleBuilderListById(tx, principal('bl-u-a', 'bl-org-a', 'owner'), id))
    expect(after).toBeNull()
  })
})
