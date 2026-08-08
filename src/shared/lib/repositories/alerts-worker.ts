import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
// auth_users is an auth-broker-only table (drizzle/0007_auth_broker.sql) —
// builderhunt_worker has no grant on it, so the digest-email lookup must go
// through authDb, not workerDb.
import { authDb } from '../db/auth-db'
import { alerts, alertTriggers, authUsers, builders, organizations } from '../db/schema'
import { nextAlertTimingState, type AlertEvaluationOutcome, type AlertFrequency } from '../alerts'
import { WORKER_ORGANIZATION_BATCH } from './worker-organization-scan'
import { SWEEP_BATCH, USER_SCOPED_LIMIT } from '../db/read-bounds'

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

export function listEnabledWorkerAlerts(transaction: WorkerTransaction, organizationId: string) {
  return transaction.select().from(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.enabled, true)))
    // Enabled radars for one organization — configured by hand, and seat-priced.
    .orderBy(asc(alerts.id))
    .limit(USER_SCOPED_LIMIT)
}

export async function findWorkerBuilder(
  transaction: WorkerTransaction,
  organizationId: string,
  builderId: string,
) {
  const [builder] = await transaction.select().from(builders)
    .where(and(eq(builders.organizationId, organizationId), eq(builders.id, builderId)))
    .limit(1)
  return builder ?? null
}

export async function listWorkerSeenSourceIds(
  transaction: WorkerTransaction,
  organizationId: string,
  alertId: string,
) {
  /*
   * The dedup memory for one radar, drained in batches.
   *
   * This is the set the evaluator checks candidates against, so a row missing from it is a match the
   * user is shown **again** — the one thing an alert must not do. So a ceiling is wrong here and the
   * loop is the answer, even though the set grows for the lifetime of the radar.
   */
  const seen = new Set<string>()
  let after: string | null = null
  for (;;) {
    const rows = await transaction.select({ id: alertTriggers.id, payload: alertTriggers.payload }).from(alertTriggers)
      .where(and(
        eq(alertTriggers.organizationId, organizationId),
        eq(alertTriggers.alertId, alertId),
        ...(after ? [gt(alertTriggers.id, after)] : []),
      ))
      .orderBy(asc(alertTriggers.id))
      .limit(SWEEP_BATCH)
    if (rows.length === 0) break
    for (const row of rows) {
      const sourceId = row.payload.sourceId
      if (typeof sourceId === 'string') seen.add(sourceId)
    }
    after = rows[rows.length - 1].id
    if (rows.length < SWEEP_BATCH) break
  }
  return seen
}

/**
 * Records the outcome of one evaluation attempt in a single UPDATE (plan:
 * calendar-scheduling-interview-intelligence, Phase 4 "Persist honest alert evaluation timing").
 *
 * One statement, not four: `lastCheckedAt` and `nextEvaluationAt` have to move together or the
 * calendar feed can read a next-run derived from the previous attempt's failure count. The timing
 * itself is computed by `nextAlertTimingState`, which is pure and tested separately.
 *
 * A failed attempt gets a short backoff rather than a full frequency window — advancing to the full
 * window would let one transient error silence a weekly alert for a week.
 */
export async function markWorkerAlertEvaluated(
  transaction: WorkerTransaction,
  organizationId: string,
  alert: { id: string; frequency: string | null; consecutiveFailures: number },
  outcome: AlertEvaluationOutcome,
  evaluatedAt: Date = new Date(),
) {
  const state = nextAlertTimingState(
    (alert.frequency ?? 'daily') as AlertFrequency,
    evaluatedAt,
    alert.consecutiveFailures,
    outcome,
  )
  const [row] = await transaction.update(alerts).set(state)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.id, alert.id)))
    .returning({
      id: alerts.id,
      lastCheckedAt: alerts.lastCheckedAt,
      nextEvaluationAt: alerts.nextEvaluationAt,
      consecutiveFailures: alerts.consecutiveFailures,
      lastEvaluationErrorCode: alerts.lastEvaluationErrorCode,
    })
  return row ?? null
}

export async function recordWorkerTrigger(
  transaction: WorkerTransaction,
  input: {
    id: string
    organizationId: string
    alertId: string
    userId: string
    builderId: string | null
    eventType: string
    payload: Record<string, unknown>
  },
) {
  await transaction.insert(alertTriggers).values(input)
  await transaction.update(alerts).set({ lastTriggeredAt: new Date() })
    .where(and(eq(alerts.organizationId, input.organizationId), eq(alerts.id, input.alertId)))
}

export async function findWorkerUserEmail(userId: string) {
  const [user] = await authDb.select({ email: authUsers.email }).from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1)
  return user?.email ?? null
}
