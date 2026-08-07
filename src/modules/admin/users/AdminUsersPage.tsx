import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Users, Edit3, X, Save, ExternalLink, ShieldCheck, AlertTriangle } from 'lucide-react'
import { PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'
import { Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'
import { DataTable } from '~/shared/components/table'
import { emptyTableSearch, tableSearchToParams } from '~/shared/lib/table/query-url'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery, TableSearch } from '~/shared/lib/table/types'

type BillingProvenance = 'canonical' | 'manual_exception' | 'expired_exception' | 'no_organization'

interface UserBillingSummary {
  organizationId: string
  organizationName: string
  entitlementTier: string
  entitlementStatus: string
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  provenance: BillingProvenance
  hasActiveSubscription: boolean
}

/**
 * `plan`, `status` and `planEndsAt` were fields on this interface until 2026-08-04, read from the per-user
 * `plans` table. The API stopped sending them when that table was retired, and **nothing caught it**: this is a
 * hand-written DTO and `load()` parses the response as `any`, so TypeScript had no way to see the divergence.
 * The failure surfaced as `startEdit` seeding the form with `plan: undefined`, which `JSON.stringify` drops,
 * which the route's schema rejects — every manual grant answered 400 with "Failed: 400" in the banner.
 *
 * Everything the operator needs is in `billing`, together with the provenance saying whether Stripe or an
 * operator put it there. Two sources for one question is what produced this.
 */
interface UserRow extends Record<string, unknown> {
  userId: string
  name: string
  email: string
  createdAt: string
  billing: UserBillingSummary | null
}

/** Canonical entitlement tier badge — includes Pro Max, which a manual grant can never produce. */
const ENTITLEMENT_TIER_COLORS: Record<string, string> = {
  free: 'text-bh-text-dim bg-bh-surface/40 border-bh-border',
  pro: 'text-bh-accent bg-bh-accent-soft border-bh-accent/30',
  pro_max: 'text-bh-warning bg-bh-warning/10 border-bh-warning/30',
  team: 'text-bh-cyan-text bg-bh-cyan/10 border-bh-cyan/30',
}

function BillingCell({ billing }: { billing: UserBillingSummary | null }) {
  if (!billing) {
    return (
      <div data-testid="admin-user-billing-no-org">
        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border text-bh-text-dim bg-bh-surface/40 border-bh-border">
          No organization
        </span>
      </div>
    )
  }

  const tierClass = ENTITLEMENT_TIER_COLORS[billing.entitlementTier] ?? ENTITLEMENT_TIER_COLORS.free

  return (
    <div className="flex flex-col gap-1" data-testid={`admin-user-billing-${billing.provenance}`}>
      <div className="flex items-center gap-1.5">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${tierClass}`}>
          {billing.entitlementTier === 'pro_max' ? 'Pro Max' : billing.entitlementTier}
        </span>
        {billing.hasActiveSubscription && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-bh-success" title="Backed by a live Stripe subscription">
            <ShieldCheck className="size-3" aria-hidden />Stripe
          </span>
        )}
        {billing.provenance === 'manual_exception' && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-bh-warning" title="Admin-granted — no matching Stripe subscription">
            <AlertTriangle className="size-3" aria-hidden />Manual exception
          </span>
        )}
        {billing.provenance === 'expired_exception' && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-bh-danger" title="Admin-granted, and its own period has already passed">
            <AlertTriangle className="size-3" aria-hidden />Expired exception
          </span>
        )}
      </div>
      <span className="text-[10px] text-bh-text-dim truncate max-w-[10rem]" title={billing.organizationName}>{billing.organizationName}</span>
    </div>
  )
}

const EMPTY_PAGE: PageResult<UserRow> = { rows: [], nextCursor: null, total: 0, facets: {} }

export function AdminUsersPage() {
  const [page, setPage] = React.useState<PageResult<UserRow>>(EMPTY_PAGE)
  const [search, setSearch] = React.useState<TableSearch>(() => emptyTableSearch())
  const [loading, setLoading] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<{ plan: PlanTier; planEndsAt: string; reason: string }>({
    plan: 'free',
    planEndsAt: '',
    reason: '',
  })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState<string | null>(null)

  /**
   * The search runs in Postgres now.
   *
   * It used to be `users.filter(...)` over whatever the browser held, and the endpoint returned
   * **every user in the system** to make that work. Typing an email that belongs to a user the
   * page had not loaded returned nothing — the same answer as "no such user", which is the
   * difference between slow and wrong.
   */
  const load = React.useCallback(async (next: TableSearch, append = false) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/users?${tableSearchToParams(next).toString()}`, { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json() as PageResult<UserRow>
      setPage((current) => append ? { ...data, rows: [...current.rows, ...data.rows] } : data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const searchKey = JSON.stringify(tableSearchToParams(search).toString())
  React.useEffect(() => {
    void load(search)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey])

  const startEdit = React.useCallback((u: UserRow) => {
    setEditingId(u.userId)
    // Seeded from the canonical entitlement. `pro_max` is deliberately not offered — only a real Stripe
    // subscription can produce it — so an organization already on it starts the form at `free` rather than at a
    // tier this control cannot express; the Stripe badge next to it is what tells the operator why.
    const currentTier = u.billing?.entitlementTier
    const plan: PlanTier = currentTier === 'pro' || currentTier === 'team' ? currentTier : 'free'
    // The grant's own expiry, not Stripe's period end: `planEndsAt` maps to `trial_ends_at`, which is the only
    // date a manual grant sets.
    const endsAt = u.billing?.trialEndsAt ? new Date(u.billing.trialEndsAt).toISOString().slice(0, 10) : ''
    setForm({ plan, planEndsAt: endsAt, reason: '' })
    setError(null)
    setSuccess(null)
  }, [])

  const save = async () => {
    if (!editingId) return
    if (form.reason.trim().length === 0) {
      setError('A reason is required for this audited grant.')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(`/api/admin/users/${editingId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: form.plan,
          planEndsAt: form.planEndsAt || undefined,
          reason: form.reason,
        }),
      })
      if (res.status === 401) throw new Error('Recent re-authentication required — sign in again and retry.')
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      setSuccess('Manual grant recorded (audited).')
      setEditingId(null)
      await load(search)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * The manual-grant form, in the row's expansion slot.
   *
   * It used to replace three of the row's five cells in place, which is why the file carried a
   * comment explaining how the column count still added up. As an expansion it is just a form under
   * the row, and the row keeps showing what it always shows.
   */
  const renderGrantForm = (user: UserRow) => (
    <div className="space-y-2">
      <p className="text-sm font-medium text-bh-text">Manual grant for {user.email}</p>
      <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v as PlanTier })}>
        <SelectTrigger data-testid="admin-user-plan-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="free">Free</SelectItem>
          <SelectItem value="pro">Pro</SelectItem>
          <SelectItem value="team">Team</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-[10px] text-bh-text-dim">Pro Max is Stripe-only — never manually grantable.</p>
      <Input
        type="date"
        value={form.planEndsAt}
        onChange={(event) => setForm({ ...form, planEndsAt: event.target.value })}
        data-testid="admin-user-ends-at"
      />
      <Input
        type="text"
        value={form.reason}
        onChange={(event) => setForm({ ...form, reason: event.target.value })}
        placeholder="Reason (required — shown in the audit log)"
        className="w-full text-xs"
        data-testid="admin-user-reason"
      />
      <Button
        type="button"
        onClick={() => void save()}
        disabled={busy || form.reason.trim().length === 0}
        variant="primary"
        size="sm"
        data-testid="admin-user-save"
      >
        <Save className="h-3 w-3" aria-hidden="true" />
        Save grant
      </Button>
    </div>
  )

  const columns = React.useMemo<ColumnDef<UserRow>[]>(() => [
    {
      id: 'name',
      header: 'User',
      sortable: true,
      priority: 'primary',
      value: (user) => user.name,
      cell: (user) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-bh-text">{user.name}</span>
          <span className="block truncate text-xs text-bh-text-dim">{user.email}</span>
        </span>
      ),
    },
    {
      id: 'billing',
      header: 'Organization & entitlement',
      value: (user) => user.billing?.entitlementTier ?? null,
      cell: (user) => <BillingCell billing={user.billing} />,
    },
    {
      id: 'endsAt',
      header: 'Ends at',
      align: 'end',
      priority: 'secondary',
      value: (user) => user.billing?.trialEndsAt ?? user.billing?.currentPeriodEnd ?? null,
      cell: (user) => (
        <span data-testid={`admin-user-ends-at-${user.userId}`}>
          {user.billing?.trialEndsAt
            ? <span title="Expiry set on a manual grant">{new Date(user.billing.trialEndsAt).toLocaleDateString()}</span>
            : user.billing?.currentPeriodEnd
              ? <span title="End of the current Stripe billing period">{new Date(user.billing.currentPeriodEnd).toLocaleDateString()}</span>
              : '—'}
        </span>
      ),
    },
    {
      id: 'createdAt',
      header: 'Joined',
      sortable: true,
      align: 'end',
      priority: 'secondary',
      value: (user) => user.createdAt,
      cell: (user) => new Date(user.createdAt).toLocaleDateString(),
    },
  ], [])

  return (
    <div data-testid="admin-users-page">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-bh-accent" aria-hidden="true" />
            Users
          </h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Each row's canonical entitlement comes from their owning organization. The control below
            issues an audited manual grant/exception on top of it — it never edits a Stripe
            subscription directly. For that, see{' '}
            <Link to="/admin/billing" className="inline-flex items-center gap-0.5 text-bh-accent hover:underline" data-testid="admin-users-billing-link">
              Billing Operations <ExternalLink className="size-3" aria-hidden />
            </Link>.
          </p>
        </div>
        {/*
          The name/email search moved into the table toolbar, where it reaches Postgres instead of
          filtering the loaded rows. The id stays so anything driving the page by it still finds a
          search box, and points at the one that works.
        */}
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" data-testid="admin-users-error">{error}</div>
      )}
      {success && (
        <div className="card border-bh-success/30 bg-bh-success/5 p-3 mb-4 text-sm text-bh-success" data-testid="admin-users-success">{success}</div>
      )}

      <DataTable
        label="Platform users"
        columns={columns}
        page={page}
        query={search.query}
        onQueryChange={(query: TableQuery) => setSearch((current) => ({
          ...current,
          query,
          page: { ...current.page, cursor: null },
        }))}
        rowTestId={(user) => `admin-user-row-${user.userId}`}
        rowId={(user) => user.userId}
        status={loading && page.rows.length === 0 ? 'loading' : 'ready'}
        onLoadMore={() => {
          if (!page.nextCursor || loading) return
          void load({ ...search, page: { ...search.page, cursor: page.nextCursor } }, true)
        }}
        expansion={renderGrantForm}
        expandedRowId={editingId}
        onExpandedChange={(rowId) => {
          const user = rowId ? page.rows.find((candidate) => candidate.userId === rowId) : null
          if (user) startEdit(user)
          else setEditingId(null)
        }}
        emptyState={(
          <div className="px-4 py-12 text-center text-sm text-bh-text-muted" data-testid="admin-users-empty">
            No users found.
          </div>
        )}
      />

      <p className="text-xs text-bh-text-dim mt-4">
        Total: {page.total} {page.total === 1 ? 'user' : 'users'}.
        Manual-grant pricing reference: {PLAN_PRICING.pro.monthly}/mo Pro, {PLAN_PRICING.team.monthly}/mo Team.
      </p>
    </div>
  )
}
