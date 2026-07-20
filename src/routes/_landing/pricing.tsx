import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, X, Mail, Sparkles, Users, Crown, HelpCircle } from 'lucide-react'
import { PLAN_LIMITS, PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

export const Route = createFileRoute('/_landing/pricing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    // Dynamic-import getUserPlan to keep db out of the client bundle
    const { getUserPlan } = await import('~/shared/lib/billing')
    const plan = user.userId ? await getUserPlan(user.userId) : null
    return { user, plan }
  },
  loader: async ({ context }) => context,
  head: () => ({
    meta: [
      { title: 'Pricing — BuilderHunt' },
      {
        name: 'description',
        content: 'Simple, transparent pricing. Free forever, Pro for power users, Team for sourcing teams. No credit card required.',
      },
    ],
  }),
  component: PricingPage,
})

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Can I use BuilderHunt for free?',
    a: 'Yes. The Free plan gives you 3 saved searches, 50 saved builders, and full access to /explore and /blog. No credit card required, no expiry.',
  },
  {
    q: 'How do I upgrade to Pro?',
    a: 'Click "Get Pro" below. We currently manage subscriptions manually (no Stripe yet) — you email us, we set up payment, and we activate your Pro within 24 hours. Once we hit 50+ paying customers, we integrate Stripe and automate this.',
  },
  {
    q: 'What happens if I downgrade?',
    a: 'You keep all your saved data. Limits kick in (e.g., free = 3 saved searches), but you can still access everything. No data loss.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'Yes, 30-day money-back on Pro and Team. No questions asked.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Admin sets your plan back to Free, no questions asked.',
  },
  {
    q: 'What is a "team seat"?',
    a: 'One team seat = one person on your team. Team owners can invite members by email. Members get shared saved searches, shared builder lists, and an activity feed.',
  },
]

const PLAN_ICONS: Record<PlanTier, React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Crown,
  team: Users,
}

const PLAN_COLORS: Record<PlanTier, string> = {
  free: 'border-bh-border',
  pro: 'border-bh-accent shadow-lg shadow-bh-accent/10',
  team: 'border-bh-cyan shadow-lg shadow-bh-cyan/10',
}

