import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Users, Edit3, X, Save } from 'lucide-react'
import { getAppAuthSession, getIsAppAdmin } from '~/shared/lib/auth/auth-session'
import { PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'
import { Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui'
import { Button } from '~/components/ui/button'

interface UserRow {
  userId: string
  name: string
  email: string
  createdAt: string
  plan: PlanTier
  status: string
  planEndsAt: string | null
}

export const Route = createFileRoute('/_dashboard/admin/users')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (!(await getIsAppAdmin())) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminUsersPage,
})

const PLAN_COLORS: Record<PlanTier, string> = {
  free: 'text-bh-text-dim bg-bh-surface/40 border-bh-border',
  pro: 'text-bh-accent bg-bh-accent-soft border-bh-accent/30',
  team: 'text-bh-cyan bg-bh-cyan/10 border-bh-cyan/30',
}

function AdminUsersPage() {
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
          reason: form.reason || undefined,
        }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      setSuccess(`Plan updated for user.`)
      setEditingId(null)
      await load()
    } catch (e) {
      setError(String(e))
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
            Manage user plans. Free is the default. Pro/Team are admin-granted.
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
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Status</th>
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
                      </td>
                      <td className="px-3 py-2 text-bh-text-dim">—</td>
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
                          placeholder="Reason (e.g. paid via bank)"
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
                            disabled={busy}
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
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${PLAN_COLORS[u.plan]}`}>
                          {u.plan}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-bh-text-muted text-xs">{u.status}</td>
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
        Plans: {PLAN_PRICING.pro.monthly}/mo Pro, {PLAN_PRICING.team.monthly}/mo Team.
      </p>
    </div>
  )
}
