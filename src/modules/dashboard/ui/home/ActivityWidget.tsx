import * as React from 'react'

/**
 * The recency chart's **body only**. `WidgetFrame` owns the header, the empty state, the failure
 * states and the staleness caption (plans/ui-dashboard Wave 0, "Distinguish every widget state").
 *
 * That split is the point of the frame: this component is now unreachable without data in hand, so
 * there is no path where a caught error renders as "nothing to show".
 *
 * ## What this chart is
 *
 * Tracked builders grouped by the UTC day a source last saw them active. It was titled "Weekly
 * Activity", captioned "Builders active per day", and its empty state said "No tracked builders have
 * **shipped**" — all three describing event volume. The data is `builder_identities.lastSeenAt`, one
 * timestamp per tracked identity, so every builder falls in exactly one bucket and the bars sum to
 * the "Seen active" metric beside them. It is a **recency histogram**, and a reader who took the old
 * caption literally would have concluded a builder shown on Tuesday shipped on Tuesday and not since.
 *
 * A chart also has to be readable without being seen, so every bar carries its exact count in the
 * visible layout and the series is repeated as a real `<table>` — the accessible equivalent the spec
 * asks for (structural problem 9). Visually hidden rather than absent: an equivalent nobody can reach
 * is not an equivalent.
 */

export interface DailyActivityPoint {
  date: string
  label: string
  count: number
}

/** Absolute, because a caption reading "2 hours ago" is where a stalled projection hides. */
function formatGeneratedAt(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ActivityWidget({
  points, generatedAt,
}: {
  points: readonly DailyActivityPoint[]
  generatedAt?: string
}) {
  const max = Math.max(1, ...points.map((p) => p.count))
  const total = points.reduce((sum, p) => sum + p.count, 0)
  const peakIndex = total > 0
    ? points.reduce((best, p, i, arr) => (p.count > arr[best].count ? i : best), 0)
    : -1
  const generated = formatGeneratedAt(generatedAt)

  return (
    <>
      <p className="-mt-2 mb-4 text-xs font-light text-bh-text-muted">
        Tracked builders by the day a source last saw them active. Each builder counts once.
      </p>

      <div className="flex items-end justify-between gap-1 px-2 pt-2" aria-hidden="true">
        {points.map((point, index) => {
          const isPeak = index === peakIndex
          // Floor of 6% so a day with one builder still paints a visible stub instead of a line
          // indistinguishable from zero.
          const heightPct = point.count === 0 ? 0 : Math.max(6, Math.round((point.count / max) * 100))
          return (
            <div key={point.date} className="flex flex-1 flex-col items-center gap-1.5">
              {/* Exact value on every bar, not only the peak: a chart whose numbers are readable
                  from one tooltip is a chart with one readable number. */}
              <span className={`text-[11px] tabular-nums ${isPeak ? 'font-semibold text-bh-text' : 'text-bh-text-dim'}`}>
                {point.count}
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

      {/*
        The accessible equivalent. `sr-only` rather than omitted: a screen-reader user gets the same
        numbers a sighted user reads off the bars, in a structure they can navigate by column. The
        bars above are `aria-hidden` so the series is announced once, not twice.
      */}
      <table className="sr-only">
        <caption>
          Tracked builders by the day a source last saw them active.
          {generated ? ` Generated ${generated}.` : ''}
        </caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Builders last seen</th></tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <th scope="row">{point.date}</th>
              <td>{point.count}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row">Total</th><td>{total}</td></tr>
        </tfoot>
      </table>

      {generated && <p className="mt-3 text-[11px] text-bh-text-dim">As of {generated}</p>}
    </>
  )
}
