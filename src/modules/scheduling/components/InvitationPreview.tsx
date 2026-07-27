/**
 * The step between drafting an invitation and sending it (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Build organizer scheduling UI").
 *
 * This screen exists because sending is not undoable in the way organizers expect. The capability is
 * minted at send and only its hash is kept, so there is no resend: if the candidate loses the email,
 * the only remedy is revoke-and-reinvite. That is a fine design, but it makes a mis-sent invitation
 * expensive, so the confirmation says so plainly rather than relying on the organizer to know.
 *
 * It also shows the slots the server actually computed. An organizer whose availability yields three
 * awkward slots should find that out here, not from a candidate's reply.
 */
import * as React from 'react'
import { Button } from '~/components/ui'
import type { CreatedDraft } from './InvitationComposer'

interface InvitationPreviewProps {
  draft: CreatedDraft
  /** Shown so the organizer can catch a typo in the address before it is the only copy. */
  sentTo: string
  onSent: (result: { invitationId: string; status: string; version: number }) => void
  onBack: () => void
}

/** Enough to judge whether the offer is reasonable; the candidate sees the full set. */
const SLOTS_SHOWN = 6

export function InvitationPreview({ draft, sentTo, onSent, onBack }: InvitationPreviewProps) {
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const grouped = React.useMemo(() => groupByDay(draft.availabilityPreview), [draft.availabilityPreview])

  async function send() {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/scheduling/invitations/${draft.invitationId}/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: draft.version,
          // Scoped to this invitation and version, so a double-click cannot become two sends.
          idempotencyKey: `send-${draft.invitationId}-${draft.version}`,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 502 means the invitation is still a draft and can be sent again — the server rolls the
        // status back when delivery fails, so saying "try again" here is accurate rather than hopeful.
        setError(body?.message ?? 'The invitation could not be sent. It is still a draft.')
        return
      }
      onSent(body)
    } catch {
      setError('Could not reach the server. The invitation is still a draft.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="invitation-preview">
      <div className="rounded-lg border border-bh-border p-3 text-sm">
        <p className="font-semibold text-bh-text">{draft.roleTitle}</p>
        <p className="text-bh-text-muted">
          {draft.durationMinutes} minutes · {draft.modality === 'remote_call' ? 'Video call' : 'In person'}
        </p>
        <p className="mt-2 text-bh-text-muted">
          Goes to <strong className="text-bh-text">{sentTo}</strong>
        </p>
      </div>

      {draft.availabilityPreview.length === 0 ? (
        <p className="text-sm text-bh-danger" role="alert">
          Your availability produces no times in the booking window. The candidate would see an empty
          calendar, so fix your availability before sending.
        </p>
      ) : (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-bh-text-muted">
            Times they will be offered ({draft.availabilityPreview.length} in total)
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {grouped.slice(0, SLOTS_SHOWN).map(([day, slots]) => (
              <li key={day} className="flex justify-between gap-3">
                <span className="text-bh-text-muted">{day}</span>
                <span className="text-bh-text">{slots.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="rounded-lg bg-bh-surface-2 p-3 text-xs text-bh-text-muted">
        Sending emails the link once. It cannot be sent again — the link is not stored anywhere, by
        design. If they lose it, revoke this invitation and create a new one.
      </p>

      {error ? (
        <p className="text-sm text-bh-danger" role="alert" data-testid="invitation-preview-error">{error}</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          onClick={send}
          disabled={sending || draft.availabilityPreview.length === 0}
        >
          {sending ? 'Sending…' : 'Send invitation'}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={sending}>
          Back
        </Button>
      </div>
    </div>
  )
}

/** Groups ISO slots by their local day, preserving the server's order. */
function groupByDay(slots: { startsAt: string }[]): [string, string[]][] {
  const days = new Map<string, string[]>()
  for (const slot of slots) {
    const date = new Date(slot.startsAt)
    const day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const existing = days.get(day)
    if (existing) existing.push(time)
    else days.set(day, [time])
  }
  return [...days]
}
