// Owner-scoped (organization-scoped) sprint service — the only place that
// queries `sourcing_sprints`/`sprint_results` directly. Every function takes
// an explicit `organizationId` and scopes every query by it (defense in
// depth alongside the composite FK), matching the `organization-alerts.ts`
// convention. No cross-organization access is possible through this module.
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import { randomId } from '~/lib/utils'
import type { SprintResultRow } from '~/lib/sprints/results'
import { sourcingSprints, sprintResults } from '~/shared/lib/db/schema'
import { sprintResultsCapability } from '~/shared/lib/table/capabilities/sprint-results'
import { buildKeysetPage } from '~/shared/lib/table/keyset'
import type { PageRequest, PageResult, TableQuery } from '~/shared/lib/table/types'
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

export async function listSprints(transaction: TenantTransaction, organizationId: string): Promise<SprintListItem[]> {
  const rows = await transaction
    .select({ sprint: sourcingSprints, resultCount: sql<number>`count(${sprintResults.id})::int` })
    .from(sourcingSprints)
    .leftJoin(sprintResults, eq(sprintResults.sprintId, sourcingSprints.id))
    .where(eq(sourcingSprints.organizationId, organizationId))
    .groupBy(sourcingSprints.id)
    .orderBy(desc(sourcingSprints.createdAt))
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
