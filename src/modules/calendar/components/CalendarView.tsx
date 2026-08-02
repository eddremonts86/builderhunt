import { Lock, X } from 'lucide-react'
import type { ProjectionItem } from './ProjectionDetails'

/**
 * Grid renderer shared by the month, week, and day views (plan: plans/UI Wave 3 "Extract a
 * route-driven multi-view Calendar shell").
 *
 * Deliberately NOT FullCalendar: `CalendarPage.tsx`'s own long-standing rationale for staying off
 * FullCalendar (drag/resize would look interactive while silently dropping edits — recurrence
 * editing is still series-only, see `lib/calendar/service.ts`) still holds for this pass. Month,
 * week, and day are all the same grid at a different day count and column width, so extracting the
 * cell-rendering logic once and parameterizing the day list is enough to add the new views without
 * a new rendering engine — and it keeps every existing accessibility contract (dashed border + lock
 * icon + `aria-label` for read-only projections, a real delete button for events) intact rather than
 * re-deriving it from FullCalendar's own DOM.
 */

export interface CalendarEventDto {
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

export type CalendarFeedItemDto = CalendarEventDto | (ProjectionItem & { editable: false })

export function isEventItem(item: CalendarFeedItemDto): item is CalendarEventDto {
  return item.kind === 'event'
}

/** Projections carry no row id, so their React key is the source identity the feed already made unique. */
export function itemKey(item: CalendarFeedItemDto): string {
  return isEventItem(item) ? item.id : `${item.kind}:${item.sourceId}`
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export interface CalendarViewProps {
  /** The cells to render, left to right, wrapping every `columns` into a new row. */
  days: Date[]
  columns: number
  weekdayLabels: string[]
  itemsByDay: Map<string, CalendarFeedItemDto[]>
  /** Month view dims days outside the active month; week/day view has nothing to dim. */
  isDimmed?: (day: Date) => boolean
  viewLabel: string
  onDelete: (event: CalendarEventDto) => void
  onSelectProjection: (item: ProjectionItem) => void
  /** Opening an event's detail panel; optional so the grid renders standalone in isolation tests. */
  onSelectEvent?: (event: CalendarEventDto) => void
}

export function CalendarView({
  days,
  columns,
  weekdayLabels,
  itemsByDay,
  isDimmed,
  viewLabel,
  onDelete,
  onSelectProjection,
  onSelectEvent,
}: CalendarViewProps) {
  return (
    <div
      role="grid"
      aria-label={viewLabel}
      className="overflow-hidden rounded-xl border border-bh-border"
      data-testid="calendar-grid"
    >
      {/**
        * `role="row"` and `role="columnheader"` are not decoration here.
        * `role="grid"` requires rows between it and its cells — without them a screen reader announces a grid
        * with no structure and arrow-key navigation has nothing to move along. Caught by the axe gate the
        * moment `/calendar` was added to its route matrix (plans/UI Wave 8), as two `critical` violations:
        * `aria-required-children` on the grid and `aria-required-parent` on all 42 day cells.
        */}
      <div
        role="row"
        className="grid border-b border-bh-border bg-bh-surface-muted"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {weekdayLabels.map((label, index) => (
          <div
            key={`${label}-${index}`}
            role="columnheader"
            className="px-2 py-2 text-center text-xs font-medium text-bh-text-muted"
          >
            {label}
          </div>
        ))}
      </div>
      {/* One `role="row"` per week. `display: contents` keeps the CSS grid layout identical — the row exists in
          the accessibility tree and not in the visual box model, which is exactly the split that was missing. */}
      <div className="grid gap-px bg-bh-border" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {chunkIntoRows(days, columns).map((week) => (
        <div key={isoDay(week[0])} role="row" style={{ display: 'contents' }}>
        {week.map((day) => {
          const key = isoDay(day)
          const dayItems = itemsByDay.get(key) ?? []
          const dimmed = isDimmed?.(day) ?? false
          return (
            <div
              key={key}
              role="gridcell"
              data-testid={`calendar-day-${key}`}
              className={`min-h-24 bg-bh-surface p-1.5 ${dimmed ? 'opacity-45' : ''}`}
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
                        <button
                          type="button"
                          onClick={() => onSelectEvent?.(item)}
                          className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bh-accent"
                          data-testid={`calendar-event-open-${item.id}`}
                        >
                          {item.title}
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${item.title}`}
                          onClick={() => onDelete(item)}
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          data-testid={`calendar-delete-${item.id}`}
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectProjection(item)}
                        className="flex w-full items-start gap-1 rounded border border-dashed border-bh-border-strong bg-bh-surface-2 px-1.5 py-1 text-left text-xs text-bh-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-bh-accent"
                        data-testid={`calendar-projection-${item.kind}`}
                        aria-label={`${item.title} — read-only, managed by the system`}
                      >
                        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          {item.title}
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
        ))}
      </div>
    </div>
  )
}

/**
 * Splits a flat day list into weeks.
 *
 * `columns` rather than a hard-coded 7 because the same component renders the week view, where one row holds
 * every day it shows. A trailing partial row is kept whole rather than padded: a padded cell would be a
 * gridcell with no date behind it.
 */
function chunkIntoRows(days: readonly Date[], columns: number): Date[][] {
  const rows: Date[][] = []
  for (let index = 0; index < days.length; index += columns) {
    rows.push(days.slice(index, index + columns))
  }
  return rows
}
