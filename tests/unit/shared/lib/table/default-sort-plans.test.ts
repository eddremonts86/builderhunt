/**
 * Every capability's default sort is served by an index, proven by `EXPLAIN`.
 *
 * plans/phase-3/13-pagination-ci-gates asks for this and says exactly why it is a separate check
 * from plan 04's: *"Plan 04's unit test proves an index was declared; only this proves the planner
 * uses it — a `NULLS LAST` mismatch satisfies the first and fails this."*
 *
 * It closes both blind spots plan 04 recorded against itself:
 *
 * 1. **`nullsLast` and direction.** `resolveSort` applies a `nullsLast` declaration to *both*
 *    directions, and `ORDER BY x DESC NULLS LAST` is the one combination a `(org, x, id)` b-tree
 *    produces from neither scan direction — forward gives `ASC NULLS LAST`, backward gives
 *    `DESC NULLS FIRST`. Plan 04's guard checks that the index *declares* `NULLS LAST`, not that the
 *    declaration is reachable, so it would report such a sort as covered while Postgres sorted the
 *    whole table. Here it is a `Sort` node, and a failure.
 * 2. **Grouped orderings.** Plan 04's guard inspects each sortable column in isolation, but
 *    `resolveSort` leads the `ORDER BY` with the group column — so the alerts inbox really orders by
 *    `(alert_id, matched_at, id)`, a composite the guard never asks about. Every `groupable` id is
 *    explained here too.
 *
 * ## Why a unit test and not `data-tables.spec.ts`
 *
 * The plan names the e2e file. Two things make this the better home, and both are about coverage
 * rather than convenience. It sweeps **`TABLE_CAPABILITIES`**, so a capability whose surface no e2e
 * spec happens to visit is still checked — that is the same argument the barrel exists for. And it
 * runs in `pnpm test`, so the check gates every run rather than only the e2e job.
 *
 * `enable_seqscan = off` is what makes the assertion about the *index* rather than about the cost
 * model: on a table with a handful of rows a sequential scan is genuinely cheaper, and the question
 * here is whether the index can serve the ordering at all. Same reasoning, same setting, as the HNSW
 * regression test in `public-builder-embeddings.test.ts`.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { capabilityTable, TABLE_CAPABILITIES, type TableCapability } from '~/shared/lib/table/capability'
import { planKeysetPage } from '~/shared/lib/table/keyset'
import type { CursorValue } from '~/shared/lib/table/cursor'
import type { TableQuery } from '~/shared/lib/table/types'

// The barrel, for the same reason `capability-index.test.ts` imports it: a sweep over an
// unpopulated registry is a green guard over nothing.
import '~/shared/lib/table/capabilities'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('sortplans')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => {
  await drop()
})

/** A tenant id that exists in no row — the plan shape does not depend on matching anything. */
const ORGANIZATION_ID = 'org-explain-probe'

function emptyQuery(overrides: Partial<TableQuery> = {}): TableQuery {
  return { search: '', filters: {}, sort: [], groupBy: null, ...overrides }
}

/**
 * The scope and required filters the capability itself declares — no hand-written map.
 *
 * The first version of this test carried a `REQUIRED_SCOPE` ledger, because a capability described its
 * columns but not the *scope* its surface always applies: `sprint_results` is only ever read for one
 * sprint, and the refund and dispute queues only for one organization, which is why those indexes lead
 * with a column the capability never mentioned. Explaining without those predicates explained a query
 * the product never issues — nineteen failures that were all the test's own.
 *
 * The ledger is gone. `TableCapability.scopeColumns` and `FilterableColumn.required` say it now, so
 * this reads the requirement off the descriptor and only has to invent a *value*. A capability that
 * acquires a scope is covered the day it declares one, with nothing to remember here.
 */
function scopeFor(capability: TableCapability): {
  filters: Record<string, string[]>
  scopeValues: Record<string, CursorValue>
} {
  const filters: Record<string, string[]> = {}
  for (const [id, entry] of Object.entries(capability.filterable)) {
    if (entry.required) filters[id] = [`${id}-explain-probe`]
  }
  const scopeValues: Record<string, CursorValue> = {}
  for (const column of capability.scopeColumns ?? []) {
    scopeValues[column.name] = `${column.name}-explain-probe`
  }
  return { filters, scopeValues }
}

