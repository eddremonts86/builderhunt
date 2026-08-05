import * as React from 'react'

/**
 * Which platforms the workspace's tracked builders come from — **all of them**.
 *
 * ## What changed, and why the old version answered a different question
 *
 * This used to count the most recent page of tracked builders and call itself "Source mix". The
 * question it invites — are we over-reliant on one platform? — is about the whole workspace, and a
 * recent sample cannot answer it: an organization that tracked 400 people from six sources last year
 * and 20 from GitHub this week read as 100% GitHub. The caption said "last 20", which is true and
 * does not repair the claim, because nobody reads a chart's denominator before reading its shape.
 *
 * It now renders `sections.sourceCoverage` from `GET /api/dashboard/overview`, which aggregates every
 * tracked builder (plans/ui-dashboard Wave 1, "Build bounded dashboard aggregate repositories").
 *
 * Body only — `WidgetFrame` owns the header and every non-ready state.
 */

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  reddit: 'Reddit',
  hn: 'Hacker News',
  devto: 'DEV.to',
  lobsters: 'Lobsters',
  npm: 'npm',
  huggingface: 'Hugging Face',
  stackoverflow: 'Stack Overflow',
  devpost: 'Devpost',
  producthunt: 'Product Hunt',
  bluesky: 'Bluesky',
}

export function SourceMixWidget({
  sources, totalTracked,
}: {
  sources: ReadonlyArray<{ source: string; count: number }>
  totalTracked: number
}) {
  return (
    <>
      <p className="-mt-2 mb-3 text-xs font-light text-bh-text-muted">
        Across all {totalTracked} tracked builder{totalTracked === 1 ? '' : 's'}.
      </p>
      <ul className="flex flex-col gap-2.5">
        {sources.map(({ source, count }) => {
          const pct = Math.round((count / Math.max(1, totalTracked)) * 100)
          return (
            <li key={source} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-bh-text-dim">{SOURCE_LABELS[source] ?? source}</span>
                {/* Raw count beside the percentage. A percentage alone invites the reader to assume
                    a denominator, and the one they assume is usually the workspace. */}
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
