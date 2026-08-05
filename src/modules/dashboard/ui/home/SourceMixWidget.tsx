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
 * ## Scope, spelled out rather than implied
 *
 * This is a **sample**, and the widget now says so in words rather than in a
 * `last 20` badge a reader has to interpret. The distinction matters because the
 * question the widget invites — "are we over-reliant on GitHub?" — is a question
 * about the whole workspace, and the answer here is drawn from the most recent
 * page of tracked builders. A workspace that tracked 400 people from six sources
 * last year and 20 from GitHub this week reads as 100% GitHub.
 *
 * The spec's remedy is a real coverage projection over all tracked builders
 * (Wave 5, "Source coverage"). Until that ships the honest move is to label the
 * denominator, not to imply one, and percentages of a sample this small are shown
 * with their raw counts so "50%" cannot be mistaken for a workspace figure.
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
      <BentoTileHeader title="Source mix" icon={Radio} tone="cyan" />
      <p className="-mt-2 mb-3 text-xs font-light text-bh-text-muted">
        Sample of your {total} most recently tracked builder{total === 1 ? '' : 's'}, not the whole
        workspace.
      </p>
      <ul className="flex flex-col gap-2.5">
        {rows.map(([source, count]) => {
          const pct = Math.round((count / Math.max(1, total)) * 100)
          return (
            <li key={source} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-bh-text-dim">{SOURCE_LABELS[source] ?? source}</span>
                {/* Raw count beside the percentage: 50% of a sample of four is a different claim
                    from 50% of a workspace, and only one of them is on offer here. */}
                <span className="shrink-0 font-mono text-xs tabular-nums text-bh-text">
                  {count}<span className="text-bh-text-dim"> · {pct}%</span>
                </span>
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