/**
 * `EXPLAIN` the page query a capability's plan produces, with sequential scans disabled.
 *
 * Built from `planKeysetPage` rather than from a hand-written query, so what is explained is the SQL
 * the product actually emits — an assertion against a reconstruction would pass while the real path
 * regressed.
 */
async function explainPage(capability: TableCapability, query: TableQuery): Promise<string> {
  const required = scopeFor(capability)
  const scoped: TableQuery = { ...query, filters: { ...required.filters, ...query.filters } }
  const table = capabilityTable(capability)
  const plan = planKeysetPage(capability, scoped, { cursor: null, limit: 50 }, {
    organizationId: ORGANIZATION_ID,
    scopeValues: required.scopeValues,
  })

  return db.transaction(async (tx) => {
    /*
     * Three settings, and each one is load-bearing.
     *
     * `enable_seqscan = off` is the obvious one: on a table with a handful of rows a sequential scan
     * is genuinely cheaper, and the question here is whether the index *can* serve the ordering.
     *
     * `enable_bitmapscan = off` was learned from a failure. Without it the planner answered
     * `alert_triggers` with a bitmap index scan plus a sort — cheaper on an empty table, and it made
     * the assertion a statement about the cost model rather than about the index. A bitmap scan
     * returns rows in heap order by construction, so it can never supply an ordering.
     *
     * `enable_sort = off` turns the remaining question into the right one. With sorting discouraged,
     * a plan that *still* contains a `Sort` node is one where no index could have supplied the order
     * — which is exactly the failure this test is for, and is what a `NULLS LAST` mismatch produces.
     */
    await tx.execute(sql`set local enable_seqscan = off`)
    await tx.execute(sql`set local enable_bitmapscan = off`)
    await tx.execute(sql`set local enable_sort = off`)
    const query$ = tx
      .select({ probe: sql`1` })
      .from(table)
      .where(plan.rowConditions.length > 0 ? sql.join(plan.rowConditions, sql` and `) : sql`true`)
      .orderBy(...plan.order)
      .limit(plan.limit)
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${query$.getSQL()}`)
    return [...rows].map((row) => row['QUERY PLAN']).join('\n')
  })
}

/** A plain `Sort` node — the ordering computed after retrieval, which is the regression. */
function hasSortNode(plan: string): boolean {
  // Matches the node line (a name followed by its cost), never `Sort Key:`, which `Incremental Sort`
  // emits too. `public-builder-embeddings.test.ts` learned that distinction the hard way.
  return plan.split('\n').some((line) => /^\s*(->\s+)?Sort\s+\(cost=/.test(line))
}

const sqlCapabilities = Object.values(TABLE_CAPABILITIES).filter((capability) => !capability.nonSql)

describe('every capability default sort is index-served', () => {
  it('has capabilities to check', () => {
    expect(sqlCapabilities.length).toBeGreaterThan(0)
  })

  it.each(sqlCapabilities.map((capability) => [capability.table, capability] as const))(
    '%s: the default sort needs no Sort node',
    async (_table, capability) => {
      const plan = await explainPage(capability, emptyQuery())
      expect(hasSortNode(plan), `default sort fell back to a Sort:\n${plan}`).toBe(false)
    },
  )

  /**
   * Both directions, for every sortable column — not only the default.
   *
   * A URL can ask for either, and the `nullsLast`-plus-`DESC` hole is invisible until someone does.
   */
  it.each(sqlCapabilities.flatMap((capability) =>
    Object.keys(capability.sortable).flatMap((id) =>
      (['asc', 'desc'] as const).map((dir) => [`${capability.table}.${id}:${dir}`, capability, id, dir] as const),
    ),
  ))('%s needs no Sort node', async (_label, capability, id, dir) => {
    const plan = await explainPage(capability, emptyQuery({ sort: [{ id, dir }] }))
    expect(hasSortNode(plan), `sort ${id}:${dir} fell back to a Sort:\n${plan}`).toBe(false)
  })

  /**
   * Grouped orderings, which plan 04's guard cannot see.
   *
   * `resolveSort` puts the group column first, so this explains the composite the query really uses.
   */
  it.each(sqlCapabilities.flatMap((capability) =>
    capability.groupable.map((id) => [`${capability.table} grouped by ${id}`, capability, id] as const),
  ))('%s needs no Sort node', async (_label, capability, groupBy) => {
    const plan = await explainPage(capability, emptyQuery({ groupBy }))
    expect(hasSortNode(plan), `grouping by ${groupBy} fell back to a Sort:\n${plan}`).toBe(false)
  })
})
