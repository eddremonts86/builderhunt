// table-surface-sr-only: the accessible equivalent of a chart — the same series the bars draw. It
// carries semantics and no visible chrome on purpose: styling a `.sr-only` table would be styling
// something nobody can see, and the visual system deliberately has nothing to say about it.
import * as React from 'react'

/**
 * The one bar chart on this dashboard, and the one place its accessible equivalent is written
 * (plans/ui-dashboard Wave 7, "shared visualization" — extracted early because three widgets were
 * about to duplicate it).
 *
 * ## Why the table is part of the primitive
 *
 * Structural problem 9 in the spec is "charts omit equivalent data". The reliable fix is not a rule
 * that every chart author remembers to add a table; it is a chart that cannot be rendered without
 * one. `ActivityWidget` grew its table by hand, and the second and third chart would each have grown
 * their own version — or not.
 *
 * The bars are `aria-hidden` and the table is `sr-only`, so the series is announced exactly once, in
 * a structure a screen-reader user can navigate by column rather than as a run of numbers.
 *
 * ## Exact values on every bar, not on hover
 *
 * A tooltip is one readable number. Every bar carries its count in the visible layout, which is also
 * what makes the chart legible in a screenshot, at 400% zoom, and on a touch device where hover does
 * not exist.
 *
 * ## Zero is drawn as zero
 *
 * A minimum bar height would make an empty day indistinguishable from a quiet one at a glance. Days
 * with a count get a 6% floor so a single event still paints something; days with none get nothing,
 * and the track behind them shows the gap.
 */

export interface BarPoint {
  /** Stable key and the table's row header — a plain calendar date or a short label. */
  key: string
  /** Short axis label. Kept separate from `key` so a date can be shown as a weekday. */
  label: string
  value: number
}

export interface BarSeriesProps {
  points: readonly BarPoint[]
  /** Describes the series in the table caption. A chart nobody can read needs a sentence, not a title. */
  caption: string
  /** Column header for the value, e.g. "Builders tracked". */
  valueLabel: string
  /** Rendered under the chart, and appended to the caption. Absolute time, never relative. */
  generatedAt?: string
  /** Height of the plot area. Kept small: this is a widget, not a report. */
  className?: string
}

function formatGeneratedAt(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function BarSeries({ points, caption, valueLabel, generatedAt, className = '' }: BarSeriesProps) {
  const max = Math.max(1, ...points.map((point) => point.value))
  const total = points.reduce((sum, point) => sum + point.value, 0)
  const peakIndex = total > 0
    ? points.reduce((best, point, index, all) => (point.value > all[best].value ? index : best), 0)
    : -1
  const generated = formatGeneratedAt(generatedAt)

  return (
    <div className={className}>
      <div className="flex items-end justify-between gap-1 px-2 pt-2" aria-hidden="true">
        {points.map((point, index) => {
          const isPeak = index === peakIndex
          const heightPct = point.value === 0 ? 0 : Math.max(6, Math.round((point.value / max) * 100))
          return (
            <div key={point.key} className="flex flex-1 flex-col items-center gap-1.5">
              <span className={`text-[11px] tabular-nums ${isPeak ? 'font-semibold text-bh-text' : 'text-bh-text-dim'}`}>
                {point.value}
              </span>
              <div className="relative flex h-24 w-full max-w-[28px] items-end rounded-t-md bg-bh-bg-alt sm:max-w-[36px]">
                <div
                  className={`w-full rounded-t-md transition-all duration-500 ease-out motion-reduce:transition-none ${
                    isPeak ? 'bg-bh-accent-soft bg-striped-terracotta' : 'bg-bh-border-strong bg-striped-neutral'
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-bh-text-dim">{point.label}</span>
            </div>
          )
        })}
      </div>

      <table className="sr-only">
        <caption>{caption}{generated ? ` Generated ${generated}.` : ''}</caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">{valueLabel}</th></tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.key}>
              <th scope="row">{point.key}</th>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row">Total</th><td>{total}</td></tr>
        </tfoot>
      </table>

      {generated && <p className="mt-3 text-[11px] text-bh-text-dim">As of {generated}</p>}
    </div>
  )
}

/** Weekday label for a `YYYY-MM-DD` bucket key, in UTC to match the boundary the server used. */
export function utcWeekdayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate
  return date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
}
