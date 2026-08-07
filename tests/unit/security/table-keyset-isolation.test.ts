// Plan 03 (keyset-pagination) — "Prove the tenant boundary cannot be crossed".
//
// These attacks are written before the endpoint that would expose them exists. `buildKeysetPage`
// is the one place table filtering, sorting and grouping reach SQL, and it is reachable from a
// query string: the moment plan 07 wires a route to it, every one of these is a live request
// someone can make.
//
// The disposable harness does not enable RLS, and that is what makes this test useful rather than
// redundant. RLS is the second layer and it is forced in the real database; here it is absent, so
// what is under test is the *first* layer — the explicit `organization_id = :current` predicate
// and the organization-bound cursor. If those were the tautology they look like, org B would read
// org A's rows in this file.

import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  organizationMembers,
  organizations,
  sourcingSprints,
  sprintResults,
} from '~/shared/lib/db/schema'
import type { ExtractedCriteria } from '~/shared/lib/sprints-shared'
import { defineTableCapability } from '~/shared/lib/table/capability'
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import { TableCursorError } from '~/shared/lib/table/cursor'
import { buildKeysetPage } from '~/shared/lib/table/keyset'
import type { TableQuery } from '~/shared/lib/table/types'

/** `sourcing_sprints.criteria` is a validated shape; this suite is about the boundary, not the parser. */
const CRITERIA: ExtractedCriteria = {
  skills: ['rust'], roles: [], seniority: 'unknown', locations: [], mustHaves: [],
}

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'keyset-iso-a'
const ORG_B = 'keyset-iso-b'
const USER_A = 'keyset-iso-user-a'
const USER_B = 'keyset-iso-user-b'
const SPRINT_A = 'keyset-iso-sprint-a'
const SPRINT_B = 'keyset-iso-sprint-b'

const capability = defineTableCapability({
  table: 'sprint_results',
  sortable: { score: { column: sprintResults.score } },
  filterable: { source: { column: sprintResults.source, facet: true } },
  groupable: [],
  searchable: [sprintResults.sourceId],
  tiebreaker: sprintResults.id,
  defaultSort: [{ id: 'score', dir: 'desc' }],
  organizationColumn: sprintResults.organizationId,
})

const options = {
  select: { id: sprintResults.id, source: sprintResults.source },
  mapRow: (row: Record<string, unknown>) => row as { id: string; source: string },
}

function query(overrides: Partial<TableQuery> = {}): TableQuery {
  return { search: '', filters: {}, sort: [], groupBy: null, ...overrides }
}

