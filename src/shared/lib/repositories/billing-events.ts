import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/client'
import { billingWebhookEvents } from '../db/schema'

/**
 * Platform-admin webhook/dead-letter discovery (plans/UI/tasks.md Wave 5 "Add billing webhook and
 * dead-letter discovery") — lets an operator find a failed event before invoking the existing
 * `POST /api/admin/billing/events/$eventId/replay` action, without ever exposing the row's
 * `payloadEncrypted` column or an unredacted error message. `lastError` is `message.slice(0, 500)`
 * of whatever the Stripe SDK or our own handler threw (`redactError` in `billing/worker.ts`) — that
 * is NOT a secret-safe string by construction, so this module never returns it as-is; only a
 * further-truncated, pattern-scrubbed preview.
 */

export const BILLING_WEBHOOK_EVENT_STATUSES = ['pending', 'processing', 'processed', 'failed', 'ignored'] as const
export type BillingWebhookEventStatus = (typeof BILLING_WEBHOOK_EVENT_STATUSES)[number]

const MAX_PAGE_SIZE = 50

export interface BillingWebhookEventListFilters {
  status?: BillingWebhookEventStatus
  eventType?: string
  receivedFrom?: Date
  receivedTo?: Date
}

export interface BillingWebhookEventCursor {
  receivedAt: Date
  id: string
}

export interface BillingWebhookEventRow {
  id: string
  stripeEventId: string
  eventType: string
  objectType: string
  status: string
  attempts: number
  receivedAt: Date
  processedAt: Date | null
  nextAttemptAt: Date | null
  hasError: boolean
}

type Db = PostgresJsDatabase | typeof platformDb

function toRow(record: typeof billingWebhookEvents.$inferSelect): BillingWebhookEventRow {
  return {
    id: record.id,
    stripeEventId: record.stripeEventId,
    eventType: record.eventType,
    objectType: record.objectType,
    status: record.status,
    attempts: record.attempts,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt,
    nextAttemptAt: record.nextAttemptAt,
    hasError: record.lastError !== null,
  }
}

export interface ListBillingWebhookEventsResult {
  rows: BillingWebhookEventRow[]
  nextCursor: BillingWebhookEventCursor | null
}

/**
 * Bounded, filtered, cursor-paginated list. `limit` is clamped to `MAX_PAGE_SIZE` regardless of
 * what the caller asks for — an operator triaging dead letters needs a page at a time, not every
 * event this deployment has ever received in one response.
 */
export async function listBillingWebhookEvents(
  filters: BillingWebhookEventListFilters,
  options: { cursor?: BillingWebhookEventCursor; limit?: number } = {},
  db: Db = platformDb,
): Promise<ListBillingWebhookEventsResult> {
  const limit = Math.max(1, Math.min(options.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE))

  const conditions = []
  if (filters.status) conditions.push(eq(billingWebhookEvents.status, filters.status))
  if (filters.eventType) conditions.push(eq(billingWebhookEvents.eventType, filters.eventType))
  if (filters.receivedFrom) conditions.push(gte(billingWebhookEvents.receivedAt, filters.receivedFrom))
  if (filters.receivedTo) conditions.push(lte(billingWebhookEvents.receivedAt, filters.receivedTo))
  if (options.cursor) {
    // Keyset pagination on (received_at desc, id desc) — Drizzle has no tuple comparator, so this is
    // built by hand: strictly older, or the same instant with a strictly smaller id.
    conditions.push(or(
      lt(billingWebhookEvents.receivedAt, options.cursor.receivedAt),
      and(eq(billingWebhookEvents.receivedAt, options.cursor.receivedAt), lt(billingWebhookEvents.id, options.cursor.id)),
    ))
  }

  const records = await db
    .select()
    .from(billingWebhookEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(billingWebhookEvents.receivedAt), desc(billingWebhookEvents.id))
    .limit(limit + 1)

  const hasMore = records.length > limit
  const page = hasMore ? records.slice(0, limit) : records
  const last = page[page.length - 1]
  return {
    rows: page.map(toRow),
    nextCursor: hasMore && last ? { receivedAt: last.receivedAt, id: last.id } : null,
  }
}

