import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { alerts, alertTriggers } from '../db/schema'
import { alertTriggersCapability } from '../table/capabilities/alert-triggers'
import { alertsCapability } from '../table/capabilities/alerts'
import { buildKeysetPage } from '../table/keyset'
import type { PageRequest, PageResult, TableQuery } from '../table/types'
import type { TenantPrincipal } from '../authorization/permissions'
import { findVisibleSavedQueryById } from './saved-queries'
import { SharedResourceError } from '../shared-resources/contracts'
import { emitActivity } from './activity'
import { ANALYTICS_WINDOW_LIMIT, USER_SCOPED_LIMIT } from '../db/read-bounds'

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

/**
 * The radar-list row the alerts page renders.
 *
 * Narrower than the table, and every field here is one the page actually reads — including
 * `triggerConditions`, which the first version of this projection omitted. The page renders
 * `a.triggerConditions.eventType`, so the omission was an immediate `TypeError` on mount; a field it
 * read only sometimes would have been a much quieter bug, which is the argument for a projection
 * this explicit rather than `select()`.
 */
export interface OrganizationAlertPageRow extends Record<string, unknown> {
  id: string
  name: string
  keywords: string[]
  frequency: string | null
  deliveryChannel: string | null
  enabled: boolean
  triggerConditions: typeof alerts.$inferSelect['triggerConditions']
  lastTriggeredAt: string | null
  nextEvaluationAt: string | null
  lastEvaluationErrorCode: string | null
  createdAt: string | null
}

/** One keyset page of the organization's radars. */
export function pageOrganizationAlerts(
  transaction: TenantTransaction,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<OrganizationAlertPageRow>> {
  return buildKeysetPage<OrganizationAlertPageRow>(transaction, alertsCapability, query, page, {
    select: {
      id: alerts.id,
      name: alerts.name,
      keywords: alerts.keywords,
      frequency: alerts.frequency,
      deliveryChannel: alerts.deliveryChannel,
      enabled: alerts.enabled,
      triggerConditions: alerts.triggerConditions,
      lastTriggeredAt: alerts.lastTriggeredAt,
      nextEvaluationAt: alerts.nextEvaluationAt,
      lastEvaluationErrorCode: alerts.lastEvaluationErrorCode,
      createdAt: alerts.createdAt,
    },
    mapRow: (row) => ({
      id: row.id as string,
      name: row.name as string,
      keywords: (row.keywords as string[] | null) ?? [],
      frequency: (row.frequency as string | null) ?? null,
      deliveryChannel: (row.deliveryChannel as string | null) ?? null,
      // `enabled` is nullable in the schema with a `true` default; a null row predates the column
      // and behaves as enabled everywhere else, so it reads as enabled here too.
      enabled: (row.enabled as boolean | null) ?? true,
      triggerConditions: row.triggerConditions as OrganizationAlertPageRow['triggerConditions'],
      lastTriggeredAt: (row.lastTriggeredAt as Date | null)?.toISOString() ?? null,
      nextEvaluationAt: (row.nextEvaluationAt as Date | null)?.toISOString() ?? null,
      lastEvaluationErrorCode: (row.lastEvaluationErrorCode as string | null) ?? null,
      createdAt: (row.createdAt as Date | null)?.toISOString() ?? null,
    }),
  })
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
  if (row) {
    await emitActivity(transaction, principal, {
      type: 'alert_created',
      targetKey: row.id,
      metadata: {
        alertId: row.id,
        alertName: row.name,
        source: 'shared_query',
        queryId: sourceQuery.id,
      },
    })
  }
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

/**
 * One keyset page of the inbox, each row carrying the name of the radar that found it.
 *
 * The name is resolved for the page's rows rather than joined: a capability describes one table, and
 * `alerts.name` is on the other one. The page's group headers key off `alertId` — the dimension the
 * server counted — and the surface maps that id to this name for the label, so the number beside a
 * radar's name describes the whole group rather than the part that happens to be loaded.
 *
 * A trigger whose radar was deleted keeps a null name. It is deliberately still returned: the match
 * already happened and the recruiter may still want to act on it, which is the same reason
 * `groupByAlert` labelled those "Deleted radar".
 */
// unbounded-read-ok: the name lookup below carries no LIMIT because it does not need one — its
// `inArray` holds the distinct alert ids of this page, so it is bounded by TABLE_PAGE_SIZE.
export async function pageOrganizationTriggers(
  transaction: TenantTransaction,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<AlertTriggerRecord & { alertName: string | null }>> {
  const result = await buildKeysetPage<AlertTriggerRecord>(transaction, alertTriggersCapability, query, page, {
    select: {
      id: alertTriggers.id,
      alertId: alertTriggers.alertId,
      userId: alertTriggers.userId,
      builderId: alertTriggers.builderId,
      eventType: alertTriggers.eventType,
      payload: alertTriggers.payload,
      matchedAt: alertTriggers.matchedAt,
      readAt: alertTriggers.readAt,
    },
    mapRow: (row) => toTriggerRecord(row as unknown as typeof alertTriggers.$inferSelect),
  })

  if (result.rows.length === 0) return { ...result, rows: [] }

  const names = await transaction
    .select({ id: alerts.id, name: alerts.name })
    .from(alerts)
    .where(inArray(alerts.id, [...new Set(result.rows.map((row) => row.alertId))]))
  const byId = new Map(names.map((row) => [row.id, row.name]))

  return {
    ...result,
    rows: result.rows.map((row) => ({ ...row, alertName: byId.get(row.alertId) ?? null })),
  }
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
    // A member's own radars. Seat-priced and configured one at a time, so the ceiling is a backstop.
    .limit(USER_SCOPED_LIMIT)
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
