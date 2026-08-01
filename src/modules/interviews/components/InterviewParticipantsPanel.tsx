import * as React from 'react'
import { Loader2, ShieldCheck, ShieldOff, Users } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * Owner-only material-access control panel (plans/UI Wave 3 "Add interview participant
 * material-access controls").
 *
 * One toggle per participant, not three. `event_participants.material_access_granted` is a single
 * column gating the brief, the report, and the transcript together (migration 0101's trigger
 * enforces it as one owner-only flag) — there is no independent per-material grant on the server to
 * wire three separate switches to. Presenting three would either desync from reality the first time
 * someone toggled just one, or silently flip all three anyway; the honest UI is one switch labeled
 * for everything it actually covers.
 *
 * Sharing (not revoking) asks for confirmation first: it is the direction that hands a candidate's
 * material to someone new, and the PATCH itself is owner-only and rate-limited but not otherwise
 * undoable-by-the-UI once the colleague has read it.
 */

export interface ParticipantView {
  id: string
  displayName: string | null
  externalEmail: string | null
  role: 'organizer' | 'attendee'
  response: string
  /** Calendar invite visibility — independent of `materialAccessGranted`. */
  accessGranted: boolean
  materialAccessGranted: boolean
}

export interface InterviewParticipantsPanelProps {
  interviewId: string
  /** Injected in tests; defaults to the real endpoint. */
  loadParticipants?: (interviewId: string) => Promise<{ ok: true; participants: ParticipantView[] } | { ok: false; status: number }>
  setMaterialAccess?: (interviewId: string, participantId: string, granted: boolean) => Promise<{ ok: true; participant: ParticipantView } | { ok: false; status: number }>
}

async function defaultLoadParticipants(interviewId: string) {
  const response = await fetch(`/api/interviews/${interviewId}/participants`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return { ok: false as const, status: response.status }
  const body = await response.json() as { participants: ParticipantView[] }
  return { ok: true as const, participants: body.participants }
}

async function defaultSetMaterialAccess(interviewId: string, participantId: string, granted: boolean) {
  const response = await fetch(`/api/interviews/${interviewId}/participants/${participantId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ materialAccessGranted: granted }),
  })
  if (!response.ok) return { ok: false as const, status: response.status }
  const body = await response.json() as { participant: ParticipantView }
  return { ok: true as const, participant: body.participant }
}

function participantName(participant: ParticipantView): string {
  return participant.displayName ?? participant.externalEmail ?? 'Unnamed participant'
}

function loadErrorMessage(status: number): string {
  if (status === 403) return 'Only the interview owner can manage material access.'
  if (status === 404) return 'This interview could not be found.'
  return 'Could not load participants.'
}

export function InterviewParticipantsPanel({
  interviewId,
  loadParticipants = defaultLoadParticipants,
  setMaterialAccess = defaultSetMaterialAccess,
}: InterviewParticipantsPanelProps) {
  const [participants, setParticipants] = React.useState<ParticipantView[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null)
  const [confirmedId, setConfirmedId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const result = await loadParticipants(interviewId)
    if (!result.ok) {
      setLoadError(loadErrorMessage(result.status))
      setParticipants(null)
      return
    }
    setLoadError(null)
    setParticipants(result.participants)
  }, [interviewId, loadParticipants])

  React.useEffect(() => { void load() }, [load])

  async function applyAccess(participant: ParticipantView, granted: boolean) {
    setBusyId(participant.id)
    setActionError(null)
    setConfirmingId(null)
    try {
      const result = await setMaterialAccess(interviewId, participant.id, granted)
      if (!result.ok) {
        setActionError(result.status === 403
          ? 'Only the interview owner can change material access.'
          : result.status === 404
            ? 'This participant is no longer on the interview.'
            : result.status === 429
              ? 'Too many changes — wait a moment and try again.'
              : 'Could not update material access.')
        return
      }
      setParticipants((current) => (current ?? []).map((p) => (p.id === participant.id ? result.participant : p)))
      setConfirmedId(participant.id)
    } finally {
      setBusyId(null)
    }
  }

  if (loadError) {
    return (
      <p className="text-sm text-bh-danger" role="alert" data-testid="participants-panel-error">
        {loadError}
      </p>
    )
  }

  if (participants === null) {
    return <p className="text-sm text-bh-text-muted">Loading participants…</p>
  }

  return (
    <section className="space-y-3" data-testid="participants-panel" aria-label="Interview participants">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-bh-text">
        <Users className="size-4" aria-hidden />
        Participants
      </h3>

      {actionError && <p className="text-sm text-bh-danger" role="alert" data-testid="participants-panel-action-error">{actionError}</p>}

      {participants.length === 0 ? (
        <p className="text-sm text-bh-text-muted" data-testid="participants-panel-empty">No one else is on this interview yet.</p>
      ) : (
        <ul className="space-y-2">
          {participants.map((participant) => (
            <li
              key={participant.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-bh-border p-3 text-sm"
              data-testid={`participant-row-${participant.id}`}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-bh-text">{participantName(participant)}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-bh-text-muted">
                  <span>{participant.accessGranted ? 'On the calendar invite' : 'Not on the calendar invite'}</span>
                  <span
                    className={`inline-flex items-center gap-1 ${participant.materialAccessGranted ? 'text-bh-success' : 'text-bh-text-muted'}`}
                    data-testid={`participant-material-status-${participant.id}`}
                  >
                    {participant.materialAccessGranted ? <ShieldCheck className="size-3" aria-hidden /> : <ShieldOff className="size-3" aria-hidden />}
                    {participant.materialAccessGranted ? 'Material shared' : 'Material not shared'}
                  </span>
                  {confirmedId === participant.id && !confirmingId && busyId !== participant.id && (
                    <span className="text-bh-accent" data-testid={`participant-confirmed-${participant.id}`}>Updated</span>
                  )}
                </div>
              </div>

              {confirmingId === participant.id ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-bh-text-muted">Share the brief, report, and transcript?</span>
                  <Button type="button" size="sm" onClick={() => void applyAccess(participant, true)} data-testid={`participant-confirm-share-${participant.id}`}>
                    Share
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={participant.materialAccessGranted ? 'ghost' : 'secondary'}
                  disabled={busyId === participant.id}
                  onClick={() => {
                    setConfirmedId(null)
                    if (participant.materialAccessGranted) void applyAccess(participant, false)
                    else setConfirmingId(participant.id)
                  }}
                  data-testid={`participant-toggle-${participant.id}`}
                >
                  {busyId === participant.id
                    ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    : participant.materialAccessGranted ? 'Revoke access' : 'Share material'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
