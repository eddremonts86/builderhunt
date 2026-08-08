// Owner-scoped (organization-scoped) sprint service — the only place that
// queries `sourcing_sprints`/`sprint_results` directly. Every function takes
// an explicit `organizationId` and scopes every query by it (defense in
// depth alongside the composite FK), matching the `organization-alerts.ts`
// convention. No cross-organization access is possible through this module.
import { and, count, desc, eq, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { randomId } from '~/lib/utils'
import type { SprintResultRow } from '~/lib/sprints/results'
import { sourcingSprints, sprintResults } from '~/shared/lib/db/schema'
import { sprintResultsCapability } from '~/shared/lib/table/capabilities/sprint-results'
import { sprintsCapability } from '~/shared/lib/table/capabilities/sprints'
import { buildKeysetPage } from '~/shared/lib/table/keyset'
import type { PageRequest, PageResult, TableQuery } from '~/shared/lib/table/types'
import { DASHBOARD_ROW_LIMITS } from '~/shared/lib/dashboard/contracts'
import {
  DEFAULT_SPRINT_QUOTA,
  type CreateSprintInput,
  type ExtractedCriteria,
  type QueryVariant,
  type SprintCursor,
  type SprintStatus,
} from '~/shared/lib/sprints-shared'

export class SprintNotFoundError extends Error {
  constructor() {
    super('Sprint not found')
    this.name = 'SprintNotFoundError'
  }
}

export class SprintConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SprintConflictError'
  }
}

export interface SprintRecord {
  id: string
  organizationId: string
  creatorUserId: string
  name: string
  criteria: ExtractedCriteria
  variants: QueryVariant[]
  status: SprintStatus
  quota: number
  cursor: SprintCursor
  lastRunAt: Date | null
  createdAt: Date
  completedAt: Date | null
}

export interface SprintListItem extends SprintRecord {
  resultCount: number
}

function toRecord(row: typeof sourcingSprints.$inferSelect): SprintRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    creatorUserId: row.creatorUserId,
    name: row.name,
    criteria: row.criteria,
    variants: row.variants,
    status: row.status as SprintStatus,
    quota: row.quota,
    cursor: row.cursor,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  }
}

/**
 * One keyset page of the sprint list, each row carrying its result count.
 *
 * The count is a second query over the page's ids rather than the `leftJoin` + `groupBy` the
 * unbounded version used. That join produced one row per *result* before collapsing — for an
 * organization with a few thousand candidates across its sprints, the grouped scan was the
 * expensive part of a query that returned a handful of rows.
 */
