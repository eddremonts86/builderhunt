import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Loader2, Plus, Search, X } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'
import { REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'
import { CalendarLayers, type CalendarLayerKey } from './CalendarLayers'
import { ProjectionDetails, type ProjectionItem } from './ProjectionDetails'
import { CalendarAgenda } from './CalendarAgenda'
import {
  CalendarView,
  isoDay,
  type CalendarEventDto,
  type CalendarFeedItemDto,
} from './CalendarView'

/**
 * Calendar page (plan: calendar-scheduling-interview-intelligence, Phase 3 "Build calendar feature
 * components"; plans/UI Wave 3 "Extract a route-driven multi-view Calendar shell").
 *
 * Renders month/week/day/list views over `/api/calendar/feed`, which merges the caller's own events
 * with read-only projections of background jobs and alerts (Phase 4 "Add calendar layer UI").
 *
 * It deliberately does NOT mount FullCalendar: the drag/resize interactions FullCalendar exists for
 * depend on the occurrence-materialization and reminder-rescheduling paths, and recurrence editing
 * is still series-only server-side (see `lib/calendar/service.ts`'s `not_implemented` scope guard).
 * Wiring FullCalendar before those are finished would produce a surface that looks interactive but
 * silently drops edits, so month/week/day share the same hand-rolled grid (`CalendarView`) and list
 * uses `CalendarAgenda` — both keep the same accessibility contract (dashed border + lock icon +
 * `aria-label` for read-only projections, a real delete button for events).
 *
 * `view`/`date`/`query` are optional and controlled: the route (`_dashboard/calendar/index.tsx`)
 * drives them from validated URL search params so a view survives a refresh or a shared link.
 * Left uncontrolled, they default to local state — this is what keeps this component testable
 * without a router context.
 */

export type CalendarViewKey = 'month' | 'week' | 'day' | 'list'

export interface CalendarFeedDto {
  items: CalendarFeedItemDto[]
  staleSources: string[]
}

export interface CalendarPageProps {
  /** Injected in tests; defaults to the real endpoints. */
  fetchFeed?: (range: { from: string; to: string }, layers: CalendarLayerKey[]) => Promise<CalendarFeedDto>
  createEvent?: (body: unknown) => Promise<{ ok: boolean; error?: string }>
  deleteEvent?: (id: string, version: number) => Promise<{ ok: boolean; error?: string }>
  /** Fixed "today" so the grid is deterministic under test. */
  today?: Date
  /** Controlled view/date/search — see the route wrapper. Uncontrolled (local state) when omitted. */
  view?: CalendarViewKey
  date?: Date
  query?: string
  onViewChange?: (view: CalendarViewKey) => void
  onDateChange?: (date: Date) => void
  onQueryChange?: (query: string) => void
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

function addDays(date: Date, delta: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + delta)
  return next
}

/** Six full weeks starting on the Monday on or before the 1st, so the grid never reflows between months. */
function monthGridDays(monthStart: Date): Date[] {
  const firstWeekday = (monthStart.getUTCDay() + 6) % 7
  const gridStart = addDays(monthStart, -firstWeekday)
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
}

/** The Monday on or before `date`, so a week always renders Mon–Sun regardless of which day it was opened on. */
function startOfWeek(date: Date): Date {
  const weekday = (date.getUTCDay() + 6) % 7
  return addDays(date, -weekday)
}

function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const LIST_WINDOW_DAYS = 30
const VIEW_OPTIONS: ReadonlyArray<{ key: CalendarViewKey; label: string }> = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
  { key: 'list', label: 'List' },
]

function supportedTimezones(): string[] {
  // `Intl.supportedValuesOf` is unavailable in older engines and in some SSR runtimes; a two-entry
  // fallback still lets the selector function, just without the full IANA list.
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone')
  } catch {
    // fall through
  }
  return ['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone]
}

// Matches Tailwind's `md` breakpoint (768px).
const MOBILE_BREAKPOINT_PX = 768

