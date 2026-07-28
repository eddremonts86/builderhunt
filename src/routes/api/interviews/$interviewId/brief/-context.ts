import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { calendarEvents, schedulingInvitations } from '~/shared/lib/db/schema'

/**
 * Resolves the role a brief is being prepared for.
 *
 * The `-` prefix keeps this out of TanStack's route tree — it is a helper the two brief route files
 * share, not a route.
 *
 * ## Why the invitation rather than the event
 *
 * The brief needs `roleTitle` and `roleContext`, and those live on `scheduling_invitations`, not on the
 * calendar event. The event is what the brief is keyed to; the invitation is what the interview is *for*.
 * Joining through `booked_event_id` is what connects them, and an event with no invitation behind it is a
 * personal calendar entry rather than an interview — which is why this returns null instead of inventing
 * a role.
 *
 * Both reads run on the caller's tenant connection, so RLS decides visibility. Nothing here re-checks
 * ownership: `calendar_events` and `scheduling_invitations` already have owner-scoped policies, and a
 * second check in application code would be a second answer to a question the database already settles.
 */
export interface BriefContext {
  invitationId: string
  roleTitle: string
  roleContext: string
}

export async function briefContextForEvent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  eventId: string,
): Promise<BriefContext | null> {
  const rows = await transaction
    .select({
      invitationId: schedulingInvitations.id,
      roleTitle: schedulingInvitations.roleTitle,
      roleContext: schedulingInvitations.roleContext,
    })
    .from(calendarEvents)
    .innerJoin(
      schedulingInvitations,
      and(
        eq(schedulingInvitations.organizationId, calendarEvents.organizationId),
        eq(schedulingInvitations.bookedEventId, calendarEvents.id),
      ),
    )
    .where(and(
      eq(calendarEvents.organizationId, principal.organizationId),
      eq(calendarEvents.id, eventId),
    ))
    .limit(1)

  return rows[0] ?? null
}
