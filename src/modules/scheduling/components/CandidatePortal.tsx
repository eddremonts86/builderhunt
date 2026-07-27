import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarCheck, Loader2, ShieldCheck } from 'lucide-react'
import { Button, Label } from '~/components/ui'
import { CandidateDetailsForm, type CandidateSubmission } from './CandidateDetailsForm'
import { SlotPicker, type SlotDto } from './SlotPicker'

/**
 * The accountless candidate portal (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Build mobile accountless candidate portal").
 *
 * The whole flow, in one component, because it is one conversation: read who is asking and why, say
 * who you are and what you agree to, pick a time, get a confirmation. Splitting it across routes
 * would put the capability exchange in one place and the state that depends on it in another.
 *
 * Three decisions worth stating:
 *
 * 1. **The secret leaves the URL immediately.** It arrives in `location.hash`, is POSTed once, and the
 *    history entry is replaced so the back button cannot resurrect it. Fragments never reach a
 *    server, so no access log ever held it; `replaceState` is about the machine it landed on.
 * 2. **There is no analytics, no third-party script, and no image from another origin.** spec.md
 *    requires it, and the reason is that a page whose URL identifies one named person interviewing at
 *    one named company must not tell anyone else it was loaded.
 * 3. **Consent is collected before times are shown.** Not for legal ceremony — it is so a candidate
 *    who is not willing to accept a required purpose finds that out before investing in choosing a
 *    slot, rather than at the last click.
 */

interface InvitationDto {
  id: string
  roleTitle: string
  roleContext: string
  durationMinutes: number
  timezone: string
  modality: string
  meetingUrl: string | null
  location: string | null
  status: string
  policyVersion: string
  noticeVersion: string
  requiredPurposes: string[]
  consents?: {
    id: string
    purpose: string
    decision: string
    noticeVersion: string
    withdrawnAt: string | null
  }[]
}

interface BookingDto {
  eventId: string
  startsAt: string
  endsAt: string
  timezone: string
  alreadyBooked?: boolean
}

type Stage = 'loading' | 'unavailable' | 'details' | 'choosing' | 'booked'

export interface CandidatePortalProps {
  invitationId: string
  /** Injected in tests. Defaults to the real endpoints. */
  fetcher?: typeof fetch
  /** Injected in tests, since jsdom has no real `location.hash` navigation. */
  initialSecret?: string | null
}

const SLOT_WINDOW_DAYS = 21

