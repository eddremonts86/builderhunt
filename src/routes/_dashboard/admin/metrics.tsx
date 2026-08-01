import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Activity, AlertTriangle, Database, Cpu, ExternalLink, Filter, RefreshCw, Compass, ShieldCheck } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { Button } from '~/components/ui/button'

interface MetricsResponse {
  inProcess: {
    searches: number
    searchCacheHits: number
    apiRequests: number
    apiErrors: number
    signups: number
    signins: number
    uptimeSeconds: number
  }
  db: {
    totalUsers: number
    newUsersLast24h: number
    newUsersLast7d: number
    totalSavedQueries: number | null
    totalBuilders: number | null
    totalNotes: number | null
  }
  discovery: {
    cursor: number
    lastCellKey: string | null
    lastRunAt: string | null
    stats: { runs: number; upserted: number; errors: number }
  } | null
  server: {
    nodeVersion: string
    platform: string
    pid: number
    memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number }
  }
}

interface ConversionRate {
  numerator: number
  denominator: number
  rate: number | null
  ci95: [number, number] | null
  insufficientSample: boolean
}

interface ConversionResponse {
  start: string
  end: string
  variant: 'baseline' | 'treatment'
  metrics: Record<string, ConversionRate & { numeratorEvent: string; denominatorEvent: string }>
}

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

const METRIC_LABELS: Record<string, string> = {
  landing_to_signup: 'Landing → Signup',
  hero_signup_ctr: 'Hero → Signup click',
  hero_explore_ctr: 'Hero → Explore click',
  explore_search_completion: 'Explore → Search completed',
  explore_to_signup_ctr: 'Search → Signup click',
  signup_completion: 'Signup submit → complete',
}
const METRIC_ORDER = Object.keys(METRIC_LABELS)

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function formatCi(ci: [number, number] | null): string | null {
  return ci ? `${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%` : null
}

