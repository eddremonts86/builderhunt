// table-surface-bounded: source register and AI task registry — both one row per code-side entry, read
// whole. Now on the shell (plan 08's last task), driven by `registryPage` rather than by a table
// capability: `SOURCE_NAMES` and `AI_TASKS` are code constants, so there is no database column to sort
// and no cursor to page. `registry-page.ts` explains why sorting a complete set in the browser is
// correct here and wrong on any surface backed by a growing table.
import * as React from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'
import { Button } from '~/components/ui'
import { DataTable, EmptyCell, PrimaryCell, StatusCell } from '~/shared/components/table'
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

/**
 * Why a source is or is not running, as one chip in the shared tones.
 *
 * Four locally-hand-rolled pills with four different tints became one `StatusCell`. The per-row
 * `data-testid` survives verbatim — `admin-integrations.spec.ts` drives these by it, and a shell
 * that renamed them would turn a green suite red for reasons that have nothing to do with tables.
 */
function SourceBadge({ row }: { row: SourceRow }) {
  const state = !row.trackable ? { label: 'Dormant', tone: 'neutral' as const }
    : row.killSwitchEnabled === false ? { label: 'Disabled', tone: 'neutral' as const }
      : row.credentialRequired && !row.credentialPresent ? { label: 'No credential', tone: 'warning' as const }
        : { label: 'Ready', tone: 'success' as const }

  return (
    <span data-testid={`integration-badge-${row.source}`}>
      <StatusCell label={state.label} tone={state.tone} />
    </span>
  )
}

/**
 * "Not required" is an absence, not a third state of the credential.
 *
 * It used to be dim text beside a green tick and a red cross, which read as a *worse* version of
 * present. The empty cell says the same thing without competing for the same colour vocabulary.
 */
function CredentialCell({ row }: { row: SourceRow }) {
  if (!row.credentialRequired) return <EmptyCell label="No credential required" />
  return row.credentialPresent
    ? <StatusCell label="Present" tone="success" />
    : <StatusCell label="Missing" tone="danger" />
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
    {
      id: 'label',
      header: 'Source',
      kind: 'primary',
      sortable: true,
      value: (row) => row.label,
      // The dormant reason moved here from under the status chip. It is prose explaining *this
      // source*, which is metadata about the row's identity rather than a second status — and in
      // a 116px status column it wrapped to three lines.
      cell: (row) => <PrimaryCell title={row.label} meta={row.dormantReason ?? undefined} />,
    },
    {
      id: 'state',
      header: 'Status',
      kind: 'status',
      sortable: true,
      value: (row) => sourceState(row),
      cell: (row) => <SourceBadge row={row} />,
    },
    {
      id: 'credential',
      header: 'Credential',
      kind: 'status',
      sortable: true,
      value: (row) => (!row.credentialRequired ? null : row.credentialPresent ? 'present' : 'missing'),
      cell: (row) => <CredentialCell row={row} />,
    },
    {
      id: 'search',
      header: 'Search',
      kind: 'actions',
      cell: (row) => (
        <a href={`/search?sources=${encodeURIComponent(row.source)}`} className="inline-flex items-center gap-1 text-bh-accent hover:underline text-xs" data-testid={`integration-search-link-${row.source}`}>
          View <ExternalLink className="size-3" aria-hidden />
        </a>
      ),
    },
  ], [])

  const aiTaskColumns = React.useMemo<ColumnDef<AITaskRow>[]>(() => [
    {
      id: 'taskId',
      header: 'Task',
      kind: 'primary',
      sortable: true,
      value: (row) => row.taskId,
      // A task id is a literal key an operator copies into a config file — one of the two things
      // DESIGN.md:221 keeps the monospace face for, and the reference's own use for this line.
      cell: (row) => <PrimaryCell title={row.taskId} meta={`v${row.version}`} monoMeta />,
    },
    {
      id: 'tier',
      header: 'Tier',
      kind: 'category',
      sortable: true,
      value: (row) => row.tier,
      cell: (row) => row.tier,
    },
    {
      id: 'state',
      header: 'State',
      kind: 'status',
      sortable: true,
      value: (row) => (row.disabled ? 'disabled' : 'enabled'),
      cell: (row) => row.disabled
        ? <StatusCell label="Disabled" tone="neutral" />
        : <StatusCell label="Enabled" tone="success" />,
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
