import * as React from 'react'
import { Radio } from 'lucide-react'
import { BentoTileHeader } from '~/modules/dashboard/ui/bento/Bento'
import type { RecentBuilder } from './RecentBuildersWidget'

/**
 * Which platforms the tracked builders come from.
 *
 * Derived from the `recent` builders already in the page's context, so it costs
 * no extra request. Useful in a sourcing tool because a workspace that is 100%
 * GitHub is leaving the other federated sources unused, and nothing else on the
 * dashboard says so.
 *
 * Honest about its own scope: the caption states this is the recent sample, not
 * an all-time figure, because that is what the data is.
 */

const SOURCE_LABELS: Record<RecentBuilder['source'], string> = {
  github: 'GitHub',
  reddit: 'Reddit',
  hn: 'Hacker News',
  devto: 'DEV.to',
}

export function SourceMixWidget({ builders }: { builders: readonly RecentBuilder[] }) {
  const counts = new Map<RecentBuilder['source'], number>()
  for (const builder of builders) {
    counts.set(builder.source, (counts.get(builder.source) ?? 0) + 1)
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const total = builders.length

  return (
    <>
      <BentoTileHeader
        title="Source mix"
        icon={Radio}
        tone="cyan"
        action={<span className="shrink-0 font-mono text-[10px] tabular-nums text-bh-text-dim">last {total}</span>}
      />
      <ul className="flex flex-col gap-2.5">
        {rows.map(([source, count]) => {
          const pct = Math.round((count / Math.max(1, total)) * 100)
          return (
            <li key={source} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-bh-text-dim">{SOURCE_LABELS[source] ?? source}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text">{pct}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bh-bg-alt">
                <div className="h-full rounded-full bg-bh-cyan" style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
