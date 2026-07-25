import { and, eq, sql } from 'drizzle-orm'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
// auth_users is an auth-broker-only table (drizzle/0007_auth_broker.sql) —
// builderhunt_worker has no grant on it, so the digest-email lookup must go
// through authDb, not workerDb.
import { authDb } from '../db/auth-db'
import { alerts, alertTriggers, authUsers, builders, organizations } from '../db/schema'

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

export async function markWorkerAlertChecked(
  transaction: WorkerTransaction,
  organizationId: string,
  alertId: string,
) {
  await transaction.update(alerts).set({ lastCheckedAt: new Date() })
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.id, alertId)))
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
