import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Users, Edit3, X, Save, ExternalLink, ShieldCheck, AlertTriangle } from 'lucide-react'
import { PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'
import { Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'

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

interface UserRow {
  userId: string
  name: string
  email: string
  createdAt: string
  plan: PlanTier
  status: string
  planEndsAt: string | null
  billing: UserBillingSummary | null
}

const PLAN_COLORS: Record<PlanTier, string> = {
  free: 'text-bh-text-dim bg-bh-surface/40 border-bh-border',
  pro: 'text-bh-accent bg-bh-accent-soft border-bh-accent/30',
  team: 'text-bh-cyan bg-bh-cyan/10 border-bh-cyan/30',
}

/** Canonical entitlement tier badge — includes Pro Max, which the legacy `PLAN_COLORS` above (a
 * pre-Pro-Max, per-user grant concept) has no entry for. */
const ENTITLEMENT_TIER_COLORS: Record<string, string> = {
  free: 'text-bh-text-dim bg-bh-surface/40 border-bh-border',
  pro: 'text-bh-accent bg-bh-accent-soft border-bh-accent/30',
  pro_max: 'text-bh-warning bg-bh-warning/10 border-bh-warning/30',
  team: 'text-bh-cyan bg-bh-cyan/10 border-bh-cyan/30',
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

export function AdminUsersPage() {
  const [users, setUsers] = React.useState<UserRow[]>([])
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
  const [filter, setFilter] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setUsers(Array.isArray(data.users) ? data.users : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const startEdit = (u: UserRow) => {
    setEditingId(u.userId)
    const endsAt = u.planEndsAt ? new Date(u.planEndsAt).toISOString().slice(0, 10) : ''
    setForm({ plan: u.plan, planEndsAt: endsAt, reason: '' })
    setError(null)
    setSuccess(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

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
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const filtered = users.filter(
    (u) => !filter || u.email.toLowerCase().includes(filter.toLowerCase()) || u.name.toLowerCase().includes(filter.toLowerCase()),
  )

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
        <Input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or email…"
          className="w-64"
          data-testid="admin-users-filter"
        />
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger" data-testid="admin-users-error">{error}</div>
      )}
      {success && (
        <div className="card border-bh-success/30 bg-bh-success/5 p-3 mb-4 text-sm text-bh-success" data-testid="admin-users-success">{success}</div>
      )}

      <div className="card table-scroll p-0" tabIndex={0} role="region" aria-label="Users table, scrollable">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-bh-border text-left text-xs uppercase tracking-wider text-bh-text-dim">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Organization &amp; entitlement</th>
              <th className="px-3 py-2">Manual grant</th>
              <th className="px-3 py-2">Ends at</th>
              <th className="px-3 py-2">Joined</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-6 text-bh-text-muted">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-6 text-bh-text-muted">No users found.</td></tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.userId} className="border-b border-bh-border/40" data-testid={`admin-user-row-${u.userId}`}>
                  {editingId === u.userId ? (
                    <>
                      <td className="px-3 py-2">
                        <p className="font-medium text-bh-text">{u.name}</p>
                        <p className="text-xs text-bh-text-dim">{u.email}</p>
                      </td>
                      <td className="px-3 py-2"><BillingCell billing={u.billing} /></td>
                      <td className="px-3 py-2">
                        <Select
                          value={form.plan}
                          onValueChange={(v) => setForm({ ...form, plan: v as PlanTier })}
                        >
                          <SelectTrigger data-testid="admin-user-plan-select">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="free">Free</SelectItem>
                            <SelectItem value="pro">Pro</SelectItem>
                            <SelectItem value="team">Team</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-bh-text-dim mt-1">Pro Max is Stripe-only — never manually grantable.</p>
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="date"
                          value={form.planEndsAt}
                          onChange={(e) => setForm({ ...form, planEndsAt: e.target.value })}
                          data-testid="admin-user-ends-at"
                        />
                        <Input
                          type="text"
                          value={form.reason}
                          onChange={(e) => setForm({ ...form, reason: e.target.value })}
                          placeholder="Reason (required — shown in the audit log)"
                          className="mt-1 w-full text-xs"
                          data-testid="admin-user-reason"
                        />
                      </td>
                      <td className="px-3 py-2 text-bh-text-dim text-xs">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            onClick={save}
                            disabled={busy || form.reason.trim().length === 0}
                            variant="primary"
                            size="sm"
                            data-testid="admin-user-save"
                          >
                            <Save className="w-3 h-3" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            onClick={cancelEdit}
                            variant="ghost"
                            size="sm"
                          >
                            <X className="w-3 h-3" aria-hidden="true" />
                          </Button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2">
                        <p className="font-medium text-bh-text">{u.name}</p>
                        <p className="text-xs text-bh-text-dim">{u.email}</p>
                      </td>
                      <td className="px-3 py-2"><BillingCell billing={u.billing} /></td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${PLAN_COLORS[u.plan]}`} data-testid={`admin-user-manual-grant-${u.userId}`}>
                          {u.plan}
                        </span>
                        <p className="text-[10px] text-bh-text-dim mt-0.5">{u.status}</p>
                      </td>
                      <td className="px-3 py-2 text-bh-text-muted text-xs">
                        {u.planEndsAt ? new Date(u.planEndsAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-bh-text-dim text-xs">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          onClick={() => startEdit(u)}
                          variant="ghost"
                          size="sm"
                          data-testid="admin-user-edit"
                        >
                          <Edit3 className="w-3 h-3" aria-hidden="true" />
                          Edit
                        </Button>
                      </td>
                    </>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-bh-text-dim mt-4">
        Total: {users.length} {users.length === 1 ? 'user' : 'users'}.
        Manual-grant pricing reference: {PLAN_PRICING.pro.monthly}/mo Pro, {PLAN_PRICING.team.monthly}/mo Team.
      </p>
    </div>
  )
}
