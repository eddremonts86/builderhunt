import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Crown } from 'lucide-react'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { OrganizationBillingCard } from '~/modules/dashboard/components/OrganizationBillingCard'
import { AutoRechargeSettings } from '~/modules/billing/AutoRechargeSettings'
import { BillingContact } from '~/modules/billing/BillingContact'
import type { OrganizationEntitlementDto } from '~/shared/lib/organizations/contracts'
import type { LimitCheck, LimitResource } from '~/shared/lib/billing-shared'

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

export const Route = createFileRoute('/_dashboard/settings/billing/')({
  // Auth is enforced by the parent layout (settings/billing.tsx). No loader —
  // all data is fetched client-side via /api/* to keep the SSR bundle clean
  // of the postgres driver.
  component: BillingSettingsPage,
})

async function fetchEntitlement(): Promise<OrganizationEntitlementDto> {
  const res = await fetch('/api/organizations/billing', { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to load billing (${res.status})`)
  return res.json()
}

async function fetchUsage(): Promise<LimitCheck[]> {
  const res = await fetch('/api/plans/me', { credentials: 'include' })
  if (!res.ok) return []
  const me = await res.json()
  if (!me.limits || !me.plan) return []
  const limits = me.limits as { savedSearches: number; savedBuilders: number; rssSubscriptions: number }
  const usageCounts = (me.usage ?? {}) as { savedSearches?: number; savedBuilders?: number }
  return [
    { allowed: true, current: usageCounts.savedSearches ?? 0, limit: limits.savedSearches, plan: me.plan.plan, resource: 'savedSearches' },
    { allowed: true, current: usageCounts.savedBuilders ?? 0, limit: limits.savedBuilders, plan: me.plan.plan, resource: 'savedBuilders' },
  ]
}

function BillingSettingsPage() {
  const activeOrganizationId = useActiveOrganizationId()

  const entitlementQuery = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'billing'),
    queryFn: fetchEntitlement,
    enabled: activeOrganizationId !== null,
  })

  const usageQuery = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'billing', 'usage'),
    queryFn: fetchUsage,
    enabled: activeOrganizationId !== null,
  })

  const usage = usageQuery.data ?? []

  return (
    <div data-testid="billing-settings-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Crown className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Billing &amp; plan
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          What your organization is on, what it includes, and what's changed recently.
        </p>
      </header>

      {entitlementQuery.isLoading ? (
        <p className="text-bh-text-muted mb-6">Loading…</p>
      ) : entitlementQuery.isError || !entitlementQuery.data ? (
        <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 mb-6 text-sm text-bh-danger">
          Unable to load billing right now.
        </div>
      ) : (
        <OrganizationBillingCard entitlement={entitlementQuery.data} />
      )}

      <div className="mb-6">
        <AutoRechargeSettings />
      </div>

      <section className="glass-panel p-5 mb-6">
        <BillingContact />
      </section>

      {usage.length > 0 && (
        <section className="glass-panel p-5" data-testid="usage-section">
          <h2 className="font-semibold mb-1">Usage</h2>
          <p className="text-xs text-bh-text-dim mb-4">
            These are limits on how much you can keep saved at once, not a monthly quota — delete old items anytime
            to free up room, or upgrade for more capacity.
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
      )}
    </div>
  )
}
