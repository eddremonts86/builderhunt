import * as React from 'react'
import { Activity } from 'lucide-react'
import { BentoTileHeader } from '~/modules/dashboard/ui/bento/Bento'

/**
 * Reference implementation of a bento widget — copy this shape for new ones.
 *
 * The contract a widget has to honour:
 *  1. It renders *content*, never the bubble. `BentoTile` paints the surface, so
 *     no `card`, no border, no radius here.
 *  2. It takes plain data as props and owns no fetch of its own, so the same
 *     widget works in both densities and in tests without a network.
 *  3. It does NOT stretch to fill. Tile height follows content, so `flex-1` and
 *     `mt-auto` only push a widget's own parts apart.
 *  4. It renders its own empty state. Whether that state gets a smaller tile is
 *     the registry's call via `whenEmpty` — not the widget's.
 *
 * ## What this chart is, after 2026-08-06
 *
 * It was titled "Weekly Activity", captioned "Builders active per day", and its empty state said "No
 * tracked builders have **shipped** in the last 7 days". All three described event volume. The data
 * is one timestamp per tracked identity — `builder_identities.lastSeenAt` — grouped by day, so every
 * builder appears in exactly one bucket and the seven bars sum to the "Seen active" metric beside
 * them. That is a **recency histogram**, and a reader who took the old caption at face value would
 * have concluded a builder appearing on Tuesday shipped on Tuesday and nothing since.
 *
 * Renaming it was the smaller half. A chart also has to be readable without seeing it, so every bar
 * now carries its exact count in the visible layout and the whole series is repeated as a real
 * `<table>` — the accessible equivalent the spec asks for (structural problem 9). The table is
 * visually hidden rather than absent: an equivalent nobody can reach is not an equivalent.
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
  const tableId = React.useId()
  const max = Math.max(1, ...points.map((p) => p.count))
  const total = points.reduce((sum, p) => sum + p.count, 0)
  const hasActivity = total > 0
  const peakIndex = hasActivity
    ? points.reduce((best, p, i, arr) => (p.count > arr[best].count ? i : best), 0)
    : -1
  const generated = formatGeneratedAt(generatedAt)

  return (
    <>
      <BentoTileHeader
        title="Builder recency"
        icon={Activity}
        tone="accent"
        action={<span className="text-xs font-light text-bh-text-dim">Last 7 days</span>}
      />

      <p className="-mt-2 mb-4 text-xs font-light text-bh-text-muted">
        Tracked builders by the day a source last saw them active. Each builder counts once.
      </p>

      {hasActivity ? (
        <>
          <div className="flex items-end justify-between gap-1 px-2 pt-2" aria-hidden="true">
            {points.map((point, index) => {
              const isPeak = index === peakIndex
              // Floor of 6% so a day with one builder still paints a visible stub
              // instead of a line indistinguishable from zero.
              const heightPct = Math.max(6, Math.round((point.count / max) * 100))
              return (
                <div key={point.date} className="flex flex-1 flex-col items-center gap-1.5">
                  {/* Exact value on every bar, not only the peak: a chart whose numbers are
                      readable from one tooltip is a chart with one readable number. */}
                  <span className={`text-[11px] tabular-nums ${isPeak ? 'font-semibold text-bh-text' : 'text-bh-text-dim'}`}>
                    {point.count}
                  </span>
                  <div className="relative flex h-24 w-full max-w-[28px] items-end rounded-t-md bg-bh-bg-alt sm:max-w-[36px]">
                    <div
                      className={`w-full rounded-t-md transition-all duration-500 ease-out motion-reduce:transition-none ${
                        isPeak
                          ? 'bg-bh-accent-soft bg-striped-terracotta'
                          : 'bg-bh-border-strong bg-striped-neutral'
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
            The accessible equivalent. `sr-only` rather than omitted: a screen-reader user gets the
            same seven numbers a sighted user reads off the bars, in a structure they can navigate by
            column. The bars above are `aria-hidden` so the series is announced once, not twice.
          */}
          <table id={tableId} className="sr-only">
            <caption>
              Tracked builders by the day a source last saw them active, last 7 days.
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

          {generated && (
            <p className="mt-3 text-[11px] text-bh-text-dim">As of {generated}</p>
          )}
        </>
      ) : (
        <div className="py-8 text-center">
          <p className="text-sm font-light text-bh-text-muted">
            No tracked builder has been seen active by a source in the last 7 days.
          </p>
          <p className="mt-1 text-xs text-bh-text-dim">
            This fills in as the sources report activity for people you track.
          </p>
        </div>
      )}
    </>
  )
}
