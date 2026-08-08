// table-surface-ok: the plan comparison is semantic prose with a fixed number of columns, written in the component.
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, X, Mail, Sparkles, Zap, Rocket, Users } from 'lucide-react'
import {
  listActivePackCatalog,
  listActiveSubscriptionCatalog,
  TIER_PRESENTATION,
  type CatalogTier,
  type PackCatalogDto,
  type SubscriptionCatalogDto,
} from '~/shared/lib/billing/catalog'
import { sourcingSprintAllowanceLabel } from '~/shared/lib/billing-shared'
import { Button, Checkbox, Input, Label, LinkButton } from '~/components/ui'
import { FaqPanel, type FaqEntry } from '~/shared/components/FaqPanel'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { getAppOrganizationPlan } from '~/shared/lib/billing-session'
import { pageMeta } from '~/shared/lib/page-meta'

export const Route = createFileRoute('/_landing/pricing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    const plan = user.userId ? await getAppOrganizationPlan() : null
    return { user, plan }
  },
  loader: async ({ context }) => context,
  head: () => ({
    meta: [
      ...pageMeta({
        title: 'Pricing — BuilderHunt',
        description: 'Simple, transparent pricing. Free forever, Pro and Pro Max for individuals, Team for sourcing teams. No credit card required to start.',
      }),
    ],
  }),
  component: PricingPage,
})

const FAQ: FaqEntry[] = [
  {
    q: 'Can I use BuilderHunt for free?',
    a: 'Yes. The Free plan gives you 3 saved searches, 50 saved builders, and full access to /explore and /blog. No credit card required, no expiry.',
  },
  {
    q: 'How do I upgrade to a paid plan?',
    a: 'Click "Subscribe" on any paid plan below and complete checkout — subscriptions are billed by Stripe, activate immediately, and include a monthly credit grant on top of the plan\'s own limits.',
  },
  {
    q: 'What happens if I downgrade or cancel?',
    a: 'You keep all your saved data. You can cancel anytime and keep access until the end of your current paid period — no manual step or support request needed. After that, plan limits apply, but nothing is deleted.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'Credit packs that are still fully unused are refundable on request. Subscription refunds are reviewed case by case — contact hello@builderhunt.dev.',
  },
  {
    q: 'What is a "credit" and do unused credits roll over?',
    a: 'Credits pay for AI-powered features like sourcing sprints, semantic search, and work-sample analysis. Subscription credits refresh each billing period and don\'t carry over; purchased credit packs are separate, expire 12 months after purchase, and also never roll into a new grant.',
  },
  {
    q: 'What is a "team seat"?',
    a: 'One team seat = one person on your team. Team owners can invite members by email. Members get shared saved searches, shared builder lists, and an activity feed.',
  },
  {
    q: 'Is there a fair-use policy?',
    a: 'Yes. Every plan is priced for one person per seat, signed in from their own normal set of devices — a laptop and phone at once is completely fine. Each seat also has its own daily limits on things like searches, exports, and profile reveals, sized generously for real research work, not automated scraping. We\'d rather warn you than surprise you: if an account looks unusual, you\'ll see an in-app notice (and, rarely, a quick re-login prompt) well before anything is restricted.',
  },
]

const TIERS: CatalogTier[] = ['free', 'pro', 'pro_max', 'team']

const TIER_ICONS: Record<CatalogTier, React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Zap,
  pro_max: Rocket,
  team: Users,
}

const TIER_COLORS: Record<CatalogTier, string> = {
  free: 'border-bh-border',
  pro: 'border-bh-accent shadow-lg shadow-bh-accent/10',
  pro_max: 'border-bh-cyan shadow-lg shadow-bh-cyan/10',
  team: 'border-bh-cyan shadow-lg shadow-bh-cyan/10',
}

const TIER_BLURB: Record<CatalogTier, string> = {
  free: 'For individual developers searching the community.',
  pro: 'For power users needing saved keyword alerts and AI-assisted search.',
  pro_max: 'For serious sourcers running regular AI sourcing sprints.',
  team: 'For hiring and community teams collaborating on shortlists.',
}

