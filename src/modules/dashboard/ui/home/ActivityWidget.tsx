import * as React from 'react'
import { BarSeries, utcWeekdayLabel } from '~/modules/dashboard/ui/BarSeries'

/**
 * The recency chart's body. `WidgetFrame` owns the header and every non-ready state; `BarSeries`
 * owns the bars, the exact values and the accessible table.
 *
 * What is left here is the one thing that is specific to this chart: **the sentence that says what
 * it measures.** It was titled "Weekly Activity", captioned "Builders active per day", and its empty
 * state said "No tracked builders have **shipped**" — all three describing event volume. The data is
 * `builder_identities.lastSeenAt`, one timestamp per tracked identity, so every builder falls in
 * exactly one bucket and the bars sum to the "Seen active" metric beside them. A recency histogram,
 * not a time series, and a reader who took the old caption literally would have concluded a builder
 * shown on Tuesday shipped on Tuesday and not since.
 *
 * Three charts on this dashboard now share `BarSeries` and differ only in that sentence. That is the
 * whole risk surface: the shapes are interchangeable and the meanings are not.
 */

export interface DailyActivityPoint {
  date: string
  label: string
  count: number
}

export function ActivityWidget({
  points, generatedAt,
}: {
  points: readonly DailyActivityPoint[]
  generatedAt?: string
}) {
  return (
    <>
      <p className="-mt-2 mb-4 text-xs font-light text-bh-text-muted">
        Tracked builders by the day a source last saw them active. Each builder counts once.
      </p>
      <BarSeries
        points={points.map((point) => ({
          key: point.date,
          // Recomputed from the key rather than trusting `label`, so every chart's axis is labelled
          // in the same zone the server bucketed in.
          label: utcWeekdayLabel(point.date),
          value: point.count,
        }))}
        caption="Tracked builders by the day a source last saw them active."
        valueLabel="Builders last seen"
        generatedAt={generatedAt}
      />
    </>
  )
}
