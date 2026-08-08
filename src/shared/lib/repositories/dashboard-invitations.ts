import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { schedulingInvitations } from '../db/schema'

/**
 * Interview-invitation state, for the organizer who sent them (plans/ui-dashboard Wave 5, "Integrate
 * Invitation Status Distribution").
 *
 * ## A distribution, not a funnel
 *
 * The seven states are `scheduling_invitations_status_check`'s own list, and they are **not** a
 * pipeline: `expired` and `revoked` are terminal, `declined` is an answer rather than a failure, and
 * an invitation can be `booked` without ever having been recorded as `opened`. Rendering them as a
 * funnel would invite a conversion rate nobody should compute — "40% open rate" from a column that
 * only records an open when the candidate loads the portal in a browser that runs the request.
 *
 * So: counts, in a fixed order, with a name each.
 *
 * ## `needsAction` is the only derived value, and it is deliberately narrow
 *
 * Two states are waiting on the *organizer* rather than on the candidate: `declined`, where somebody
 * has to decide what happens next, and `expired`, where the invitation lapsed unanswered. `sent` and
 * `opened` are waiting on the candidate and are not the organizer's move; counting them as "needs
 * action" would put a permanent non-zero badge on a dashboard, which is how a badge stops being read.
 */

/** The status list, in the order a reader thinks about them. Mirrors the CHECK constraint exactly. */
export const INVITATION_STATUSES = [
  'draft',
  'sent',
  'opened',
  'booked',
  'declined',
  'expired',
  'revoked',
] as const

export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

export interface InvitationDistribution {
  counts: Array<{ status: InvitationStatus; count: number }>
  /** `declined` + `expired` — the two the organizer has to do something about. */
  needsAction: number
  total: number
}

export async function getInvitationDistribution(
  transaction: TenantTransaction,
  organizationId: string,
  ownerUserId: string,
): Promise<InvitationDistribution> {
  const rows = await transaction
    .select({
      status: schedulingInvitations.status,
      value: sql<number>`count(*)::int`,
    })
    .from(schedulingInvitations)
    .where(and(
      eq(schedulingInvitations.organizationId, organizationId),
      // The organizer's own invitations. An invitation names a candidate a specific person is
      // interviewing; a colleague's belong on a colleague's dashboard.
      eq(schedulingInvitations.ownerUserId, ownerUserId),
    ))
    .groupBy(schedulingInvitations.status)
    // One row per status, and `INVITATION_STATUSES` right above is that enum — the same list the
    // result is padded back out to below, so the ceiling cannot drop a category the caller then
    // reports as zero.
    .limit(INVITATION_STATUSES.length)

  const byStatus = new Map(rows.map((row) => [row.status, Number(row.value)]))
  // Every status, always, including the zeros. A distribution that omits its empty categories is a
  // distribution whose shape changes meaning between two workspaces.
  const counts = INVITATION_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 }))

  return {
    counts,
    needsAction: (byStatus.get('declined') ?? 0) + (byStatus.get('expired') ?? 0),
    total: counts.reduce((sum, entry) => sum + entry.count, 0),
  }
}
