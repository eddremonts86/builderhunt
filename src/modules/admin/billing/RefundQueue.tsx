// table-surface: billingRefundsCapability
import * as React from 'react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { ErrorState } from '~/shared/components/ErrorState'
import { DataTable, DateCell, PrimaryCell, StatusCell, type StatusTone } from '~/shared/components/table'
import { REFUND_POLICY_DECISIONS, type RefundPolicyDecision } from '~/shared/lib/billing-shared'
import type { ColumnDef } from '~/shared/lib/table/columns'
import { tableSearchToParams } from '~/shared/lib/table/query-url'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'

interface RefundRow extends Record<string, unknown> {
  id: string
  organizationId: string
  policyDecision: string
  amountCents: number
  state: string
  createdAt: string
}

const POLICY_LABELS: Record<RefundPolicyDecision, string> = {
  full_unused_pack: 'Full unused pack',
  partial_pack_operator: 'Partial pack (operator)',
  full_subscription_invoice: 'Full subscription invoice',
  partial_subscription_operator: 'Partial subscription (operator)',
}

/** The chips and the filtered-empty copy read these rather than the raw column ids. */
const FILTER_LABELS: Record<string, string> = {
  state: 'State',
  policyDecision: 'Policy',
  organizationId: 'Organization',
}

const EMPTY_PAGE: PageResult<RefundRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * The platform-operator refund review queue.
 *
 * ## What the organization id is now
 *
 * It used to be a precondition: type an id, press Load, and the route returned **every** refund
 * that organization had ever requested. It is a filter dimension now — it lives in
 * `TableQuery.filters`, which means it is in the URL (an operator can hand a colleague the link to
 * a specific queue), it is part of what the keyset cursor is bound to, and an empty result under a
 * typed id renders the *filtered*-empty state naming the organization rather than the blank state
 * claiming the queue is empty. Those were the same message before, and they are different facts.
 *
 * It is still required, because `builderhunt_platform`'s SELECT policy on `billing_refunds` is
 * org-scoped: without an id there is no query to run, so the grid shows the prompt below instead of
 * fetching. The Load button is gone with it — a filter applies itself.
 */
export interface RefundQueueProps {
  /** The route's URL, parsed. This component holds no query state of its own. */
  search: TableSearch
  onSearchChange: (next: TableSearch) => void
}

/**
 * A pending refund is the only state an operator can act on, so it is the only one that carries a
 * colour asking to be acted on. Everything after it belongs to the billing worker.
 */
const REFUND_STATE_TONES: Record<string, StatusTone> = {
  pending: 'warning',
  approved: 'accent',
  completed: 'success',
  denied: 'neutral',
  failed: 'danger',
}

