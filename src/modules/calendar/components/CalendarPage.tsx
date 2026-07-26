import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Loader2, Plus, X } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'
import { REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'

/**
 * Calendar page (plan: calendar-scheduling-interview-intelligence, Phase 3 "Build calendar feature
 * components").
 *
 * Renders a month grid and a create form against the real `/api/calendar/events` endpoints. It
 * deliberately does NOT mount FullCalendar yet: the drag/resize interactions FullCalendar exists
 * for depend on the occurrence-materialization and reminder-rescheduling paths, so wiring it
 * before those are finished would produce a surface that looks interactive but silently drops
 * edits. This grid is honest about what currently works — read, create, cancel, delete.
 */

interface CalendarEventDto {
  id: string
  title: string
  startsAt: string
  endsAt: string
  type: string
  status: string
  allDay: boolean
  busy: boolean
  version: number
  location: string | null
  meetingUrl: string | null
  description: string | null
}

export interface CalendarPageProps {
  /** Injected in tests; defaults to the real endpoints. */
  fetchEvents?: (range: { from: string; to: string }) => Promise<CalendarEventDto[]>
  createEvent?: (body: unknown) => Promise<{ ok: boolean; error?: string }>
  deleteEvent?: (id: string, version: number) => Promise<{ ok: boolean; error?: string }>
  /** Fixed "today" so the grid is deterministic under test. */
  today?: Date
}

async function defaultFetchEvents(range: { from: string; to: string }) {
  const response = await fetch(`/api/calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
  if (!response.ok) throw new Error('load_failed')
  const body = await response.json()
  return (body.events ?? []) as CalendarEventDto[]
}

async function defaultCreateEvent(body: unknown) {
  const response = await fetch('/api/calendar/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.ok) return { ok: true as const }
  const payload = await response.json().catch(() => ({}))
  return { ok: false as const, error: String(payload.error ?? 'invalid_input') }
}

async function defaultDeleteEvent(id: string, version: number) {
  const response = await fetch(`/api/calendar/events/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
  if (response.ok) return { ok: true as const }
  const payload = await response.json().catch(() => ({}))
  return { ok: false as const, error: String(payload.error ?? 'invalid_input') }
}

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function addMonths(date: Date, delta: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1))
}

