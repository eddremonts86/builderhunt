import { useState } from 'react'
import { CalendarClock, ExternalLink, MapPin, Repeat, Users, X } from 'lucide-react'
import { Button } from '~/components/ui'
import { isSafeHttpUrl } from '~/shared/lib/url-safety'
import type { CalendarEventDto } from './CalendarView'
import type { RecurrenceScope } from './EventEditor'

/**
 * Read view and action hub for one selected editable event (plans/UI Wave 3 "Build complete event
 * create, detail, and edit UI").
 *
 * Renders from the feed DTO the grid already has, and enriches it with participants and the
 * recurrence rule once the caller has loaded the full detail (`GET /api/calendar/events/:id`, which
 * is the only source of participants and the raw `rrule`). Two safety rules are enforced here, not
 * assumed upstream:
 * - a meeting link is only an anchor when it is a real `http(s)` URL — rows stored before the
 *   URL-safety allowlist was tightened are still clickable otherwise;
 * - deleting a recurring event forces a `this|following|series` scope choice rather than defaulting
 *   to a destructive whole-series delete.
 */

export interface EventParticipantView {
  id: string
  displayName: string | null
  externalEmail: string | null
  role: 'organizer' | 'attendee'
  response: 'needs_action' | 'accepted' | 'declined' | 'tentative'
  materialAccessGranted: boolean
}

export interface EventDetailView {
  participants: EventParticipantView[]
  rrule: string | null
  recurrenceUntil: string | null
}

export interface EventDetailsProps {
  event: CalendarEventDto
  /** Participants + recurrence, loaded lazily; null/undefined until the detail request resolves. */
  detail?: EventDetailView | null
  loadingDetail?: boolean
  actionError?: string | null
  /** An action (cancel/delete) is in flight; disables the destructive controls. */
  busy?: boolean
  onEdit: () => void
  onCancelEvent: () => void
  onDelete: (scope?: RecurrenceScope) => void
  onClose: () => void
}

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
}

function formatWhen(event: CalendarEventDto): string {
  const start = new Date(event.startsAt)
  const dateLabel = start.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  if (event.allDay) return `${dateLabel} · All day`
  const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  const endTime = new Date(event.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  return `${dateLabel} · ${startTime} – ${endTime}`
}

function participantName(participant: EventParticipantView): string {
  return participant.displayName ?? participant.externalEmail ?? 'Guest'
}

export function EventDetails({
  event,
  detail,
  loadingDetail = false,
  actionError = null,
  busy = false,
  onEdit,
  onCancelEvent,
  onDelete,
  onClose,
}: EventDetailsProps) {
  const recurring = Boolean(detail?.rrule)
  const [scope, setScope] = useState<RecurrenceScope>('this')
  const safeMeetingUrl = isSafeHttpUrl(event.meetingUrl) ? event.meetingUrl : null
  const isCancelled = event.status === 'cancelled'

  return (
    <section className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4" data-testid="event-details" aria-label="Event details">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold" data-testid="event-details-title">{event.title}</h3>
        <button type="button" onClick={onClose} aria-label="Close event details" data-testid="event-details-close">
          <X className="size-4 text-bh-text-muted" aria-hidden />
        </button>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-center gap-2 text-bh-text-muted" data-testid="event-details-when">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          <span>{formatWhen(event)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-bh-surface-muted px-2 py-0.5 text-xs" data-testid="event-details-status">
            {humanize(event.status)}
          </span>
          <span className="rounded-full bg-bh-surface-muted px-2 py-0.5 text-xs" data-testid="event-details-busy">
            {event.busy ? 'Busy' : 'Free'}
          </span>
        </div>

        {event.location && (
          <div className="flex items-center gap-2 text-bh-text-muted" data-testid="event-details-location">
            <MapPin className="size-4 shrink-0" aria-hidden />
            <span>{event.location}</span>
          </div>
        )}

        {safeMeetingUrl && (
          <a
            href={safeMeetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-bh-accent underline"
            data-testid="event-details-meeting-link"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            Join meeting
          </a>
        )}

        {recurring && (
          <div className="flex items-center gap-2 text-bh-text-muted" data-testid="event-details-recurrence">
            <Repeat className="size-4 shrink-0" aria-hidden />
            <span>Repeats{detail?.recurrenceUntil ? ` until ${new Date(detail.recurrenceUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}</span>
          </div>
        )}

        {event.description && (
          <p className="whitespace-pre-line text-bh-text" data-testid="event-details-description">{event.description}</p>
        )}
      </dl>

      <div className="mt-4">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-bh-text-muted">
          <Users className="size-3.5" aria-hidden />
          Participants
        </h4>
        {loadingDetail ? (
          <div className="mt-2 h-4 w-40 animate-pulse rounded bg-bh-surface-muted" data-testid="event-details-loading" />
        ) : detail && detail.participants.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm" data-testid="event-details-participants">
            {detail.participants.map((participant) => (
              <li key={participant.id} className="flex flex-wrap items-center gap-2" data-testid={`event-details-participant-${participant.id}`}>
                <span className="min-w-0 truncate">{participantName(participant)}</span>
                <span className="text-xs text-bh-text-muted">{humanize(participant.role)}</span>
                <span className="text-xs text-bh-text-dim">· {humanize(participant.response)}</span>
                {participant.materialAccessGranted && (
                  <span className="rounded bg-bh-surface-muted px-1.5 py-0.5 text-[10px] text-bh-text-muted">Materials shared</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-bh-text-muted" data-testid="event-details-participants-empty">Just you.</p>
        )}
      </div>

      {actionError && <p className="mt-4 text-sm text-bh-danger" data-testid="event-details-error">{actionError}</p>}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onEdit} data-testid="event-details-edit">Edit</Button>
        {!isCancelled && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancelEvent} data-testid="event-details-cancel-event">
            Cancel event
          </Button>
        )}
        {recurring && (
          <select
            className="h-8 rounded-md border border-bh-border bg-bh-surface px-2 text-xs"
            value={scope}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setScope(e.target.value as RecurrenceScope)}
            aria-label="Delete scope"
            data-testid="event-details-delete-scope"
          >
            <option value="this">This event</option>
            <option value="following">This and following</option>
            <option value="series">All events in the series</option>
          </select>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => onDelete(recurring ? scope : undefined)}
          className="text-bh-danger"
          data-testid="event-details-delete"
        >
          Delete
        </Button>
      </div>
    </section>
  )
}