export function RefundQueue({ search, onSearchChange }: RefundQueueProps) {
  const [page, setPage] = React.useState<PageResult<RefundRow>>(EMPTY_PAGE)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [decidingId, setDecidingId] = React.useState<string | null>(null)
  const [policyDecision, setPolicyDecision] = React.useState<RefundPolicyDecision>('partial_pack_operator')
  const [amountCents, setAmountCents] = React.useState('0')
  const [creditRevocationUnits, setCreditRevocationUnits] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const organizationId = search.query.filters.organizationId?.[0] ?? ''
  // Seeded from the URL, so a pasted link shows its organization in the box rather than an empty
  // field above a full grid.
  const [organizationInput, setOrganizationInput] = React.useState(organizationId)

  /*
   * The effect below must not depend on `search` or `onSearchChange`.
   *
   * Both change identity on a render, and a debounce whose timer is cleared by every re-render is
   * a debounce that never fires. Reading them through a ref is what keeps the delay a delay.
   */
  const latest = React.useRef({ search, onSearchChange })
  React.useEffect(() => {
    latest.current = { search, onSearchChange }
  })

  /*
   * The input is the operator's, the filter is the table's, and one of them has to follow.
   *
   * Typing pushes into the filter on a delay — an organization id is pasted far more often than
   * typed, and a fetch per keystroke would be a fetch per character of a 24-character id for no
   * answer anyone reads. The equality guard is what keeps this from looping against the sync in
   * `onQueryChange` below.
   */
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
      const res = await fetch(`/api/admin/billing/refunds?${tableSearchToParams(next).toString()}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load refunds')
        setPage(EMPTY_PAGE)
        return
      }
      const result = data as PageResult<RefundRow>
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

  /** Both ways into the form — the Decide button and the shell's expand toggle — seed it the same. */
  const openDecision = React.useCallback((refund: RefundRow | null) => {
    setDecidingId(refund?.id ?? null)
    if (refund) {
      setAmountCents(String(refund.amountCents))
      setError(null)
    }
  }, [])

  const submitDecision = async (refundId: string) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/billing/refunds', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          refundId,
          policyDecision,
          amountCents: Number(amountCents),
          creditRevocationUnits: creditRevocationUnits ? Number(creditRevocationUnits) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to record decision')
        return
      }
      setDecidingId(null)
      await load(search)
    } finally {
      setSaving(false)
    }
  }

  /**
   * The expansion, which is not always the form.
   *
   * The old markup could only ever open it on a pending refund, because the Decide button was the
   * only way in and only pending rows had one. The shell adds a second way in — the expand toggle,
   * on every row — so the guard has to move here. `decideRefund` would answer `decision_conflict`
   * anyway; offering an operator a form that cannot succeed is the part worth not doing.
   */
  const renderExpansion = (refund: RefundRow) => refund.state !== 'pending'
    ? (
      <p className="text-sm text-bh-text-muted" data-testid={`refund-decided-${refund.id}`}>
        This refund is <strong className="text-bh-text">{refund.state}</strong> — its decision is
        recorded and the billing worker owns it from here.
      </p>
      )
    : (
    <div className="space-y-3">
      <p className="text-sm font-medium text-bh-text">Decision for {refund.id}</p>
      <div>
        <Label htmlFor="refund-policy-select">Policy decision</Label>
        <Select value={policyDecision} onValueChange={(value) => setPolicyDecision(value as RefundPolicyDecision)}>
          <SelectTrigger id="refund-policy-select" data-testid="refund-policy-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REFUND_POLICY_DECISIONS.map((value) => (
              <SelectItem key={value} value={value}>{POLICY_LABELS[value]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="refund-amount-input">Amount (cents)</Label>
        <Input id="refund-amount-input" type="number" value={amountCents} onChange={(e) => setAmountCents(e.target.value)} data-testid="refund-amount-input" />
      </div>
      <div>
        <Label htmlFor="refund-units-input">Credit units to revoke (partial pack only)</Label>
        <Input id="refund-units-input" type="number" value={creditRevocationUnits} onChange={(e) => setCreditRevocationUnits(e.target.value)} data-testid="refund-units-input" />
      </div>
      <Button onClick={() => void submitDecision(refund.id)} disabled={saving} data-testid="refund-submit-decision">
        {saving ? 'Saving…' : 'Record decision'}
      </Button>
    </div>
      )

  const columns = React.useMemo<ColumnDef<RefundRow>[]>(() => [
    {
      id: 'policyDecision',
      header: 'Policy',
      kind: 'primary',
      priority: 'primary',
      value: (refund) => refund.policyDecision,
      cell: (refund) => <PrimaryCell title={POLICY_LABELS[refund.policyDecision as RefundPolicyDecision] ?? refund.policyDecision} />,
    },
    {
      id: 'amountCents',
      header: 'Amount',
      kind: 'number',
      sortable: true,
      value: (refund) => refund.amountCents,
      // Formatted currency rather than `NumberCell`: the figure carries a symbol and a fixed two
      // decimals that a generic number cell would have to be told about twice.
      cell: (refund) => <span className="tbl-cell-number">{formatUsd(refund.amountCents)}</span>,
    },
    {
      id: 'state',
      header: 'State',
      kind: 'status',
      value: (refund) => refund.state,
      cell: (refund) => <StatusCell label={refund.state} tone={REFUND_STATE_TONES[refund.state] ?? 'neutral'} />,
    },
    {
      id: 'createdAt',
      header: 'Requested',
      kind: 'date',
      sortable: true,
      priority: 'secondary',
      value: (refund) => refund.createdAt,
      cell: (refund) => <DateCell value={refund.createdAt} withTime />,
    },
    {
      id: 'decide',
      header: 'Decision',
      kind: 'actions',
      // Only a pending refund can be decided; the worker owns every state after that.
      value: () => null,
      cell: (refund) => refund.state === 'pending'
        ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openDecision(decidingId === refund.id ? null : refund)}
            data-testid={`refund-decide-${refund.id}`}
          >
            Decide
          </Button>
          )
        : null,
    },
  ], [decidingId, openDecision])

  return (
    <div data-testid="refund-queue" className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Refund queue</h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Review pending refund requests and record operator decisions for partial packs and subscriptions. Sending the refund to Stripe and applying credit revocation happens asynchronously in the billing worker.
        </p>
      </header>

      <div className="max-w-md">
        <Label htmlFor="refund-queue-org">Organization ID</Label>
        <Input
          id="refund-queue-org"
          value={organizationInput}
          onChange={(e) => setOrganizationInput(e.target.value)}
          placeholder="org_…"
          data-testid="refund-queue-org-input"
        />
      </div>

      {error && <ErrorState message={error} icon={false} />}

      <DataTable
        label="Refund requests"
        columns={columns}
        page={page}
        query={search.query}
        onQueryChange={(query: TableQuery) => {
          // The shell can clear the organization along with the other filters, and when it does the
          // input has to follow — otherwise it would keep displaying an id that no longer selects
          // anything, and the debounce above would push it straight back.
          setOrganizationInput(query.filters.organizationId?.[0] ?? '')
          onSearchChange({ ...search, query, page: { ...search.page, cursor: null } })
        }}
        rowTestId={(refund) => `refund-row-${refund.id}`}
        rowId={(refund) => refund.id}
        filterLabels={FILTER_LABELS}
        status={loading && page.rows.length === 0 ? 'loading' : 'ready'}
        onLoadMore={() => {
          if (!page.nextCursor || loading) return
          void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, true)
        }}
        expansion={renderExpansion}
        expandedRowId={decidingId}
        onExpandedChange={(rowId) => openDecision(rowId ? page.rows.find((row) => row.id === rowId) ?? null : null)}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="refund-queue-prompt">
            Enter an organization ID above to load its refund queue.
          </div>
        )}
      />
    </div>
  )
}
