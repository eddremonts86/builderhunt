// Worker-only DB access for the ai-sourcing-sprints plan. Mirrors
// `alerts-worker.ts`'s split (worker repo vs. `src/lib/alerts/worker.ts`
// orchestration): the background worker has no caller session/principal, so
// it uses the dedicated worker DB role + explicit per-organization tenant
// context, one organization at a time — never a caller-scoped
// `withTenantContext`.
import { and, eq, sql } from 'drizzle-orm'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { organizations, sourcingSprints, sprintResults } from '../db/schema'
import type { SprintCursor, SprintProfileSnapshot } from '../sprints-shared'

export function listWorkerOrganizationIds() {
  return workerDb.select({ id: organizations.id }).from(organizations)
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
