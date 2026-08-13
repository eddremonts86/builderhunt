// table-surface-bounded: one row per entry in OPERATIONAL_SCHEDULES, the code-side registry this page
// reconciles against. Now on the shell (plan 08's last task), driven by `registryPage` rather than by
// a table capability — there is no database column to sort and no cursor to page, because the row set
// is a property of the codebase. See `registry-page.ts` for why sorting it in the browser is correct
// here and wrong on every surface backed by a growing table.
import * as React from 'react'
import { BookOpen, Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '~/components/ui'
import { DataTable, DateCell, EmptyCell, PrimaryCell, RatioCell, StatusCell } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import { registryPage, type RegistryTableSpec } from '~/shared/lib/table/registry-page'
import type { TableQuery } from '~/shared/lib/table/types'

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

// `extends Record<string, unknown>` because `DataTableProps<Row>` constrains on it, and a plain
// interface gets no implicit index signature. Same declaration as every other migrated surface.
interface JobRow extends Record<string, unknown> {
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

/**
 * What an operator may sort, filter and search on.
 *
 * `status` is derived rather than stored — the same three-way `StatusPill` decision (paused, needs
 * attention, healthy) expressed as a value, so filtering by it and reading it off the pill cannot
 * disagree. `attention` covers overdue, stale and a failed last run, which is exactly the set the
 * header's "needs attention" count uses.
 */
type JobStatus = 'paused' | 'attention' | 'healthy'

function jobStatus(job: JobRow): JobStatus {
  if (!job.enabled) return 'paused'
  if (job.overdue || job.stale || job.lastRun?.state === 'failed') return 'attention'
  return 'healthy'
}

const JOB_SPEC: RegistryTableSpec<JobRow> = {
  searchable: (job) => [job.label, job.jobKey, job.cronExpression],
  filterable: { scope: (job) => job.scope, status: (job) => jobStatus(job) },
  sortable: {
    label: (job) => job.label,
    scope: (job) => job.scope,
    status: (job) => jobStatus(job),
    nextRunAt: (job) => (job.enabled ? job.nextRunAt : null),
    lastRunAt: (job) => job.lastRun?.scheduledFor ?? null,
    durationMs: (job) => job.lastRun?.durationMs ?? null,
  },
  tiebreaker: (job) => job.jobKey,
}

const OPERATIONS_FILTER_LABELS = { scope: 'Scope', status: 'Status' }

const EMPTY_QUERY: TableQuery = { search: '', filters: {}, sort: [{ id: 'label', dir: 'asc' }] } as TableQuery

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * One chip for the job's state, in the shared tones.
 *
 * Five hand-rolled pills with five different tints and five different icons became one
 * `StatusCell`. The per-row `data-testid` survives verbatim: `admin-operations.spec.ts` and the
 * status regression suite drive these by it.
 *
 * Note the order — paused first, then overdue/stale, then failed. A paused job that is also
 * overdue is *paused*: it is not running because somebody stopped it, and reporting "Overdue"
 * there sends an operator looking for a fault that does not exist.
 */
function StatusPill({ job }: { job: JobRow }) {
  const state = !job.enabled ? { label: 'Paused', tone: 'neutral' as const }
    : job.overdue ? { label: 'Overdue', tone: 'warning' as const }
      : job.stale ? { label: 'Stale', tone: 'warning' as const }
        : job.lastRun?.state === 'failed' ? { label: 'Failed', tone: 'danger' as const }
          : job.lastRun?.state === 'running' ? { label: 'Running', tone: 'accent' as const }
            : { label: 'Healthy', tone: 'success' as const }

  return (
    <span data-testid={`job-status-${job.jobKey}`}>
      <StatusCell label={state.label} tone={state.tone} />
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
  const [query, setQuery] = React.useState<TableQuery>(EMPTY_QUERY)
  const [pausingKey, setPausingKey] = React.useState<string | null>(null)
  const [runningKey, setRunningKey] = React.useState<string | null>(null)
  const [confirmRunKey, setConfirmRunKey] = React.useState<string | null>(null)
  const [rowMessages, setRowMessages] = React.useState<Record<string, string>>({})
  // Located by test id rather than by a row ref: the shell owns row rendering now, and both the table
  // and the stacked presentation carry the same key in their test id, so whichever one is visible is
  // the one that gets scrolled.
  React.useEffect(() => {
    if (!highlightJobKey) return
    const row = document.querySelector(`[data-testid="operations-row-${highlightJobKey}"], [data-testid="operations-card-${highlightJobKey}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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

  const attentionCount = data?.jobs.filter((job) => jobStatus(job) === 'attention').length ?? 0

  const columns = React.useMemo<ColumnDef<JobRow>[]>(() => [
    {
      id: 'label',
      header: 'Job',
      kind: 'primary',
      sortable: true,
      value: (job) => job.label,
      // The cron expression is a literal schedule string an operator copies — one of the two
      // things DESIGN.md:221 keeps the monospace face for.
      cell: (job) => <PrimaryCell title={job.label} meta={`${job.cronExpression} · ${job.timezone}`} monoMeta />,
    },
    { id: 'status', header: 'Status', kind: 'status', sortable: true, value: (job) => jobStatus(job), cell: (job) => <StatusPill job={job} /> },
    { id: 'scope', header: 'Scope', kind: 'category', sortable: true, value: (job) => job.scope, cell: (job) => <span className="capitalize">{job.scope}</span> },
    {
      id: 'nextRunAt',
      header: 'Next run',
      kind: 'date',
      sortable: true,
      value: (job) => (job.enabled ? job.nextRunAt : null),
      // A paused job has no next run, and the empty cell says so — "—" beside a date column used
      // to read as "we do not know when", which is a different and more alarming fact.
      cell: (job) => job.enabled
        ? <DateCell value={job.nextRunAt} withTime />
        : <EmptyCell label="Paused, no next run" />,
    },
    {
      id: 'lastRunAt',
      header: 'Last run',
      kind: 'date',
      sortable: true,
      value: (job) => job.lastRun?.scheduledFor ?? null,
      cell: (job) => <DateCell value={job.lastRun?.scheduledFor ?? null} withTime />,
    },
    {
      id: 'durationMs',
      header: 'Duration',
      kind: 'number',
      sortable: true,
      value: (job) => job.lastRun?.durationMs ?? null,
      // `formatDuration` picks its own unit (ms, s, m), so the unit travels with the figure
      // rather than living only in a header that scrolls out of view.
      cell: (job) => job.lastRun?.durationMs === undefined || job.lastRun?.durationMs === null
        ? <EmptyCell label="Never run" />
        : <span className="tbl-cell-number">{formatDuration(job.lastRun.durationMs)}</span>,
    },
    {
      id: 'counters',
      header: 'Counters',
      kind: 'ratio',
      value: (job) => (job.lastRun ? `${job.lastRun.processedCount} ok / ${job.lastRun.failedCount} failed` : null),
      // A bar rather than "412 ok / 3 failed" as prose: what an operator scans this column for is
      // "did anything fail", and the number beside it is what makes the bar legible and legal.
      cell: (job) => {
        const run = job.lastRun
        if (!run) return <EmptyCell label="Never run" />
        const total = run.processedCount + run.failedCount
        return (
          <RatioCell
            value={total === 0 ? 1 : run.processedCount / total}
            label={`${run.processedCount} ok / ${run.failedCount} failed`}
          />
        )
      },
    },
    {
      id: 'error',
      header: 'Error',
      kind: 'category',
      value: (job) => job.lastRun?.errorCode ?? null,
      cell: (job) => job.lastRun?.errorCode
        ? <span className="font-mono text-xs truncate" title={job.lastRun.errorCode}>{job.lastRun.errorCode}</span>
        : <EmptyCell label="No error" />,
    },
    {
      id: 'actions',
      header: 'Actions',
      kind: 'actions',
      // No `value`: there is nothing to sort or group a button by, and giving it one would put a
      // sort control on a column whose order means nothing.
      cell: (job) => (
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
      ),
    },
  ], [confirmRunKey, pausingKey, rowMessages, runNow, runningKey, togglePause])

  const page = React.useMemo(() => registryPage(data?.jobs ?? [], query, JOB_SPEC), [data?.jobs, query])

  // Both presentations render the same page, and only one is visible at a time. Two instances rather
  // than one, because `renderer` picks a single presentation and the breakpoint is what decides here —
  // the same `hidden md:block` / `md:hidden` pair this page already used. The test ids stay distinct
  // (`operations-row-*` and `operations-card-*`) because the existing unit and e2e specs assert on
  // both, and collapsing them would break passing tests for no product reason.
  const shared = {
    label: 'Registered background workers',
    columns,
    page,
    query,
    onQueryChange: setQuery,
    status: (loading && !data ? 'loading' : error ? 'error' : 'ready') as 'loading' | 'error' | 'ready',
    error: { message: error ?? '', onRetry: () => void load() },
    searchable: true,
    filterLabels: OPERATIONS_FILTER_LABELS,
    rowId: (job: JobRow) => job.jobKey,
    emptyState: (
      <p className="text-bh-text-muted py-6 text-center" data-testid="operations-empty">No jobs match this filter.</p>
    ),
  }

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

      {/*
        The scope shortcuts stay, and now write into the shell's own filter state rather than into a
        separate `scopeFilter`. Two sources of truth for "which rows are showing" is how a page ends up
        with a chip that disagrees with its table; `all` is the absence of the dimension, which is the
        same thing `TableQuery` means by an empty array.
      */}
      <div className="mb-4 flex items-center gap-2" role="group" aria-label="Filter by scope">
        {(['all', 'platform', 'organization'] as const).map((scope) => {
          const selected = scope === 'all'
            ? (query.filters.scope ?? []).length === 0
            : (query.filters.scope ?? []).includes(scope)
          return (
            <button
              key={scope}
              type="button"
              onClick={() => setQuery((current) => ({
                ...current,
                filters: scope === 'all'
                  ? Object.fromEntries(Object.entries(current.filters).filter(([key]) => key !== 'scope'))
                  : { ...current.filters, scope: [scope] },
              }))}
              aria-pressed={selected}
              data-testid={`operations-filter-${scope}`}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                selected ? 'bg-bh-accent text-bh-accent-contrast' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
              }`}
            >
              {scope}
            </button>
          )
        })}
      </div>

      {/*
        Loading and error are the shell's states now, not a ternary around it. The page used to render
        a bare "Loading…" paragraph in place of the whole table, so the header, the filters and the
        column headings all disappeared and came back on every 30-second refresh; the shell keeps the
        chrome and its own skeleton keeps the layout from shifting under it.
      */}
      {/*
        `operations-table` and `operations-cards` name the two presentations, not the markup inside
        them — the shell renders a `role="grid"` over divs rather than a `<table>`. The names are kept
        because two e2e tests scope their assertions to "the one visible at this viewport", and that
        intent survives the migration even though the element under it changed.
      */}
      <div className="hidden md:block" data-testid="operations-table">
        <DataTable {...shared} renderer="table" rowTestId={(job) => `operations-row-${job.jobKey}`} />
      </div>
      <div className="md:hidden" data-testid="operations-cards">
        <DataTable {...shared} renderer="stacked" rowTestId={(job) => `operations-card-${job.jobKey}`} />
      </div>

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
