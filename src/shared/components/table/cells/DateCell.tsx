import { formatDistanceToNow } from '~/shared/lib/format'

import { EmptyCell } from './EmptyCell'

interface DateCellProps {
  /** An ISO string, a `Date`, or nothing. */
  value: string | Date | null | undefined
  /**
   * Show the time of day beside the date.
   *
   * For rows where "which day" is not enough — an incident timeline, a job run. Off by default:
   * on a list of profiles updated over two years, a minute-precise timestamp is noise in a 168px
   * column.
   */
  withTime?: boolean
}

/**
 * A relative value over an abbreviated absolute one. Never a raw ISO string, and never truncated.
 *
 * Two lines rather than one because they answer different questions and both get asked. "3d ago"
 * is what an operator scanning a queue needs and an absolute date makes them compute; "12 Aug 2026"
 * is what they need the moment they have to say it to somebody else, and a relative one makes
 * *them* compute. Showing one and hiding the other behind a tooltip picks a winner for a
 * disagreement that has none.
 *
 * The date column is a fixed 168px (`--tbl-col-date`) so neither line ever ellipsizes. A truncated
 * date is not a shortened date, it is a different date.
 */
export function DateCell({ value, withTime = false }: DateCellProps) {
  const date = toDate(value)
  // `null` and an unparseable string are the same fact to a reader: there is no date here. An
  // "Invalid Date" in a cell is a bug report the user cannot file.
  if (date === null) return <EmptyCell label="No date" />

  const iso = date.toISOString()
  return (
    <div className="min-w-0" data-testid="cell-date">
      {/* A machine-readable `datetime` alongside the human strings: the visible text is
          deliberately imprecise, and a `<time>` without it makes that imprecision the only
          version anything can read. */}
      <time className="tbl-cell-date-relative" dateTime={iso} data-testid="cell-date-relative">
        {formatDistanceToNow(date)}
      </time>
      <div className="tbl-cell-date-absolute" data-testid="cell-date-absolute">
        {formatAbsolute(date, withTime)}
      </div>
    </div>
  )
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * `12 Aug 2026`, in a pinned locale.
 *
 * Pinned rather than the visitor's, for two reasons that point the same way. `08/12/2026` means
 * two different days either side of the Atlantic and the abbreviated month removes the ambiguity
 * outright; and a visual-regression baseline captured on a machine with a different system locale
 * would diff against every date on the page. The app's own copy is English throughout.
 */
const ABSOLUTE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const ABSOLUTE_WITH_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

function formatAbsolute(date: Date, withTime: boolean): string {
  return (withTime ? ABSOLUTE_WITH_TIME : ABSOLUTE).format(date)
}
