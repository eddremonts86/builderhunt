import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Inbox, Check, X, Mail, Clock } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { PLAN_PRICING } from '~/shared/lib/billing-shared'

interface PlanRequest {
  id: string
  userId: string
  requestedPlan: 'pro' | 'team'
  status: 'pending' | 'approved' | 'declined'
  message: string | null
  createdAt: string
  userName: string | null
  userEmail: string | null
}

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean)

export const Route = createFileRoute('/_dashboard/admin/plan-requests')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    if (ADMIN_IDS.length === 0 || !ADMIN_IDS.includes(user.userId)) {
      throw new Error('Forbidden')
    }
    return { user }
  },
  component: AdminPlanRequestsPage,
})

function AdminPlanRequestsPage() {
  const [requests, setRequests] = React.useState<PlanRequest[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/plan-requests', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setRequests(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const resolve = async (id: string, decision: 'approved' | 'declined') => {
    setBusy(id)
    try {
      await fetch('/api/admin/plan-requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: id, decision, reason: 'admin resolved from /admin/plan-requests' }),
      })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const pending = requests.filter((r) => r.status === 'pending')
  const resolved = requests.filter((r) => r.status !== 'pending')

  return (
    <div className="p-6 max-w-4xl mx-auto" data-testid="admin-plan-requests-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Inbox className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Plan requests
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Users who clicked "Get Pro" or "Get Team" on /pricing. Approve to grant them that plan for 30 days.
        </p>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">{error}</div>
      )}

      <section className="mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
          Pending ({pending.length})
        </h2>
        {loading ? (
          <p className="text-sm text-bh-text-muted">Loading…</p>
        ) : pending.length === 0 ? (
          <div className="card text-center py-8 text-bh-text-muted" data-testid="plan-requests-empty">
            No pending requests. 🎉
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div
                key={r.id}
                className="card p-4 flex items-start gap-3"
                data-testid={`plan-request-row-${r.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-semibold text-bh-text">{r.userName ?? 'Unknown'}</span>
                    <a
                      href={`mailto:${r.userEmail}`}
                      className="text-xs text-bh-accent hover:underline inline-flex items-center gap-1"
                    >
                      <Mail className="w-3 h-3" />
                      {r.userEmail}
                    </a>
                    <span className="ml-auto text-[10px] uppercase tracking-wider font-bold text-bh-accent bg-bh-accent-soft border border-bh-accent/30 px-2 py-0.5 rounded-full">
                      wants {r.requestedPlan}
                    </span>
                  </div>
                  <p className="text-xs text-bh-text-dim flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(r.createdAt).toLocaleString()}
                  </p>
                  {r.message && (
                    <p className="text-sm text-bh-text-muted mt-2 italic">"{r.message}"</p>
                  )}
                  <p className="text-xs text-bh-text-dim mt-2">
                    Approving grants: <strong className="text-bh-text">{PLAN_PRICING[r.requestedPlan].label}</strong> plan for 30 days.
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => resolve(r.id, 'approved')}
                    disabled={busy === r.id}
                    className="btn-primary btn-sm"
                    data-testid="plan-request-approve"
                  >
                    <Check className="w-3 h-3" aria-hidden="true" />
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => resolve(r.id, 'declined')}
                    disabled={busy === r.id}
                    className="btn-ghost btn-sm"
                    data-testid="plan-request-decline"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {resolved.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim mb-3">
            Resolved ({resolved.length})
          </h2>
          <div className="space-y-2">
            {resolved.slice(0, 10).map((r) => (
              <div
                key={r.id}
                className="card p-3 flex items-center gap-3 opacity-70"
                data-testid={`plan-request-resolved-${r.id}`}
              >
                <span className="text-sm">{r.userName ?? 'Unknown'}</span>
                <span className={`text-[10px] uppercase font-bold ${
                  r.status === 'approved' ? 'text-bh-success' : 'text-bh-text-dim'
                }`}>
                  {r.status}
                </span>
                <span className="text-xs text-bh-text-dim">{r.requestedPlan}</span>
                <span className="ml-auto text-xs text-bh-text-dim">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
