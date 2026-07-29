import { and, asc, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { alerts, alertTriggers } from '../db/schema'
import type { TenantPrincipal } from '../authorization/permissions'
import { findVisibleSavedQueryById } from './saved-queries'
import { SharedResourceError } from '../shared-resources/contracts'

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
  /**
   * Optional back-reference to the saved query this alert was
   * created from. The composite FK on the table
   * (`alerts(organization_id, query_id) → saved_queries(organization_id, id)`)
   * is the tenant boundary: even if a caller spoofed a queryId from
   * a different organization, PostgreSQL would reject the insert.
   * Use `createOrganizationAlertFromQueryForPrincipal` (not this
   * function) when the alert is being created from a shared query,
   * so the visibility check is enforced before the FK even fires.
   */
  queryId?: string | null
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

/**
 * Create an alert that is tied to a saved query the principal can
 * actually see. The principal-scoped `findVisibleSavedQueryById` is
 * the tenant boundary — a caller who cannot read the query
 * (private-and-not-yours, or cross-tenant) gets `not_found` (404,
 * not 403) so probing ids cannot enumerate. Even if the visibility
 * check were bypassed, the composite FK on the table would still
 * reject any queryId that does not belong to the active
 * organization.
 *
 * Keywords are copied from the source query into the new alert —
 * the caller cannot inject arbitrary keywords. Sharing a query
 * does not create an alert and does not deliver anything; the
 * recipient must opt in explicitly via this function.
 */
export async function createOrganizationAlertFromQueryForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: {
    name: string
    queryId: string
    frequency?: string
    deliveryChannel?: string
    triggerConditions: typeof alerts.$inferInsert.triggerConditions
  },
) {
  const sourceQuery = await findVisibleSavedQueryById(transaction, principal, input.queryId)
  if (!sourceQuery) {
    throw new SharedResourceError('not_found', 'Saved query not accessible', 404)
  }
  const [row] = await transaction.insert(alerts).values({
    id: crypto.randomUUID(),
    organizationId: principal.organizationId,
    userId: principal.userId,
    queryId: sourceQuery.id,
    name: input.name.trim(),
    keywords: sourceQuery.keywords,
    frequency: input.frequency ?? 'daily',
    deliveryChannel: input.deliveryChannel ?? 'email',
    triggerConditions: input.triggerConditions,
    enabled: true,
  }).returning()
  return row ?? null
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

// ── Calendar feed projections (plan: calendar-scheduling-interview-intelligence, Phase 4) ─────

/**
 * The caller's OWN alerts whose next evaluation falls inside the range.
 *
 * Scoped to `userId`, not just the organization. An alert is a personal watch list, and the calendar
 * is a private surface — showing a colleague's alert schedule would leak what they are tracking,
 * which is the same reasoning that gives calendar events no admin read path.
 */
export function listOwnAlertProjections(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  range: { from: Date; to: Date },
) {
  return transaction
    .select({
      id: alerts.id,
      name: alerts.name,
      frequency: alerts.frequency,
      nextEvaluationAt: alerts.nextEvaluationAt,
      consecutiveFailures: alerts.consecutiveFailures,
      lastEvaluationErrorCode: alerts.lastEvaluationErrorCode,
    })
    .from(alerts)
    .where(and(
      eq(alerts.organizationId, organizationId),
      eq(alerts.userId, userId),
      eq(alerts.enabled, true),
      isNotNull(alerts.nextEvaluationAt),
      gte(alerts.nextEvaluationAt, range.from),
      lt(alerts.nextEvaluationAt, range.to),
    ))
    .orderBy(asc(alerts.nextEvaluationAt))
}

/**
 * The caller's own alert matches inside the range, pre-aggregated per alert per local day.
 *
 * Aggregated in SQL rather than in JS because the feed needs one `alert_result` item per
 * alert-per-day, and a busy alert can produce hundreds of triggers in a range — shipping them all to
 * the app to be counted there would make the feed's cost scale with match volume instead of with the
 * number of items it actually renders.
 */
export function listOwnAlertResultBuckets(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  range: { from: Date; to: Date },
) {
  return transaction
    .select({
      alertId: alertTriggers.alertId,
      alertName: alerts.name,
      bucketStart: sql<string>`date_trunc('day', ${alertTriggers.matchedAt})`.as('bucket_start'),
      matchCount: sql<number>`count(*)::int`.as('match_count'),
    })
    .from(alertTriggers)
    .innerJoin(alerts, and(
      eq(alerts.organizationId, alertTriggers.organizationId),
      eq(alerts.id, alertTriggers.alertId),
    ))
    .where(and(
      eq(alertTriggers.organizationId, organizationId),
      eq(alertTriggers.userId, userId),
      gte(alertTriggers.matchedAt, range.from),
      lt(alertTriggers.matchedAt, range.to),
    ))
    .groupBy(alertTriggers.alertId, alerts.name, sql`date_trunc('day', ${alertTriggers.matchedAt})`)
    .orderBy(sql`bucket_start asc`)
}
