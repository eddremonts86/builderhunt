import { Lock, X } from 'lucide-react'
import { type CalendarFeedItemDto, isEventItem, isoDay, itemKey } from './CalendarView'

/**
 * Flat, day-grouped list rendering of the active range (plan: plans/UI Wave 3 "Extract a
 * route-driven multi-view Calendar shell").
 *
 * Two jobs: it is the desktop "list" view, and it is the mobile fallback for month/week/day —
 * `CalendarPage` always renders this below the `md` breakpoint regardless of the selected view,
 * because a 42-cell month grid (or an hour-by-hour day grid) is not usable at 320px. Reads the
 * exact same `items` the grid views do; no separate fetch.
 */

export interface CalendarAgendaProps {
  days: Date[]
  itemsByDay: Map<string, CalendarFeedItemDto[]>
  onDelete: (event: Extract<CalendarFeedItemDto, { kind: 'event' }>) => void
  onSelectProjection: (item: Exclude<CalendarFeedItemDto, { kind: 'event' }>) => void
  emptyMessage: string
}

function formatDayHeading(day: Date): string {
  return day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
}

export function CalendarAgenda({ days, itemsByDay, onDelete, onSelectProjection, emptyMessage }: CalendarAgendaProps) {
  const daysWithItems = days.filter((day) => (itemsByDay.get(isoDay(day)) ?? []).length > 0)

  if (daysWithItems.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-bh-text-muted" data-testid="calendar-agenda-empty">
        {emptyMessage}
      </p>
    )
  }

  return (
    <ul className="space-y-4" data-testid="calendar-agenda" aria-label="Agenda">
      {daysWithItems.map((day) => {
        const key = isoDay(day)
        const dayItems = itemsByDay.get(key) ?? []
        return (
          <li key={key}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-bh-text-muted">
              {formatDayHeading(day)}
            </h3>
            <ul className="space-y-1.5 rounded-lg border border-bh-border bg-bh-surface p-2">
              {dayItems.map((item) => (
                <li
                  key={itemKey(item)}
                  className="flex items-center gap-2 text-sm"
                  data-testid={isEventItem(item) ? `calendar-agenda-event-${item.id}` : `calendar-agenda-projection-${item.kind}`}
                >
                  <span className="w-16 shrink-0 tabular-nums text-xs text-bh-text-dim">{formatTime(item.startsAt)}</span>
                  {isEventItem(item) ? (
                    <>
                      <span className={`min-w-0 flex-1 truncate ${item.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>
                        {item.title}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete ${item.title}`}
                        onClick={() => onDelete(item)}
                        data-testid={`calendar-agenda-delete-${item.id}`}
                      >
                        <X className="size-3.5 text-bh-text-muted" aria-hidden />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelectProjection(item)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-bh-text-muted"
                      aria-label={`${item.title} — read-only, managed by the system`}
                    >
                      <Lock className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {item.title}
                        {item.estimateOnly ? ' (estimate)' : ''}
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}
