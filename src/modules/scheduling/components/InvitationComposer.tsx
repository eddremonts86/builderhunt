/**
 * The organizer's invitation form (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Build organizer scheduling UI").
 *
 * Creating is deliberately separate from sending. `POST /api/scheduling/invitations` only drafts,
 * and answers with the slots the candidate would actually be offered — so the organizer sees what
 * their availability produces *before* anything reaches an inbox. `InvitationPreview` owns that
 * second step.
 *
 * The draft survives a failed send. Every error path here leaves the fields exactly as typed,
 * because the alternative — a cleared form after a 502 — costs the organizer their role context for
 * a reason that had nothing to do with what they wrote.
 */
import * as React from 'react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '~/components/ui'

/** Mirrors `SCHEDULING_MODALITIES` in shared/lib/scheduling.ts. */
type Modality = 'remote_call' | 'in_person'

export interface InvitationDraft {
  candidateEmail: string
  roleTitle: string
  roleContext: string
  durationMinutes: number
  timezone: string
  modality: Modality
  meetingUrl: string
  location: string
}

export interface CreatedDraft {
  invitationId: string
  version: number
  roleTitle: string
  durationMinutes: number
  modality: Modality
  status: string
  availabilityPreview: { startsAt: string; endsAt: string }[]
}

interface InvitationComposerProps {
  /** `organization_builders.id` — links the invitation to the tracked builder it is about. */
  organizationBuilderId?: string | null
  /** Seeds the role context so the organizer edits rather than composes from nothing. */
  suggestedContext?: string
  onCreated: (draft: CreatedDraft, sentTo: string) => void
  onCancel: () => void
}

const DURATIONS = [15, 30, 45, 60, 90]

export function InvitationComposer({
  organizationBuilderId,
  suggestedContext,
  onCreated,
  onCancel,
}: InvitationComposerProps) {
  const [draft, setDraft] = React.useState<InvitationDraft>({
    candidateEmail: '',
    roleTitle: '',
    roleContext: suggestedContext ?? '',
    durationMinutes: 30,
    // The organizer's own zone, because they are the one reading the times back. The candidate
    // switches to theirs in the portal.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    modality: 'remote_call',
    meetingUrl: '',
    location: '',
  })
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const set = <K extends keyof InvitationDraft>(key: K, value: InvitationDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  // The modality decides which joining detail is required — the server enforces the same rule, this
  // just avoids a round-trip to learn it.
  const joiningDetailMissing = draft.modality === 'remote_call'
    ? draft.meetingUrl.trim().length === 0
    : draft.location.trim().length === 0
  const canSubmit = draft.candidateEmail.trim().length > 0
    && draft.roleTitle.trim().length > 0
    && draft.roleContext.trim().length > 0
    && !joiningDetailMissing

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/scheduling/invitations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          candidateEmail: draft.candidateEmail.trim(),
          roleTitle: draft.roleTitle.trim(),
          roleContext: draft.roleContext.trim(),
          durationMinutes: draft.durationMinutes,
          timezone: draft.timezone,
          modality: draft.modality,
          ...(draft.modality === 'remote_call'
            ? { meetingUrl: draft.meetingUrl.trim() }
            : { location: draft.location.trim() }),
          ...(organizationBuilderId ? { organizationBuilderId } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Deliberately the server's message when it has one: it knows why, and paraphrasing it here
        // would drift. The draft is untouched either way.
        setError(body?.message ?? 'The invitation could not be drafted. Your details are still here.')
        return
      }
      onCreated(body as CreatedDraft, draft.candidateEmail.trim())
    } catch {
      setError('Could not reach the server. Your details are still here — try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit} data-testid="invitation-composer">
      <div>
        <Label htmlFor="invite-email">Candidate email</Label>
        <Input
          id="invite-email"
          type="email"
          value={draft.candidateEmail}
          onChange={(event) => set('candidateEmail', event.target.value)}
          required
          autoComplete="off"
        />
        <p className="mt-1 text-xs text-bh-text-muted">
          The invitation link goes here, once. It cannot be sent again.
        </p>
      </div>

      <div>
        <Label htmlFor="invite-role">Role title</Label>
        <Input
          id="invite-role"
          value={draft.roleTitle}
          onChange={(event) => set('roleTitle', event.target.value)}
          required
          maxLength={200}
        />
      </div>

      <div>
        <Label htmlFor="invite-context">What to tell them about the role</Label>
        <Textarea
          id="invite-context"
          value={draft.roleContext}
          onChange={(event) => set('roleContext', event.target.value)}
          required
          maxLength={4000}
          rows={4}
        />
        <p className="mt-1 text-xs text-bh-text-muted">
          The candidate sees this, and it is stored as written — later edits to the builder record do
          not change what they were told.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="invite-duration">Length</Label>
          <Select
            value={String(draft.durationMinutes)}
            onValueChange={(value) => set('durationMinutes', Number(value))}
          >
            <SelectTrigger id="invite-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>{minutes} minutes</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="invite-modality">Format</Label>
          <Select
            value={draft.modality}
            onValueChange={(value) => set('modality', value as Modality)}
          >
            <SelectTrigger id="invite-modality">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="remote_call">Video call</SelectItem>
              <SelectItem value="in_person">In person</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.modality === 'remote_call' ? (
        <div>
          <Label htmlFor="invite-url">Meeting link</Label>
          <Input
            id="invite-url"
            type="url"
            value={draft.meetingUrl}
            onChange={(event) => set('meetingUrl', event.target.value)}
            placeholder="https://meet.google.com/… or https://zoom.us/j/…"
            required
          />
          {/* Named explicitly because this field was read as the *invitation* link, which is a different
              thing entirely — that one is minted at send, goes in the email, and never appears in this
              form. An empty box labelled "Meeting link" beside a `https://…` placeholder reads as
              something the product failed to fill in. spec.md's non-goals list video conferencing, so it
              never will: BuilderHunt runs beside the call. */}
          <p className="text-xs text-bh-text-muted">
            Your video call: Google Meet, Zoom or Teams. This is not the invitation link — that one is
            emailed to the candidate when you send.
          </p>
        </div>
      ) : (
        <div>
          <Label htmlFor="invite-location">Where</Label>
          <Input
            id="invite-location"
            value={draft.location}
            onChange={(event) => set('location', event.target.value)}
            maxLength={500}
            required
          />
        </div>
      )}

      <p className="text-xs text-bh-text-muted">
        Times are offered in <strong>{draft.timezone}</strong>, from the availability on your
        calendar. The candidate can switch to their own zone.
      </p>

      {error ? (
        <p className="text-sm text-bh-danger" role="alert" data-testid="invitation-composer-error">{error}</p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
          {submitting ? 'Drafting…' : 'Preview times'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
