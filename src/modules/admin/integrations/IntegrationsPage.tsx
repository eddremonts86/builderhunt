// table-surface-bounded: source register and AI task registry — both one row per code-side entry, read
// whole. Now on the shell (plan 08's last task), driven by `registryPage` rather than by a table
// capability: `SOURCE_NAMES` and `AI_TASKS` are code constants, so there is no database column to sort
// and no cursor to page. `registry-page.ts` explains why sorting a complete set in the browser is
// correct here and wrong on any surface backed by a growing table.
import * as React from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, ExternalLink, MinusCircle, XCircle } from 'lucide-react'
import { Button } from '~/components/ui'
import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import { registryPage, type RegistryTableSpec } from '~/shared/lib/table/registry-page'
import type { TableQuery } from '~/shared/lib/table/types'

interface SourceRow extends Record<string, unknown> {
  source: string
  label: string
  trackable: boolean
  dormantReason: string | null
  credentialRequired: boolean
  credentialPresent: boolean
  killSwitchEnabled: boolean | null
  quota: null
  lastSuccessAt: null
  lastFailureAt: null
  indexedCount: null
  backlogCount: null
}

interface AITaskRow extends Record<string, unknown> {
  taskId: string
  tier: 'local-first' | 'server-only'
  sensitive: boolean
  version: string
  disabled: boolean
}

interface IntegrationsResponse {
  sources: SourceRow[]
  aiTasks: AITaskRow[]
  aiGloballyDisabled: boolean
  aiProviderAvailable: boolean
  aiBudgetDenials: number
  enrichmentEnabled: boolean
  discovery: { cursor: number; lastRunAt: string | null; stats: unknown } | null
  generatedAt: string
}

const RUNBOOK_PATH = 'docs/operations/deploy-runbook.md'

function sourceNeedsAttention(row: SourceRow): boolean {
  if (row.killSwitchEnabled === false) return true
  if (row.credentialRequired && !row.credentialPresent) return true
  return false
}

/**
 * The four-way state the filter shortcuts and the badge both read.
 *
 * Derived once, so filtering by `attention` and reading the badge cannot disagree — the shortcuts used
 * to re-implement each predicate inline beside a `SourceBadge` that made the same decision separately.
 */
type SourceState = 'attention' | 'dormant' | 'active'

function sourceState(row: SourceRow): SourceState {
  if (sourceNeedsAttention(row)) return 'attention'
  if (!row.trackable || row.killSwitchEnabled === false) return 'dormant'
  return 'active'
}

const SOURCE_SPEC: RegistryTableSpec<SourceRow> = {
  searchable: (row) => [row.label, row.source, row.dormantReason],
  filterable: { state: (row) => sourceState(row) },
  sortable: {
    label: (row) => row.label,
    state: (row) => sourceState(row),
    credential: (row) => (!row.credentialRequired ? null : row.credentialPresent ? 'present' : 'missing'),
  },
  tiebreaker: (row) => row.source,
}

const AI_TASK_SPEC: RegistryTableSpec<AITaskRow> = {
  searchable: (row) => [row.taskId, row.tier, row.version],
  filterable: { tier: (row) => row.tier, state: (row) => (row.disabled ? 'disabled' : 'enabled') },
  sortable: {
    taskId: (row) => row.taskId,
    tier: (row) => row.tier,
    version: (row) => row.version,
    state: (row) => (row.disabled ? 'disabled' : 'enabled'),
  },
  tiebreaker: (row) => row.taskId,
}

const SOURCE_FILTER_LABELS = { state: 'State' }
const AI_TASK_FILTER_LABELS = { tier: 'Tier', state: 'State' }

const SOURCES_QUERY: TableQuery = { search: '', filters: {}, sort: [{ id: 'label', dir: 'asc' }] } as TableQuery
const AI_TASKS_QUERY: TableQuery = { search: '', filters: {}, sort: [{ id: 'taskId', dir: 'asc' }] } as TableQuery

function SourceBadge({ row }: { row: SourceRow }) {
  if (!row.trackable) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted" data-testid={`integration-badge-${row.source}`}>
        Dormant
      </span>
    )
  }
  if (row.killSwitchEnabled === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted" data-testid={`integration-badge-${row.source}`}>
        Disabled
      </span>
    )
  }
  if (row.credentialRequired && !row.credentialPresent) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-warning/15 text-bh-warning" data-testid={`integration-badge-${row.source}`}>
        <AlertTriangle className="size-3" aria-hidden />
        No credential
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-success/15 text-bh-success" data-testid={`integration-badge-${row.source}`}>
      <CheckCircle2 className="size-3" aria-hidden />
      Active
    </span>
  )
}

