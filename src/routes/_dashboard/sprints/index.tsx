import * as React from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Compass, Plus, Trash2, Pause, Play, PlayCircle, Loader2 } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { sprintProgressPercent, type QueryVariant, type SprintCursor } from '~/shared/lib/sprints-shared'
import { Button } from '~/components/ui/button'
import { LinkButton } from '~/components/ui/link'
import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import {
  pickTableSearchParams,
  serializeTableSearch,
  tableSearchSchema,
  tableSearchToParams,
} from '~/shared/lib/table/query-url'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'

interface SprintRow extends Record<string, unknown> {
  id: string
  name: string
  status: 'active' | 'paused' | 'completed'
  quota: number
  lastRunAt: string | null
  createdAt: string
  resultCount: number
  variants: QueryVariant[]
  cursor: SprintCursor
}

export const Route = createFileRoute('/_dashboard/sprints/')({
  // The list's state is the URL, so "my paused sprints, oldest run first" is a link. Flat params,
  // not a parsed `TableSearch` — the router re-serializes whatever this returns.
  validateSearch: (raw: Record<string, unknown>) => pickTableSearchParams(raw),
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    const isAdmin = await getIsAppAdmin()
    return { user, isAdmin }
  },
  component: SprintsListPage,
})

const EMPTY_PAGE: PageResult<SprintRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

const FILTER_LABELS: Record<string, string> = { status: 'Status' }

