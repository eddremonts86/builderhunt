import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { calendarEvents, interviewBriefs, schedulingInvitations } from '../db/schema'

/**
 * The "today and upcoming" agenda (plans/ui-dashboard Wave 3, "Build the upcoming schedule
 * projection").
 *
 * ## Why one query and not three
 *
 * The obvious shape is: list the events, then for each one ask whether it has a brief and whether a
 * scheduling invitation booked it. On a busy week that is 1 + 2N round trips for a widget showing
 * five rows, and it grows with the calendar rather than with what is displayed. Both extras are
 * left joins on indexed columns here, so the cost is one query whose row count is the cap.
 *
 * ## The merge key is the calendar event, which is what makes duplicates impossible
 *
 * The plan asks for Calendar, Interview and booked Scheduling records "merged by canonical
 * event/interview identifiers", which reads as three sources to reconcile. They are not three
 * sources: an interview brief is keyed by `event_id`, and a booked invitation stores
 * `booked_event_id`. Both hang off the event. Selecting from `calendar_events` and joining outward
 * means one row per appointment by construction — there is no dedup step to get wrong, and no way
 * for a rescheduled invitation pointing at a replacement event to appear twice.
 *
 * ## What is excluded, and why each exclusion is deliberate
 *
 * - **Cancelled events.** `cancelled_at is null`. A cancelled interview is not upcoming work, and
 *   showing it with a strikethrough invites the reader to check whether it is really off.
 * - **Events that already ended.** The window starts at `now`, not at midnight: an agenda whose
 *   first row finished two hours ago is a log.
 * - **Other people's events.** `owner_user_id` is the caller's. Calendar events are personal even
 *   inside a shared tenant, and a dashboard is not the place to discover a colleague's schedule.
 *
 * All-day events are *kept*: `starts_at`/`ends_at` are still real instants for them, and an all-day
 * interview block is exactly the kind of thing someone needs to see before booking over it.
 */

/** How far ahead the agenda looks. Beyond a week it stops being "upcoming" and becomes a calendar. */
export const UPCOMING_HORIZON_DAYS = 7

export interface UpcomingAppointment {
  eventId: string
  title: string
  startsAt: Date
  endsAt: Date
  /** IANA zone stored on the event, so the widget can label a time the viewer may not be in. */
  timezone: string
  allDay: boolean
  location: string | null
  meetingUrl: string | null
  /** `interview`, `meeting`, … — the event's own type, not an inference from its title. */
  type: string
  /**
   * True when an interview brief exists and is active for this event.
   *
   * The distinction the dashboard needs is "walking into this unprepared", so a brief that exists in
   * a draft or superseded state counts as absent — which is what `status = 'active'` means here and
   * what `findActiveBrief` means everywhere else.
   */
  hasActiveBrief: boolean
  /** Set when this event was booked through a scheduling invitation, so the row can link to it. */
  invitationId: string | null
}

export async function listUpcomingAppointments(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
  now: Date,
  limit: number,
): Promise<UpcomingAppointment[]> {
  const horizon = new Date(now.getTime() + UPCOMING_HORIZON_DAYS * 24 * 60 * 60 * 1000)

  const rows = await transaction
    .select({
      eventId: calendarEvents.id,
      title: calendarEvents.title,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      timezone: calendarEvents.timezone,
      allDay: calendarEvents.allDay,
      location: calendarEvents.location,
      meetingUrl: calendarEvents.meetingUrl,
      type: calendarEvents.type,
      // Aggregated rather than selected: the left joins can multiply rows, and a boolean built with
      // `bool_or` is immune to that in a way `row !== null` on a duplicated row is not.
      hasActiveBrief: sql<boolean>`bool_or(${interviewBriefs.id} is not null)`,
      /*
       * `::text` before `max`, because `scheduling_invitations.id` is a uuid and **Postgres has no
       * `max(uuid)`**. Without the cast this whole section answered `unavailable` — the route's
       * per-section `try` turned a SQL type error into a quiet "this section is unavailable" for
       * every user with a calendar entry, exactly the failure the envelopes exist to make visible
       * rather than the one they exist to hide. Found by the e2e; nothing in the type system could
       * have caught it, since drizzle types the fragment from the annotation it is given.
       *
       * `max` rather than a plain select: at most one invitation books a given event, but the join
       * still has to be aggregated to survive the `group by`, and picking the greatest id is a total
       * rule where "whichever row came back" is not.
       */
      invitationId: sql<string | null>`max(${schedulingInvitations.id}::text)`,
    })
    .from(calendarEvents)
    .leftJoin(interviewBriefs, and(
      eq(interviewBriefs.organizationId, calendarEvents.organizationId),
      eq(interviewBriefs.eventId, calendarEvents.id),
      eq(interviewBriefs.status, 'active'),
    ))
    .leftJoin(schedulingInvitations, and(
      eq(schedulingInvitations.organizationId, calendarEvents.organizationId),
      eq(schedulingInvitations.bookedEventId, calendarEvents.id),
    ))
    .where(and(
      eq(calendarEvents.organizationId, organizationId),
      eq(calendarEvents.ownerUserId, ownerUserId),
      isNull(calendarEvents.cancelledAt),
      // Ends after now, starts before the horizon: catches the meeting already in progress, which is
      // the one row a "what is happening next" widget must never omit.
      gte(calendarEvents.endsAt, now),
      lt(calendarEvents.startsAt, horizon),
    ))
    .groupBy(
      calendarEvents.id,
      calendarEvents.title,
      calendarEvents.startsAt,
      calendarEvents.endsAt,
      calendarEvents.timezone,
      calendarEvents.allDay,
      calendarEvents.location,
      calendarEvents.meetingUrl,
      calendarEvents.type,
    )
    // Total order. `startsAt` alone ties for two events beginning at the same minute, and a tie
    // resolved by the query plan reshuffles between requests and reads as the page changing itself.
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id))
    .limit(limit)

  return rows.map((row) => ({
    eventId: row.eventId,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezone,
    allDay: row.allDay,
    location: row.location,
    meetingUrl: row.meetingUrl,
    type: row.type,
    hasActiveBrief: row.hasActiveBrief === true,
    invitationId: row.invitationId,
  }))
}