function CredentialCell({ row }: { row: SourceRow }) {
  if (!row.credentialRequired) {
    return <span className="text-bh-text-dim">Not required</span>
  }
  return row.credentialPresent ? (
    <span className="inline-flex items-center gap-1 text-bh-success"><CheckCircle2 className="size-3.5" aria-hidden />Present</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-bh-danger"><XCircle className="size-3.5" aria-hidden />Missing</span>
  )
}

export function IntegrationsPage() {
  const [data, setData] = React.useState<IntegrationsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [sourcesQuery, setSourcesQuery] = React.useState<TableQuery>(SOURCES_QUERY)
  const [aiTasksQuery, setAiTasksQuery] = React.useState<TableQuery>(AI_TASKS_QUERY)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/integrations', { credentials: 'include' })
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

  React.useEffect(() => { load() }, [load])

  const sourcesPage = React.useMemo(
    () => registryPage(data?.sources ?? [], sourcesQuery, SOURCE_SPEC),
    [data?.sources, sourcesQuery],
  )
  const aiTasksPage = React.useMemo(
    () => registryPage(data?.aiTasks ?? [], aiTasksQuery, AI_TASK_SPEC),
    [data?.aiTasks, aiTasksQuery],
  )

  const attentionCount = data?.sources.filter(sourceNeedsAttention).length ?? 0
  const status = loading && !data ? 'loading' : error ? 'error' : 'ready'

  const sourceColumns = React.useMemo<ColumnDef<SourceRow>[]>(() => [
    { id: 'label', header: 'Source', sortable: true, weight: 2, value: (row) => row.label, cell: (row) => <span className="font-medium text-bh-text">{row.label}</span> },
    {
      id: 'state',
      header: 'Status',
      sortable: true,
      value: (row) => sourceState(row),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <SourceBadge row={row} />
          {row.dormantReason && <span className="text-xs text-bh-text-dim">{row.dormantReason}</span>}
        </div>
      ),
    },
    {
      id: 'credential',
      header: 'Credential',
      sortable: true,
      value: (row) => (!row.credentialRequired ? null : row.credentialPresent ? 'present' : 'missing'),
      cell: (row) => <CredentialCell row={row} />,
    },
    {
      id: 'search',
      header: 'Search',
      align: 'end',
      cell: (row) => (
        <a href={`/search?sources=${encodeURIComponent(row.source)}`} className="inline-flex items-center gap-1 text-bh-accent hover:underline text-xs" data-testid={`integration-search-link-${row.source}`}>
          View <ExternalLink className="size-3" aria-hidden />
        </a>
      ),
    },
  ], [])

  const aiTaskColumns = React.useMemo<ColumnDef<AITaskRow>[]>(() => [
    { id: 'taskId', header: 'Task', sortable: true, weight: 2, value: (row) => row.taskId, cell: (row) => <span className="font-medium text-bh-text font-mono text-xs">{row.taskId}</span> },
    { id: 'tier', header: 'Tier', sortable: true, value: (row) => row.tier, cell: (row) => <span className="text-bh-text-muted">{row.tier}</span> },
    { id: 'version', header: 'Version', sortable: true, value: (row) => row.version, cell: (row) => <span className="text-bh-text-dim">v{row.version}</span> },
    {
      id: 'state',
      header: 'State',
      sortable: true,
      value: (row) => (row.disabled ? 'disabled' : 'enabled'),
      cell: (row) => row.disabled ? (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-surface text-bh-text-muted">
          <MinusCircle className="size-3" aria-hidden />Disabled
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bh-success/15 text-bh-success">
          <CheckCircle2 className="size-3" aria-hidden />Enabled
        </span>
      ),
    },
  ], [])

  return (
    <div data-testid="admin-integrations-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Every builder source and AI task this deployment knows about, and whether it can actually run.
            {attentionCount > 0 && (
              <span className="ml-2 text-bh-warning font-medium" data-testid="integrations-attention-count">
                {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
              </span>
            )}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={load} data-testid="integrations-refresh">Refresh</Button>
      </header>

      {loading ? (
        <p className="text-bh-text-muted">Loading…</p>
      ) : error ? (
        <p className="text-bh-danger" role="alert">{error}</p>
      ) : data ? (
        <>
          <section className="card p-4 mb-6" data-testid="integrations-ai-summary">
            <h2 className="font-semibold text-sm mb-3">AI platform</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Kill switch</dt>
                <dd className={data.aiGloballyDisabled ? 'text-bh-danger font-medium' : 'text-bh-success font-medium'}>
                  {data.aiGloballyDisabled ? 'All AI disabled' : 'On'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Provider</dt>
                <dd className={data.aiProviderAvailable ? 'text-bh-success font-medium' : 'text-bh-danger font-medium'} data-testid="integrations-provider-availability">
                  {data.aiProviderAvailable ? 'Available' : 'Unavailable — no API key configured'}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Budget denials (process lifetime)</dt>
                <dd className="font-medium">{data.aiBudgetDenials}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-bh-text-dim mb-1">Profile enrichment</dt>
                <dd className={data.enrichmentEnabled ? 'text-bh-success font-medium' : 'text-bh-text-muted font-medium'}>
                  {data.enrichmentEnabled ? 'Enabled' : 'Disabled'}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-3 mt-4 text-xs">
              <a href="/admin/operations" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="integrations-link-operations">
                Operations <ExternalLink className="size-3" aria-hidden />
              </a>
              <a href="/admin/metrics" className="inline-flex items-center gap-1 text-bh-accent hover:underline" data-testid="integrations-link-metrics">
                Metrics <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          </section>

          {/*
            The shortcuts write into the shell's own filter state rather than a separate `filter`, and
            each predicate is now `sourceState()` — the same function the badge reads, so a source
            filtered as `attention` and a source badged "No credential" can no longer disagree. They
            used to be two independent re-implementations of the same three rules.
          */}
          <div className="mb-4 flex items-center gap-2" role="group" aria-label="Filter sources">
            {(['all', 'active', 'dormant', 'attention'] as const).map((f) => {
              const selected = f === 'all'
                ? (sourcesQuery.filters.state ?? []).length === 0
                : (sourcesQuery.filters.state ?? []).includes(f)
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setSourcesQuery((current) => {
                    const filters: Record<string, string[]> = f === 'all' ? {} : { state: [f] }
                    return { ...current, filters }
                  })}
                  aria-pressed={selected}
                  data-testid={`integrations-filter-${f}`}
                  className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                    selected ? 'bg-bh-accent text-white' : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
                  }`}
                >
                  {f}
                </button>
              )
            })}
          </div>

          {/*
            Four columns are gone rather than migrated: Quota, Last success, Last failure and
            Indexed / backlog were all `null` in `SourceRow` and rendered the literal string
            "Not tracked" in every cell, so half the table's width said the same nothing nineteen
            times over. Stated once below instead — the same correction this repository already made on
            `/admin/metrics`, where three hardcoded-`null` counts rendered as "three permanent
            em-dashes".
          */}
          <div className="mb-6" data-testid="integrations-sources-table">
            <DataTable
              label="Builder sources"
              columns={sourceColumns}
              page={sourcesPage}
              query={sourcesQuery}
              onQueryChange={setSourcesQuery}
              rowTestId={(row) => `integration-row-${row.source}`}
              rowId={(row) => row.source}
              status={status}
              error={{ message: error ?? '', onRetry: () => void load() }}
              searchable
              filterLabels={SOURCE_FILTER_LABELS}
              emptyState={(
                <p className="text-bh-text-muted py-6 text-center" data-testid="integrations-sources-empty">
                  No sources match this filter.
                </p>
              )}
            />
            <p className="mt-2 text-xs text-bh-text-dim">
              Quota, last success/failure and indexed/backlog counts are not tracked per source yet.
            </p>
          </div>

          <div className="mb-6" data-testid="integrations-ai-tasks-table">
            <h2 className="font-semibold text-sm mb-3">AI tasks</h2>
            <DataTable
              label="AI tasks"
              columns={aiTaskColumns}
              page={aiTasksPage}
              query={aiTasksQuery}
              onQueryChange={setAiTasksQuery}
              rowTestId={(row) => `integration-ai-task-${row.taskId}`}
              rowId={(row) => row.taskId}
              status={status}
              error={{ message: error ?? '', onRetry: () => void load() }}
              searchable
              filterLabels={AI_TASK_FILTER_LABELS}
              emptyState={(
                <p className="text-bh-text-muted py-6 text-center" data-testid="integrations-ai-tasks-empty">
                  No AI tasks match this filter.
                </p>
              )}
            />
          </div>
        </>
      ) : null}

      <section className="card p-4" data-testid="integrations-runbook">
        <h2 className="font-semibold text-sm flex items-center gap-2 mb-1">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          Runbook
        </h2>
        <p className="text-xs text-bh-text-muted">
          For credential rotation, kill-switch procedures, and provider incident response, see{' '}
          <code className="text-xs">{RUNBOOK_PATH}</code> in the repository.
        </p>
      </section>
    </div>
  )
}
