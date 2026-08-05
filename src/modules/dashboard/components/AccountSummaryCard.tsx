import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { CreditCard, Mail, Users } from 'lucide-react'
import { TIER_PRESENTATION, type CatalogTier } from '~/shared/lib/billing/catalog'
import { UsageMeters, type UsageCounts, type UsageLimits } from '~/shared/components/UsageMeters'

export interface AccountIdentity {
  name: string | null
  email: string | null
  image: string | null
}

interface PlansMeResponse {
  plan?: {
    plan?: string
    status?: string
    seatLimit?: number
    seatsUsed?: number
  } | null
  usage?: UsageCounts
  limits?: UsageLimits
}

function isCatalogTier(value: string | undefined): value is CatalogTier {
  return value === 'free' || value === 'pro' || value === 'pro_max' || value === 'team'
}

/**
 * Identity, plan and account-wide usage for the signed-in user.
 *
 * `/me` showed nothing at all until a profile was claimed, which reads as an empty account rather
 * than an account with no claimed profile — the session already knows who you are, and
 * `GET /api/plans/me` already returns the tier and the org-wide saved-item counts that
 * `/settings/billing` renders. Identity comes from the route's own loader (already resolved
 * server-side for the auth gate) rather than a second fetch; only the plan is fetched, because it
 * changes without a navigation.
 *
 * Credit balance is deliberately absent: it lives on the elevated, role-gated
 * `/api/billing/summary`, and this card must render for a plain member too. The billing link below
 * is where credits are shown.
 */
export function AccountSummaryCard({ identity }: { identity: AccountIdentity }) {
  const [data, setData] = React.useState<PlansMeResponse | null>(null)
  const [state, setState] = React.useState<'loading' | 'ready' | 'unavailable'>('loading')

  React.useEffect(() => {
    let active = true
    fetch('/api/plans/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: PlansMeResponse | null) => {
        if (!active) return
        setData(body)
        setState(body?.plan ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (active) setState('unavailable')
      })
    return () => { active = false }
  }, [])

  const tier = data?.plan?.plan
  const tierLabel = isCatalogTier(tier) ? TIER_PRESENTATION[tier].label : null
  const status = data?.plan?.status
  const seatLimit = data?.plan?.seatLimit
  const seatsUsed = data?.plan?.seatsUsed
  const displayName = identity.name?.trim() || identity.email?.split('@')[0] || 'Your account'
  const initial = (identity.name?.trim() || identity.email || '?')[0]?.toUpperCase()

  return (
    <section className="card mb-6" data-testid="account-summary">
      <div className="flex items-start gap-4">
        {identity.image ? (
          <img
            src={identity.image}
            alt=""
            className="w-14 h-14 rounded-full border border-bh-border shrink-0"
          />
        ) : (
          <div
            className="w-14 h-14 rounded-full bg-bh-accent/20 flex items-center justify-center text-bh-accent text-xl font-semibold shrink-0"
            aria-hidden="true"
          >
            {initial}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h2 className="text-lg font-semibold text-bh-text truncate" data-testid="account-name">
              {displayName}
            </h2>
            {tierLabel && (
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold border border-bh-accent/30 bg-bh-accent-soft text-bh-accent"
                data-testid="account-tier"
              >
                <CreditCard className="w-3 h-3" aria-hidden="true" />
                {tierLabel}
              </span>
            )}
            {/* Only worth surfacing when it isn't the boring case: a status badge next to every
                healthy plan trains people to ignore it. */}
            {status && status !== 'active' && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-bh-warning/30 bg-bh-warning/10 text-bh-warning" data-testid="account-status">
                {status.replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {identity.email && (
            <p className="text-sm text-bh-text-muted inline-flex items-center gap-1.5" data-testid="account-email">
              <Mail className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
              {identity.email}
            </p>
          )}

          {typeof seatLimit === 'number' && typeof seatsUsed === 'number' && seatLimit > 1 && (
            <p className="text-xs text-bh-text-dim inline-flex items-center gap-1.5 mt-1" data-testid="account-seats">
              <Users className="w-3.5 h-3.5" aria-hidden="true" />
              {seatsUsed} of {seatLimit} team seats used
            </p>
          )}
        </div>

        <Link
          to="/settings/billing"
          className="text-xs text-bh-accent hover:underline shrink-0 whitespace-nowrap"
          data-testid="account-billing-link"
        >
          Plan &amp; billing
        </Link>
      </div>

      <div className="mt-5 pt-4 border-t border-bh-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">
            Account usage
          </h3>
          {tierLabel === 'Free' && (
            <Link to="/pricing" className="text-xs text-bh-accent hover:underline">
              Compare plans
            </Link>
          )}
        </div>

        {state === 'loading' && (
          <div className="animate-pulse space-y-3" data-testid="account-usage-loading">
            <div className="h-3 w-40 bg-bh-surface rounded" />
            <div className="h-1.5 bg-bh-surface rounded-full" />
            <div className="h-3 w-40 bg-bh-surface rounded" />
            <div className="h-1.5 bg-bh-surface rounded-full" />
          </div>
        )}

        {state === 'ready' && data?.usage && data?.limits && (
          <UsageMeters usage={data.usage} limits={data.limits} />
        )}

        {state === 'unavailable' && (
          <p className="text-xs text-bh-text-dim" data-testid="account-usage-unavailable">
            Usage is temporarily unavailable. Your saved searches and builders are unaffected.
          </p>
        )}
      </div>
    </section>
  )
}
