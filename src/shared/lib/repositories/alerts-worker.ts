import { and, eq, sql } from 'drizzle-orm'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
// auth_users is an auth-broker-only table (drizzle/0007_auth_broker.sql) —
// builderhunt_worker has no grant on it, so the digest-email lookup must go
// through authDb, not workerDb.
import { authDb } from '../db/auth-db'
import { alerts, alertTriggers, authUsers, builders, organizations } from '../db/schema'
import { nextAlertTimingState, type AlertEvaluationOutcome, type AlertFrequency } from '../alerts'

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

export function listEnabledWorkerAlerts(transaction: WorkerTransaction, organizationId: string) {
  return transaction.select().from(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.enabled, true)))
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
  const rows = await transaction.select({ payload: alertTriggers.payload }).from(alertTriggers)
    .where(and(eq(alertTriggers.organizationId, organizationId), eq(alertTriggers.alertId, alertId)))
  return new Set(rows
    .map((row) => row.payload.sourceId)
    .filter((value): value is string => typeof value === 'string'))
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