export const Route = createFileRoute('/_dashboard/admin/metrics')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminMetricsPage,
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function AdminMetricsPage() {
  const [data, setData] = React.useState<MetricsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [conversion, setConversion] = React.useState<{ baseline: ConversionResponse; treatment: ConversionResponse } | null>(null)
  const [conversionError, setConversionError] = React.useState<string | null>(null)
  const [removal, setRemoval] = React.useState<RemovalOperationsMetrics | null>(null)
  const [removalError, setRemovalError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/metrics', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      setData(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadConversion = React.useCallback(async () => {
    try {
      const [baselineRes, treatmentRes] = await Promise.all([
        fetch('/api/admin/metrics/conversion?variant=baseline', { credentials: 'include' }),
        fetch('/api/admin/metrics/conversion?variant=treatment', { credentials: 'include' }),
      ])
      if (!baselineRes.ok || !treatmentRes.ok) {
        setConversionError(`Failed to load: ${baselineRes.ok ? treatmentRes.status : baselineRes.status}`)
        return
      }
      const [baseline, treatment] = await Promise.all([baselineRes.json(), treatmentRes.json()])
      setConversion({ baseline, treatment })
      setConversionError(null)
    } catch (e) {
      setConversionError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadRemoval = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/metrics/trust', { credentials: 'include' })
      if (!res.ok) {
        setRemovalError(`Failed to load: ${res.status}`)
        return
      }
      setRemoval(await res.json())
      setRemovalError(null)
    } catch (e) {
      setRemovalError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [load])

  React.useEffect(() => {
    loadConversion()
  }, [loadConversion])

  React.useEffect(() => {
    loadRemoval()
  }, [loadRemoval])

  if (loading) {
    return (
      <div data-testid="admin-metrics-page">
        <p className="text-bh-text-muted">Loading…</p>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div data-testid="admin-metrics-page">
        <p className="text-bh-danger">{error ?? 'No data'}</p>
      </div>
    )
  }

  return (
    <div data-testid="admin-metrics-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Metrics
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            In-process counters + DB aggregates. Auto-refreshes every 15s.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => { load(); loadConversion(); loadRemoval() }}
          variant="ghost"
          size="sm"
          aria-label="Refresh"
          data-testid="admin-metrics-refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </header>

      <ConversionFunnelSection conversion={conversion} error={conversionError} />

      <RemovalOperationsSection removal={removal} error={removalError} />

      <section className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6" data-testid="metrics-inprocess">
        <h2 className="sr-only">In-process metrics</h2>
        <MetricCard label="Searches" value={data.inProcess.searches} />
        <MetricCard label="Cache hits" value={data.inProcess.searchCacheHits} />
        <MetricCard label="API requests" value={data.inProcess.apiRequests} />
        <MetricCard label="API errors" value={data.inProcess.apiErrors} />
        <MetricCard label="Signups" value={data.inProcess.signups} />
        <MetricCard label="Signins" value={data.inProcess.signins} />
      </section>

      <section className="card p-5 mb-6" data-testid="metrics-db">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Database
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Total users" value={data.db.totalUsers} />
          <MetricCard label="New (24h)" value={data.db.newUsersLast24h} />
          <MetricCard label="New (7d)" value={data.db.newUsersLast7d} />
          <MetricCard label="Saved queries" value={data.db.totalSavedQueries} />
          <MetricCard label="Builders" value={data.db.totalBuilders} />
          <MetricCard label="Notes" value={data.db.totalNotes} />
        </div>
      </section>

      <section className="card p-5 mb-6" data-testid="metrics-discovery">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Compass className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Proactive discovery
        </h2>
        {data.discovery ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Runs" value={data.discovery.stats.runs} />
            <MetricCard label="Upserted" value={data.discovery.stats.upserted} />
            <MetricCard label="Errors" value={data.discovery.stats.errors} />
            <div className="card p-3">
              <p className="text-xs text-bh-text-dim mb-1">Cursor / last cell</p>
              <p className="font-mono text-xs">
                {data.discovery.cursor} · {data.discovery.lastCellKey ?? '—'}
              </p>
              <p className="text-xs text-bh-text-dim mt-1">
                {data.discovery.lastRunAt ? new Date(data.discovery.lastRunAt).toLocaleString() : 'never run'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-bh-text-muted">Worker has not run yet.</p>
        )}
      </section>

      <section className="card p-5" data-testid="metrics-server">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Server
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <p className="text-bh-text-dim text-xs">Uptime</p>
            <p className="font-semibold">{formatUptime(data.inProcess.uptimeSeconds)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Node</p>
            <p className="font-mono text-xs">{data.server.nodeVersion}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Platform</p>
            <p className="font-mono text-xs">{data.server.platform}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">PID</p>
            <p className="font-mono text-xs">{data.server.pid}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">RSS</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.rss)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap total</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.heapTotal)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Heap used</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.heapUsed)}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">External</p>
            <p className="font-mono text-xs">{formatBytes(data.server.memoryUsage.external)}</p>
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Landing-funnel conversion rates for both experiment arms (plans/UI/tasks.md Wave 5 "Render
 * conversion metrics in Admin Metrics"). Every rate the API returns is rendered as-is — a metric
 * with too few sessions still shows its real rate, just flagged `insufficientSample` rather than a
 * fabricated confidence interval. An entirely-empty window (every metric's denominator is 0 in both
 * arms) gets its own honest message instead of a table of dashes.
 */
function ConversionFunnelSection({
  conversion,
  error,
}: {
  conversion: { baseline: ConversionResponse; treatment: ConversionResponse } | null
  error: string | null
}) {
  if (error) {
    return (
      <section className="card p-5 mb-6 border-bh-danger/30" data-testid="metrics-conversion-error">
        <h2 className="font-semibold mb-2 flex items-center gap-2 text-bh-danger">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" />
          Conversion funnel unavailable
        </h2>
        <p className="text-sm text-bh-text-muted mb-2">{error}</p>
        <p className="text-sm">
          <Link to="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="metrics-conversion-operations-link">
            Check Operations <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        </p>
      </section>
    )
  }

  if (!conversion) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-conversion">
        <p className="text-sm text-bh-text-muted">Loading conversion funnel…</p>
      </section>
    )
  }

  const { baseline, treatment } = conversion
  const totalDenominator = METRIC_ORDER.reduce(
    (sum, key) => sum + (baseline.metrics[key]?.denominator ?? 0) + (treatment.metrics[key]?.denominator ?? 0),
    0,
  )

  if (totalDenominator === 0) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-conversion-empty">
        <h2 className="font-semibold mb-2 flex items-center gap-2">
          <Filter className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Conversion funnel
        </h2>
        <p className="text-sm text-bh-text-muted">No conversion events recorded in {baseline.start} – {baseline.end} yet.</p>
      </section>
    )
  }

  // A real anomaly (not just a small sample): a step with a healthy sample size but a zero rate,
  // in either arm — worth a nudge toward the content that step actually lives on.
  const hasAnomaly = METRIC_ORDER.some((key) => {
    const b = baseline.metrics[key]
    const t = treatment.metrics[key]
    return (b && !b.insufficientSample && b.rate === 0) || (t && !t.insufficientSample && t.rate === 0)
  })

  return (
    <section className="card p-5 mb-6" data-testid="metrics-conversion">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Filter className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Conversion funnel
        </h2>
        <p className="text-xs text-bh-text-dim">{baseline.start} – {baseline.end}</p>
      </div>
      {hasAnomaly && (
        <p className="text-xs text-bh-warning mb-3 flex items-center gap-1" data-testid="metrics-conversion-anomaly">
          <AlertTriangle className="size-3" aria-hidden />
          A step shows 0% on a real sample —{' '}
          <Link to="/admin/content" search={{ tab: 'blog' }} className="inline-flex items-center gap-0.5 text-bh-accent hover:underline" data-testid="metrics-conversion-content-link">
            review Content <ExternalLink className="size-3" aria-hidden />
          </Link>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-bh-text-dim border-b border-bh-border">
              <th className="py-2 pr-4">Step</th>
              <th className="py-2 pr-4">Baseline</th>
              <th className="py-2 pr-4">Treatment</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ORDER.map((key) => {
              const b = baseline.metrics[key]
              const t = treatment.metrics[key]
              return (
                <tr key={key} className="border-b border-bh-border/50" data-testid={`metrics-conversion-row-${key}`}>
                  <td className="py-2 pr-4 text-bh-text">{METRIC_LABELS[key]}</td>
                  <td className="py-2 pr-4">
                    <span className="font-semibold">{formatRate(b?.rate ?? null)}</span>
                    <span className="text-bh-text-dim ml-1">({b?.numerator ?? 0}/{b?.denominator ?? 0})</span>
                    {b?.insufficientSample && <span className="text-bh-text-dim ml-1" title="Sample too small for a confidence interval">low n</span>}
                    {b && !b.insufficientSample && formatCi(b.ci95) && <span className="text-bh-text-dim ml-1 text-xs">{formatCi(b.ci95)}</span>}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="font-semibold">{formatRate(t?.rate ?? null)}</span>
                    <span className="text-bh-text-dim ml-1">({t?.numerator ?? 0}/{t?.denominator ?? 0})</span>
                    {t?.insufficientSample && <span className="text-bh-text-dim ml-1" title="Sample too small for a confidence interval">low n</span>}
                    {t && !t.insufficientSample && formatCi(t.ci95) && <span className="text-bh-text-dim ml-1 text-xs">{formatCi(t.ci95)}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * Bounded, redacted removal/suppression pipeline health (plans/UI/tasks.md Wave 5 "Render redacted
 * removal operations metrics"). Only counts ever render here — no identity, URL, request text,
 * evidence, or other per-request metadata reaches this component, because the API itself never
 * returns those fields (see `getRemovalOperationsMetrics`). A backlog of `pending` requests already
 * past their own `expiresAt` — work the scheduled sweep should have cleared — links to Operations.
 */
function RemovalOperationsSection({
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

function MetricCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="card p-3" data-testid={`metric-card-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-bh-text-dim mb-1">{label}</p>
      <p className="text-2xl font-bold text-bh-text">{value === null ? '—' : value.toLocaleString()}</p>
    </div>
  )
}