// unbounded-read-ok: the count query below carries no LIMIT because it does not need one — its
// `inArray` is exactly this page's sprint ids, so its output is bounded by TABLE_PAGE_SIZE.
export async function pageSprints(
  transaction: TenantTransaction,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<SprintListItem>> {
  const result = await buildKeysetPage<SprintRecord>(transaction, sprintsCapability, query, page, {
    select: {
      id: sourcingSprints.id,
      organizationId: sourcingSprints.organizationId,
      creatorUserId: sourcingSprints.creatorUserId,
      name: sourcingSprints.name,
      criteria: sourcingSprints.criteria,
      variants: sourcingSprints.variants,
      status: sourcingSprints.status,
      quota: sourcingSprints.quota,
      cursor: sourcingSprints.cursor,
      lastRunAt: sourcingSprints.lastRunAt,
      createdAt: sourcingSprints.createdAt,
      completedAt: sourcingSprints.completedAt,
    },
    mapRow: (row) => toRecord(row as unknown as typeof sourcingSprints.$inferSelect),
  })

  if (result.rows.length === 0) return { ...result, rows: [] }

  const counts = await transaction
    .select({ sprintId: sprintResults.sprintId, value: count() })
    .from(sprintResults)
    .where(inArray(sprintResults.sprintId, result.rows.map((row) => row.id)))
    .groupBy(sprintResults.sprintId)
  const bySprint = new Map(counts.map((row) => [row.sprintId, row.value]))

  return {
    ...result,
    rows: result.rows.map((row) => ({ ...row, resultCount: bySprint.get(row.id) ?? 0 })),
  }
}

/**
 * The sprints the dashboard's action queue can actually raise a nudge about.
 *
 * `listSprints` was here, unbounded, and plan 10 kept it for exactly this caller: the queue's rules
 * filter by status, so a naive `.limit()` would have dropped the nudge for a stalled sprint sitting
 * past it. Plan 12's answer is not a bigger limit — it is to move both rules' predicates into SQL, so
 * what comes back is only rows that *will* produce an item.
 *
 * Two shapes, one union, matching `action-rules.ts` one to one:
 *   - `completed` with at least one result — "a finished sprint has results to review"
 *   - `paused`, or `active` and last run before `stalledBefore` — "this sprint is stalled"
 *
 * The `having` clause is what makes the first honest: `resultCount > 0` was a JavaScript filter over
 * every sprint the organization ever ran, and it is the reason this read had to be unbounded.
 */
export async function listActionQueueSprints(
  transaction: TenantTransaction,
  organizationId: string,
  stalledBefore: Date,
  limit: number = DASHBOARD_ROW_LIMITS.actionQueue,
): Promise<SprintListItem[]> {
  const rows = await transaction
    .select({ sprint: sourcingSprints, resultCount: sql<number>`count(${sprintResults.id})::int` })
    .from(sourcingSprints)
    .leftJoin(sprintResults, eq(sprintResults.sprintId, sourcingSprints.id))
    .where(and(
      eq(sourcingSprints.organizationId, organizationId),
      or(
        eq(sourcingSprints.status, 'completed'),
        eq(sourcingSprints.status, 'paused'),
        and(eq(sourcingSprints.status, 'active'), lt(sourcingSprints.lastRunAt, stalledBefore)),
      ),
    ))
    .groupBy(sourcingSprints.id)
    // A completed sprint with no results raises nothing, so it is not worth returning. The other two
    // states qualify on status alone, which is why this is `or` and not a flat `> 0`.
    .having(or(
      ne(sourcingSprints.status, 'completed'),
      sql`count(${sprintResults.id}) > 0`,
    ))
    .orderBy(desc(sourcingSprints.createdAt))
    // The queue renders at most `actionQueue` items in total, across every rule.
    .limit(limit)
  return rows.map((row) => ({ ...toRecord(row.sprint), resultCount: row.resultCount }))
}

export async function findSprint(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
): Promise<SprintRecord | null> {
  const [row] = await transaction.select().from(sourcingSprints)
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.id, id)))
    .limit(1)
  return row ? toRecord(row) : null
}

export async function countActiveSprints(transaction: TenantTransaction, organizationId: string): Promise<number> {
  const [row] = await transaction.select({ value: count() }).from(sourcingSprints)
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.status, 'active')))
  return row?.value ?? 0
}

export async function createSprint(
  transaction: TenantTransaction,
  organizationId: string,
  creatorUserId: string,
  input: CreateSprintInput,
): Promise<SprintRecord> {
  const [row] = await transaction.insert(sourcingSprints).values({
    id: randomId(),
    organizationId,
    creatorUserId,
    name: input.name,
    criteria: input.criteria,
    variants: input.variants,
    status: 'active',
    quota: input.quota ?? DEFAULT_SPRINT_QUOTA,
    cursor: { variantIndex: 0, page: 1 },
  }).returning()
  return toRecord(row)
}

export async function renameSprint(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  name: string,
): Promise<SprintRecord> {
  const [row] = await transaction.update(sourcingSprints).set({ name })
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.id, id)))
    .returning()
  if (!row) throw new SprintNotFoundError()
  return toRecord(row)
}

export async function updateSprintQuota(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  quota: number,
): Promise<SprintRecord> {
  const [row] = await transaction.update(sourcingSprints).set({ quota })
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.id, id)))
    .returning()
  if (!row) throw new SprintNotFoundError()
  return toRecord(row)
}

/**
 * Pause/resume lifecycle transition. `resume` re-checks the active-sprint
 * plan limit (a paused sprint may no longer fit after other sprints were
 * created, or after a plan downgrade) — never silently exceeds it.
 */