const STATUS_LABEL: Record<SprintRow['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

function sprintProgress(sprint: SprintRow): number {
  return sprintProgressPercent(sprint.status, sprint.cursor, sprint.variants.length)
}

function SprintsListPage() {
  const { isAdmin } = Route.useRouteContext()
  const params = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const search = React.useMemo(() => tableSearchSchema(params), [params])

  const [page, setPage] = React.useState<PageResult<SprintRow>>(EMPTY_PAGE)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [runningJob, setRunningJob] = React.useState(false)
  const [runNote, setRunNote] = React.useState<string | null>(null)

  const load = React.useCallback(async (next: TableSearch, append = false) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/sprints?${tableSearchToParams(next).toString()}`, { credentials: 'include' })
      if (!res.ok) {
        setPage(EMPTY_PAGE)
        return
      }
      const result = await res.json() as PageResult<SprintRow>
      setPage((current) => append ? { ...result, rows: [...current.rows, ...result.rows] } : result)
    } catch {
      setPage(EMPTY_PAGE)
    } finally {
      setLoading(false)
    }
  }, [])

  const searchKey = tableSearchToParams(search).toString()
  React.useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

  // Every mutation below refetches the page the user is looking at, not page one.
  const reload = React.useCallback(() => load(search), [load, search])

  const runJobNow = async () => {
    setRunningJob(true)
    setRunNote(null)
    setError(null)
    try {
      const res = await fetch('/api/admin/sprints/run-worker', { method: 'POST', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Failed to run the sourcing job')
        return
      }
      setRunNote('Job run triggered — refreshing results…')
      await reload()
    } finally {
      setRunningJob(false)
    }
  }

  const toggle = async (sprint: SprintRow) => {
    setError(null)
    const action = sprint.status === 'active' ? 'pause' : 'resume'
    const res = await fetch(`/api/sprints/${sprint.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to update sprint')
      return
    }
    await reload()
  }

  const remove = async (sprint: SprintRow) => {
    if (!window.confirm(`Delete sprint "${sprint.name}"? This also deletes its results.`)) return
    await fetch(`/api/sprints/${sprint.id}`, { method: 'DELETE', credentials: 'include' })
    await reload()
  }

  const columns = React.useMemo<ColumnDef<SprintRow>[]>(() => [
    {
      id: 'name',
      header: 'Sprint',
      sortable: false,
      priority: 'primary',
      value: (sprint) => sprint.name,
      cell: (sprint) => (
        <Link to="/sprints/$sprintId" params={{ sprintId: sprint.id }} search={{}} className="min-w-0 block">
          <span className="block truncate font-medium text-bh-text">{sprint.name}</span>
          <span className="mt-1.5 block h-1 w-full max-w-xs rounded-full bg-bh-surface/60 overflow-hidden" data-testid="sprint-progress">
            <span
              className="block h-full rounded-full bg-bh-accent transition-all"
              style={{ width: `${sprintProgress(sprint)}%` }}
            />
          </span>
        </Link>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      value: (sprint) => sprint.status,
      cell: (sprint) => STATUS_LABEL[sprint.status],
    },
    {
      id: 'resultCount',
      header: 'Candidates',
      align: 'end',
      value: (sprint) => sprint.resultCount,
      cell: (sprint) => sprint.resultCount.toLocaleString(),
    },
    {
      id: 'lastRunAt',
      header: 'Last run',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (sprint) => sprint.lastRunAt,
      cell: (sprint) => sprint.lastRunAt ? new Date(sprint.lastRunAt).toLocaleString() : 'never',
    },
    {
      id: 'createdAt',
      header: 'Created',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (sprint) => sprint.createdAt,
      cell: (sprint) => new Date(sprint.createdAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'end',
      value: () => null,
      cell: (sprint) => (
        <span className="flex items-center justify-end gap-1">
          {sprint.status !== 'completed' && (
            <button
              type="button"
              onClick={() => toggle(sprint)}
              className="p-2 rounded-md hover:bg-bh-surface/60 text-bh-text-dim"
              aria-label={sprint.status === 'active' ? 'Pause sprint' : 'Resume sprint'}
            >
              {sprint.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={() => remove(sprint)}
            className="p-2 rounded-md hover:bg-bh-surface/60 text-bh-text-dim"
            aria-label="Delete sprint"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  return (
    <div data-testid="sprints-page">
      {/* Both levels wrap: the title and the action group as siblings, and the action group internally.
          "Run job now" plus "New sprint" is 208px of buttons, which does not fit beside a title at 320px. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2">
          <Compass className="w-5 h-5 text-bh-accent" />
          <h1 className="text-xl font-bold text-bh-text">Sourcing sprints</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <Button
              type="button"
              onClick={runJobNow}
              disabled={runningJob}
              variant="secondary"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
              data-testid="sprint-run-job-button"
              title="Manually run the sourcing worker now instead of waiting for the next scheduled run"
            >
              {runningJob ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              Run job now
            </Button>
          )}
          <LinkButton to="/sprints/new" variant="primary" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
            <Plus className="w-4 h-4" /> New sprint
          </LinkButton>
        </div>
      </div>

      {runNote && <p className="text-sm text-bh-text-dim mb-4">{runNote}</p>}
      {error && <p className="text-sm text-bh-danger mb-4">{error}</p>}

      <DataTable
        label="Sourcing sprints"
        columns={columns}
        page={page}
        query={search.query}
        onQueryChange={(query: TableQuery) => void navigate({
          search: serializeTableSearch({ ...search, query, page: { ...search.page, cursor: null } }),
          replace: true,
        })}
        rowTestId={() => 'sprint-row'}
        rowId={(sprint) => sprint.id}
        filterLabels={FILTER_LABELS}
        status={loading && page.rows.length === 0 ? 'loading' : 'ready'}
        onLoadMore={() => {
          if (!page.nextCursor || loading) return
          void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, true)
        }}
        emptyState={(
          <div className="px-4 py-12 text-center" data-testid="sprints-empty">
            <p className="text-bh-text-muted mb-3">
              No sourcing sprints yet. A sprint saves a set of search-query variants and re-runs them in the
              background until it reaches a result quota.
            </p>
            <LinkButton to="/sprints/new" variant="primary" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
              <Plus className="w-4 h-4" /> Start a sprint
            </LinkButton>
          </div>
        )}
      />
    </div>
  )
}
