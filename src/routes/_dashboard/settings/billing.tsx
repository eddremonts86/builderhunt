import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Crown, Users, Sparkles, Check, ArrowRight, Mail, AlertTriangle, Clock } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { PLAN_PRICING, type PlanTier, type PlanStatus, type LimitCheck, type LimitResource } from '~/shared/lib/billing-shared'

interface ChangeRecord {
  id: string
  fromPlan: string | null
  toPlan: string
  reason: string | null
  createdAt: string
}

// Shape actually returned by GET /api/plans/me — the organization's billing
// entitlement, not the legacy per-user `UserPlan` row. `billingPeriod` is
// 'none' for orgs that have never been on a paid plan.
interface PlanDetail {
  plan: PlanTier
  status: PlanStatus
  billingPeriod: 'none' | 'monthly' | 'annual'
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  notes: string | null
  seatLimit: number
  seatsUsed: number
}

const PLAN_ICONS: Record<PlanTier, React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Crown,
  team: Users,
}

const USAGE_COPY: Record<LimitResource, { label: string; description: string }> = {
  savedSearches: {
    label: 'Saved searches',
    description: 'Search alerts that notify you when new builders match your criteria.',
  },
  savedBuilders: {
    label: 'Saved builders',
    description: "Builders you've added to your pipeline for tracking and outreach.",
  },
  rssSubscriptions: {
    label: 'RSS feeds',
    description: 'Feed links generated from your saved searches for use in a feed reader.',
  },
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatPrice(plan: PlanTier, billingPeriod: PlanDetail['billingPeriod']): string {
  const pricing = PLAN_PRICING[plan]
  if (plan === 'free' || pricing.monthly === 0) return 'Free'
  if (billingPeriod === 'annual') return `$${pricing.annual}/year`
  return `$${pricing.monthly}/month`
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
  const [plan, setPlan] = React.useState<PlanDetail | null>(null)
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
          What you're on, what it includes, and what's changed recently.
        </p>
      </header>

      {plan?.status === 'past_due' && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-6 flex items-start gap-2 text-sm text-bh-danger" data-testid="status-banner-past-due">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>Payment past due.</strong> We couldn't confirm your last payment. Email{' '}
            <a href="mailto:hello@builderhunt.dev" className="underline">hello@builderhunt.dev</a> to sort out billing —
            your plan will revert to Free if this isn't resolved.
          </p>
        </div>
      )}
      {plan?.status === 'canceled' && (
        <div className="card border-bh-warning/30 bg-bh-warning/5 p-3 mb-6 flex items-start gap-2 text-sm text-bh-warning" data-testid="status-banner-canceled">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>This plan is canceled.</strong>{' '}
            {formatDate(plan.currentPeriodEnd)
              ? `You'll keep ${plan.plan} access until ${formatDate(plan.currentPeriodEnd)}, then your account moves to Free.`
              : "You'll move to the Free plan at the end of the current billing period."}{' '}
            All your saved data stays intact either way.
          </p>
        </div>
      )}
      {plan?.status === 'trialing' && (
        <div className="card border-bh-cyan/30 bg-bh-cyan/5 p-3 mb-6 flex items-start gap-2 text-sm text-bh-cyan" data-testid="status-banner-trialing">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>You're on a trial of the {plan.plan} plan.</strong>{' '}
            {formatDate(plan.trialEndsAt)
              ? `It ends ${formatDate(plan.trialEndsAt)}. After that you'll need an active subscription to keep these limits.`
              : "We'll email you before it ends."}
          </p>
        </div>
      )}

      {plan && (
        <section className="card p-5 mb-6" data-testid="current-plan">
          <div className="flex items-center gap-3 mb-3">
            <Icon className={`w-6 h-6 ${plan.plan === 'pro' ? 'text-bh-accent' : plan.plan === 'team' ? 'text-bh-cyan' : 'text-bh-text-muted'}`} aria-hidden="true" />
            <div className="flex-1">
              <h2 className="text-lg font-semibold capitalize">
                {plan.plan} plan <span className="font-normal text-bh-text-muted">· {formatPrice(plan.plan, plan.billingPeriod)}</span>
              </h2>
              <p className="text-xs text-bh-text-dim">
                {plan.status === 'active' ? 'Active and in good standing' : `Status: ${plan.status}`}
                {plan.status === 'active' && formatDate(plan.currentPeriodEnd) && ` · Renews ${formatDate(plan.currentPeriodEnd)}`}
              </p>
            </div>
            {plan.plan === 'free' ? (
              <Link to="/pricing" className="btn-primary btn-sm" data-testid="upgrade-cta">
                Upgrade
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </Link>
            ) : (
              <Link to="/pricing" className="btn-secondary btn-sm" data-testid="compare-plans-cta">
                Compare plans
              </Link>
            )}
          </div>

          {plan.plan === 'team' && (
            <p className="text-xs text-bh-text-dim mb-3">
              <strong className="text-bh-text">{plan.seatsUsed}</strong> of {plan.seatLimit} team seats used. Each seat is one
              person with access to your shared saved searches and builder lists.
            </p>
          )}

          <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 mb-3" data-testid="current-plan-features">
            {PLAN_PRICING[plan.plan].features.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm text-bh-text-muted">
                <Check className="w-3.5 h-3.5 text-bh-success shrink-0" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>

          {plan.notes && (
            <p className="text-xs text-bh-text-dim italic mb-2">Note from our team: {plan.notes}</p>
          )}

          <p className="text-xs text-bh-text-dim">
            We manage billing manually while we're small — there's no self-serve payment portal yet. To change
            plans, seats, or billing cadence, email{' '}
            <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">hello@builderhunt.dev</a>{' '}
            and we'll take care of it, usually within 24 hours.
          </p>
        </section>
      )}

      <section className="card p-5 mb-6" data-testid="usage-section">
        <h2 className="font-semibold mb-1">Usage</h2>
        <p className="text-xs text-bh-text-dim mb-4">
          These are limits on how much you can keep saved at once, not a monthly quota — delete old items anytime to
          free up room, or upgrade for more capacity.
        </p>
        <div className="space-y-4">
          {usage.map((u) => {
            // `Infinity` (pro/team's "unlimited") doesn't survive JSON —
            // it round-trips through the API as `null`. Treat both the
            // same so unlimited plans don't render a blank "/ " or a
            // NaN-width progress bar.
            const isUnlimited = u.limit === Infinity || u.limit == null
            const limit = isUnlimited ? '∞' : u.limit
            const pct = isUnlimited ? 0 : Math.min(100, Math.round((u.current / u.limit) * 100))
            const copy = USAGE_COPY[u.resource]
            return (
              <div key={u.resource} data-testid={`usage-${u.resource}`}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span>{copy.label}</span>
                  <span className="text-bh-text-muted">
                    {u.current} / {limit}
                  </span>
                </div>
                <p className="text-xs text-bh-text-dim mb-1.5">{copy.description}</p>
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
                {!isUnlimited && pct >= 90 && (
                  <p className="text-xs text-bh-danger mt-1">
                    You're almost at your {copy.label.toLowerCase()} limit. Delete unused items or{' '}
                    <Link to="/pricing" className="underline">upgrade for more room</Link>.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="card p-5" data-testid="plan-history">
        <h2 className="font-semibold mb-1">Plan history</h2>
        <p className="text-xs text-bh-text-dim mb-3">
          Every change to your plan, most recent first — including the reason it happened when we have one on file.
        </p>
        {history.length > 0 ? (
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="py-1.5 border-b border-bh-border/40 last:border-b-0">
                <div className="flex items-center gap-2 text-sm">
                  <Check className="w-3 h-3 text-bh-success shrink-0" aria-hidden="true" />
                  <span>
                    {h.fromPlan ? `${h.fromPlan} → ` : ''}
                    <strong className="text-bh-text capitalize">{h.toPlan}</strong>
                  </span>
                  <span className="text-xs text-bh-text-dim ml-auto shrink-0">
                    {new Date(h.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-xs text-bh-text-dim pl-5">
                  {h.reason ?? 'No reason was recorded for this change.'}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-bh-text-muted">
            No changes on record — you've been on the {plan?.plan ?? 'Free'} plan since your account was created.
          </p>
        )}
      </section>

      <p className="text-xs text-bh-text-dim mt-6 text-center">
        Questions about your invoice or plan? Email{' '}
        <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">
          <Mail className="w-3 h-3 inline" /> hello@builderhunt.dev
        </a>
      </p>
    </div>
  )
}