export function formatUsd(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`
}

interface SubscribeCtaProps {
  entry: SubscriptionCatalogDto
  tierLabel: string
}

/**
 * The disclosure checkbox below intentionally consolidates all 7 fields the Checkout route requires
 * (`renewal`/`amount`/`interval`/`cancellationRefundPolicy`/`creditExpiryNonTransferability`/`tax`/
 * `total`) into one confirmation, since every one of those facts is already stated in plain language
 * on this same page (price, interval, tax-exclusive note, the FAQ's refund/cancellation/credit-expiry
 * answers) — seven separate checkboxes for facts already visible above would be clutter, not clarity.
 */
export function SubscribeCta({ entry, tierLabel }: SubscribeCtaProps) {
  const [open, setOpen] = React.useState(false)
  const [country, setCountry] = React.useState('DK')
  const [agreed, setAgreed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const startCheckout = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/checkout/subscription', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogKey: entry.key,
          country,
          disclosures: {
            renewal: true, amount: true, interval: true, cancellationRefundPolicy: true, creditExpiryNonTransferability: true, tax: true, total: true,
          },
          idempotencyKey: crypto.randomUUID(),
          successUrl: `${window.location.origin}/settings/billing/return`,
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to start checkout')
        return
      }
      window.location.href = data.checkoutUrl
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" className="w-full rounded-xl font-bold py-2" onClick={() => setOpen(true)} data-testid={`pricing-cta-${entry.tier}`}>
        Subscribe to {tierLabel}
      </Button>
    )
  }

  return (
    <div className="space-y-3 text-left" data-testid={`pricing-subscribe-form-${entry.tier}`}>
      <div>
        <Label htmlFor={`pricing-country-${entry.key}`} className="text-xs">Billing country</Label>
        <Input
          id={`pricing-country-${entry.key}`}
          value={country}
          maxLength={2}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
          className="uppercase"
        />
      </div>
      <label className="flex items-start gap-2 text-xs text-bh-text-muted">
        <Checkbox checked={agreed} onCheckedChange={(value) => setAgreed(value === true)} className="mt-0.5" />
        <span>I confirm the renewal terms, price, billing interval, cancellation/refund policy, and credit expiry described on this page, and that the amount shown excludes applicable tax.</span>
      </label>
      {error && <p className="text-xs text-bh-danger" role="alert">{error}</p>}
      <Button
        type="button"
        className="w-full rounded-xl font-bold py-2"
        disabled={busy || !agreed || country.length !== 2}
        onClick={startCheckout}
        data-testid={`pricing-confirm-${entry.tier}`}
      >
        {busy ? 'Starting checkout…' : 'Continue to payment'}
      </Button>
    </div>
  )
}

function PricingPage() {
  const { user, plan } = Route.useLoaderData() as {
    user: { userId: string | null }
    plan: { plan: string; status: string; canSubscribe: boolean } | null
  }
  const [billingPeriod, setBillingPeriod] = React.useState<'monthly' | 'annual'>('monthly')
  const [signInPrompt, setSignInPrompt] = React.useState(false)

  const subscriptionCatalog = React.useMemo(() => listActiveSubscriptionCatalog(), [])
  const packCatalog = React.useMemo(() => listActivePackCatalog(), [])

  const entryFor = (tier: Exclude<CatalogTier, 'free'>): SubscriptionCatalogDto | undefined =>
    subscriptionCatalog.find((e) => e.tier === tier && e.interval === billingPeriod)

  return (
    <div className="container py-12 max-w-5xl animate-fade-in" data-testid="pricing-page">
      <header className="text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-3 text-bh-text">Pricing</h1>
        <p className="text-bh-text-muted text-base">
          Simple, transparent. Free forever. Upgrade when you outgrow the limits. Prices exclude applicable tax.
        </p>
        <div className="inline-flex rounded-lg border border-bh-border p-0.5 mt-4" data-testid="billing-period-toggle">
          <button
            type="button"
            onClick={() => setBillingPeriod('monthly')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-colors ${
              billingPeriod === 'monthly' ? 'bg-bh-accent text-[color:var(--color-bh-accent-contrast)]' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-monthly"
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingPeriod('annual')}
            className={`px-4 py-2 text-sm font-bold rounded-md transition-colors ${
              billingPeriod === 'annual' ? 'bg-bh-accent text-[color:var(--color-bh-accent-contrast)]' : 'text-bh-text-muted hover:text-bh-text'
            }`}
            data-testid="period-annual"
          >
            Annual <span className="text-[10px] text-bh-cyan ml-1">(~20% off)</span>
          </button>
        </div>
      </header>

      {signInPrompt && (
        <div className="card border-bh-accent/30 bg-bh-accent/5 p-4 mb-6 text-sm text-bh-accent text-center rounded-xl" data-testid="pricing-msg">
          Please <Link to="/auth/sign-in" className="underline font-semibold">sign in</Link> first to subscribe.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        {TIERS.map((tier) => {
          const presentation = TIER_PRESENTATION[tier]
          const entry = tier === 'free' ? null : entryFor(tier as Exclude<CatalogTier, 'free'>)
          const isCurrent = plan?.plan === tier
          const Icon = TIER_ICONS[tier]
          const price = tier === 'free' ? 0 : entry?.amountCents ?? 0
          const periodLabel = tier === 'free' ? '' : billingPeriod === 'monthly' ? '/mo' : '/yr'

          return (
            <article
              key={tier}
              className={`card p-6 border ${TIER_COLORS[tier]} bg-bh-surface rounded-2xl flex flex-col justify-between`}
              data-testid={`plan-${tier}`}
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border border-bh-border bg-bh-surface/50 text-bh-text">
                    <Icon className="w-3.5 h-3.5" />
                    {presentation.label}
                  </span>
                  {tier === 'pro' && (
                    <span className="text-[10px] bg-bh-accent-soft text-bh-accent border border-bh-accent/30 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
                      Popular
                    </span>
                  )}
                </div>

                <div className="mb-2">
                  <span className="text-3xl font-extrabold text-bh-text font-display">{tier === 'free' ? '$0' : formatUsd(price)}</span>
                  <span className="text-bh-text-dim text-sm">{periodLabel}</span>
                </div>
                {tier !== 'free' && <p className="text-[11px] text-bh-text-dim mb-4">+ applicable tax</p>}
                {tier === 'free' && <div className="mb-4" />}

                <p className="text-xs text-bh-text-muted mb-6 min-h-[32px] leading-relaxed">{TIER_BLURB[tier]}</p>

                <ul className="space-y-2.5 mb-8 text-sm text-bh-text-muted">
                  {presentation.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-bh-success shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                  {entry && (
                    <li className="flex items-center gap-2 font-semibold text-bh-text">
                      <Check className="w-4 h-4 text-bh-success shrink-0" />
                      <span>{entry.monthlyCredits.toLocaleString()} credits/month included</span>
                    </li>
                  )}
                </ul>
              </div>

              <div>
                {isCurrent ? (
                  <div className="w-full text-center py-2 bg-bh-accent-soft border border-bh-accent/30 text-bh-accent text-sm font-bold rounded-xl">
                    Your current plan
                  </div>
                ) : tier === 'free' ? (
                  <LinkButton to="/auth/sign-up" variant="secondary" className="w-full justify-center rounded-xl font-bold">
                    Get started
                  </LinkButton>
                ) : !user.userId ? (
                  <Button
                    type="button"
                    className="w-full rounded-xl font-bold py-2"
                    onClick={() => setSignInPrompt(true)}
                    data-testid={`pricing-cta-${tier}`}
                  >
                    Subscribe to {presentation.label}
                  </Button>
                ) : !plan?.canSubscribe ? (
                  <p className="text-xs text-bh-text-muted text-center py-2" data-testid={`pricing-owner-only-${tier}`}>
                    Ask your workspace owner to upgrade.
                  </p>
                ) : entry ? (
                  <SubscribeCta entry={entry} tierLabel={presentation.label} />
                ) : null}
              </div>
            </article>
          )
        })}
      </div>

      <section className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm mb-12" data-testid="pricing-features">
        <h2 className="text-xl font-bold text-bh-text mb-6">Feature comparison</h2>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Feature comparison table, scrollable">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bh-border text-left">
                <th className="py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Feature</th>
                <th className="text-center py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Free</th>
                <th className="text-center py-3 px-2 font-bold text-bh-accent uppercase tracking-wider text-xs">Pro</th>
                <th className="text-center py-3 px-2 font-bold text-bh-cyan uppercase tracking-wider text-xs">Pro Max</th>
                <th className="text-center py-3 px-2 font-bold text-bh-cyan uppercase tracking-wider text-xs">Team</th>
              </tr>
            </thead>
            <tbody className="text-bh-text-muted">
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Saved searches</td>
                <td className="text-center py-3 px-2">3</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">50</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">50</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">200</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Saved builders</td>
                <td className="text-center py-3 px-2">50</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">Unlimited</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Monthly credits</td>
                <td className="text-center py-3 px-2">—</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">140</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">700</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">2,100</td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Smart alerts</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
              {/* Derived from SOURCING_SPRINT_LIMITS, the map /api/sprints
                  enforces — hand-typed, this row said "—" for Pro and "Up to 3"
                  for Pro Max while the routes allowed 3 and 10. Column order
                  follows TIERS, which matches the header above. */}
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">AI sourcing sprints</td>
                {TIERS.map((tier) => {
                  const allowance = sourcingSprintAllowanceLabel(tier)
                  return (
                    <td
                      key={tier}
                      className={`text-center py-3 px-2${allowance ? ' text-bh-text font-semibold' : ''}`}
                      data-testid={`pricing-sprints-${tier}`}
                    >
                      {allowance ?? <X className="w-4 h-4 text-bh-text-dim inline" />}
                    </td>
                  )
                })}
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Work-sample analysis</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
              <tr className="border-b border-bh-border/40">
                <td className="py-3 px-2">Team seats</td>
                <td className="text-center py-3 px-2">1</td>
                <td className="text-center py-3 px-2">1</td>
                <td className="text-center py-3 px-2">1</td>
                <td className="text-center py-3 px-2 text-bh-text font-semibold">10</td>
              </tr>
              <tr className="border-0">
                <td className="py-3 px-2">Activity feed</td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><X className="w-4 h-4 text-bh-text-dim inline" /></td>
                <td className="text-center py-3 px-2"><Check className="w-4 h-4 text-bh-success inline" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm mb-12" data-testid="pricing-packs">
        <h2 className="text-xl font-bold text-bh-text mb-2">Credit packs</h2>
        <p className="text-sm text-bh-text-muted mb-6">
          One-time top-ups for when you need more credits than your plan's monthly grant — separate from your subscription, on any plan.
          Pack credits expire 12 months after purchase and never roll over into a new grant period.
        </p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Credit packs table, scrollable">
          <table className="w-full text-sm" data-testid="pricing-pack-table">
            <thead>
              <tr className="border-b border-bh-border text-left">
                <th className="py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Pack</th>
                <th className="text-center py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Credits</th>
                <th className="text-center py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Price</th>
                <th className="text-center py-3 px-2 font-bold text-bh-text-dim uppercase tracking-wider text-xs">Expires</th>
              </tr>
            </thead>
            <tbody className="text-bh-text-muted">
              {packCatalog.map((pack: PackCatalogDto) => (
                <tr key={pack.key} className="border-b border-bh-border/40 last:border-0">
                  <td className="py-3 px-2 text-bh-text font-semibold capitalize">{pack.key.replace(/_/g, ' ')}</td>
                  <td className="text-center py-3 px-2">{pack.credits.toLocaleString()}</td>
                  <td className="text-center py-3 px-2">{formatUsd(pack.amountCents)} <span className="text-[10px] text-bh-text-dim">+ tax</span></td>
                  <td className="text-center py-3 px-2">{pack.expiryMonths} months, no rollover</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <FaqPanel
        items={FAQ}
        title="Frequently Asked Questions"
        testId="pricing-faq"
        className="mb-12"
      />

      <p className="text-center text-xs text-bh-text-dim mt-8">
        Questions? <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline inline-flex items-center gap-1">
          <Mail className="w-3.5 h-3.5 inline" /> hello@builderhunt.dev
        </a>
      </p>
    </div>
  )
}