/**
 * True below the `md` breakpoint. Deliberately renders exactly one of
 * `CalendarView`/`CalendarAgenda` rather than both plus a CSS `hidden` class on the other: two
 * copies of the same event's title in the DOM at once — one merely `display:none` — still match a
 * plain-text query (`page.getByText(...)`), and `.first()` has no way to know which copy is the
 * one actually on screen. Defaults to `false` (desktop) on the server and on first client render
 * so hydration never has to reconcile a guess against the real viewport; `matchMedia` is guarded
 * for jsdom, which does not implement it, so every existing component test keeps rendering the
 * grid exactly as before.
 */
function useIsNarrowViewport(breakpointPx: number): boolean {
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`)
    const update = () => setIsNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [breakpointPx])
  return isNarrow
}

export function CalendarPage(props: CalendarPageProps = {}) {
  const fetchFeed = props.fetchFeed ?? defaultFetchFeed
  const createEventFn = props.createEvent ?? defaultCreateEvent
  const deleteEventFn = props.deleteEvent ?? defaultDeleteEvent
  const today = useMemo(() => props.today ?? new Date(), [props.today])

  const [localView, setLocalView] = useState<CalendarViewKey>('month')
  const [localDate, setLocalDate] = useState<Date>(today)
  const [localQuery, setLocalQuery] = useState('')
  const view = props.view ?? localView
  const activeDate = props.date ?? localDate
  const query = props.query ?? localQuery

  const setView = useCallback((next: CalendarViewKey) => {
    if (props.onViewChange) props.onViewChange(next)
    else setLocalView(next)
  }, [props])
  const setActiveDate = useCallback((next: Date) => {
    if (props.onDateChange) props.onDateChange(next)
    else setLocalDate(next)
  }, [props])
  const setQuery = useCallback((next: string) => {
    if (props.onQueryChange) props.onQueryChange(next)
    else setLocalQuery(next)
  }, [props])

  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const timezoneOptions = useMemo(() => supportedTimezones(), [])
  const isNarrowViewport = useIsNarrowViewport(MOBILE_BREAKPOINT_PX)

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

  // Every view resolves to a bounded [rangeFrom, rangeTo) plus the concrete day cells (if any) it
  // renders — month/week/day are grids over `days`; list has no grid, just a rolling window.
  const { days, rangeFrom, rangeTo, columns, weekdayLabels, dimPredicate, viewLabel } = useMemo(() => {
    if (view === 'week') {
      const weekStart = startOfWeek(activeDate)
      const weekDaysList = weekDays(weekStart)
      return {
        days: weekDaysList,
        rangeFrom: weekDaysList[0],
        rangeTo: addDays(weekDaysList[6], 1),
        columns: 7,
        weekdayLabels: WEEKDAY_LABELS,
        dimPredicate: undefined as ((d: Date) => boolean) | undefined,
        viewLabel: 'Week view',
      }
    }
    if (view === 'day') {
      const dayStart = new Date(Date.UTC(activeDate.getUTCFullYear(), activeDate.getUTCMonth(), activeDate.getUTCDate()))
      return {
        days: [dayStart],
        rangeFrom: dayStart,
        rangeTo: addDays(dayStart, 1),
        columns: 1,
        weekdayLabels: [dayStart.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })],
        dimPredicate: undefined,
        viewLabel: 'Day view',
      }
    }
    if (view === 'list') {
      const windowStart = new Date(Date.UTC(activeDate.getUTCFullYear(), activeDate.getUTCMonth(), activeDate.getUTCDate()))
      return {
        days: Array.from({ length: LIST_WINDOW_DAYS }, (_, index) => addDays(windowStart, index)),
        rangeFrom: windowStart,
        rangeTo: addDays(windowStart, LIST_WINDOW_DAYS),
        columns: 0,
        weekdayLabels: [] as string[],
        dimPredicate: undefined,
        viewLabel: 'List view',
      }
    }
    const monthStart = startOfMonth(activeDate)
    const monthDays = monthGridDays(monthStart)
    return {
      days: monthDays,
      rangeFrom: monthDays[0],
      rangeTo: addDays(monthDays[monthDays.length - 1], 1),
      columns: 7,
      weekdayLabels: WEEKDAY_LABELS,
      dimPredicate: (d: Date) => d.getUTCMonth() !== monthStart.getUTCMonth(),
      viewLabel: 'Month view',
    }
  }, [view, activeDate])

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

  const visibleItems = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return items
    return items.filter((item) => item.title.toLowerCase().includes(trimmed))
  }, [items, query])

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarFeedItemDto[]>()
    for (const item of visibleItems) {
      const key = item.startsAt.slice(0, 10)
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return map
  }, [visibleItems])

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

  function handleSelectProjection(item: ProjectionItem) {
    setSelectedProjection(item)
  }

  function step(delta: number) {
    if (view === 'month') setActiveDate(addMonths(activeDate, delta))
    else if (view === 'week') setActiveDate(addDays(activeDate, delta * 7))
    else if (view === 'list') setActiveDate(addDays(activeDate, delta * LIST_WINDOW_DAYS))
    else setActiveDate(addDays(activeDate, delta))
  }

  const rangeLabel = view === 'month'
    ? startOfMonth(activeDate).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : view === 'week'
      ? `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${days[days.length - 1].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
      : view === 'day'
        ? days[0].toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        : `Next ${LIST_WINDOW_DAYS} days from ${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`

  const emptyMessage = layers.length === 0
    // Distinguishing these matters: "nothing scheduled" when the user has simply switched every
    // layer off would look like their data disappeared.
    ? 'No layers selected. Turn one on to see your calendar.'
    : query.trim()
      ? `Nothing matches "${query.trim()}" in this range.`
      : 'Nothing scheduled in this range yet. Create your first event to get started.'

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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-bh-border p-0.5" role="tablist" aria-label="Calendar view">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={view === option.key}
              onClick={() => setView(option.key)}
              data-testid={`calendar-view-${option.key}`}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bh-accent ${
                view === option.key ? 'bg-bh-accent-soft text-bh-text' : 'text-bh-text-muted hover:text-bh-text'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => step(-1)} data-testid="calendar-prev">Previous</Button>
          <Button variant="secondary" size="sm" onClick={() => setActiveDate(today)} data-testid="calendar-today">Today</Button>
          <Button variant="secondary" size="sm" onClick={() => step(1)} data-testid="calendar-next">Next</Button>
        </div>

        <h2 className="text-lg font-medium" data-testid="calendar-range-label">{rangeLabel}</h2>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-bh-text-dim" aria-hidden />
            <Input
              value={query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
              placeholder="Search this range"
              aria-label="Search calendar items"
              className="w-48 pl-8"
              data-testid="calendar-search-input"
            />
          </div>
          <label className="flex min-w-0 items-center gap-1.5 text-xs text-bh-text-muted">
            <span className="shrink-0">Timezone</span>
            <select
              aria-label="Display timezone"
              value={timezone}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTimezone(e.target.value)}
              className="h-8 w-32 truncate rounded-md border border-bh-border bg-bh-surface px-2 text-xs"
              data-testid="calendar-timezone-select"
            >
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loadError && <p className="mb-4 text-sm text-bh-danger" data-testid="calendar-load-error">{loadError}</p>}

      {loading ? (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-bh-border bg-bh-border" data-testid="calendar-skeleton">
          {Array.from({ length: 42 }, (_, index) => (
            <div key={index} className="min-h-24 animate-pulse bg-bh-surface" />
          ))}
        </div>
      ) : isNarrowViewport || view === 'list' ? (
        // Below the `md` breakpoint the agenda always wins regardless of the selected view — a
        // 42-cell month grid (or an hour-by-hour day grid) is not usable at 320px — and it is the
        // desktop rendering of "list" too. Exactly one tree renders; see `useIsNarrowViewport`.
        <CalendarAgenda days={days} itemsByDay={itemsByDay} onDelete={handleDelete} onSelectProjection={handleSelectProjection} emptyMessage={emptyMessage} />
      ) : (
        <CalendarView
          days={days}
          columns={columns}
          weekdayLabels={weekdayLabels}
          itemsByDay={itemsByDay}
          isDimmed={dimPredicate}
          viewLabel={viewLabel}
          onDelete={handleDelete}
          onSelectProjection={handleSelectProjection}
        />
      )}

      {!loading && visibleItems.length === 0 && !loadError && view !== 'list' && (
        <p className="mt-6 text-center text-sm text-bh-text-muted" data-testid="calendar-empty">
          {emptyMessage}
        </p>
      )}
    </div>
  )
}
