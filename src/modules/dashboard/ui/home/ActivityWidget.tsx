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
 * Registered in `registry.tsx`; the markup below is the previous inline
 * "Weekly Activity" card, unchanged apart from losing its `.card` wrapper.
 */

export interface DailyActivityPoint {
  date: string
  label: string
  count: number
}

export function ActivityWidget({ points }: { points: readonly DailyActivityPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count))
  const hasActivity = points.some((p) => p.count > 0)
  const peakIndex = hasActivity
    ? points.reduce((best, p, i, arr) => (p.count > arr[best].count ? i : best), 0)
    : -1

  return (
    <>
      <BentoTileHeader
        title="Weekly Activity"
        icon={Activity}
        tone="accent"
        action={(
          <span className="text-xs font-light text-bh-text-dim">
            {hasActivity ? 'Builders active per day' : 'Last 7 days'}
          </span>
        )}
      />

      {hasActivity ? (
        <div className="flex items-end justify-between gap-1 px-2 pt-4">
          {points.map((point, index) => {
            const isPeak = index === peakIndex
            // Floor of 6% so a day with one commit still paints a visible stub
            // instead of a line indistinguishable from zero.
            const heightPct = Math.max(6, Math.round((point.count / max) * 100))
            return (
              <div key={point.date} className="flex flex-1 flex-col items-center gap-2">
                <div className="relative flex h-28 w-full max-w-[28px] items-end rounded-t-md bg-bh-bg-alt sm:max-w-[36px]">
                  {isPeak && (
                    <div className="absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-[#2b1812] px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                      {point.count}
                      <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-[#2b1812]" />
                    </div>
                  )}
                  <div
                    className={`w-full rounded-t-md transition-all duration-500 ease-out ${
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
      ) : (
        <div className="py-8 text-center">
          <p className="text-sm font-light text-bh-text-muted">
            No tracked builders have shipped in the last 7 days yet.
          </p>
          <p className="mt-1 text-xs text-bh-text-dim">
            This fills in once builders you're tracking are active again.
          </p>
        </div>
      )}
    </>
  )
}
