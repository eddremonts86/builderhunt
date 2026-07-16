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
  loader: async ({ context }) => {
    const userId = context.user.userId!
    // Dynamic-import server-only helpers to keep db out of client bundle
    const [{ getUserPlan, checkLimit }, { db }, { planChanges }] = await Promise.all([
      import('~/shared/lib/billing'),
      import('~/shared/lib/db/index'),
      import('~/shared/lib/db/schema'),
    ])
    const { desc, eq } = await import('drizzle-orm')
    const plan = await getUserPlan(userId)
    const usage = await Promise.all([
      checkLimit(userId, 'savedSearches'),
      checkLimit(userId, 'savedBuilders'),
    ])
    let history: ChangeRecord[] = []
    try {
      const rows = await db
        .select()
        .from(planChanges)
        .where(eq(planChanges.userId, userId))
        .orderBy(desc(planChanges.createdAt))
        .limit(10)
      history = rows.map((r) => ({
        id: r.id,
        fromPlan: r.fromPlan,
        toPlan: r.toPlan,
        changedBy: r.changedBy,
        reason: r.reason,
        createdAt: r.createdAt?.toISOString() ?? '',
      }))
    } catch (err) {
      console.error('plan history error:', err)
    }
    return { plan, usage, history }
  },
  component: BillingSettingsPage,
})

function BillingSettingsPage() {
  const { plan, usage, history } = Route.useLoaderData() as {
    plan: UserPlan | null
    usage: LimitCheck[]
    history: ChangeRecord[]
  }
  const Icon = plan ? PLAN_ICONS[plan.plan] : Sparkles

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="billing-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Crown className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Billing &amp; plan
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Your current plan, usage, and history.
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
            const limit = u.limit === Infinity ? '∞' : u.limit
            const pct = u.limit === Infinity ? 0 : Math.min(100, Math.round((u.current / u.limit) * 100))
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
                      u.limit === Infinity ? 'bg-bh-cyan/30' :
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
