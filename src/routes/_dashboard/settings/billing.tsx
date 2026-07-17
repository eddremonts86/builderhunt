import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Crown, Users, Sparkles, Check, ArrowRight, Mail } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import type { PlanTier, UserPlan, LimitCheck } from '~/shared/lib/billing-shared'

interface ChangeRecord {
  id: string
  fromPlan: string | null
  toPlan: string
  changedBy: string
  reason: string | null
  createdAt: string
}

const PLAN_ICONS: Record<PlanTier, React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Crown,
  team: Users,
}

export const Route = createFileRoute('/_dashboard/settings/billing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  // No loader — all data is fetched client-side via /api/* to keep
  // the SSR bundle clean of the postgres driver.
  component: BillingSettingsPage,
})

function BillingSettingsPage() {
  const [plan, setPlan] = React.useState<UserPlan | null>(null)
  const [usage, setUsage] = React.useState<LimitCheck[]>([])
  const [history, setHistory] = React.useState<ChangeRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [meRes, histRes] = await Promise.all([
        fetch('/api/plans/me', { credentials: 'include' }),
        fetch('/api/me/plan-changes', { credentials: 'include' }),
      ])
      if (!meRes.ok) {
        setError(`Failed to load plan (${meRes.status})`)
        return
      }
      const me = await meRes.json()
      setPlan(me.plan ?? null)
      if (me.limits && me.plan) {
        const limits = me.limits as { savedSearches: number; savedBuilders: number; rssSubscriptions: number }
        const usageCounts = (me.usage ?? {}) as { savedSearches?: number; savedBuilders?: number }
        setUsage([
          { allowed: true, current: usageCounts.savedSearches ?? 0, limit: limits.savedSearches, plan: me.plan.plan, resource: 'savedSearches' },
          { allowed: true, current: usageCounts.savedBuilders ?? 0, limit: limits.savedBuilders, plan: me.plan.plan, resource: 'savedBuilders' },
        ])
      }
      if (histRes.ok) {
        const list = await histRes.json()
        setHistory(
          (Array.isArray(list) ? list : []).map((r: { id: string; fromPlan: string | null; toPlan: string; reason: string | null; createdAt: string }) => ({
            id: r.id,
            fromPlan: r.fromPlan,
            toPlan: r.toPlan,
            changedBy: '',
            reason: r.reason,
            createdAt: r.createdAt,
          })),
        )
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const Icon = plan ? PLAN_ICONS[plan.plan] : Sparkles

  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto" data-testid="billing-settings-page">
        <p className="text-bh-text-muted">Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6 max-w-3xl mx-auto" data-testid="billing-settings-page">
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 text-sm text-bh-danger">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="billing-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Crown className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Billing &amp; plan
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Your current plan and usage.
        </p>
      </header>

      {plan && (
        <section className="card p-5 mb-6" data-testid="current-plan">
          <div className="flex items-center gap-3 mb-3">
            <Icon className={`w-6 h-6 ${plan.plan === 'pro' ? 'text-bh-accent' : plan.plan === 'team' ? 'text-bh-cyan' : 'text-bh-text-muted'}`} aria-hidden="true" />
            <div className="flex-1">
              <h2 className="text-lg font-semibold capitalize">{plan.plan} plan</h2>
              <p className="text-xs text-bh-text-dim">
                Status: {plan.status}
                {plan.planEndsAt && ` · Renews ${new Date(plan.planEndsAt).toLocaleDateString()}`}
              </p>
            </div>
            {plan.plan === 'free' && (
              <Link to="/pricing" className="btn-primary btn-sm" data-testid="upgrade-cta">
                Upgrade
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </Link>
            )}
          </div>
          {plan.notes && (
            <p className="text-xs text-bh-text-dim italic">Note: {plan.notes}</p>
          )}
        </section>
      )}

      <section className="card p-5 mb-6" data-testid="usage-section">
        <h2 className="font-semibold mb-3">Usage</h2>
        <div className="space-y-3">
          {usage.map((u) => {
            // `Infinity` (pro/team's "unlimited") doesn't survive JSON —
            // it round-trips through the API as `null`. Treat both the
            // same so unlimited plans don't render a blank "/ " or a
            // NaN-width progress bar.
            const isUnlimited = u.limit === Infinity || u.limit == null
            const limit = isUnlimited ? '∞' : u.limit
            const pct = isUnlimited ? 0 : Math.min(100, Math.round((u.current / u.limit) * 100))
            return (
              <div key={u.resource} data-testid={`usage-${u.resource}`}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="capitalize">{u.resource.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className="text-bh-text-muted">
                    {u.current} / {limit}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-bh-surface overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isUnlimited ? 'bg-bh-cyan/30' :
                      pct >= 90 ? 'bg-bh-danger' :
                      pct >= 70 ? 'bg-bh-warning' : 'bg-bh-accent'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-bh-text-dim mt-3">
          Usage counts update after each new save. Visit /explore to test.
        </p>
      </section>

      {history.length > 0 && (
        <section className="card p-5" data-testid="plan-history">
          <h2 className="font-semibold mb-3">History</h2>
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-bh-border/40">
                <Check className="w-3 h-3 text-bh-success" aria-hidden="true" />
                <span>
                  {h.fromPlan ? `${h.fromPlan} → ` : ''}
                  <strong className="text-bh-text capitalize">{h.toPlan}</strong>
                </span>
                <span className="text-xs text-bh-text-dim ml-auto">
                  {new Date(h.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-bh-text-dim mt-6 text-center">
        Need help? <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">
          <Mail className="w-3 h-3 inline" /> hello@builderhunt.dev
        </a>
      </p>
    </div>
  )
}