export function CandidatePortal({ invitationId, fetcher, initialSecret }: CandidatePortalProps) {
  const call = fetcher ?? fetch
  const base = `/api/public/scheduling/${invitationId}`

  const [stage, setStage] = useState<Stage>('loading')
  const [invitation, setInvitation] = useState<InvitationDto | null>(null)
  const [timezone, setTimezone] = useState<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  })
  const [slots, setSlots] = useState<SlotDto[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<SlotDto | null>(null)
  const [receiptIds, setReceiptIds] = useState<string[]>([])
  const [booking, setBooking] = useState<BookingDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * The exchange must happen exactly once per mount. A ref rather than state, because the guard has
   * to take effect synchronously — a second render before a state update landed would POST the secret
   * twice, and the second POST would arrive after the first had already consumed the fragment.
   */
  const exchanged = useRef(false)

  const loadSlots = useCallback(async () => {
    setSlotsLoading(true)
    setError(null)
    try {
      const from = new Date()
      const to = new Date(from.getTime() + SLOT_WINDOW_DAYS * 24 * 60 * 60_000)
      const response = await call(
        `${base}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) {
        setError('We could not load the available times. Please reload the page.')
        return
      }
      const body = await response.json() as { slots: SlotDto[] }
      setSlots(body.slots)
    } finally {
      setSlotsLoading(false)
    }
  }, [base, call])

  /** Exchange the fragment secret for the session cookie, exactly once. */
  useEffect(() => {
    if (exchanged.current) return
    exchanged.current = true

    const secret = initialSecret ?? readSecretFromHash()
    void (async () => {
      try {
        if (secret) {
          const response = await call(`${base}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ secret }),
          })
          // Whether or not the exchange succeeded, the secret has served its purpose in this URL.
          clearHash()
          if (!response.ok) {
            setStage('unavailable')
            return
          }
        }

        const invitationResponse = await call(base, { headers: { accept: 'application/json' } })
        if (!invitationResponse.ok) {
          setStage('unavailable')
          return
        }
        const dto = await invitationResponse.json() as InvitationDto
        setInvitation(dto)
        // A returning candidate whose consent is already on file skips straight to choosing.
        const liveConsents = (dto.consents ?? []).filter((consent) =>
          consent.decision === 'accepted'
          && consent.withdrawnAt === null
          && consent.noticeVersion === dto.noticeVersion)
        const satisfied = dto.requiredPurposes.every((purpose) =>
          liveConsents.some((consent) => consent.purpose === purpose))
        if (satisfied) {
          setReceiptIds(liveConsents.map((consent) => consent.id))
          if (dto.status === 'booked') {
            setStage('booked')
          } else {
            setStage('choosing')
            void loadSlots()
          }
        } else {
          setStage('details')
        }
      } catch {
        setStage('unavailable')
      }
    })()
  }, [base, call, initialSecret, loadSlots])

  /**
   * Re-reads the invitation.
   *
   * Needed after anything that changes server-side state the confirmation screen renders. The
   * consent receipts in particular are created by the submission request, so the DTO loaded at mount
   * has none of them — without this refetch the "Your agreements" list on the confirmation screen is
   * empty and the withdrawal controls never appear, which is the one control spec.md requires to be
   * always visible.
   */
  const refreshInvitation = useCallback(async () => {
    const response = await call(base, { headers: { accept: 'application/json' } })
    if (response.ok) setInvitation(await response.json() as InvitationDto)
  }, [base, call])

  async function submitDetails(submission: CandidateSubmission) {
    setBusy(true)
    setError(null)
    try {
      const response = await call(`${base}/submission`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: submission.displayName,
          email: submission.email,
          ...(submission.notes ? { notes: submission.notes } : {}),
          links: [],
          consentDecisions: submission.consentDecisions,
        }),
      })
      if (!response.ok) {
        setError('We could not save your details. Please check them and try again.')
        return
      }
      const body = await response.json() as {
        consentReceipts: { id: string; decision: string }[]
      }
      setReceiptIds(body.consentReceipts.filter((r) => r.decision === 'accepted').map((r) => r.id))
      setStage('choosing')
      void loadSlots()
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!selectedSlot) return
    setBusy(true)
    setError(null)
    try {
      const response = await call(`${base}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slotId: selectedSlot.slotId,
          slotStartsAt: selectedSlot.startsAt,
          submissionVersion: 1,
          consentReceiptIds: receiptIds,
          idempotencyKey: `${invitationId}-${selectedSlot.slotId}`,
        }),
      })
      const body = await response.json().catch(() => ({})) as Record<string, unknown>

      if (response.status === 409) {
        // Someone took it. Show the refreshed times the server sent rather than a dead end.
        const alternatives = (body.alternatives as SlotDto[] | undefined) ?? []
        setSlots(alternatives)
        setSelectedSlot(null)
        setError('That time was just taken. Here are the times still available.')
        return
      }
      if (response.status === 422) {
        setError('A required agreement is missing or was withdrawn. Please review the agreements below.')
        setStage('details')
        return
      }
      if (!response.ok) {
        setError('We could not confirm that time. Please try another one.')
        return
      }

      setBooking(body as unknown as BookingDto)
      await refreshInvitation()
      setStage('booked')
    } finally {
      setBusy(false)
    }
  }

  async function withdraw(purpose: string) {
    setBusy(true)
    try {
      await call(`${base}/withdraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose, noticeVersion: invitation?.noticeVersion ?? '' }),
      })
      await refreshInvitation()
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true)
    try {
      const response = await call(`${base}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (response.ok) {
        setBooking(null)
        setSelectedSlot(null)
        setStage('choosing')
        // The cancelled time is free again, so the list has to be re-derived, not reused.
        void loadSlots()
      }
    } finally {
      setBusy(false)
    }
  }

  async function decline() {
    setBusy(true)
    try {
      const response = await call(`${base}/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (response.ok) setStage('unavailable')
    } finally {
      setBusy(false)
    }
  }

  const timezones = useMemo(() => timezoneChoices(timezone, invitation?.timezone), [timezone, invitation?.timezone])

  if (stage === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-bh-text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Opening your invitation…
      </p>
    )
  }

  if (stage === 'unavailable' || !invitation) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-bh-text">This invitation is no longer open</h1>
        {/* Deliberately one message for every cause: expired, withdrawn, declined, or never valid. */}
        <p className="text-sm text-bh-text-muted">
          The link may have expired, or the interviewer may have withdrawn it. If you still want to
          interview, reply to the email you received and ask for a new link.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-bh-text-muted">Interview invitation</p>
        <h1 className="text-2xl font-semibold text-bh-text">{invitation.roleTitle}</h1>
        <p className="text-sm text-bh-text-muted">{invitation.roleContext}</p>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-bh-text-muted">Length</dt>
            <dd className="font-medium text-bh-text">{invitation.durationMinutes} minutes</dd>
          </div>
          <div>
            <dt className="text-bh-text-muted">Format</dt>
            <dd className="font-medium text-bh-text">
              {invitation.modality === 'remote_call' ? 'Video call' : 'In person'}
              {invitation.location ? ` — ${invitation.location}` : ''}
            </dd>
          </div>
        </dl>
      </header>

      <section className="rounded-lg border border-bh-border bg-bh-surface p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-bh-text">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Who is handling your data
        </h2>
        <ul className="mt-2 space-y-1 text-xs text-bh-text-muted">
          <li>BuilderHunt is the data controller for the interview record.</li>
          <li>Processing happens in the EU. Audio is never stored; only the transcription text is.</li>
          <li>Your data is never used to train or improve AI models.</li>
          <li>You can withdraw any agreement at any time, including after booking.</li>
          <li>
            Full detail is in the <a className="underline" href="/legal/privacy" rel="noreferrer">privacy notice</a>
            {' '}(notice version {invitation.noticeVersion}).
          </li>
        </ul>
      </section>

      {stage === 'details' ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-bh-text">About you</h2>
          <CandidateDetailsForm
            noticeVersion={invitation.noticeVersion}
            requiredPurposes={invitation.requiredPurposes}
            submitting={busy}
            error={error}
            onSubmit={submitDetails}
          />
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={decline}>
            I do not want to continue
          </Button>
        </section>
      ) : null}

      {stage === 'choosing' ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-bh-text">Choose a time</h2>

          <div>
            <Label htmlFor="candidate-timezone">Show times in</Label>
            <select
              id="candidate-timezone"
              className="mt-1 w-full rounded-md border border-bh-border bg-bh-surface px-3 py-2 text-sm"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          </div>

          {error ? <p className="text-sm text-bh-danger" role="alert">{error}</p> : null}

          <SlotPicker
            slots={slots}
            timezone={timezone}
            loading={slotsLoading}
            selectedSlotId={selectedSlot?.slotId ?? null}
            onSelect={setSelectedSlot}
            disabled={busy}
          />

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!selectedSlot || busy} onClick={confirm}>
              {busy ? 'Confirming…' : 'Confirm this time'}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={decline}>
              I do not want to continue
            </Button>
          </div>
        </section>
      ) : null}

      {stage === 'booked' ? (
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-bh-text">
            <CalendarCheck className="h-5 w-5" aria-hidden="true" />
            Your interview is confirmed
          </h2>
          {booking ? (
            <p className="text-sm text-bh-text">
              {new Intl.DateTimeFormat('en-GB', {
                timeZone: timezone,
                weekday: 'long', day: 'numeric', month: 'long',
                hour: '2-digit', minute: '2-digit', hour12: false,
              }).format(new Date(booking.startsAt))}
              {' '}({timezone})
            </p>
          ) : null}
          {invitation.meetingUrl ? (
            <p className="text-sm text-bh-text-muted break-words">
              Join link: <a className="underline" href={invitation.meetingUrl} rel="noreferrer">{invitation.meetingUrl}</a>
            </p>
          ) : null}

          <div className="rounded-lg border border-bh-border p-4">
            <h3 className="text-sm font-semibold text-bh-text">Your agreements</h3>
            <p className="mt-1 text-xs text-bh-text-muted">
              Withdrawing an agreement does not cancel your interview.
            </p>
            <ul className="mt-3 space-y-2">
              {(invitation.consents ?? [])
                .filter((consent) => consent.decision === 'accepted')
                .map((consent) => (
                  <li key={consent.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-bh-text">{consent.purpose.replace(/_/g, ' ')}</span>
                    {consent.withdrawnAt ? (
                      <span className="text-bh-text-muted">withdrawn</span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => withdraw(consent.purpose)}
                      >
                        Withdraw
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>
              Cancel or choose another time
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

/** Reads the capability out of `#capability=…`, tolerating a bare fragment. */
function readSecretFromHash(): string | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  return params.get('capability') ?? (hash.includes('=') ? null : hash)
}

/**
 * Removes the fragment without adding a history entry.
 *
 * `replaceState` rather than assigning `location.hash = ''`, which would push a new entry and leave
 * the secret one Back press away.
 */
function clearHash(): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

/** The candidate's own zone, the organizer's, and UTC — enough to reconcile a time without a picker. */
function timezoneChoices(candidateZone: string, organizerZone?: string): string[] {
  const zones = new Set<string>([candidateZone, 'UTC'])
  if (organizerZone) zones.add(organizerZone)
  return [...zones]
}
