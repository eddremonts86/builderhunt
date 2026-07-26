import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Loader2, Lock, Plus, X } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'
import { REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'
import { CalendarLayers, type CalendarLayerKey } from './CalendarLayers'
import { ProjectionDetails, type ProjectionItem } from './ProjectionDetails'

/**
 * Calendar page (plan: calendar-scheduling-interview-intelligence, Phase 3 "Build calendar feature
 * components").
 *
 * Renders a month grid and a create form over `/api/calendar/feed`, which merges the caller's own
 * events with read-only projections of background jobs and alerts (Phase 4 "Add calendar layer UI").
 *
 * It deliberately does NOT mount FullCalendar: the drag/resize interactions FullCalendar exists for
 * depend on the occurrence-materialization and reminder-rescheduling paths, so wiring it before
 * those are finished would produce a surface that looks interactive but silently drops edits. This
 * grid is honest about what currently works — read, create, cancel, delete.
 *
 * The editable/read-only split is carried by the DTO, not by this component's judgement: only
 * `kind === 'event'` items get a delete control, and every other kind renders with a dashed border
 * plus a lock icon. Shape and icon rather than colour alone, because the distinction is "you can
 * change this" versus "you cannot", which must survive greyscale and high-contrast rendering.
 */

interface CalendarEventDto {
  kind: 'event'
  editable: true
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

type CalendarFeedItemDto = CalendarEventDto | (ProjectionItem & { editable: false })

interface CalendarFeedDto {
  items: CalendarFeedItemDto[]
  staleSources: string[]
}

function isEventItem(item: CalendarFeedItemDto): item is CalendarEventDto {
  return item.kind === 'event'
}

/** Projections carry no row id, so their React key is the source identity the feed already made unique. */
function itemKey(item: CalendarFeedItemDto): string {
  return isEventItem(item) ? item.id : `${item.kind}:${item.sourceId}`
}

export interface CalendarPageProps {
  /** Injected in tests; defaults to the real endpoints. */
  fetchFeed?: (range: { from: string; to: string }, layers: CalendarLayerKey[]) => Promise<CalendarFeedDto>
  createEvent?: (body: unknown) => Promise<{ ok: boolean; error?: string }>
  deleteEvent?: (id: string, version: number) => Promise<{ ok: boolean; error?: string }>
  /** Fixed "today" so the grid is deterministic under test. */
  today?: Date
}

async function defaultFetchFeed(range: { from: string; to: string }, layers: CalendarLayerKey[]): Promise<CalendarFeedDto> {
  // No layers selected means no query at all rather than a fetch that returns nothing — the server
  // would do the work and the user asked for none of it.
  if (layers.length === 0) return { items: [], staleSources: [] }
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  // Repeated params, matching the contract's array type; a comma-joined string would let an invalid
  // layer through the client and only fail server-side.
  for (const layer of layers) params.append('layers', layer)
  const response = await fetch(`/api/calendar/feed?${params.toString()}`)
  if (!response.ok) throw new Error('load_failed')
  const body = await response.json()
  return { items: (body.items ?? []) as CalendarFeedItemDto[], staleSources: (body.staleSources ?? []) as string[] }
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
  const fetchFeed = props.fetchFeed ?? defaultFetchFeed
  const createEventFn = props.createEvent ?? defaultCreateEvent
  const deleteEventFn = props.deleteEvent ?? defaultDeleteEvent
  const today = useMemo(() => props.today ?? new Date(), [props.today])

  const [monthStart, setMonthStart] = useState(() => startOfMonth(today))
  const [items, setItems] = useState<CalendarFeedItemDto[]>([])
  const [staleSources, setStaleSources] = useState<string[]>([])
  const [layers, setLayers] = useState<CalendarLayerKey[]>(['events', 'jobs', 'alerts'])
  const [selectedProjection, setSelectedProjection] = useState<ProjectionItem | null>(null)
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
      const feed = await fetchFeed({ from: rangeFrom.toISOString(), to: rangeTo.toISOString() }, layers)
      setItems(feed.items)
      setStaleSources(feed.staleSources)
      setLoadError(null)
    } catch {
      setLoadError('We could not load your calendar. Try again in a moment.')
      setItems([])
      setStaleSources([])
    } finally {
      setLoading(false)
    }
  }, [fetchFeed, rangeFrom, rangeTo, layers])

  useEffect(() => {
    let cancelled = false
    void fetchFeed({ from: rangeFrom.toISOString(), to: rangeTo.toISOString() }, layers)
      .then((feed) => {
        if (cancelled) return
        setItems(feed.items)
        setStaleSources(feed.staleSources)
        setLoadError(null)
      })
      .catch(() => {
        if (cancelled) return
        setLoadError('We could not load your calendar. Try again in a moment.')
        setItems([])
        setStaleSources([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetchFeed, rangeFrom, rangeTo, layers])

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarFeedItemDto[]>()
    for (const item of items) {
      const key = item.startsAt.slice(0, 10)
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return map
  }, [items])

  function toggleLayer(key: CalendarLayerKey) {
    // Closing the detail panel on a layer change avoids showing details for an item that the new
    // filter no longer includes — a panel describing something not on screen reads as a bug.
    setSelectedProjection(null)
    setLayers((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]))
  }

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

      <CalendarLayers active={layers} onToggle={toggleLayer} staleSources={staleSources} />

      {selectedProjection && (
        <ProjectionDetails item={selectedProjection} onClose={() => setSelectedProjection(null)} />
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
              const dayItems = itemsByDay.get(key) ?? []
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
                    {dayItems.map((item) => (
                      <li key={itemKey(item)}>
                        {isEventItem(item) ? (
                          <div
                            className={`group flex items-start justify-between gap-1 rounded border border-transparent px-1.5 py-1 text-xs ${
                              item.status === 'cancelled' ? 'bg-bh-surface-2 line-through opacity-60' : 'bg-bh-accent-soft'
                            }`}
                            data-testid={`calendar-event-${item.id}`}
                          >
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                            <button
                              type="button"
                              aria-label={`Delete ${item.title}`}
                              onClick={() => handleDelete(item)}
                              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              data-testid={`calendar-delete-${item.id}`}
                            >
                              <X className="size-3" aria-hidden />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelectedProjection(item)}
                            // Dashed border + lock icon, not a colour swap: the difference being
                            // encoded is "you can move this" versus "you cannot", which has to
                            // survive greyscale and high-contrast rendering.
                            className="flex w-full items-start gap-1 rounded border border-dashed border-bh-border-strong bg-bh-surface-2 px-1.5 py-1 text-left text-xs text-bh-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bh-accent"
                            data-testid={`calendar-projection-${item.kind}`}
                            aria-label={`${item.title} — read-only, managed by the system`}
                          >
                            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">
                              {item.title}
                              {/* Spelled out rather than implied by styling, so the constraint is
                                  readable by a screen reader and in a printout. */}
                              {item.estimateOnly ? ' (estimate)' : ''}
                            </span>
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!loading && items.length === 0 && !loadError && (
        <p className="mt-6 text-center text-sm text-bh-text-muted" data-testid="calendar-empty">
          {layers.length === 0
            // Distinguishing these matters: "nothing scheduled" when the user has simply switched
            // every layer off would look like their data disappeared.
            ? 'No layers selected. Turn one on to see your calendar.'
            : 'Nothing scheduled this month yet. Create your first event to get started.'}
        </p>
      )}
    </div>
  )
}
