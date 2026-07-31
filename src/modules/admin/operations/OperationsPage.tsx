import * as React from 'react'
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react'

interface JobRunSummary {
  state: string
  scheduledFor: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  processedCount: number
  failedCount: number
  errorCode: string | null
}

interface JobRow {
  jobKey: string
  label: string
  scope: 'platform' | 'organization'
  cronExpression: string
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  overdue: boolean
  stale: boolean
  lastRun: JobRunSummary | null
}

interface OperationsResponse {
  jobs: JobRow[]
  generatedAt: string
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function StatusPill({ job }: { job: JobRow }) {
  if (!job.enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted" data-testid={`job-status-${job.jobKey}`}>
        Paused
      </span>
    )
  }
  if (job.overdue || job.stale) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-warning/15 text-bh-warning" data-testid={`job-status-${job.jobKey}`}>
        <AlertTriangle className="size-3" aria-hidden />
        {job.overdue ? 'Overdue' : 'Stale'}
      </span>
    )
  }
  if (job.lastRun?.state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-danger/15 text-bh-danger" data-testid={`job-status-${job.jobKey}`}>
        <XCircle className="size-3" aria-hidden />
        Failed
      </span>
    )
  }
  if (job.lastRun?.state === 'running') {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-accent/15 text-bh-accent" data-testid={`job-status-${job.jobKey}`}>
        <Clock className="size-3" aria-hidden />
        Running
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-success/15 text-bh-success" data-testid={`job-status-${job.jobKey}`}>
      <CheckCircle2 className="size-3" aria-hidden />
      Healthy
    </span>
  )
}

export interface OperationsPageProps {
  /** Pre-selects the job this page was linked to from, e.g. a calendar projection anchor. */
  highlightJobKey?: string | null
}

export function OperationsPage({ highlightJobKey = null }: OperationsPageProps = {}) {
  const [data, setData] = React.useState<OperationsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [scopeFilter, setScopeFilter] = React.useState<'all' | 'platform' | 'organization'>('all')
  const highlightedRowRef = React.useRef<HTMLTableRowElement | null>(null)

  React.useEffect(() => {
    if (highlightJobKey && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [highlightJobKey, data])

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/operations', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const jobs = data?.jobs.filter((job) => scopeFilter === 'all' || job.scope === scopeFilter) ?? []
  const attentionCount = data?.jobs.filter((job) => job.enabled && (job.overdue || job.stale || job.lastRun?.state === 'failed')).length ?? 0

  return (
    <div data-testid="admin-operations-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations</h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Every registered background worker, its cadence, and its most recent run.
            {attentionCount > 0 && (
              <span className="ml-2 text-bh-warning font-medium" data-testid="operations-attention-count">
                {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm hover:bg-bh-surface"
          aria-label="Refresh"
          data-testid="operations-refresh"
        >
          <RefreshCw className="size-4" aria-hidden />
          Refresh
        </button>
      </header>

      <div className="mb-4 flex items-center gap-2" role="group" aria-label="Filter by scope">
        {(['all', 'platform', 'organization'] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            onClick={() => setScopeFilter(scope)}
            aria-pressed={scopeFilter === scope}
            data-testid={`operations-filter-${scope}`}
            className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
              scopeFilter === scope ? 'bg-bh-accent text-white' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
            }`}
          >
            {scope}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-bh-text-muted">Loading…</p>
      ) : error ? (
        <p className="text-bh-danger" role="alert">{error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="operations-table">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-bh-text-dim border-b border-bh-border">
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Scope</th>
                <th className="py-2 pr-4">Next run</th>
                <th className="py-2 pr-4">Last run</th>
                <th className="py-2 pr-4">Duration</th>
                <th className="py-2 pr-4">Counters</th>
                <th className="py-2 pr-4">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.jobKey}
                  ref={job.jobKey === highlightJobKey ? highlightedRowRef : undefined}
                  className={`border-b border-bh-border/50 ${job.jobKey === highlightJobKey ? 'bg-bh-accent-soft' : ''}`}
                  data-testid={`operations-row-${job.jobKey}`}
                >
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-bh-text">{job.label}</div>
                    <div className="text-xs text-bh-text-dim font-mono">{job.cronExpression} · {job.timezone}</div>
                  </td>
                  <td className="py-2.5 pr-4"><StatusPill job={job} /></td>
                  <td className="py-2.5 pr-4 capitalize text-bh-text-muted">{job.scope}</td>
                  <td className="py-2.5 pr-4 text-bh-text-muted">{job.enabled ? formatWhen(job.nextRunAt) : '—'}</td>
                  <td className="py-2.5 pr-4 text-bh-text-muted">{formatWhen(job.lastRun?.scheduledFor ?? null)}</td>
                  <td className="py-2.5 pr-4 text-bh-text-muted">{formatDuration(job.lastRun?.durationMs ?? null)}</td>
                  <td className="py-2.5 pr-4 text-bh-text-muted">
                    {job.lastRun ? `${job.lastRun.processedCount} ok / ${job.lastRun.failedCount} failed` : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-bh-text-dim font-mono text-xs">{job.lastRun?.errorCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {jobs.length === 0 && (
            <p className="text-bh-text-muted py-6 text-center">No jobs match this filter.</p>
          )}
        </div>
      )}
    </div>
  )
}
