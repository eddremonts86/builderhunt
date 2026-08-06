import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Activity, AlertTriangle, CalendarClock, Database, Cpu, ExternalLink, Filter, RefreshCw, Compass, ShieldCheck } from 'lucide-react'
import { Button } from '~/components/ui/button'

/**
 * The Admin Metrics page (plans/ui-dashboard, Admin track "Rebuild `/admin/metrics` as a route-driven
 * lazy widget shell" — this is the file that task names).
 *
 * ## Why it lives here and not in the route file
 *
 * It used to be defined in `src/routes/_dashboard/admin/metrics.tsx` and exported so the unit test
 * could import it. TanStack Router cannot code-split a route file that exports anything besides its
 * `Route`, so all ~780 lines of this — the conversion funnel, the removal matrix, the interview
 * counter groups, the runtime diagnostics — were compiled into the bundle **every visitor
 * downloads**, for a page only platform admins can open. It was the only route file in the codebase
 * doing that: the build warned about this file and no other.
 *
 * Moving the component out is the whole fix. The route keeps its `beforeLoad` guard and names this
 * component, and the router splits the chunk as it does for every other page.
 *
 * The rule this broke is not obvious from the route file, which is why it survived: nothing fails, no
 * gate objects, and the page works perfectly. Only the bundle gets bigger, for everyone, forever.
 */

interface MetricsResponse {
  /** ISO timestamp of when the server read these numbers — see the route's comment. */
  generatedAt: string
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
  }
  discovery: {
    cursor: number
    lastCellKey: string | null
    lastRunAt: string | null
    stats: { runs: number; upserted: number; errors: number }
  } | null
  interviews: InterviewOperations
  server: {
    nodeVersion: string
    platform: string
    pid: number
    memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number }
  }
}

/**
 * plans/phase-1/44-calendar-scheduling-interview-intelligence, "Add redacted metrics and operator
 * dashboards" — the half that was recorded as not built until 2026-08-05.
 *
 * `counters` is optional on purpose, and that is the whole design. The API omits it while every
 * interview capability is off, so this page cannot render "0 booking conflicts" for a product where
 * nobody can book. Read the flags first, then the numbers.
 */
interface InterviewOperations {
  capabilities: {
    calendar: boolean
    scheduling: boolean
    candidateUploads: boolean
    transcription: boolean
    sensitiveAi: boolean
  }
  counters?: Record<string, number>
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

/** How often the page re-reads `/api/admin/metrics` while it is the foreground tab. */
const REFRESH_INTERVAL_MS = 15_000

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function formatCi(ci: [number, number] | null): string | null {
  return ci ? `${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%` : null
}

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

  /**
   * Refreshes only while somebody is looking.
   *
   * The bare `setInterval` this replaces kept polling a backgrounded tab, so an operator who opened
   * `/admin/metrics` on Friday and switched away spent the weekend issuing four platform-metrics
   * queries a minute at nobody. Re-fetching on `visibilitychange` rather than just resuming the timer
   * matters too: a tab returning to the foreground is showing numbers as old as the time it spent
   * hidden, and waiting up to fifteen seconds to correct them is how an operator reads a stale count
   * during an incident.
   */
  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined

    const stop = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      if (timer === undefined) timer = setInterval(load, REFRESH_INTERVAL_MS)
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
        return
      }
      load()
      start()
    }

    load()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
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
            In-process counters + DB aggregates. Auto-refreshes every 15s while this tab is in view.
          </p>
          <p className="text-xs text-bh-text-dim mt-1" data-testid="admin-metrics-generated-at">
            As of {new Date(data.generatedAt).toLocaleTimeString()}
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

      {/*
        The scope line is not decoration on this section — it is the difference between the numbers
        meaning something and meaning something else (plans/ui-dashboard spec §7, "restart-scoped
        semantics"; Admin track "Demote Runtime diagnostics").

        These six come from `metrics.get()`: counters cumulative since *this server process* started.
        The heading used to be `sr-only`, so a sighted operator saw six bare numbers, and the two
        facts that qualify them — uptime and pid — sat in a "Server" card at the very bottom of the
        page. Three ways that misleads, worst last:

          1. After a deploy, "API requests 0" means this process has served none, not that the
             platform served none.
          2. There is no way to tell a quiet hour from a restart four minutes ago.
          3. With more than one instance behind the load balancer, these describe whichever process
             answered — so the next refresh can hit a different one and a number can *go down* with
             nothing behind it.

        Uptime and pid moved here from the Server card because here they are qualifiers; there they
        were diagnostics next to heap sizes.
      */}
      <section className="mb-6" data-testid="metrics-inprocess">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          This server process, since it started
        </h2>
        <p className="text-xs text-bh-text-dim mb-3" data-testid="metrics-inprocess-scope">
          Counting for {formatUptime(data.inProcess.uptimeSeconds)} · pid {data.server.pid} · one
          process, not a platform total — a refresh answered by another instance shows that
          instance&rsquo;s numbers instead.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Searches" value={data.inProcess.searches} />
          <MetricCard label="Cache hits" value={data.inProcess.searchCacheHits} />
          <MetricCard label="API requests" value={data.inProcess.apiRequests} />
          <MetricCard label="API errors" value={data.inProcess.apiErrors} />
          <MetricCard label="Signups" value={data.inProcess.signups} />
          <MetricCard label="Signins" value={data.inProcess.signins} />
        </div>
      </section>

      <section className="card p-5 mb-6" data-testid="metrics-db">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Database
        </h2>
        {/*
          Three tiles used to sit here — Saved queries, Builders, Notes — reading response fields the
          API hardcoded to `null`, so they rendered a permanent em-dash. See the route's comment for
          why they are not being made real instead.
        */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Total users" value={data.db.totalUsers} />
          <MetricCard label="New (24h)" value={data.db.newUsersLast24h} />
          <MetricCard label="New (7d)" value={data.db.newUsersLast7d} />
        </div>
      </section>

      <InterviewOperationsSection interviews={data.interviews} />

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

      {/*
        Runtime diagnostics, demoted deliberately: last on the page, and no longer holding the two
        values the counters above depend on. Node version, platform and heap sizes answer "is this
        process unhealthy" — a real question, but not one an operator opens this page to ask.
      */}
      <section className="card p-5" data-testid="metrics-server">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Runtime diagnostics
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <p className="text-bh-text-dim text-xs">Node</p>
            <p className="font-mono text-xs">{data.server.nodeVersion}</p>
          </div>
          <div>
            <p className="text-bh-text-dim text-xs">Platform</p>
            <p className="font-mono text-xs">{data.server.platform}</p>
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
/**
 * Interview operations.
 *
 * Two rules this panel exists to obey, both inherited from the counters it renders:
 *
 * 1. **Never show a number as a fact when the door it counts is shut.** A capability grid comes first
 *    and the counters are absent — not zero — while everything is off. The API enforces the same thing
 *    by omitting `counters`, so this is not the only guard.
 * 2. **Nothing but numbers.** Every value here is a counter and every label is static text. That is
 *    what makes an interview dashboard safe to look at: a candidate's name, filename, transcript line
 *    or capability secret has no path into this component, because it never receives one.
 *
 * The counters are grouped by the question an operator is actually asking, rather than in the order
 * the metrics module declares them — "is intake working", "is capture working", "is the AI behaving",
 * "is retention keeping up". An alphabetical list of nineteen numbers is a list, not a dashboard.
 */
const INTERVIEW_COUNTER_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Scheduling and intake',
    keys: [
      ['bookingConflicts', 'Booking conflicts'],
      ['staleReservations', 'Stale reservations'],
      ['schedulesStale', 'Stale schedules'],
      ['documentBacklog', 'Document backlog'],
      ['documentFailures', 'Document failures'],
    ],
  },
  {
    title: 'Capture',
    keys: [
      ['captureRemote', 'Remote'],
      ['captureInPerson', 'In person'],
      ['captureUnsupported', 'Unsupported'],
      ['transcriptReconnects', 'Reconnects'],
      ['segmentsPersisted', 'Segments persisted'],
      ['segmentRetries', 'Segment retries'],
    ],
  },
  {
    title: 'AI behaviour',
    keys: [
      ['providerErrors', 'Provider errors'],
      ['aiParseFailures', 'Parse failures'],
      ['templateFallbacks', 'Template fallbacks'],
      ['prohibitedOutputRefusals', 'Refusals'],
    ],
  },
  {
    title: 'Retention and cost',
    keys: [
      ['retentionRowsDeleted', 'Rows deleted'],
      ['retentionObjectsDeleted', 'Objects deleted'],
      ['retentionObjectFailures', 'Object failures'],
      ['usageVariances', 'Usage variances'],
    ],
  },
]

const CAPABILITY_LABELS: Array<[keyof InterviewOperations['capabilities'], string]> = [
  ['calendar', 'Calendar'],
  ['scheduling', 'Scheduling'],
  ['candidateUploads', 'Candidate uploads'],
  ['transcription', 'Transcription'],
  ['sensitiveAi', 'Sensitive AI'],
]

function InterviewOperationsSection({ interviews }: { interviews: InterviewOperations | undefined }) {
  if (!interviews) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-interviews">
        <p className="text-sm text-bh-text-muted">Loading interview operations…</p>
      </section>
    )
  }

  const { capabilities, counters } = interviews
  // Counters the module reports but no group claims. Rendered rather than dropped: a counter added to
  // `metrics.ts` reaches the API automatically (`interviewOperatorCounters` derives its keys), so
  // silently discarding the unknown ones here would reintroduce exactly the gap this task closed.
  const grouped = new Set(INTERVIEW_COUNTER_GROUPS.flatMap((group) => group.keys.map(([key]) => key)))
  const ungrouped = Object.entries(counters ?? {}).filter(([key]) => !grouped.has(key))

  return (
    <section className="card p-5 mb-6" data-testid="metrics-interviews">
      <h2 className="font-semibold mb-3 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Interview operations
      </h2>

      <div className="flex flex-wrap gap-2 mb-4" data-testid="metrics-interviews-capabilities">
        {CAPABILITY_LABELS.map(([key, label]) => (
          <span
            key={key}
            data-testid={`interview-capability-${key}`}
            className={`text-xs px-2 py-1 rounded border ${
              capabilities[key]
                ? 'border-bh-accent/40 text-bh-accent'
                : 'border-bh-border text-bh-text-dim'
            }`}
          >
            {label}: {capabilities[key] ? 'on' : 'off'}
          </span>
        ))}
      </div>

      {counters ? (
        <div className="space-y-4">
          {INTERVIEW_COUNTER_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">{group.title}</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {group.keys.map(([key, label]) => (
                  <MetricCard key={key} label={label} value={counters[key] ?? null} />
                ))}
              </div>
            </div>
          ))}
          {ungrouped.length > 0 && (
            <div data-testid="metrics-interviews-ungrouped">
              <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Other counters</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {ungrouped.map(([key, value]) => (
                  <MetricCard key={key} label={key} value={value} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-bh-text-muted" data-testid="metrics-interviews-disabled">
          Every interview capability is disabled, so there is nothing to count. These counters are
          deliberately absent rather than shown as zeros — a zero here would read as &ldquo;no problems&rdquo;
          when it means &ldquo;no traffic is possible&rdquo;.
        </p>
      )}
    </section>
  )
}

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