/** Scrubs known secret shapes defensively, then truncates hard — never the raw stored message. */
function redactErrorPreview(message: string): string {
  return message
    .replace(/sk_(live|test)_[a-zA-Z0-9]+/g, '[redacted-key]')
    .replace(/rk_(live|test)_[a-zA-Z0-9]+/g, '[redacted-key]')
    .replace(/whsec_[a-zA-Z0-9]+/g, '[redacted-secret]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 200)
}

export interface ReplayEligibility {
  eligible: boolean
  reason: string
}

function replayEligibilityFor(status: string): ReplayEligibility {
  switch (status) {
    case 'failed':
      return { eligible: true, reason: 'Dead-lettered — ready to replay.' }
    case 'pending':
      return { eligible: true, reason: 'Still waiting for its first scheduled attempt — replay forces it now.' }
    case 'processed':
      return { eligible: true, reason: 'Already processed — replaying is a safe no-op, not required.' }
    case 'ignored':
      return { eligible: true, reason: 'Ignored (not a type this app handles) — replaying is a safe no-op.' }
    case 'processing':
      return { eligible: false, reason: 'Currently claimed by the worker — wait for it to finish or dead-letter before replaying.' }
    default:
      return { eligible: false, reason: 'Unknown status.' }
  }
}

export interface BillingWebhookEventDetail extends BillingWebhookEventRow {
  lastErrorPreview: string | null
  replayEligible: boolean
  replayEligibilityReason: string
}

export async function getBillingWebhookEventDetail(id: string, db: Db = platformDb): Promise<BillingWebhookEventDetail | null> {
  const [record] = await db.select().from(billingWebhookEvents).where(eq(billingWebhookEvents.id, id)).limit(1)
  if (!record) return null
  const eligibility = replayEligibilityFor(record.status)
  return {
    ...toRow(record),
    lastErrorPreview: record.lastError ? redactErrorPreview(record.lastError) : null,
    replayEligible: eligibility.eligible,
    replayEligibilityReason: eligibility.reason,
  }
}

/**
 * Counts webhook events per status in one grouped query (plan 57, Admin track).
 *
 * ## Why an aggregate and not a length
 *
 * The obvious version reads `listBillingWebhookEvents` and counts what came back — and that is wrong in the one
 * direction that matters. The list is bounded, so once there are more failures than the page size the count
 * stops growing: the dashboard reports "50 failed" whether there are fifty or fifty thousand, and it reports it
 * calmly. A grouped count returns one row per status, and `BILLING_WEBHOOK_EVENT_STATUSES` has five, so the
 * result size is decided by the enum rather than by the backlog.
 *
 * ## Why not `getBillingOperationsMetrics`
 *
 * That function walks **every organization** serially — one transaction and nine queries each — and reads this
 * table twice to count statuses in JavaScript. It was deliberately removed from every frequent path, and a
 * metrics section on a refresh timer is the most frequent path there is. This is the same fact for one query.
 */
export async function countBillingWebhookEventsByStatus(
  db: Db = platformDb,
): Promise<Record<BillingWebhookEventStatus, number>> {
  const counts = Object.fromEntries(
    BILLING_WEBHOOK_EVENT_STATUSES.map((status) => [status, 0]),
  ) as Record<BillingWebhookEventStatus, number>

  // unbounded-read-ok: grouped by a five-value status enum, so this returns at most five rows however large the
  // table grows. A LIMIT would drop a status rather than bound anything.
  const rows = await db
    .select({ status: billingWebhookEvents.status, total: sql<number>`count(*)::int` })
    .from(billingWebhookEvents)
    .groupBy(billingWebhookEvents.status)

  for (const row of rows) {
    // A status the enum does not know is skipped rather than coerced: folding an unknown value into `failed`
    // would invent an alert, and into `processed` would hide one.
    if ((BILLING_WEBHOOK_EVENT_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as BillingWebhookEventStatus] = Number(row.total ?? 0)
    }
  }
  return counts
}
