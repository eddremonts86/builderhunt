import type { TenantTransaction } from '~/shared/lib/db/client'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { CalendarFeedItem, CalendarFeedResponse } from '~/shared/lib/calendar'
import { findScheduleDefinition, OPERATIONAL_SCHEDULES } from '~/shared/lib/operational-schedules'
import { listJobRuns, listScheduleRegistry } from '~/shared/lib/repositories/platform-operations'
import { listOwnAlertProjections, listOwnAlertResultBuckets } from '~/shared/lib/repositories/organization-alerts'
import { listRange } from './service'

/**
 * The unified calendar feed (plan: calendar-scheduling-interview-intelligence, Phase 4 "Implement
 * unified calendar feed").
 *
 * Merges five sources into one discriminated list: the caller's authorized events, upcoming
 * operational runs, upcoming alert evaluations, completed job runs, and alert matches.
 *
 * Two invariants hold across every non-event item, and the type system enforces both:
 *
 *  - **`editable: false`.** A projection is a view of something that lives elsewhere. It is never
 *    copied into `calendar_events`, so a client that let a user drag one would be editing nothing —
 *    the change would silently vanish on the next fetch. The literal type makes an editable
 *    projection unrepresentable rather than merely discouraged.
 *  - **`estimateOnly` distinguishes intent from history.** A `job_projection` or `alert_projection`
 *    says "we intend to run at this time"; a `job_run` or `alert_result` says "this happened". They
 *    must not be rendered identically, because a user planning around a *prediction* is making a
 *    different decision than one reading a *record*.
 *
 * `staleSources` is the honest-uncertainty channel. A schedule whose next run is already in the past
 * means the worker is not running; an alert with consecutive failures means its estimate is a guess
 * built on a broken evaluation. Rather than hide either behind a confident-looking calendar entry,
 * the feed names the source so the UI can say so.
 */

export type CalendarLayer = 'events' | 'jobs' | 'alerts'

// The persisted columns are plain `text`; the DTO narrows them. Casting here rather than widening
// the DTO keeps the closed contract authoritative — an unexpected value fails schema validation at
// the route boundary instead of flowing into the client as a surprise string.
type FeedEventItem = Extract<CalendarFeedItem, { kind: 'event' }>
type CalendarFeedEventType = FeedEventItem['type']
type CalendarFeedEventStatus = FeedEventItem['status']
type CalendarFeedEventVisibility = FeedEventItem['visibility']

export interface CalendarFeedInput {
  from: Date
  to: Date
  layers: CalendarLayer[]
  /** Hard cap on returned items. The agenda paginates; a month of a busy tenant must not be unbounded. */
  limit?: number
}

const DEFAULT_ITEM_LIMIT = 500

/** A job run of unknown duration still needs a non-zero span so a calendar can lay it out. */
const MINIMUM_ITEM_DURATION_MS = 60_000

function iso(value: Date): string {
  return value.toISOString()
}

/**
 * Only jobs whose scope is meaningful to a tenant appear in a tenant's feed.
 *
 * A `platform`-scoped job (billing reconciliation, discovery crawl) is not something an
 * organization's calendar should present as its own work — it would read as "your account is doing
 * this", which is untrue and unactionable for them.
 */
function isTenantVisibleJob(jobKey: string): boolean {
  return findScheduleDefinition(jobKey)?.scope === 'organization'
}

const TENANT_VISIBLE_JOB_KEYS = OPERATIONAL_SCHEDULES
  .filter((schedule) => schedule.scope === 'organization')
  .map((schedule) => schedule.jobKey)