function asOrganization<T>(organizationId: string, operation: (tx: never) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`)
    return operation(tx as never)
  })
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('table_keyset_isolation')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: USER_A, name: 'A', email: 'keyset-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: USER_B, name: 'B', email: 'keyset-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.insert(organizations).values([
    { id: ORG_A, name: 'Org A', slug: ORG_A, createdAt: new Date() },
    { id: ORG_B, name: 'Org B', slug: ORG_B, createdAt: new Date() },
  ])
  await db.insert(organizationMembers).values([
    { id: 'keyset-mem-a', userId: USER_A, organizationId: ORG_A, role: 'owner', createdAt: new Date() },
    { id: 'keyset-mem-b', userId: USER_B, organizationId: ORG_B, role: 'owner', createdAt: new Date() },
  ])
  await db.insert(sourcingSprints).values([
    {
      id: SPRINT_A, organizationId: ORG_A, creatorUserId: USER_A, name: 'A sprint', status: 'active',
      criteria: CRITERIA, variants: [], quota: 25, cursor: { page: 1, variantIndex: 0 }, createdAt: new Date(),
    },
    {
      id: SPRINT_B, organizationId: ORG_B, creatorUserId: USER_B, name: 'B sprint', status: 'active',
      criteria: CRITERIA, variants: [], quota: 25, cursor: { page: 1, variantIndex: 0 }, createdAt: new Date(),
    },
  ])
  await db.insert(sprintResults).values([
    ...[90, 80, 70].map((score, index) => ({
      id: `a-${index}`, organizationId: ORG_A, sprintId: SPRINT_A, source: 'github',
      sourceId: `a-${index}`, profile: { name: `a-${index}` } as never,
      matchedVariant: 'senior', score, createdAt: new Date(),
    })),
    ...[95, 85].map((score, index) => ({
      id: `b-${index}`, organizationId: ORG_B, sprintId: SPRINT_B, source: 'gitlab',
      sourceId: `b-${index}`, profile: { name: `b-${index}` } as never,
      matchedVariant: 'senior', score, createdAt: new Date(),
    })),
  ])
}, 120_000)

afterAll(async () => {
  await drop?.()
})

describe('the tenant boundary', () => {
  it('returns only the acting organization\'s rows, with RLS absent', async () => {
    const a = await asOrganization(ORG_A, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))
    const b = await asOrganization(ORG_B, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))

    expect(a.rows.map((row) => row.id)).toEqual(['a-0', 'a-1', 'a-2'])
    expect(a.total).toBe(3)
    expect(b.rows.map((row) => row.id)).toEqual(['b-0', 'b-1'])
    expect(b.total).toBe(2)
  })

  it('keeps facet counts inside the boundary too', async () => {
    const b = await asOrganization(ORG_B, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))

    // `github` exists in the table, but not in org B.
    expect(b.facets.source).toEqual([{ value: 'gitlab', count: 2 }])
  })

  /**
   * The negative tenant A/B the security policy requires.
   *
   * A keyset cursor is a way of asking "what comes after this row". Accepting one minted by
   * another organization answers that about rows the caller cannot see — and the leak is in the
   * *boundary*, not in the payload, so no row of A's data has to appear in B's response for the
   * question to have been answered.
   */
  it('refuses a cursor minted by another organization', async () => {
    const first = await asOrganization(ORG_A, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: 1 }, options))
    expect(first.nextCursor).not.toBeNull()

    await expect(asOrganization(ORG_B, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: first.nextCursor, limit: 1 }, options)))
      .rejects.toThrow(TableCursorError)

    await expect(asOrganization(ORG_B, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: first.nextCursor, limit: 1 }, options)))
      .rejects.toThrow(/organization mismatch/)
  })

  it('accepts that same cursor from the organization that minted it', async () => {
    const first = await asOrganization(ORG_A, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: 1 }, options))
    const second = await asOrganization(ORG_A, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: first.nextCursor, limit: 1 }, options))

    expect(first.rows.map((row) => row.id)).toEqual(['a-0'])
    expect(second.rows.map((row) => row.id)).toEqual(['a-1'])
  })

  /**
   * A builder that fell back to a global connection when the tenant setting was missing would be a
   * cross-tenant read with nothing to notice. It reads `app.organization_id` back out of the
   * transaction rather than trusting a caller-supplied id, so "I forgot `withTenantContext`" is an
   * error and not a full-table scan.
   */
  it('throws when app.organization_id is unset instead of reading every row', async () => {
    await expect(db.transaction((tx) =>
      buildKeysetPage(tx as never, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options)))
      .rejects.toThrow(/must run inside withTenantContext/)
  })

  it('throws when app.organization_id is set to the empty string', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', '', true)`)
      return buildKeysetPage(tx as never, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options)
    })).rejects.toThrow(/must run inside withTenantContext/)
  })
})

describe('client-supplied values reach SQL as parameters', () => {
  /**
   * The allowlist stops a client *naming* a column. This is the other half: a client-supplied
   * *value* is bound, so quotes and keywords are data. If it were interpolated, this test would
   * drop the table and every later assertion in the file would fail with "relation does not
   * exist" — which is a deliberately loud way to fail.
   */
  it('treats a filter value full of quotes and keywords as data', async () => {
    const hostile = "github'); drop table sprint_results; --"
    const result = await asOrganization(ORG_A, (tx) => buildKeysetPage(
      tx,
      capability,
      query({ filters: { source: [hostile] } }),
      { cursor: null, limit: TABLE_PAGE_SIZE },
      options,
    ))

    expect(result.rows).toEqual([])
    expect(result.total).toBe(0)

    const survivors = await asOrganization(ORG_A, (tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))
    expect(survivors.total).toBe(3)
  })

  it('treats a search term full of wildcards and quotes as data', async () => {
    const result = await asOrganization(ORG_A, (tx) => buildKeysetPage(
      tx,
      capability,
      query({ search: "%' or 1=1 --" }),
      { cursor: null, limit: TABLE_PAGE_SIZE },
      options,
    ))

    // `or 1=1` would return all three if the term were interpolated; escaped, the literal string
    // matches no `source_id`.
    expect(result.total).toBe(0)
  })
})
