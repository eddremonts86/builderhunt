import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { calendarEvents, schedulingInvitations } from '~/shared/lib/db/schema'
import { hasGrantedMaterialAccess } from '~/shared/lib/repositories/calendar'

/**
 * Resolves the role a brief is being prepared for.
 *
 * Lives in `lib/`, not beside the routes that use it. A `-` prefix does keep a file out of TanStack's
 * route tree, but `scripts/check-route-coverage.mjs` scans everything under `src/routes/api/**` and
 * requires an auth guard in each file — correctly, since a route without one is the failure that check
 * exists for. Allowlisting this would have weakened the check to accommodate a file that reads the
 * database and has nothing to do with routing.
 *
 * ## Why the invitation rather than the event
 *
 * The brief needs `roleTitle` and `roleContext`, and those live on `scheduling_invitations`, not on the
 * calendar event. The event is what the brief is keyed to; the invitation is what the interview is *for*.
 * Joining through `booked_event_id` is what connects them, and an event with no invitation behind it is a
 * personal calendar entry rather than an interview — which is why this returns null instead of inventing
 * a role.
 *
 * ## Authorization is resolved here, not left entirely to RLS
 *
 * This used to filter on `(organization_id, event_id)` alone, on the argument that the tables' owner-scoped
 * policies already settle visibility and a second check would be a second answer to the same question.
 * That argument is coherent and it left this path with exactly one enforcement layer — for the routes that
 * start a recording and mint a transcription token, the most sensitive pair in the product. Every other
 * service in this codebase stacks three deliberately (`lib/calendar/service.ts`: "A bug in any one of them
 * is caught by the other two").
 *
 * It also failed in practice: the Phase 12 live-session e2e had an ungranted colleague create a session on
 * someone else's interview and get a `200`, because a developer's `DATABASE_URL` names the `postgres`
 * superuser and RLS is therefore not evaluated at all outside production. A single layer that is switched
 * off in every environment anyone develops in is not a layer.
 *
 * So the caller's relationship is now returned alongside the role, and callers decide with it: a granted
 * participant reads, and only the owner writes.
 */
export interface BriefContext {
  invitationId: string
  roleTitle: string
  roleContext: string
  /** The booked modality, which decides the capture mode a live session may use. */
  modality: string
  /** The caller owns the interview: the only relationship that may drive a session. */
  isOwner: boolean
  /** A colleague explicitly handed the material — `event_participants.material_access_granted`. Reads only. */
  isGrantedParticipant: boolean
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
      modality: schedulingInvitations.modality,
      ownerUserId: calendarEvents.ownerUserId,
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

  const row = rows[0]
  if (!row) return null

  const isOwner = row.ownerUserId === principal.userId
  // Only asked when it can change the answer. Being on the attendee list is not the same act as being
  // handed the interview material, which is why the predicate is `access_granted` rather than membership.
  const isGrantedParticipant = isOwner
    ? true
    : await hasGrantedMaterialAccess(transaction, principal.organizationId, eventId, principal.userId)

  // Neither means the caller has no relationship to this interview. Null rather than a 403, so "not
  // yours" and "does not exist" are the same answer — a 403 here would confirm that an interview exists.
  if (!isOwner && !isGrantedParticipant) return null

  const { ownerUserId: _ownerUserId, ...context } = row
  return { ...context, isOwner, isGrantedParticipant }
}
