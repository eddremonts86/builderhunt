import * as React from 'react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'
import { DataTable } from '~/shared/components/table'
import { ABUSE_SIGNAL_FILTER_LABELS } from '~/shared/lib/table/capabilities/abuse-signals'
import {
  emptyTableSearch,
  serializeTableSearch,
  tableSearchToParams,
} from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'

interface StageInfo {
  stage: string
  riskScore: number
  reason: string | null
  updatedAt: string
}

interface AbuseSignalRow extends Record<string, unknown> {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  userId: string | null
  organizationId: string | null
  requestId: string | null
  createdAt: string
  /** The account's current enforcement stage, annotated onto the page by the route. */
  stage: StageInfo | null
}

const EMPTY_PAGE: PageResult<AbuseSignalRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

interface AccountCluster {
  userIds: string[]
  sharedDeviceHashes: string[]
  sharedIpAddresses: string[]
}

const ACTION_OPTIONS = [
  { value: 'clear', label: 'Clear (reset to observe)' },
  { value: 'warn', label: 'Warn' },
  { value: 'stepup', label: 'Force step-up' },
  { value: 'block', label: 'Block' },
]

/** Platform-admin abuse console (abuse-and-usage-integrity Phase 5 task 3). Composes the recent
 * `abuse_signals` feed (with each signal's current enforcement stage) and the linked-account
 * cluster read model (its own pre-existing route from Phase 3) into one review surface, with
 * inline manual actions per account — same expand-a-row-no-modal pattern as `RefundQueue`. */