export async function setSprintLifecycle(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  action: 'pause' | 'resume',
  activeLimit: number,
): Promise<SprintRecord> {
  const sprint = await findSprint(transaction, organizationId, id)
  if (!sprint) throw new SprintNotFoundError()

  if (action === 'pause') {
    if (sprint.status !== 'active') {
      throw new SprintConflictError(`Cannot pause a sprint with status "${sprint.status}"`)
    }
  } else {
    if (sprint.status !== 'paused') {
      throw new SprintConflictError(`Cannot resume a sprint with status "${sprint.status}"`)
    }
    const activeCount = await countActiveSprints(transaction, organizationId)
    if (activeCount >= activeLimit) {
      throw new SprintConflictError('Resuming this sprint would exceed the active-sprint plan limit')
    }
  }

  const [row] = await transaction.update(sourcingSprints)
    .set({ status: action === 'pause' ? 'paused' : 'active' })
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.id, id)))
    .returning()
  if (!row) throw new SprintNotFoundError()
  return toRecord(row)
}

export async function deleteSprint(transaction: TenantTransaction, organizationId: string, id: string): Promise<boolean> {
  const rows = await transaction.delete(sourcingSprints)
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.id, id)))
    .returning({ id: sourcingSprints.id })
  return rows.length > 0
}

export interface SprintResultRecord {
  id: string
  sprintId: string
  source: string
  sourceId: string
  profile: Record<string, unknown>
  matchedVariant: string
  score: number
  createdAt: Date
}

export async function countSprintResults(transaction: TenantTransaction, organizationId: string, sprintId: string): Promise<number> {
  const [row] = await transaction.select({ value: count() }).from(sprintResults)
    .where(and(eq(sprintResults.organizationId, organizationId), eq(sprintResults.sprintId, sprintId)))
  return row?.value ?? 0
}

export interface SprintResultPageOptions {
  sprintId: string
  query: TableQuery
  page: PageRequest
  /**
   * Minimum follower count, from the surface's own control.
   *
   * Not part of `TableQuery`, which models set-membership filters. It is parsed and validated by
   * the route, and reaches SQL as a bound parameter inside a `scope` predicate — see
   * `KeysetPageOptions.scope`.
   */
  minFollowers?: number
}

/**
 * One page of a sprint's results, ordered, filtered and counted by Postgres.
 *
 * Replaces `listSprintResults`, which read every row for a sprint and left the route to filter,
 * sort and slice them in memory behind a base64 *offset* it called a cursor. That worked because
 * sprints are small today; it is O(all results) per request, and the slice moved under concurrent
 * inserts, so a row could appear on two pages or on none.
 */
export async function pageSprintResults(
  transaction: TenantTransaction,
  options: SprintResultPageOptions,
): Promise<PageResult<SprintResultRow>> {
  const scope: SQL[] = [eq(sprintResults.sprintId, options.sprintId)]
  if (options.minFollowers !== undefined) {
    // `followersCount` lives in the profile document. Cast before comparing, or Postgres compares
    // text and "9" sorts above "10".
    scope.push(sql`coalesce((${sprintResults.profile}->>'followersCount')::int, 0) >= ${options.minFollowers}`)
  }

  return buildKeysetPage<SprintResultRow>(transaction, sprintResultsCapability, options.query, options.page, {
    scope,
    select: {
      id: sprintResults.id,
      source: sprintResults.source,
      sourceId: sprintResults.sourceId,
      profile: sprintResults.profile,
      matchedVariant: sprintResults.matchedVariant,
      score: sprintResults.score,
      createdAt: sprintResults.createdAt,
    },
    // The explicit field allowlist the output-minimisation rule asks for: named here, never a raw
    // ORM row handed to `Response.json`.
    mapRow: (row) => ({
      id: row.id as string,
      source: row.source as string,
      sourceId: row.sourceId as string,
      profile: row.profile as SprintResultRow['profile'],
      matchedVariant: row.matchedVariant as string,
      score: row.score as number,
      createdAt: (row.createdAt as Date).toISOString(),
    }),
  })
}
