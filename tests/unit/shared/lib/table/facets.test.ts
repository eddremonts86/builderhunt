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
import { buildKeysetPage } from '~/shared/lib/table/keyset'
import type { TableQuery } from '~/shared/lib/table/types'

/** `sourcing_sprints.criteria` is a validated shape; this suite is about paging, not the parser. */
const CRITERIA: ExtractedCriteria = {
  skills: ['rust'], roles: [], seniority: 'unknown', locations: [], mustHaves: [],
}

/**
 * Facet counts, against a real Postgres.
 *
 * The bug this file exists to catch is not a crash. It is a facet panel that reports 0 for every
 * unselected value in the dimension the user is currently filtering by — so at exactly the moment
 * someone is looking for what *else* is in that dimension, the chips say "nothing". A naive
 * implementation (count with all filters applied, including this dimension's own) produces it, and
 * it looks entirely plausible in a screenshot.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'facets-org'
const OWNER = 'facets-owner'
const SPRINT = 'facets-sprint'

const capability = defineTableCapability({
  table: 'sprint_results',
  sortable: { score: { column: sprintResults.score } },
  filterable: {
    source: { column: sprintResults.source, facet: true },
    matchedVariant: { column: sprintResults.matchedVariant, facet: true },
  },
  groupable: [],
  searchable: [],
  tiebreaker: sprintResults.id,
  defaultSort: [{ id: 'score', dir: 'desc' }],
  organizationColumn: sprintResults.organizationId,
})

/**
 * Six rows over two dimensions:
 *
 * | source | variant | rows |
 * |---|---|---|
 * | github | senior | 3 |
 * | github | junior | 1 |
 * | gitlab | senior | 2 |
 */
const ROWS = [
  { id: 'f1', source: 'github', matchedVariant: 'senior', score: 90 },
  { id: 'f2', source: 'github', matchedVariant: 'senior', score: 80 },
  { id: 'f3', source: 'github', matchedVariant: 'senior', score: 70 },
  { id: 'f4', source: 'github', matchedVariant: 'junior', score: 60 },
  { id: 'f5', source: 'gitlab', matchedVariant: 'senior', score: 50 },
  { id: 'f6', source: 'gitlab', matchedVariant: 'senior', score: 40 },
]

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('table_facets')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values([
    { id: OWNER, name: 'Facets Owner', email: 'facets@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.insert(organizations).values([{ id: ORG, name: 'Facets Org', slug: ORG, createdAt: new Date() }])
  await db.insert(organizationMembers).values([
    { id: 'facets-member', userId: OWNER, organizationId: ORG, role: 'owner', createdAt: new Date() },
  ])
  await db.insert(sourcingSprints).values([{
    id: SPRINT, organizationId: ORG, creatorUserId: OWNER,
    name: 'Facets sprint', status: 'active',
    criteria: CRITERIA, variants: [], quota: 25,
    cursor: { page: 1, variantIndex: 0 }, createdAt: new Date(),
  }])
  await db.insert(sprintResults).values(ROWS.map((row) => ({
    id: row.id,
    organizationId: ORG,
    sprintId: SPRINT,
    source: row.source,
    sourceId: `${row.source}-${row.id}`,
    profile: { name: row.id } as never,
    matchedVariant: row.matchedVariant,
    score: row.score,
    createdAt: new Date(),
  })))
}, 120_000)

afterAll(async () => {
  await drop?.()
})

function inTenantContext<T>(operation: (tx: never) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${ORG}, true)`)
    return operation(tx as never)
  })
}

function query(overrides: Partial<TableQuery> = {}): TableQuery {
  return { search: '', filters: {}, sort: [], groupBy: null, ...overrides }
}

const options = {
  select: { id: sprintResults.id, source: sprintResults.source },
  mapRow: (row: Record<string, unknown>) => row as { id: string; source: string },
}

describe('facet counts', () => {
  it('counts every value of an unfiltered dimension', async () => {
    const result = await inTenantContext((tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))

    expect(result.total).toBe(6)
    expect(result.facets.source).toEqual([
      { value: 'github', count: 4 },
      { value: 'gitlab', count: 2 },
    ])
  })

  /**
   * The regression. With `source=gitlab` selected, a naive facet applies that filter to its own
   * count and reports `github: 0` — telling the user the only other option is empty, when it holds
   * four rows they could switch to.
   */
  it('counts a filtered dimension as if its own filter were not applied', async () => {
    const result = await inTenantContext((tx) => buildKeysetPage(
      tx,
      capability,
      query({ filters: { source: ['gitlab'] } }),
      { cursor: null, limit: TABLE_PAGE_SIZE },
      options,
    ))

    expect(result.rows).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.facets.source).toEqual([
      { value: 'github', count: 4 },
      { value: 'gitlab', count: 2 },
    ])
  })

  /** The other half: a *different* dimension must feel the active filter, or the chips promise rows the table will not show. */
  it('narrows every other dimension by the active filter', async () => {
    const result = await inTenantContext((tx) => buildKeysetPage(
      tx,
      capability,
      query({ filters: { source: ['gitlab'] } }),
      { cursor: null, limit: TABLE_PAGE_SIZE },
      options,
    ))

    // gitlab has two senior rows and no junior row, so `junior` disappears from the variant facet
    // even though it is present in the table.
    expect(result.facets.matchedVariant).toEqual([{ value: 'senior', count: 2 }])
  })

  it('applies two active dimensions to each other but not to themselves', async () => {
    const result = await inTenantContext((tx) => buildKeysetPage(
      tx,
      capability,
      query({ filters: { source: ['github'], matchedVariant: ['junior'] } }),
      { cursor: null, limit: TABLE_PAGE_SIZE },
      options,
    ))

    expect(result.total).toBe(1)
    // `source` counted with the variant filter applied: github has 1 junior, gitlab has 0.
    expect(result.facets.source).toEqual([{ value: 'github', count: 1 }])
    // `matchedVariant` counted with the source filter applied: github's 3 senior and 1 junior.
    expect(result.facets.matchedVariant).toEqual([
      { value: 'senior', count: 3 },
      { value: 'junior', count: 1 },
    ])
  })

  it('does not compute a facet for a dimension that did not opt in', async () => {
    const noFacets = defineTableCapability({
      ...capability,
      filterable: { source: { column: sprintResults.source } },
    })
    const result = await inTenantContext((tx) =>
      buildKeysetPage(tx, noFacets, query(), { cursor: null, limit: TABLE_PAGE_SIZE }, options))

    expect(result.facets).toEqual({})
  })
})

describe('the page and its counts come from one transaction', () => {
  it('reports a total for the filtered set, not for the page', async () => {
    const result = await inTenantContext((tx) =>
      buildKeysetPage(tx, capability, query(), { cursor: null, limit: 2 }, options))

    expect(result.rows).toHaveLength(2)
    expect(result.total).toBe(6)
    expect(result.nextCursor).not.toBeNull()
  })

  it('walks every row exactly once across pages, with no offset', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard += 1) {
      const pageResult: Awaited<ReturnType<typeof buildKeysetPage<{ id: string; source: string }>>>
        = await inTenantContext((tx) =>
          buildKeysetPage(tx, capability, query(), { cursor, limit: 2 }, options))
      seen.push(...pageResult.rows.map((row) => row.id))
      cursor = pageResult.nextCursor
      if (!cursor) break
    }

    expect(seen).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'])
    expect(new Set(seen).size).toBe(seen.length)
  })
})
