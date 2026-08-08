// table-surface-bounded: one row per entry in OPERATIONAL_SCHEDULES, the code-side registry this page reconciles against. See plans/phase-3/08 for the shell migration.
import * as React from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, Clock, Pause, Play, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '~/components/ui'

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
  /** Null until the registry has synced this key in at least once — pause/resume is disabled until then. */
  version: number | null
  nextRunAt: string | null
  overdue: boolean
  stale: boolean
  lastRun: JobRunSummary | null
}

interface OperationsResponse {
  jobs: JobRow[]
  generatedAt: string
}

const RUNBOOK_PATH = 'docs/operations/deploy-runbook.md'

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

interface RowActionsProps {
  job: JobRow
  pausing: boolean
  running: boolean
  confirmingRun: boolean
  rowMessage: string | null
  onTogglePause: () => void
  onStartRunConfirm: () => void
  onCancelRunConfirm: () => void
  onConfirmRun: () => void
}

function RowActions({ job, pausing, running, confirmingRun, rowMessage, onTogglePause, onStartRunConfirm, onCancelRunConfirm, onConfirmRun }: RowActionsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={job.version === null || pausing}
          onClick={onTogglePause}
          data-testid={`operations-toggle-${job.jobKey}`}
        >
          {job.enabled ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {pausing ? 'Working…' : job.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={running}
          onClick={onStartRunConfirm}
          data-testid={`operations-run-${job.jobKey}`}
        >
          {running ? 'Running…' : 'Run now'}
        </Button>
      </div>
      {confirmingRun && (
        <div className="rounded border border-bh-border bg-bh-surface p-2 text-xs" data-testid={`operations-run-confirm-${job.jobKey}`}>
          <p className="text-bh-text-muted mb-1.5">Run &ldquo;{job.label}&rdquo; now, outside its normal {job.cronExpression} cadence?</p>
          <div className="flex gap-1.5">
            <Button type="button" variant="primary" size="sm" onClick={onConfirmRun} disabled={running} data-testid={`operations-run-confirm-yes-${job.jobKey}`}>
              {running ? 'Running…' : 'Run now'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancelRunConfirm} disabled={running}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {rowMessage && <p className="text-xs text-bh-text-muted" role="status" data-testid={`operations-message-${job.jobKey}`}>{rowMessage}</p>}
    </div>
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
  const [pausingKey, setPausingKey] = React.useState<string | null>(null)
  const [runningKey, setRunningKey] = React.useState<string | null>(null)
  const [confirmRunKey, setConfirmRunKey] = React.useState<string | null>(null)
  const [rowMessages, setRowMessages] = React.useState<Record<string, string>>({})
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

  const setRowMessage = React.useCallback((jobKey: string, message: string) => {
    setRowMessages((prev) => ({ ...prev, [jobKey]: message }))
  }, [])

  const togglePause = React.useCallback(async (job: JobRow) => {
    if (job.version === null) return
    setPausingKey(job.jobKey)
    try {
      const res = await fetch(`/api/admin/operations/${job.jobKey}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled, expectedVersion: job.version }),
      })
      if (res.status === 409) {
        setRowMessage(job.jobKey, 'Someone else changed this job — refreshed with the latest state, try again.')
        await load()
        return
      }
      if (!res.ok) {
        setRowMessage(job.jobKey, `Failed: ${res.status}`)
        return
      }
      setRowMessage(job.jobKey, job.enabled ? 'Paused.' : 'Resumed.')
      await load()
    } catch (e) {
      setRowMessage(job.jobKey, e instanceof Error ? e.message : String(e))
    } finally {
      setPausingKey(null)
    }
  }, [load, setRowMessage])

  const runNow = React.useCallback(async (job: JobRow) => {
    setRunningKey(job.jobKey)
    setConfirmRunKey(null)
    try {
      const res = await fetch(`/api/admin/operations/${job.jobKey}/run`, { method: 'POST', credentials: 'include' })
      if (res.status === 409) {
        setRowMessage(job.jobKey, 'Already running — this run was not started again.')
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setRowMessage(job.jobKey, body.error ? `Failed: ${body.error}` : `Failed: ${res.status}`)
        return
      }
      setRowMessage(job.jobKey, 'Run started.')
      await load()
    } catch (e) {
      setRowMessage(job.jobKey, e instanceof Error ? e.message : String(e))
    } finally {
      setRunningKey(null)
    }
  }, [load, setRowMessage])

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
        <Button type="button" variant="ghost" size="sm" onClick={load} data-testid="operations-refresh">
          <RefreshCw className="size-4" aria-hidden />
          Refresh
        </Button>
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
        <>
          {/* Desktop/tablet: table. Mobile: stacked cards below — same data, actions, testids. */}
          <div className="hidden md:block overflow-x-auto">
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
                  <th className="py-2 pr-4">Actions</th>
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
                    <td className="py-2.5 pr-4">
                      <RowActions
                        job={job}
                        pausing={pausingKey === job.jobKey}
                        running={runningKey === job.jobKey}
                        confirmingRun={confirmRunKey === job.jobKey}
                        rowMessage={rowMessages[job.jobKey] ?? null}
                        onTogglePause={() => togglePause(job)}
                        onStartRunConfirm={() => setConfirmRunKey(job.jobKey)}
                        onCancelRunConfirm={() => setConfirmRunKey(null)}
                        onConfirmRun={() => runNow(job)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden flex flex-col gap-3">
            {jobs.map((job) => (
              <li
                key={job.jobKey}
                className={`card p-3 ${job.jobKey === highlightJobKey ? 'bg-bh-accent-soft' : ''}`}
                data-testid={`operations-card-${job.jobKey}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="font-medium text-bh-text">{job.label}</div>
                    <div className="text-xs text-bh-text-dim font-mono">{job.cronExpression} · {job.timezone}</div>
                  </div>
                  <StatusPill job={job} />
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-bh-text-muted mb-3">
                  <dt className="text-bh-text-dim">Scope</dt><dd className="capitalize">{job.scope}</dd>
                  <dt className="text-bh-text-dim">Next run</dt><dd>{job.enabled ? formatWhen(job.nextRunAt) : '—'}</dd>
                  <dt className="text-bh-text-dim">Last run</dt><dd>{formatWhen(job.lastRun?.scheduledFor ?? null)}</dd>
                  <dt className="text-bh-text-dim">Duration</dt><dd>{formatDuration(job.lastRun?.durationMs ?? null)}</dd>
                  <dt className="text-bh-text-dim">Counters</dt><dd>{job.lastRun ? `${job.lastRun.processedCount} ok / ${job.lastRun.failedCount} failed` : '—'}</dd>
                  <dt className="text-bh-text-dim">Error</dt><dd className="font-mono">{job.lastRun?.errorCode ?? '—'}</dd>
                </dl>
                <RowActions
                  job={job}
                  pausing={pausingKey === job.jobKey}
                  running={runningKey === job.jobKey}
                  confirmingRun={confirmRunKey === job.jobKey}
                  rowMessage={rowMessages[job.jobKey] ?? null}
                  onTogglePause={() => togglePause(job)}
                  onStartRunConfirm={() => setConfirmRunKey(job.jobKey)}
                  onCancelRunConfirm={() => setConfirmRunKey(null)}
                  onConfirmRun={() => runNow(job)}
                />
              </li>
            ))}
          </ul>

          {jobs.length === 0 && (
            <p className="text-bh-text-muted py-6 text-center">No jobs match this filter.</p>
          )}
        </>
      )}

      <section className="card p-4 mt-6" data-testid="operations-runbook">
        <h2 className="font-semibold text-sm flex items-center gap-2 mb-1">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          Runbook
        </h2>
        <p className="text-xs text-bh-text-muted">
          For deploy sequencing, incident response, and worker-recovery steps, see{' '}
          <code className="text-xs">{RUNBOOK_PATH}</code> in the repository.
        </p>
      </section>
    </div>
  )
}
