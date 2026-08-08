// Worker-only DB access for the ai-sourcing-sprints plan. Mirrors
// `alerts-worker.ts`'s split (worker repo vs. `src/lib/alerts/worker.ts`
// orchestration): the background worker has no caller session/principal, so
// it uses the dedicated worker DB role + explicit per-organization tenant
// context, one organization at a time — never a caller-scoped
// `withTenantContext`.
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { organizations, sourcingSprints, sprintResults } from '../db/schema'
import type { SprintCursor, SprintProfileSnapshot } from '../sprints-shared'
import { WORKER_ORGANIZATION_BATCH } from './worker-organization-scan'

/**
 * One batch of organization ids, ascending — bounded since plan 12.
 *
 * Callers must **drain** this, not take the first batch: a worker that silently skips the
 * five-hundred-and-first organization has not failed, it has just not done the work, and nobody is
 * waiting on that tenant to notice. `collectWorkerOrganizationIds`/`drainWorkerOrganizations` in
 * `worker-organization-scan.ts` are the shapes that cannot get the termination condition wrong.
 */
export function listWorkerOrganizationIds(after: string | null = null, limit: number = WORKER_ORGANIZATION_BATCH) {
  return workerDb.select({ id: organizations.id }).from(organizations)
    .where(after ? gt(organizations.id, after) : undefined)
    .orderBy(asc(organizations.id))
    .limit(limit)
}

export function withWorkerOrganization<TResult>(
  organizationId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
) {
  return workerDb.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'worker', true),
        set_config('app.request_id', ${crypto.randomUUID()}, true)
    `)
    return operation(transaction)
  })
}

/**
 * The single oldest-due active sprint in this organization (lastRunAt NULLs
 * first, i.e. never-run sprints go first). One cell of one sprint is
 * processed per organization per worker run — see worker.ts's module doc
 * for why this replaces the spec's global "3 oldest across all orgs" query.
 */
export async function findOldestDueActiveSprint(transaction: WorkerTransaction, organizationId: string) {
  const [row] = await transaction.select().from(sourcingSprints)
    .where(and(eq(sourcingSprints.organizationId, organizationId), eq(sourcingSprints.status, 'active')))
    .orderBy(sql`${sourcingSprints.lastRunAt} asc nulls first`)
    .limit(1)
  return row ?? null
}

export async function countWorkerSprintResults(transaction: WorkerTransaction, organizationId: string, sprintId: string) {
  const [row] = await transaction.select({ value: sql<number>`count(*)::int` }).from(sprintResults)
    .where(and(eq(sprintResults.organizationId, organizationId), eq(sprintResults.sprintId, sprintId)))
  return row?.value ?? 0
}

export interface InsertSprintResultInput {
  id: string
  organizationId: string
  sprintId: string
  source: string
  sourceId: string
  profile: SprintProfileSnapshot
  matchedVariant: string
  score: number
}

/** Inserts new result rows, ignoring duplicates via the unique
 * (sprintId, source, sourceId) constraint — safe to call with overlapping
 * federated-search pages across worker runs. */
export async function insertWorkerSprintResults(transaction: WorkerTransaction, rows: InsertSprintResultInput[]) {
  if (rows.length === 0) return
  await transaction.insert(sprintResults).values(rows).onConflictDoNothing()
}

export interface AdvanceSprintCursorInput {
  organizationId: string
  sprintId: string
  cursor: SprintCursor
  status: 'active' | 'completed'
}

export async function advanceWorkerSprintCursor(transaction: WorkerTransaction, input: AdvanceSprintCursorInput) {
  await transaction.update(sourcingSprints)
    .set({
      cursor: input.cursor,
      lastRunAt: new Date(),
      status: input.status,
      completedAt: input.status === 'completed' ? new Date() : null,
    })
    .where(and(eq(sourcingSprints.organizationId, input.organizationId), eq(sourcingSprints.id, input.sprintId)))
}