export function AbuseConsole() {
  const [page, setPage] = React.useState<PageResult<AbuseSignalRow>>(EMPTY_PAGE)
  const [loaded, setLoaded] = React.useState(false)
  // Table state is local rather than in the URL: the console is a component inside `/admin/abuse`,
  // which owns its own search params. A surface that wants linkable table state passes
  // `tableSearchSchema` to its route, as `sprints/$sprintId` does.
  const [search, setSearch] = React.useState<TableSearch>(() => emptyTableSearch())
  const [clusters, setClusters] = React.useState<AccountCluster[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // No `actingSignalId`: which row is expanded is the shell's business now, and two components
  // tracking it was how the old markup ended up with a second `<tr>` it had to keep in sync.
  const [action, setAction] = React.useState(ACTION_OPTIONS[0].value)
  const [reason, setReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async (next: TableSearch, append = false) => {
    setLoading(true)
    setError(null)
    try {
      const [feedRes, clustersRes] = await Promise.all([
        fetch(`/api/admin/abuse?${tableSearchToParams(next).toString()}`, { credentials: 'include' }),
        fetch('/api/admin/abuse/clusters', { credentials: 'include' }),
      ])
      const feedData = await feedRes.json()
      const clustersData = await clustersRes.json()
      if (!feedRes.ok) {
        setError(feedData.error ?? 'Failed to load abuse signals')
        return
      }
      setPage((current) => append ? { ...feedData, rows: [...current.rows, ...feedData.rows] } : feedData)
      setLoaded(true)
      if (clustersRes.ok) setClusters(clustersData.clusters)
    } finally {
      setLoading(false)
    }
  }, [])

  const searchKey = JSON.stringify(serializeTableSearch(search))
  React.useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

  const submitAction = async (userId: string) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/abuse', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action, reason: reason.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to record action')
        return
      }
      setReason('')
      await load(search)
    } finally {
      setSaving(false)
    }
  }

  /**
   * The per-account action form, in the row's expansion slot.
   *
   * It was a second `<tr colSpan={6}>` under the row before — the "expand a row, no modal" pattern
   * `RefundQueue` established. The shell's `expansion` slot is the same idea with the ARIA row
   * bookkeeping done for it.
   */
  const renderAccountAction = (row: AbuseSignalRow) => (
    <div className="space-y-3">
      <div>
        <Label htmlFor="abuse-action-select">Action</Label>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger id="abuse-action-select" data-testid="abuse-account-action-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="abuse-action-reason">Reason (optional)</Label>
        <Input
          id="abuse-action-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          data-testid="abuse-account-action-reason"
        />
      </div>
      <Button
        onClick={() => void submitAction(row.userId!)}
        disabled={saving}
        data-testid={`abuse-account-action-submit-${row.userId}`}
      >
        {saving ? 'Saving…' : 'Apply action'}
      </Button>
    </div>
  )

  const columns = React.useMemo<ColumnDef<AbuseSignalRow>[]>(() => [
    {
      id: 'type',
      header: 'Type',
      sortable: true,
      groupable: true,
      priority: 'primary',
      value: (row) => row.type,
      cell: (row) => row.type,
    },
    { id: 'severity', header: 'Severity', value: (row) => row.severity, cell: (row) => row.severity },
    {
      id: 'user',
      header: 'User',
      priority: 'secondary',
      value: (row) => row.userId,
      // Deliberately not a monospace face: DESIGN.md:221 reserves it for literal code and keys, and
      // an opaque id rendered in a table column is neither. `truncate` does the alignment work.
      cell: (row) => <span className="truncate text-xs">{row.userId ?? '—'}</span>,
    },
    {
      id: 'stage',
      header: 'Stage',
      priority: 'secondary',
      value: (row) => row.stage?.stage ?? null,
      cell: (row) => row.stage?.stage ?? '—',
    },
    {
      id: 'createdAt',
      header: 'Created',
      sortable: true,
      align: 'end',
      value: (row) => row.createdAt,
      cell: (row) => new Date(row.createdAt).toLocaleString(),
    },
  ], [])

  return (
    <div data-testid="abuse-console" className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Abuse console</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Review recent abuse signals and linked-account clusters, and manually clear, warn, force
          step-up, or block an account. Every manual action is audited.
        </p>
      </header>

      {error && <ErrorState message={error} icon={false} />}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent abuse signals</h2>
          <Button variant="secondary" onClick={() => void load(search)} disabled={loading} data-testid="abuse-console-refresh">
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        <DataTable
          label="Recent abuse signals"
          columns={columns}
          page={page}
          query={search.query}
          onQueryChange={(query: TableQuery) => setSearch((current) => ({
            ...current,
            query,
            // A cursor is bound to the sort it was minted for, so a query change starts over.
            page: { ...current.page, cursor: null },
          }))}
          rowTestId={(row) => `abuse-signal-row-${row.id}`}
          status={loading && !loaded ? 'loading' : error ? 'error' : 'ready'}
          error={{ message: error ?? '', onRetry: () => void load(search) }}
          onLoadMore={() => {
            if (!page.nextCursor || loading) return
            void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, true)
          }}
          filterLabels={ABUSE_SIGNAL_FILTER_LABELS}
          expansion={(row) => row.userId ? renderAccountAction(row) : null}
          emptyState={(
            <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="abuse-signals-empty">
              No abuse signals recorded.
            </div>
          )}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Linked-account clusters</h2>
        <p className="text-sm text-bh-text-muted">
          Accounts sharing a device hash or IP address in the last 30 days. Review-only — clusters
          never trigger enforcement on their own.
        </p>
        {clusters && clusters.length === 0 && <p className="text-sm text-bh-text-muted">No linked-account clusters detected.</p>}
        {clusters && clusters.length > 0 && (
          <ul className="space-y-2" data-testid="abuse-clusters-list">
            {clusters.map((cluster, index) => (
              <li key={index} className="card p-3 text-sm" data-testid={`abuse-cluster-row-${index}`}>
                <div className="font-mono text-xs">{cluster.userIds.join(', ')}</div>
                <div className="text-bh-text-muted mt-1">
                  {cluster.sharedDeviceHashes.length > 0 && `${cluster.sharedDeviceHashes.length} shared device(s)`}
                  {cluster.sharedDeviceHashes.length > 0 && cluster.sharedIpAddresses.length > 0 && ', '}
                  {cluster.sharedIpAddresses.length > 0 && `${cluster.sharedIpAddresses.length} shared IP(s)`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  )
}
