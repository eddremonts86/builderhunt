// table-surface: billingDisputesCapability
import * as React from 'react'
import { Input, Label } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'
import { DataTable } from '~/shared/components/table'
import type { ColumnDef } from '~/shared/lib/table/columns'
import { tableSearchToParams } from '~/shared/lib/table/query-url'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'

interface DisputeRow extends Record<string, unknown> {
  id: string
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  outcome: string
  evidenceDueBy: string | null
  fundsReinstatedAt: string | null
  createdAt: string
}

const FILTER_LABELS: Record<string, string> = {
  outcome: 'Outcome',
  stripeStatus: 'Stripe status',
  organizationId: 'Organization',
}

const EMPTY_PAGE: PageResult<DisputeRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function outcomeBadgeClass(outcome: string): string {
  if (outcome === 'won') return 'text-bh-success'
  if (outcome === 'lost') return 'text-bh-danger'
  return 'text-bh-warning'
}

export interface DisputeQueueProps {
  /** The route's URL, parsed. This component holds no query state of its own. */
  search: TableSearch
  onSearchChange: (next: TableSearch) => void
}

/**
 * Read-only chargeback view — no operator "decide" action here, because evidence submission and
 * the won/lost outcome both live in the Stripe Dashboard (see `billing/disputes.ts`). What this
 * surface answers is which grants are frozen and which evidence deadline is closest, which is why
 * "Evidence due" is a sort and not only a column.
 *
 * The organization moved from a Load-button precondition to `filter.organizationId`, same as the
 * refund queue: in the URL, in the cursor's binding, and named by the filtered-empty state when a
 * typed organization has no disputes — a different fact from never having chosen one.
 */
export function DisputeQueue({ search, onSearchChange }: DisputeQueueProps) {
  const [page, setPage] = React.useState<PageResult<DisputeRow>>(EMPTY_PAGE)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const organizationId = search.query.filters.organizationId?.[0] ?? ''
  const [organizationInput, setOrganizationInput] = React.useState(organizationId)

  // Read through a ref so the debounce below does not depend on props whose identity changes on
  // every render — a timer cleared by each re-render is a timer that never fires.
  const latest = React.useRef({ search, onSearchChange })
  React.useEffect(() => {
    latest.current = { search, onSearchChange }
  })

  React.useEffect(() => {
    const trimmed = organizationInput.trim()
    if (trimmed === organizationId) return
    const timer = setTimeout(() => {
      const current = latest.current.search
      const filters = { ...current.query.filters }
      if (trimmed === '') delete filters.organizationId
      else filters.organizationId = [trimmed]
      latest.current.onSearchChange({
        ...current,
        query: { ...current.query, filters },
        page: { ...current.page, cursor: null },
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [organizationInput, organizationId])

  const load = React.useCallback(async (next: TableSearch, append = false) => {
    if ((next.query.filters.organizationId?.[0] ?? '') === '') {
      setPage(EMPTY_PAGE)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/billing/disputes?${tableSearchToParams(next).toString()}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load disputes')
        setPage(EMPTY_PAGE)
        return
      }
      const result = data as PageResult<DisputeRow>
      setPage((current) => append ? { ...result, rows: [...current.rows, ...result.rows] } : result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const searchKey = tableSearchToParams(search).toString()
  React.useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

  const columns = React.useMemo<ColumnDef<DisputeRow>[]>(() => [
    {
      id: 'reason',
      header: 'Reason',
      priority: 'primary',
      value: (dispute) => dispute.reason,
      cell: (dispute) => dispute.reason ?? '—',
    },
    {
      id: 'amountCents',
      header: 'Amount',
      align: 'end',
      value: (dispute) => dispute.amountCents,
      cell: (dispute) => formatUsd(dispute.amountCents),
    },
    {
      id: 'stripeStatus',
      header: 'Stripe status',
      value: (dispute) => dispute.stripeStatus,
      cell: (dispute) => dispute.stripeStatus,
    },
    {
      id: 'outcome',
      header: 'Outcome',
      value: (dispute) => dispute.outcome,
      cell: (dispute) => <span className={`font-medium ${outcomeBadgeClass(dispute.outcome)}`}>{dispute.outcome}</span>,
    },
    {
      id: 'evidenceDueBy',
      header: 'Evidence due',
      sortable: true,
      align: 'end',
      value: (dispute) => dispute.evidenceDueBy,
      cell: (dispute) => dispute.evidenceDueBy ? new Date(dispute.evidenceDueBy).toLocaleString() : '—',
    },
    {
      id: 'createdAt',
      header: 'Opened',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (dispute) => dispute.createdAt,
      cell: (dispute) => new Date(dispute.createdAt).toLocaleString(),
    },
  ], [])

  return (
    <div data-testid="dispute-queue" className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Dispute queue</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Chargebacks freeze their linked pack grant automatically. Evidence submission and the won/lost outcome are handled in the Stripe Dashboard — this view is read-only.
        </p>
      </header>

      <div className="max-w-md">
        <Label htmlFor="dispute-queue-org">Organization ID</Label>
        <Input
          id="dispute-queue-org"
          value={organizationInput}
          onChange={(e) => setOrganizationInput(e.target.value)}
          placeholder="org_…"
          data-testid="dispute-queue-org-input"
        />
      </div>

      {error && <ErrorState message={error} icon={false} />}

      <DataTable
        label="Disputes"
        columns={columns}
        page={page}
        query={search.query}
        onQueryChange={(query: TableQuery) => {
          setOrganizationInput(query.filters.organizationId?.[0] ?? '')
          onSearchChange({ ...search, query, page: { ...search.page, cursor: null } })
        }}
        rowTestId={(dispute) => `dispute-row-${dispute.id}`}
        rowId={(dispute) => dispute.id}
        filterLabels={FILTER_LABELS}
        status={loading && page.rows.length === 0 ? 'loading' : 'ready'}
        onLoadMore={() => {
          if (!page.nextCursor || loading) return
          void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, true)
        }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="dispute-queue-prompt">
            Enter an organization ID above to load its disputes.
          </div>
        )}
      />
    </div>
  )
}