/** Six full weeks starting on the Monday on or before the 1st, so the grid never reflows between months. */
function monthGridDays(monthStart: Date): Date[] {
  const firstWeekday = (monthStart.getUTCDay() + 6) % 7
  const gridStart = new Date(monthStart)
  gridStart.setUTCDate(gridStart.getUTCDate() - firstWeekday)
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart)
    day.setUTCDate(gridStart.getUTCDate() + index)
    return day
  })
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10)
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function CalendarPage(props: CalendarPageProps = {}) {
  const fetchEvents = props.fetchEvents ?? defaultFetchEvents
  const createEventFn = props.createEvent ?? defaultCreateEvent
  const deleteEventFn = props.deleteEvent ?? defaultDeleteEvent
  const today = useMemo(() => props.today ?? new Date(), [props.today])

  const [monthStart, setMonthStart] = useState(() => startOfMonth(today))
  const [events, setEvents] = useState<CalendarEventDto[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [title, setTitle] = useState('')
  const [date, setDate] = useState(isoDay(today))
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('09:30')
  const [description, setDescription] = useState('')
  const [reminderOffset, setReminderOffset] = useState<number | null>(30)

  const days = useMemo(() => monthGridDays(monthStart), [monthStart])
  const rangeFrom = days[0]
  const rangeTo = useMemo(() => {
    const end = new Date(days[days.length - 1])
    end.setUTCDate(end.getUTCDate() + 1)
    return end
  }, [days])

  // Every setState here happens after an await, never synchronously in the effect body — a
  // synchronous one would cascade an extra render on mount (react-hooks/set-state-in-effect).
  const load = useCallback(async () => {
    try {
      const rows = await fetchEvents({ from: rangeFrom.toISOString(), to: rangeTo.toISOString() })
      setEvents(rows)
      setLoadError(null)
    } catch {
      setLoadError('We could not load your calendar. Try again in a moment.')
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [fetchEvents, rangeFrom, rangeTo])

  useEffect(() => {
    let cancelled = false
    void fetchEvents({ from: rangeFrom.toISOString(), to: rangeTo.toISOString() })
      .then((rows) => {
        if (cancelled) return
        setEvents(rows)
        setLoadError(null)
      })
      .catch(() => {
        if (cancelled) return
        setLoadError('We could not load your calendar. Try again in a moment.')
        setEvents([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetchEvents, rangeFrom, rangeTo])

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventDto[]>()
    for (const event of events) {
      const key = event.startsAt.slice(0, 10)
      map.set(key, [...(map.get(key) ?? []), event])
    }
    return map
  }, [events])

  async function handleCreate(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const result = await createEventFn({
        type: 'personal',
        title,
        description: description || undefined,
        startsAt: new Date(`${date}T${startTime}:00Z`).toISOString(),
        endsAt: new Date(`${date}T${endTime}:00Z`).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        allDay: false,
        busy: true,
        reminders: reminderOffset === null ? [] : [{ channel: 'in_app', offsetMinutes: reminderOffset }],
        participants: [],
        // The user has seen the grid; a personal overlap is theirs to allow.
        acknowledgeOverlapWarning: true,
      })
      if (!result.ok) {
        setFormError(result.error === 'slot_unavailable'
          ? 'That time conflicts with an existing booking.'
          : 'We could not save that event. Check the times and try again.')
        return
      }
      setFormOpen(false)
      setTitle('')
      setDescription('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(event: CalendarEventDto) {
    const result = await deleteEventFn(event.id, event.version)
    if (result.ok) await load()
    else setLoadError('We could not delete that event. Refresh and try again.')
  }

  const monthLabel = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-8" data-testid="calendar-page">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CalendarDays className="size-6" aria-hidden />
            Calendar
          </h1>
          <p className="mt-1 text-sm text-bh-text-muted">Your private schedule. Only you and people you invite can see these events.</p>
        </div>
        <Button onClick={() => setFormOpen((open) => !open)} data-testid="calendar-new-event">
          {formOpen ? <X className="mr-2 size-4" aria-hidden /> : <Plus className="mr-2 size-4" aria-hidden />}
          {formOpen ? 'Close' : 'New event'}
        </Button>
      </header>

      {formOpen && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4" data-testid="calendar-event-form">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="cal-title">Title</Label>
              <Input id="cal-title" value={title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} required maxLength={200} data-testid="calendar-title-input" />
            </div>
            <div>
              <Label htmlFor="cal-date">Date</Label>
              <Input id="cal-date" type="date" value={date} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDate(e.target.value)} required data-testid="calendar-date-input" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="cal-start">Starts</Label>
                <Input id="cal-start" type="time" value={startTime} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartTime(e.target.value)} required data-testid="calendar-start-input" />
              </div>
              <div>
                <Label htmlFor="cal-end">Ends</Label>
                <Input id="cal-end" type="time" value={endTime} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndTime(e.target.value)} required data-testid="calendar-end-input" />
              </div>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cal-description">Notes (private)</Label>
              <textarea
                id="cal-description"
                className="w-full rounded-md border border-bh-border bg-bh-surface px-3 py-2 text-sm"
                value={description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                maxLength={5000}
                rows={2}
              />
            </div>
            <div>
              <Label htmlFor="cal-reminder">Reminder</Label>
              <select
                id="cal-reminder"
                className="h-9 w-full rounded-md border border-bh-border bg-bh-surface px-3 text-sm"
                value={reminderOffset ?? ''}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setReminderOffset(e.target.value === '' ? null : Number(e.target.value))}
                data-testid="calendar-reminder-select"
              >
                <option value="">No reminder</option>
                {REMINDER_OFFSET_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes === 0 ? 'At start time' : `${minutes} minutes before`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {formError && <p className="mt-3 text-sm text-bh-danger" data-testid="calendar-form-error">{formError}</p>}
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={saving} data-testid="calendar-save-event">
              {saving && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
              Save event
            </Button>
          </div>
        </form>
      )}

      <div className="mb-4 flex items-center justify-between">
        <Button variant="secondary" size="sm" onClick={() => setMonthStart((m) => addMonths(m, -1))} data-testid="calendar-prev-month">Previous</Button>
        <h2 className="text-lg font-medium" data-testid="calendar-month-label">{monthLabel}</h2>
        <Button variant="secondary" size="sm" onClick={() => setMonthStart((m) => addMonths(m, 1))} data-testid="calendar-next-month">Next</Button>
      </div>

      {loadError && <p className="mb-4 text-sm text-bh-danger" data-testid="calendar-load-error">{loadError}</p>}

      {loading ? (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-bh-border bg-bh-border" data-testid="calendar-skeleton">
          {Array.from({ length: 42 }, (_, index) => (
            <div key={index} className="min-h-24 animate-pulse bg-bh-surface" />
          ))}
        </div>
      ) : (
        <div role="grid" aria-label="Month view" className="overflow-hidden rounded-xl border border-bh-border" data-testid="calendar-grid">
          <div className="grid grid-cols-7 border-b border-bh-border bg-bh-surface-muted">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="px-2 py-2 text-center text-xs font-medium text-bh-text-muted">{label}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-bh-border">
            {days.map((day) => {
              const key = isoDay(day)
              const dayEvents = eventsByDay.get(key) ?? []
              const inMonth = day.getUTCMonth() === monthStart.getUTCMonth()
              return (
                <div
                  key={key}
                  role="gridcell"
                  data-testid={`calendar-day-${key}`}
                  className={`min-h-24 bg-bh-surface p-1.5 ${inMonth ? '' : 'opacity-45'}`}
                >
                  <div className="mb-1 text-xs font-medium text-bh-text-muted">{day.getUTCDate()}</div>
                  <ul className="space-y-1">
                    {dayEvents.map((event) => (
                      <li key={event.id}>
                        <div
                          className={`group flex items-start justify-between gap-1 rounded px-1.5 py-1 text-xs ${
                            event.status === 'cancelled' ? 'bg-bh-surface-muted line-through opacity-60' : 'bg-bh-accent-subtle'
                          }`}
                          data-testid={`calendar-event-${event.id}`}
                        >
                          <span className="min-w-0 flex-1 truncate">{event.title}</span>
                          <button
                            type="button"
                            aria-label={`Delete ${event.title}`}
                            onClick={() => handleDelete(event)}
                            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            data-testid={`calendar-delete-${event.id}`}
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!loading && events.length === 0 && !loadError && (
        <p className="mt-6 text-center text-sm text-bh-text-muted" data-testid="calendar-empty">
          Nothing scheduled this month yet. Create your first event to get started.
        </p>
      )}
    </div>
  )
}
