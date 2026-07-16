import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, X, Mail, Sparkles, Users, Crown, HelpCircle } from 'lucide-react'
import { PLAN_PRICING, type PlanTier } from '~/shared/lib/billing-shared'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

export const Route = createFileRoute('/pricing')({
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
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-5xl mx-auto" data-testid="pricing-page">
      <header className="text-center mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">Pricing</h1>
        <p className="text-bh-text-muted mb-4">
          Simple, transparent. Free forever. Upgrade when you outgrow the limits.
        </p>
        <div className="inline-flex rounded-lg border border-bh-border p-0.5" data-testid="billing-period-toggle">
          <button
            type="button"
            onClick={() => setBillingPeriod('monthly')}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              billingPeriod === 'monthly' ? 'bg-bh-accent text-white' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-monthly"
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod('annual')}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              billingPeriod === 'annual' ? 'bg-bh-accent text-white' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-annual"
          >
            Annual <span className="text-[10px] text-bh-cyan">(-20%)</span>
          </button>
        </div>
      </header>

      {requestMsg && (
        <div className="card border-bh-accent/30 bg-bh-accent/5 p-3 mb-4 text-sm text-bh-accent" data-testid="pricing-msg">
          {requestMsg}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {tiers.map((tier) => {
          const config = PLAN_PRICING[tier]
          const Icon = PLAN_ICONS[tier]
          const isCurrent = plan?.plan === tier
          const price = billingPeriod === 'monthly' ? config.monthly : Math.round(config.annual / 12)
          return (
            <div
              key={tier}
              className={`card p-5 flex flex-col ${PLAN_COLORS[tier]}`}
              data-testid={`pricing-tier-${tier}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-5 h-5 ${tier === 'pro' ? 'text-bh-accent' : tier === 'team' ? 'text-bh-cyan' : 'text-bh-text-muted'}`} aria-hidden="true" />
                <h2 className="text-lg font-semibold">{config.label}</h2>
                {isCurrent && (
                  <span className="ml-auto text-[10px] uppercase tracking-wider font-bold text-bh-success bg-bh-success/10 px-2 py-0.5 rounded-full">
                    Current
                  </span>
                )}
              </div>
              <p className="mb-4">
                <span className="text-3xl font-bold">${price}</span>
                <span className="text-sm text-bh-text-muted">/mo</span>
                {billingPeriod === 'annual' && tier !== 'free' && (
                  <span className="block text-xs text-bh-text-dim">billed annually (${config.annual}/yr)</span>
                )}
              </p>
              <ul className="space-y-1.5 text-sm text-bh-text-muted mb-5 flex-1">
                {config.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-bh-success shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {tier === 'free' ? (
                <Link to="/auth/sign-up" className="btn-secondary text-center" data-testid="pricing-cta-free">
                  {isCurrent ? 'Current plan' : 'Get started'}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => requestUpgrade(tier)}
                  disabled={busy === tier || isCurrent}
                  className={tier === 'pro' ? 'btn-primary' : 'btn-secondary'}
                  data-testid={`pricing-cta-${tier}`}
                >
                  {isCurrent ? 'Current plan' : busy === tier ? 'Submitting…' : `Get ${config.label}`}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <section className="card p-5 mb-6" data-testid="pricing-comparison">
        <h2 className="text-lg font-semibold mb-3">Feature comparison</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bh-border">
                <th className="text-left py-2 px-2 font-semibold">Feature</th>
                <th className="text-center py-2 px-2 font-semibold">Free</th>
                <th className="text-center py-2 px-2 font-semibold text-bh-accent">Pro</th>
                <th className="text-center py-2 px-2 font-semibold text-bh-cyan">Team</th>
              </tr>
            </thead>
            <tbody className="text-bh-text-muted">
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">Saved searches</td>
                <td className="text-center py-2 px-2">3</td>
                <td className="text-center py-2 px-2 text-bh-text">50</td>
                <td className="text-center py-2 px-2 text-bh-text">200</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">Saved builders</td>
                <td className="text-center py-2 px-2">50</td>
                <td className="text-center py-2 px-2 text-bh-text">Unlimited</td>
                <td className="text-center py-2 px-2 text-bh-text">Unlimited</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">RSS feeds</td>
                <td className="text-center py-2 px-2">3</td>
                <td className="text-center py-2 px-2 text-bh-text">Unlimited</td>
                <td className="text-center py-2 px-2 text-bh-text">Unlimited</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">Smart alerts</td>
                <td className="text-center py-2 px-2"><X className="w-3.5 h-3.5 text-bh-text-dim inline" /></td>
                <td className="text-center py-2 px-2"><Check className="w-3.5 h-3.5 text-bh-success inline" /></td>
                <td className="text-center py-2 px-2"><Check className="w-3.5 h-3.5 text-bh-success inline" /></td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">Code fingerprinting</td>
                <td className="text-center py-2 px-2"><X className="w-3.5 h-3.5 text-bh-text-dim inline" /></td>
                <td className="text-center py-2 px-2"><Check className="w-3.5 h-3.5 text-bh-success inline" /></td>
                <td className="text-center py-2 px-2"><Check className="w-3.5 h-3.5 text-bh-success inline" /></td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-2 px-2">Team seats</td>
                <td className="text-center py-2 px-2">1</td>
                <td className="text-center py-2 px-2">1</td>
                <td className="text-center py-2 px-2 text-bh-text">10</td>
              </tr>
              <tr>
                <td className="py-2 px-2">Activity feed</td>
                <td className="text-center py-2 px-2"><X className="w-3.5 h-3.5 text-bh-text-dim inline" /></td>
                <td className="text-center py-2 px-2"><X className="w-3.5 h-3.5 text-bh-text-dim inline" /></td>
                <td className="text-center py-2 px-2"><Check className="w-3.5 h-3.5 text-bh-success inline" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5" data-testid="pricing-faq">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <HelpCircle className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          FAQ
        </h2>
        <div className="space-y-4">
          {FAQ.map((f) => (
            <details key={f.q} className="group">
              <summary className="cursor-pointer font-medium text-bh-text hover:text-bh-accent transition-colors flex items-center gap-2">
                <span>{f.q}</span>
              </summary>
              <p className="text-sm text-bh-text-muted mt-2 pl-1">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <p className="text-center text-xs text-bh-text-dim mt-8">
        Questions? <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">
          <Mail className="w-3 h-3 inline" /> hello@builderhunt.dev
        </a>
      </p>
    </div>
  )
}