export async function buildCalendarFeed(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CalendarFeedInput,
  /**
   * `operational_schedules` and `job_runs` are platform-owned and carry no `organization_id`, so
   * they are read on their own connection rather than through the tenant transaction. Injected so a
   * test can supply the same disposable database.
   */
  platformDatabase?: PostgresJsDatabase,
): Promise<CalendarFeedResponse> {
  const limit = input.limit ?? DEFAULT_ITEM_LIMIT
  const range = { from: input.from, to: input.to }
  const wantEvents = input.layers.includes('events')
  const wantJobs = input.layers.includes('jobs')
  const wantAlerts = input.layers.includes('alerts')

  const items: CalendarFeedItem[] = []
  const staleSources: string[] = []

  // One query per requested layer, never one per item. A layer the caller did not ask for costs
  // nothing — this is what keeps the query count flat as the range widens.
  if (wantEvents) {
    const events = await listRange(transaction, principal, range)
    for (const event of events) {
      // Fields are listed explicitly rather than spread. `feedEventItemSchema` is `.strict()` and
      // deliberately has no `organizationId`, so a spread would both fail validation and be the
      // exact leak the closed schema exists to prevent.
      items.push({
        kind: 'event',
        editable: true,
        id: event.id,
        calendarId: event.calendarId,
        ownerUserId: event.ownerUserId,
        type: event.type as CalendarFeedEventType,
        status: event.status as CalendarFeedEventStatus,
        title: event.title,
        description: event.description,
        location: event.location,
        meetingUrl: event.meetingUrl,
        startsAt: iso(event.startsAt),
        endsAt: iso(event.endsAt),
        timezone: event.timezone,
        allDay: event.allDay,
        busy: event.busy,
        visibility: event.visibility as CalendarFeedEventVisibility,
        rrule: event.rrule,
        recurrenceUntil: event.recurrenceUntil ? iso(event.recurrenceUntil) : null,
        version: event.version,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        cancelledAt: event.cancelledAt ? iso(event.cancelledAt) : null,
      })
    }
  }

  if (wantJobs) {
    const [schedules, runs] = await Promise.all([
      listScheduleRegistry(platformDatabase),
      listJobRuns(TENANT_VISIBLE_JOB_KEYS, range, platformDatabase),
    ])

    for (const schedule of schedules) {
      if (!schedule.enabled || !schedule.nextRunAt) continue
      if (!isTenantVisibleJob(schedule.jobKey)) continue

      // A next run in the past is not a schedule the user can plan around — it means nothing is
      // executing. Surfaced as stale instead of drawn as a confident future entry.
      if (schedule.nextRunAt <= new Date()) {
        staleSources.push(schedule.jobKey)
        continue
      }
      if (schedule.nextRunAt < range.from || schedule.nextRunAt >= range.to) continue

      const definition = findScheduleDefinition(schedule.jobKey)
      items.push({
        kind: 'job_projection',
        sourceType: 'operational_schedule',
        sourceId: schedule.jobKey,
        editable: false,
        estimateOnly: true,
        title: definition?.label ?? schedule.jobKey,
        startsAt: iso(schedule.nextRunAt),
        endsAt: iso(new Date(schedule.nextRunAt.getTime() + MINIMUM_ITEM_DURATION_MS)),
        safeSourceRoute: definition?.sourceRoute ?? '/api/admin/operations/sync-schedules',
      })
    }

    for (const run of runs) {
      const definition = findScheduleDefinition(run.jobKey)
      const startsAt = run.startedAt ?? run.scheduledFor
      // `finishedAt` is null for a run still in flight; the floor keeps the item layout-able rather
      // than collapsing it to a zero-width sliver the user cannot click.
      const endsAt = run.finishedAt ?? new Date(startsAt.getTime() + Math.max(run.durationMs ?? 0, MINIMUM_ITEM_DURATION_MS))
      items.push({
        kind: 'job_run',
        sourceType: 'job_run',
        sourceId: run.id,
        editable: false,
        estimateOnly: false,
        state: run.state,
        title: definition?.label ?? run.jobKey,
        startsAt: iso(startsAt),
        endsAt: iso(endsAt.getTime() > startsAt.getTime() ? endsAt : new Date(startsAt.getTime() + MINIMUM_ITEM_DURATION_MS)),
        safeSourceRoute: definition?.sourceRoute ?? '/api/admin/operations/sync-schedules',
      })
    }
  }

  if (wantAlerts) {
    const [projections, buckets] = await Promise.all([
      listOwnAlertProjections(transaction, principal.organizationId, principal.userId, range),
      listOwnAlertResultBuckets(transaction, principal.organizationId, principal.userId, range),
    ])

    for (const alert of projections) {
      if (!alert.nextEvaluationAt) continue
      // A failing alert's next-evaluation time is real but its usefulness is not: the last attempt
      // produced nothing. Name it stale AND still show it, because the user needs to see that the
      // alert exists and is struggling — hiding it would look like the alert was deleted.
      if (alert.consecutiveFailures > 0) staleSources.push(`alert:${alert.id}`)

      items.push({
        kind: 'alert_projection',
        sourceType: 'alert',
        sourceId: alert.id,
        editable: false,
        estimateOnly: true,
        // "Next check" not "next match": the projection is when we will look, never a promise of
        // what we will find.
        title: `Next check — ${alert.name}`,
        startsAt: iso(alert.nextEvaluationAt),
        endsAt: iso(new Date(alert.nextEvaluationAt.getTime() + MINIMUM_ITEM_DURATION_MS)),
        safeSourceRoute: '/dashboard/alerts',
      })
    }

    for (const bucket of buckets) {
      const bucketStart = new Date(bucket.bucketStart)
      items.push({
        kind: 'alert_result',
        sourceType: 'alert_trigger',
        sourceId: `${bucket.alertId}:${iso(bucketStart)}`,
        editable: false,
        estimateOnly: false,
        matchCount: bucket.matchCount,
        title: `${bucket.matchCount} match${bucket.matchCount === 1 ? '' : 'es'} — ${bucket.alertName}`,
        startsAt: iso(bucketStart),
        endsAt: iso(new Date(bucketStart.getTime() + 24 * 60 * 60_000)),
        safeSourceRoute: '/dashboard/alerts',
      })
    }
  }

  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt))

  return {
    items: items.slice(0, limit),
    generatedAt: iso(new Date()),
    // De-duplicated: one broken worker should read as one problem, not as one per affected item.
    staleSources: [...new Set(staleSources)],
  }
}
