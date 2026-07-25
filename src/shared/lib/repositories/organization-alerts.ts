import { and, desc, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { alerts, alertTriggers } from '../db/schema'

export interface AlertTriggerRecord {
  id: string
  alertId: string
  userId: string
  builderId: string | null
  eventType: string
  payload: Record<string, unknown>
  matchedAt: string
  readAt: string | null
}

export interface CreateOrganizationAlertInput {
  id: string
  organizationId: string
  userId: string
  name: string
  keywords: string[]
  frequency?: string
  deliveryChannel?: string
  triggerConditions: typeof alerts.$inferInsert.triggerConditions
}

export function listOrganizationAlerts(transaction: TenantTransaction, organizationId: string) {
  return transaction.select().from(alerts)
    .where(eq(alerts.organizationId, organizationId))
    .orderBy(desc(alerts.createdAt))
}

export async function createOrganizationAlert(
  transaction: TenantTransaction,
  input: CreateOrganizationAlertInput,
) {
  const [row] = await transaction.insert(alerts).values({
    ...input,
    enabled: true,
  }).returning()
  return row
}

export async function findOrganizationAlert(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const [row] = await transaction.select().from(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.id, id)))
    .limit(1)
  return row ?? null
}

export interface UpdateOrganizationAlertInput {
  enabled?: boolean
  name?: string
  frequency?: string
  deliveryChannel?: string
  triggerConditions?: typeof alerts.$inferInsert.triggerConditions
}

export async function updateOrganizationAlert(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  input: UpdateOrganizationAlertInput,
) {
  const [row] = await transaction.update(alerts)
    .set(input)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.id, id)))
    .returning()
  return row ?? null
}

export async function deleteOrganizationAlert(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const rows = await transaction.delete(alerts)
    .where(and(eq(alerts.organizationId, organizationId), eq(alerts.id, id)))
    .returning({ id: alerts.id })
  return rows.length > 0
}

export async function recordOrganizationTrigger(
  transaction: TenantTransaction,
  input: {
    id: string
    organizationId: string
    alertId: string
    userId: string
    builderId: string | null
    eventType: string
    payload: Record<string, unknown>
  },
): Promise<AlertTriggerRecord | null> {
  const alert = await findOrganizationAlert(transaction, input.organizationId, input.alertId)
  if (!alert) return null
  const [row] = await transaction.insert(alertTriggers).values(input).returning()
  await transaction.update(alerts)
    .set({ lastTriggeredAt: new Date() })
    .where(and(eq(alerts.organizationId, input.organizationId), eq(alerts.id, input.alertId)))
  return toTriggerRecord(row)
}

export async function listOrganizationTriggers(
  transaction: TenantTransaction,
  organizationId: string,
  limit = 50,
) {
  const rows = await transaction.select().from(alertTriggers)
    .where(eq(alertTriggers.organizationId, organizationId))
    .orderBy(desc(alertTriggers.matchedAt))
    .limit(limit)
  return rows.map(toTriggerRecord)
}

export async function markOrganizationTriggerRead(
  transaction: TenantTransaction,
  organizationId: string,
  triggerId: string,
) {
  const [updated] = await transaction.update(alertTriggers)
    .set({ readAt: new Date() })
    .where(and(eq(alertTriggers.organizationId, organizationId), eq(alertTriggers.id, triggerId)))
    .returning({ id: alertTriggers.id })
  return Boolean(updated)
}

export async function unreadOrganizationTriggerCount(
  transaction: TenantTransaction,
  organizationId: string,
) {
  const [row] = await transaction.select({ value: sql<number>`count(*)::int` })
    .from(alertTriggers)
    .where(and(
      eq(alertTriggers.organizationId, organizationId),
      sql`${alertTriggers.readAt} is null`,
    ))
  return Number(row?.value ?? 0)
}

function toTriggerRecord(row: typeof alertTriggers.$inferSelect): AlertTriggerRecord {
  return {
    id: row.id,
    alertId: row.alertId,
    userId: row.userId,
    builderId: row.builderId,
    eventType: row.eventType,
    payload: row.payload,
    matchedAt: row.matchedAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  }
}
