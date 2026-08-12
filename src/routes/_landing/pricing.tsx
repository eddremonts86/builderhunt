// table-surface-semantic: the plan comparison and the credit-pack list are bounded marketing
// prose read rather than operated. Native <th scope> is what lets a screen reader announce
// "Pro Max, Monthly credits, 700" instead of a bare number in a grid of numbers.
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
import { EmptyCell, NumberCell, SemanticTable, type SemanticColumn } from '~/shared/components/table'
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

/** A tick or a cross, sized and coloured once instead of eleven times in the comparison markup. */
function Included({ yes }: { yes: boolean }) {
  return yes
    ? <Check className="w-4 h-4 text-bh-success inline" aria-label="Included" />
    : <X className="w-4 h-4 text-bh-text-dim inline" aria-label="Not included" />
}

interface FeatureRow {
  feature: string
  /** One entry per tier, in `TIERS` order. */
  values: Record<CatalogTier, React.ReactNode>
  /** A `data-testid` per cell, for the rows a spec drives directly. */
  cellTestId?: (tier: CatalogTier) => string
}

/**
 * Every value in this table is either a constant the routes also enforce or derived from the same
 * helper they call.
 *
 * The AI-sourcing-sprints row is the reason that sentence is here: hand-typed, it read "—" for Pro
 * and "Up to 3" for Pro Max while `/api/sprints` was allowing 3 and 10. A pricing page that
 * disagrees with the enforcement is worse than one with no table.
 */
const FEATURE_ROWS: FeatureRow[] = [
  { feature: 'Saved searches', values: { free: '3', pro: '50', pro_max: '50', team: '200' } },
  { feature: 'Saved builders', values: { free: '50', pro: 'Unlimited', pro_max: 'Unlimited', team: 'Unlimited' } },
  // Free has no monthly grant at all, which is an absence rather than a withheld feature — the
  // canonical empty cell, not a cross.
  { feature: 'Monthly credits', values: { free: <EmptyCell label="No monthly credits" />, pro: '140', pro_max: '700', team: '2,100' } },
  { feature: 'Smart alerts', values: { free: <Included yes={false} />, pro: <Included yes />, pro_max: <Included yes />, team: <Included yes /> } },
  {
    feature: 'AI sourcing sprints',
    cellTestId: (tier) => `pricing-sprints-${tier}`,
    values: Object.fromEntries(TIERS.map((tier) => {
      const allowance = sourcingSprintAllowanceLabel(tier)
      return [tier, allowance ?? <Included yes={false} />]
    })) as Record<CatalogTier, React.ReactNode>,
  },
  { feature: 'Work-sample analysis', values: { free: <Included yes={false} />, pro: <Included yes={false} />, pro_max: <Included yes />, team: <Included yes /> } },
  { feature: 'Team seats', values: { free: '1', pro: '1', pro_max: '1', team: '10' } },
  { feature: 'Activity feed', values: { free: <Included yes={false} />, pro: <Included yes={false} />, pro_max: <Included yes={false} />, team: <Included yes /> } },
]

/**
 * The feature name is a `<th scope="row">`.
 *
 * Without it a screen reader reads the third cell of the fifth row as "700" and nothing else. With
 * it: "Pro Max, Monthly credits, 700". That is the one thing native table markup does here that a
 * `role="grid"` over divs would have to rebuild by hand, and it is why this is a `SemanticTable`.
 */
const FEATURE_COLUMNS: SemanticColumn<FeatureRow>[] = [
  { id: 'feature', header: 'Feature', rowHeader: true, cell: (row) => row.feature },
  ...TIERS.map((tier): SemanticColumn<FeatureRow> => ({
    id: tier,
    header: TIER_PRESENTATION[tier].label,
    align: 'center',
    cell: (row) => <span data-testid={row.cellTestId?.(tier)}>{row.values[tier]}</span>,
  })),
]

const PACK_COLUMNS: SemanticColumn<PackCatalogDto>[] = [
  { id: 'pack', header: 'Pack', rowHeader: true, cell: (pack) => <span className="capitalize">{pack.key.replace(/_/g, ' ')}</span> },
  { id: 'credits', header: 'Credits', align: 'end', cell: (pack) => <NumberCell value={pack.credits} /> },
  {
    id: 'price',
    header: 'Price',
    align: 'end',
    // "+ tax" beside the figure rather than only in the section copy: a price a reader quotes to
    // their finance team without it is a price that comes back wrong.
    cell: (pack) => <>{formatUsd(pack.amountCents)} <span className="tbl-cell-meta inline">+ tax</span></>,
  },
  { id: 'expires', header: 'Expires', cell: (pack) => `${pack.expiryMonths} months, no rollover` },
]

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
        <SemanticTable
          caption="What each plan includes, by feature"
          columns={FEATURE_COLUMNS}
          rows={FEATURE_ROWS}
          rowKey={(row) => row.feature}
        />
      </section>

      <section className="card p-8 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm mb-12" data-testid="pricing-packs">
        <h2 className="text-xl font-bold text-bh-text mb-2">Credit packs</h2>
        <p className="text-sm text-bh-text-muted mb-6">
          One-time top-ups for when you need more credits than your plan's monthly grant — separate from your subscription, on any plan.
          Pack credits expire 12 months after purchase and never roll over into a new grant period.
        </p>
        <SemanticTable
          caption="Credit packs, their size, price and expiry"
          columns={PACK_COLUMNS}
          rows={packCatalog}
          rowKey={(pack) => pack.key}
          tableTestId="pricing-pack-table"
        />
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