function PricingPage() {
  const { plan } = Route.useLoaderData() as { plan: { plan: PlanTier; status: string } | null }
  const [busy, setBusy] = React.useState<PlanTier | null>(null)
  const [requestMsg, setRequestMsg] = React.useState<string | null>(null)
  const [billingPeriod, setBillingPeriod] = React.useState<'monthly' | 'annual'>('monthly')

  const requestUpgrade = async (tier: 'pro' | 'team') => {
    setBusy(tier)
    setRequestMsg(null)
    try {
      const res = await fetch('/api/plans/request-upgrade', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedPlan: tier, message: '' }),
      })
      if (res.status === 401) {
        setRequestMsg('Please sign in first.')
        return
      }
      if (!res.ok) {
        setRequestMsg('Failed to submit request.')
        return
      }
      setRequestMsg(`Request submitted! We'll email you within 24h. Or email hello@builderhunt.dev now.`)
    } catch (e) {
      setRequestMsg(String(e))
    } finally {
      setBusy(null)
    }
  }

  const tiers: PlanTier[] = ['free', 'pro', 'team']

  return (
    <div className="container py-12 max-w-5xl animate-fade-in" data-testid="pricing-page">
      <header className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-3 text-bh-text">Pricing</h1>
        <p className="text-bh-text-muted text-base">
          Simple, transparent. Free forever. Upgrade when you outgrow the limits.
        </p>
        <div className="inline-flex rounded-lg border border-bh-border p-0.5 mt-4" data-testid="billing-period-toggle">
          <button
            type="button"
            onClick={() => setBillingPeriod('monthly')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-colors ${
              billingPeriod === 'monthly' ? 'bg-bh-accent text-white' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-monthly"
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod('annual')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-colors ${
              billingPeriod === 'annual' ? 'bg-bh-accent text-white' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-annual"
          >
            Annual <span className="text-[10px] text-bh-cyan ml-1">(-20%)</span>
          </button>
        </div>
      </header>

      {requestMsg && (
        <div className="card border-bh-accent/30 bg-bh-accent/5 p-4 mb-6 text-sm text-bh-accent text-center rounded-xl" data-testid="pricing-msg">
          {requestMsg}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        {tiers.map((tier) => {
          const config = PLAN_PRICING[tier]
          const limits = PLAN_LIMITS[tier]
          const isCurrent = plan?.plan === tier
          const Icon = PLAN_ICONS[tier]
          const price = billingPeriod === 'monthly' ? config.monthly : config.annual
          const periodLabel = billingPeriod === 'monthly' ? '/mo' : '/yr'
          const hasAlerts = config.features.includes('Smart alerts')
          const hasCodeStyle = config.features.includes('Code fingerprinting')
          const teamSeats = tier === 'team' ? 10 : 1
          const displayLimit = (value: number) => Number.isFinite(value) ? value : 'Unlimited'

          return (
            <article
              key={tier}
              className={`card p-8 border ${PLAN_COLORS[tier]} bg-bh-surface rounded-2xl flex flex-col justify-between`}
              data-testid={`plan-${tier}`}
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border border-bh-border bg-bh-surface/50 text-bh-text capitalize">
                    <Icon className="w-3.5 h-3.5" />
                    {tier}
                  </span>
                  {tier === 'pro' && (
                    <span className="text-[10px] bg-bh-accent-soft text-bh-accent border border-bh-accent/30 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
                      Popular
                    </span>
                  )}
                </div>

                <div className="mb-6">
                  <span className="text-4xl font-extrabold text-bh-text">${price}</span>
                  <span className="text-bh-text-dim text-sm">{periodLabel}</span>
                </div>

                <p className="text-xs text-bh-text-muted mb-6 min-h-[32px] leading-relaxed">
                  {tier === 'free' && 'For individual developers searching the community.'}
                  {tier === 'pro' && 'For power users needing saved keyword alerts.'}
                  {tier === 'team' && 'For hiring and community teams collaborating on shortlists.'}
                </p>

                <ul className="space-y-3 mb-8 text-sm text-bh-text-muted">
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-bh-success" />
                    <span>{displayLimit(limits.savedSearches)} saved searches</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-bh-success" />
                    <span>{displayLimit(limits.savedBuilders)} saved builders</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-bh-success" />
                    <span>{displayLimit(limits.rssSubscriptions)} RSS feeds</span>
                  </li>
                  <li className="flex items-center gap-2">
                    {hasAlerts ? (
                      <Check className="w-4 h-4 text-bh-success" />
                    ) : (
                      <X className="w-4 h-4 text-bh-text-dim" />
                    )}
                    <span className={hasAlerts ? 'text-bh-text' : 'line-through text-bh-text-dim'}>Smart alerts</span>
                  </li>
                  <li className="flex items-center gap-2">
                    {hasCodeStyle ? (
                      <Check className="w-4 h-4 text-bh-success" />
                    ) : (
                      <X className="w-4 h-4 text-bh-text-dim" />
                    )}
                    <span className={hasCodeStyle ? 'text-bh-text' : 'line-through text-bh-text-dim'}>Code fingerprinting</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-bh-success" />
                    <span>{teamSeats} seat{teamSeats > 1 ? 's' : ''}</span>
                  </li>
                </ul>
              </div>

              <div>
                {isCurrent ? (
                  <div className="w-full text-center py-2 bg-bh-accent-soft border border-bh-accent/30 text-bh-accent text-sm font-bold rounded-xl">
                    Your current plan
                  </div>
                ) : tier === 'free' ? (
                  <Link to="/auth/sign-up" className="w-full btn-secondary justify-center rounded-xl font-bold">
                    Get started
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => requestUpgrade(tier as 'pro' | 'team')}
                    className="w-full btn-primary rounded-xl font-bold py-2"
                  >
                    {busy === tier ? 'Submitting...' : `Get ${tier}`}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>

      <section className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm mb-12" data-testid="pricing-features">
        <h2 className="text-xl font-bold text-bh-text mb-6">Feature comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bh-border text-left">
                <th className="py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Feature</th>
                <th className="text-center py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Free</th>
                <th className="text-center py-3 px-2 font-bold text-bh-accent uppercase tracking-wider text-xs">Pro</th>
                <th className="text-center py-3 px-2 font-bold text-bh-cyan uppercase tracking-wider text-xs">Team</th>
              </tr>
            </thead>
            <tbody className="text-bh-text-muted">
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Saved searches</td>
                <td className="text-center py-3 px-2">3</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">50</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">200</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Saved builders</td>
                <td className="text-center py-3 px-2">50</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">RSS feeds</td>
                <td className="text-center py-3 px-2">3</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Smart alerts</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Code fingerprinting</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Team seats</td>
                <td className="text-center py-3 px-2">1</td>
                <td className="text-center py-3 px-2">1</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">10</td>
              </tr>
              <tr className="border-0">
                <td className="py-3 px-2">Activity feed</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm mb-12" data-testid="pricing-faq">
        <h2 className="text-xl font-bold flex items-center gap-2 mb-6">
          <HelpCircle className="w-5 h-5 text-bh-accent" aria-hidden="true" />
          Frequently Asked Questions
        </h2>
        <div className="space-y-4">
          {FAQ.map((f) => (
            <details key={f.q} className="group border-b border-bh-border/40 last:border-0 pb-4 last:pb-0">
              <summary className="cursor-pointer font-semibold text-bh-text hover:text-bh-accent transition-colors flex items-center gap-2 outline-none list-none [&::-webkit-details-marker]:hidden">
                <span className="w-1.5 h-1.5 rounded-full bg-bh-accent opacity-0 group-open:opacity-100 transition-opacity" />
                <span>{f.q}</span>
              </summary>
              <p className="text-sm text-bh-text-muted mt-2 pl-3 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <p className="text-center text-xs text-bh-text-dim mt-8">
        Questions? <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline inline-flex items-center gap-1">
          <Mail className="w-3.5 h-3.5 inline" /> hello@builderhunt.dev
        </a>
      </p>
    </div>
  )
}
