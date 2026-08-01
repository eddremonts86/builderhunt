/**
 * The organizer's view of invitations already issued (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Build organizer scheduling UI").
 *
 * Two things shape this list:
 *
 * 1. **Revoke is the only lever after sending.** There is no resend, and the status graph allows no
 *    move backwards, so the actions here are deliberately just one. Offering a "resend" that answers
 *    `409 already_sent` would be worse than not offering it.
 * 2. **The version goes with the action.** Every mutation carries the version this list was rendered
 *    from, so a revoke racing another tab's send loses with a conflict instead of resurrecting or
 *    clobbering. On conflict the fix is a reload, and the message says that.
 *
 * A booked row gets three more links (plans/UI Wave 3 "Connect booked scheduling to Calendar and
 * Interviews") built from `bookedEventId` alone — no extra lookup, because an interview *is* the
 * calendar event it was booked onto: `/interviews/$interviewId` and the calendar route both resolve
 * by that same id. The candidate's own meeting URL stays a secondary, safety-checked external link.
 */
import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '~/components/ui'
import { isSafeHttpUrl } from '~/shared/lib/url-safety'

export interface InvitationSummary {
  /** The DTO's own key name (`toInvitationDto` in the route), not `id`. */
  invitationId: string
  status: string
  version: number
  roleTitle: string
  durationMinutes: number
  organizationBuilderId?: string | null
  expiresAt?: string | null
  bookedAt?: string | null
  /** Same id as the calendar event and the `/interviews/$interviewId` route; null until booked. */
  bookedEventId?: string | null
  meetingUrl?: string | null
}

interface InvitationStatusProps {
  invitations: InvitationSummary[]
  onChanged: () => void
}

/** Terminal states accept nothing, so they get no action button. */
const TERMINAL = new Set(['revoked', 'expired', 'declined', 'booked'])

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft — not sent', tone: 'text-bh-text-muted' },
  sent: { label: 'Sent, waiting', tone: 'text-bh-accent' },
  opened: { label: 'Opened', tone: 'text-bh-accent' },
  booked: { label: 'Booked', tone: 'text-bh-success' },
  declined: { label: 'Declined', tone: 'text-bh-text-muted' },
  expired: { label: 'Expired', tone: 'text-bh-text-muted' },
  revoked: { label: 'Revoked', tone: 'text-bh-text-muted' },
}

export function InvitationStatus({ invitations, onChanged }: InvitationStatusProps) {
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function revoke(invitation: InvitationSummary) {
    if (busyId) return
    setBusyId(invitation.invitationId)
    setError(null)
    try {
      const res = await fetch(`/api/scheduling/invitations/${invitation.invitationId}/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: invitation.version,
          idempotencyKey: `revoke-${invitation.invitationId}-${invitation.version}`,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body?.message ?? 'Could not revoke this invitation.')
        return
      }
      onChanged()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusyId(null)
    }
  }

  if (invitations.length === 0) {
    return <p className="text-sm text-bh-text-muted">No interview invitations yet.</p>
  }

  return (
    <div className="space-y-2" data-testid="invitation-status-list">
      {error ? (
        <p className="text-sm text-bh-danger" role="alert" data-testid="invitation-status-error">{error}</p>
      ) : null}
      <ul className="space-y-2">
        {invitations.map((invitation) => {
          const copy = STATUS_COPY[invitation.status] ?? { label: invitation.status, tone: 'text-bh-text-muted' }
          return (
            <li
              key={invitation.invitationId}
              className="flex items-start justify-between gap-3 rounded-lg border border-bh-border p-3 text-sm"
              data-testid="invitation-status-row"
              data-status={invitation.status}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-bh-text">{invitation.roleTitle}</p>
                <p className={`text-xs ${copy.tone}`}>
                  {copy.label} · {invitation.durationMinutes} min
                </p>
                {invitation.status === 'booked' && invitation.bookedAt ? (
                  <p className="mt-0.5 text-xs text-bh-text-muted">
                    {new Date(invitation.bookedAt).toLocaleString()}
                  </p>
                ) : null}
                {invitation.status === 'booked' && invitation.bookedEventId ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="invitation-status-booked-links">
                    <a href={`/calendar?event=${invitation.bookedEventId}`} className="text-bh-accent underline" data-testid="invitation-status-view-in-calendar">
                      View in Calendar
                    </a>
                    <a href={`/interviews/${invitation.bookedEventId}`} className="text-bh-accent underline" data-testid="invitation-status-prepare-brief">
                      Prepare brief
                    </a>
                    <a href={`/interviews/${invitation.bookedEventId}/live`} className="text-bh-accent underline" data-testid="invitation-status-join-interview">
                      Start / Rejoin
                    </a>
                    {isSafeHttpUrl(invitation.meetingUrl ?? null) && (
                      <a
                        href={invitation.meetingUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-bh-text-muted underline"
                        data-testid="invitation-status-meeting-link"
                      >
                        <ExternalLink className="size-3 shrink-0" aria-hidden />
                        Meeting link
                      </a>
                    )}
                  </div>
                ) : null}
              </div>
              {TERMINAL.has(invitation.status) ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(invitation)}
                  disabled={busyId === invitation.invitationId}
                >
                  {busyId === invitation.invitationId ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
