import * as React from 'react'
import { Compass } from 'lucide-react'
import { MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Proactive discovery (plan 57, Admin track — the discovery half of "Build Search and Discovery metrics
 * widgets").
 *
 * ## Why the cursor and cell key are in a disclosure and not on a card
 *
 * They are the two values here that are *not* metrics. `cursor` and `lastCellKey` describe where the worker is
 * in its sweep — a debugging aid — and rendering them as headline numbers puts a reader in the position of
 * interpreting a scan position as progress. "Cursor 4821" says nothing about coverage without knowing the total
 * cell count, which this page does not have.
 *
 * The section's own values are counts and are windowed; these are current-run state. That distinction is what
 * the task means by labelling every value as bounded-window, current-run, or lifetime.
 */

interface DiscoveryState {
  cursor: number
  lastCellKey: string | null
  lastRunAt: string | null
  stats: { runs: number; upserted: number; errors: number }
}

export function DiscoverySection({ state }: SectionWidgetProps) {
  const [discovery, setDiscovery] = React.useState<DiscoveryState | null | undefined>(undefined)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/admin/metrics', { credentials: 'include', signal: controller.signal })
        if (!response.ok) return
        // `null` from the API means the worker has never run, which is different from a failed read. The
        // difference is preserved: `undefined` renders as loading, `null` as never-run.
        setDiscovery((await response.json()).discovery ?? null)
      } catch {
        // Left undefined — a failed read must not render as "the worker has never run".
      }
    })()
    return () => controller.abort()
  }, [])

  return (
    <MetricSectionView state={state} title="Proactive discovery">
      <details className="mt-4" data-testid="metrics-discovery-diagnostics">
        <summary className="text-sm text-bh-text-muted cursor-pointer flex items-center gap-2">
          <Compass className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Current-run state
        </summary>
        {discovery === undefined ? (
          <p className="text-sm text-bh-text-muted mt-3">Reading worker state…</p>
        ) : discovery === null ? (
          <p className="text-sm text-bh-text-muted mt-3" data-testid="metrics-discovery-never-run">
            The worker has not run yet. This is not a count of zero — nothing has been scanned.
          </p>
        ) : (
          <dl className="text-sm mt-3 space-y-1">
            <div className="flex justify-between">
              <dt className="text-bh-text-muted">Cursor / last cell</dt>
              <dd className="font-mono text-xs">{discovery.cursor} · {discovery.lastCellKey ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-bh-text-muted">Last run</dt>
              <dd className="font-mono text-xs">
                {discovery.lastRunAt ? new Date(discovery.lastRunAt).toLocaleString() : 'never'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-bh-text-muted">Runs / upserted / errors (lifetime)</dt>
              <dd className="font-mono text-xs">
                {discovery.stats.runs} · {discovery.stats.upserted} · {discovery.stats.errors}
              </dd>
            </div>
          </dl>
        )}
      </details>
    </MetricSectionView>
  )
}

export default DiscoverySection
