import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ExternalLink, ShieldCheck } from 'lucide-react'
import { MetricCard, MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Overview (plan 57, Admin track — the section the page loads first and re-reads on a timer).
 *
 * The contract half is two indexed aggregate reads and nothing else, which is why `overview.ts` is its own
 * route: it has to stay cheap on a refresh loop.
 *
 * ## Why the removal pipeline is here
 *
 * It is not where it belongs. Removal/suppression health is trust-and-safety operations, and this plan has a
 * separate task for it — "Build Billing, Abuse, Trust, and User Anomaly admin widgets" — whose home is the
 * Platform Admin Command Center, not this page. Until that lands it is rendered here rather than dropped: it is
 * a working widget an operator uses, and deleting working functionality to tidy a layout is a worse trade than
 * leaving it one screen away from its eventual home. When the Command Center task lands, this moves.
 */

interface RemovalOperationsMetrics {
  totalRequests: number
  byStatus: Record<'pending' | 'verified' | 'rejected' | 'expired', number>
  bySource: Array<{ source: string; count: number }>
  otherSourcesCount: number
  pendingAging: { underOneDay: number; oneToSevenDays: number; sevenToThirtyDays: number; overThirtyDays: number }
  overduePendingCount: number
  activeSuppressions: number
  generatedAt: string
}

export function OverviewSection({ state }: SectionWidgetProps) {
  const [removal, setRemoval] = React.useState<RemovalOperationsMetrics | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/admin/metrics/trust', { credentials: 'include', signal: controller.signal })
        if (!response.ok) {
          setError(`Failed to load: ${response.status}`)
          return
        }
        setRemoval(await response.json())
        setError(null)
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => controller.abort()
  }, [])

  return (
    <>
      <MetricSectionView state={state} title="Platform overview" />
      <RemovalOperationsSection removal={removal} error={error} />
    </>
  )
}

/**
 * Bounded, redacted removal/suppression pipeline health.
 *
 * Only counts ever render here — no identity, URL, request text, evidence, or other per-request metadata
 * reaches this component, because the API itself never returns those fields. A backlog of `pending` requests
 * already past their own `expiresAt` — work the scheduled sweep should have cleared — links to Operations.
 */
export function RemovalOperationsSection({
  removal,
  error,
}: {
  removal: RemovalOperationsMetrics | null
  error: string | null
}) {
  if (error) {
    return (
      <section className="card p-5 mb-6 border-bh-danger/30" data-testid="metrics-removal-error">
        <h2 className="font-semibold mb-2 flex items-center gap-2 text-bh-danger">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Removal operations unavailable
        </h2>
        <p className="text-sm text-bh-text-muted mb-2">{error}</p>
        <p className="text-sm">
          <Link to="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="metrics-removal-operations-link">
            Check Operations <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        </p>
      </section>
    )
  }

  if (!removal) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-removal">
        <p className="text-sm text-bh-text-muted">Loading removal operations…</p>
      </section>
    )
  }

  if (removal.totalRequests === 0) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-removal-empty">
        <h2 className="font-semibold mb-2 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Removal operations
        </h2>
        <p className="text-sm text-bh-text-muted">No removal requests recorded yet.</p>
      </section>
    )
  }

  const { byStatus, bySource, otherSourcesCount, pendingAging, overduePendingCount, activeSuppressions } = removal

  return (
    <section className="card p-5 mb-6" data-testid="metrics-removal">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Removal operations
        </h2>
        <p className="text-xs text-bh-text-dim">{removal.totalRequests.toLocaleString()} total</p>
      </div>

      {overduePendingCount > 0 && (
        <p className="text-xs text-bh-warning mb-3 flex items-center gap-1" data-testid="metrics-removal-overdue">
          <AlertTriangle className="size-3" aria-hidden />
          {overduePendingCount} pending request{overduePendingCount === 1 ? '' : 's'} past its own deadline —{' '}
          <Link to="/admin/operations" className="inline-flex items-center gap-0.5 text-bh-accent hover:underline" data-testid="metrics-removal-overdue-link">
            check Operations <ExternalLink className="size-3" aria-hidden />
          </Link>
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Pending" value={byStatus.pending} />
        <MetricCard label="Verified" value={byStatus.verified} />
        <MetricCard label="Rejected" value={byStatus.rejected} />
        <MetricCard label="Expired" value={byStatus.expired} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Pending aging</p>
          <ul className="text-sm space-y-1" data-testid="metrics-removal-aging">
            <li className="flex justify-between"><span className="text-bh-text-muted">&lt; 1 day</span><span className="font-mono tabular-nums">{pendingAging.underOneDay}</span></li>
            <li className="flex justify-between"><span className="text-bh-text-muted">1 – 7 days</span><span className="font-mono tabular-nums">{pendingAging.oneToSevenDays}</span></li>
            <li className="flex justify-between"><span className="text-bh-text-muted">7 – 30 days</span><span className="font-mono tabular-nums">{pendingAging.sevenToThirtyDays}</span></li>
            <li className="flex justify-between"><span className="text-bh-text-muted">&gt; 30 days</span><span className="font-mono tabular-nums">{pendingAging.overThirtyDays}</span></li>
          </ul>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">By source</p>
          {bySource.length === 0 && otherSourcesCount === 0 ? (
            <p className="text-sm text-bh-text-muted">No sources recorded.</p>
          ) : (
            <ul className="text-sm space-y-1" data-testid="metrics-removal-by-source">
              {bySource.map((s) => (
                <li key={s.source} className="flex justify-between">
                  <span className="text-bh-text-muted">{s.source}</span>
                  <span className="font-mono tabular-nums">{s.count}</span>
                </li>
              ))}
              {otherSourcesCount > 0 && (
                <li className="flex justify-between" data-testid="metrics-removal-other-sources" title="Sources with too few requests to name individually">
                  <span className="text-bh-text-muted">Other</span>
                  <span className="font-mono tabular-nums">{otherSourcesCount}</span>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <p className="text-xs text-bh-text-dim mt-4">{activeSuppressions.toLocaleString()} active suppression{activeSuppressions === 1 ? '' : 's'}</p>
    </section>
  )
}

export default OverviewSection
