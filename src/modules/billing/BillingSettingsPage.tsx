import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Crown, ExternalLink } from 'lucide-react'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { Button } from '~/components/ui'
import { listActiveSubscriptionCatalog, TIER_PRESENTATION, type CatalogTier } from '~/shared/lib/billing/catalog'
import { AutoRechargeSettings } from './AutoRechargeSettings'
import { BillingContact } from './BillingContact'
import { CreditBalance } from './CreditBalance'
import { PlanChangePreview } from './PlanChangePreview'

const STALE_SESSION_MESSAGE = 'Please sign in again to continue'

interface BillingCapabilities {
  paidActionsAllowed: boolean
  canOpenPortal?: boolean
  canRequestRefund?: boolean
  canConfigureAutoRecharge?: boolean
}

interface OrganizationBillingSummary {
  tier: string
  status: string
  billingPeriod: string
  currentPeriodEnd: string | null
  trialEndsAt: string | null
  notes: string | null
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  scheduledChange: { catalogKey: string; effectiveAt: string } | null
  grace: { gracePeriodEndsAt: string | null; paymentBlockedAt: string | null }
  seats: { limit: number; used: number }
  customer: { hasStripeCustomer: boolean; livemode: boolean } | null
  activeCreditGrants: Array<{ id: string; source: string; remainingUnits: number; expiresAt: string }>
  recentRefunds: Array<{ policyDecision: string; amountCents: number; state: string; createdAt: string }>
  usage: { savedSearches: number; savedBuilders: number }
  limits: { savedSearches: number | null; savedBuilders: number | null; rssSubscriptions: number | null }
  billingContact: { email: string; verifiedAt: string | null } | null
  capabilities: BillingCapabilities
}

interface BillingAvailability {
  capabilities: BillingCapabilities
}

type SummaryResponse = OrganizationBillingSummary | BillingAvailability

function isElevatedSummary(data: SummaryResponse): data is OrganizationBillingSummary {
  return 'tier' in data
}

interface Dispute {
  id: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  outcome: string
  evidenceDueBy: string | null
}

async function fetchSummary(): Promise<SummaryResponse> {
  const res = await fetch('/api/billing/summary', { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to load billing (${res.status})`)
  return res.json()
}

async function fetchDisputes(): Promise<Dispute[]> {
  const res = await fetch('/api/billing/disputes', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json()
  return data.disputes ?? []
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
}

export function BillingSettingsPage() {
  const activeOrganizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()

  const summaryQuery = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'billing', 'summary'),
    queryFn: fetchSummary,
    enabled: activeOrganizationId !== null,
  })

  const summary = summaryQuery.data
  const isElevated = summary ? isElevatedSummary(summary) : false

  const disputesQuery = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'billing', 'disputes'),
    queryFn: fetchDisputes,
    enabled: activeOrganizationId !== null && isElevated,
  })

  const [changingPlan, setChangingPlan] = React.useState<string | null>(null)
  const [portalError, setPortalError] = React.useState<string | null>(null)
  const [cancelError, setCancelError] = React.useState<string | null>(null)
  const [cancelMessage, setCancelMessage] = React.useState<string | null>(null)
  const [confirmingCancel, setConfirmingCancel] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const invalidateSummary = () => {
    queryClient.invalidateQueries({ queryKey: organizationQueryKey(activeOrganizationId, 'billing', 'summary') })
  }

  const openPortal = async () => {
    setBusy(true)
    setPortalError(null)
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/settings/billing` }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPortalError(data.error ?? 'Failed to open the billing portal')
        return
      }
      window.location.href = data.url
    } finally {
      setBusy(false)
    }
  }

  const cancelSubscription = async () => {
    setBusy(true)
    setCancelError(null)
    setCancelMessage(null)
    try {
      const res = await fetch('/api/billing/subscription/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!res.ok) {
        setCancelError(data.error ?? 'Failed to cancel')
        return
      }
      setCancelMessage(`Your subscription will end on ${new Date(data.effectiveAt).toLocaleDateString()}. You keep full access until then.`)
      setConfirmingCancel(false)
      invalidateSummary()
    } finally {
      setBusy(false)
    }
  }

  if (summaryQuery.isLoading) {
    return <p className="text-bh-text-muted" data-testid="billing-settings-loading">Loading…</p>
  }

  if (summaryQuery.isError || !summary) {
    return (
      <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 text-sm text-bh-danger" data-testid="billing-settings-error">
        Unable to load billing right now.
      </div>
    )
  }

  // Member view — spec.md §Permissions and UX: "Members see only feature availability and an
  // owner-contact action." No plan/period/seats/credit-grant/refund detail is even fetched for them.
  if (!isElevatedSummary(summary)) {
    return (
      <div className="glass-panel p-5 text-sm" data-testid="billing-availability">
        <p className="text-bh-text">
          {summary.capabilities.paidActionsAllowed
            ? 'Your organization has paid features enabled.'
            : 'Your organization is on the free plan.'}
        </p>
        <p className="text-bh-text-muted mt-1">Ask your workspace owner to change plans or billing details.</p>
      </div>
    )
  }

  const presentation = TIER_PRESENTATION[summary.tier as CatalogTier]
  // canOpenPortal/canRequestRefund/canConfigureAutoRecharge are all owner-only (billing/permissions.ts) —
  // any one of them being true already means this session is the owner; admin always gets all three `false`.
  const isOwner = summary.capabilities.canOpenPortal === true

  return (
    <div className="space-y-6" data-testid="billing-settings-content">
      {summary.grace.paymentBlockedAt && (
        <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 text-sm text-bh-danger flex items-start gap-2" data-testid="warning-payment-blocked">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <p>Paid features are on hold because a payment failed and the grace period ended. Update your payment method to restore access.</p>
        </div>
      )}
      {!summary.grace.paymentBlockedAt && summary.grace.gracePeriodEndsAt && (() => {
        const remaining = daysUntil(summary.grace.gracePeriodEndsAt!)
        const severe = remaining <= 1
        return (
          <div className={`glass-panel p-3 text-sm flex items-start gap-2 ${severe ? 'border-bh-danger/30 bg-bh-danger/5 text-bh-danger' : 'border-bh-warning/30 bg-bh-warning/5 text-bh-warning'}`} data-testid="warning-grace-period">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              {severe
                ? 'Your last payment failed and access will be blocked today unless it succeeds.'
                : `Your last payment failed. Paid features will be blocked in ${remaining} day${remaining === 1 ? '' : 's'} unless it succeeds.`}
            </p>
          </div>
        )
      })()}
      {summary.scheduledChange && (
        <div className="glass-panel border-bh-accent/30 bg-bh-accent/5 p-3 text-sm text-bh-accent" data-testid="warning-scheduled-change">
          Your plan will change to <strong>{summary.scheduledChange.catalogKey}</strong> on {new Date(summary.scheduledChange.effectiveAt).toLocaleDateString()}.
        </div>
      )}
      {summary.cancelAtPeriodEnd && (
        <div className="glass-panel border-bh-warning/30 bg-bh-warning/5 p-3 text-sm text-bh-warning" data-testid="warning-cancel-scheduled">
          Your subscription is set to cancel{summary.currentPeriodEnd ? ` on ${new Date(summary.currentPeriodEnd).toLocaleDateString()}` : ''}. You keep access until then.
        </div>
      )}
      {!summary.cancelAtPeriodEnd && summary.currentPeriodEnd && daysUntil(summary.currentPeriodEnd) <= 30 && daysUntil(summary.currentPeriodEnd) > 0 && (
        <div className="glass-panel p-3 text-sm text-bh-text-muted" data-testid="notice-renewal-soon">
          Renews on {new Date(summary.currentPeriodEnd).toLocaleDateString()}.
        </div>
      )}

      <section className="glass-panel p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-bh-text flex items-center gap-2">
            <Crown className="w-5 h-5 text-bh-accent" aria-hidden="true" />
            {presentation?.label ?? summary.tier} plan
          </h2>
          <span className="text-xs text-bh-text-dim capitalize">{summary.status.replace('_', ' ')}</span>
        </div>
        {summary.trialEndsAt && (
          <p className="text-xs text-bh-text-muted mb-2">Trial ends {new Date(summary.trialEndsAt).toLocaleDateString()}</p>
        )}
        <p className="text-sm text-bh-text-muted">
          {summary.seats.used} of {summary.seats.limit} seat{summary.seats.limit === 1 ? '' : 's'} used
        </p>
        {summary.notes && <p className="text-xs text-bh-text-dim italic mt-2">Note from our team: {summary.notes}</p>}

        {isOwner && (
          <div className="flex flex-wrap gap-2 mt-4">
            {summary.capabilities.canOpenPortal && (
              <Button type="button" variant="secondary" onClick={openPortal} disabled={busy} data-testid="open-portal-button">
                Manage payment &amp; invoices <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </Button>
            )}
            {!summary.cancelAtPeriodEnd && !confirmingCancel && (
              <Button type="button" variant="secondary" onClick={() => setConfirmingCancel(true)} data-testid="cancel-subscription-button">
                Cancel subscription
              </Button>
            )}
            {confirmingCancel && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-bh-text-muted">Keep access until the period ends?</span>
                <Button type="button" onClick={cancelSubscription} disabled={busy} data-testid="cancel-subscription-confirm">
                  {busy ? 'Canceling…' : 'Yes, cancel'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setConfirmingCancel(false)} data-testid="cancel-subscription-dismiss">
                  Never mind
                </Button>
              </div>
            )}
          </div>
        )}
        {portalError && portalError === STALE_SESSION_MESSAGE ? (
          <div className="glass-panel border-bh-warning/30 bg-bh-warning/5 p-3 mt-3 text-sm text-bh-warning" data-testid="stale-session-banner">
            <p>Your session isn't recent enough for this action.</p>
            <Link to="/auth/sign-in" className="inline-block mt-1 font-medium underline" data-testid="reauth-link">Sign in again to continue</Link>
          </div>
        ) : portalError && <p className="text-xs text-bh-danger mt-2" role="alert">{portalError}</p>}
        {cancelError && <p className="text-xs text-bh-danger mt-2" role="alert">{cancelError}</p>}
        {cancelMessage && <p className="text-xs text-bh-success mt-2">{cancelMessage}</p>}
      </section>

      {isOwner && (
        <section className="glass-panel p-5">
          {changingPlan ? (
            <PlanChangePreview
              newCatalogKey={changingPlan}
              onChanged={() => { setChangingPlan(null); invalidateSummary() }}
              onCancel={() => setChangingPlan(null)}
            />
          ) : (
            <PlanPicker currentTier={summary.tier} currentBillingPeriod={summary.billingPeriod} onSelect={setChangingPlan} />
          )}
        </section>
      )}

      <section className="glass-panel p-5">
        <CreditBalance
          grants={summary.activeCreditGrants}
          recentRefunds={summary.recentRefunds}
          canRequestRefund={Boolean(summary.capabilities.canRequestRefund)}
          canPurchasePacks={isOwner}
        />
      </section>

      {isOwner && (
        <section className="glass-panel p-5">
          <AutoRechargeSettings />
        </section>
      )}

      <section className="glass-panel p-5">
        <BillingContact />
      </section>

      {disputesQuery.data && disputesQuery.data.length > 0 && (
        <section className="glass-panel border-bh-warning/30 bg-bh-warning/5 p-5" data-testid="disputes-section">
          <h3 className="text-sm font-bold text-bh-warning mb-2">Disputes</h3>
          <ul className="space-y-2 text-sm">
            {disputesQuery.data.map((dispute) => (
              <li key={dispute.id} data-testid={`dispute-${dispute.id}`}>
                <span className="text-bh-text">{dispute.reason ?? 'Chargeback'}</span>
                <span className="text-bh-text-muted"> — {dispute.stripeStatus} ({dispute.outcome})</span>
                {dispute.evidenceDueBy && dispute.outcome === 'open' && (
                  <span className="text-xs text-bh-warning block">Evidence due {new Date(dispute.evidenceDueBy).toLocaleDateString()}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <UsageSection usage={summary.usage} limits={summary.limits} />
    </div>
  )
}

function PlanPicker({ currentTier, currentBillingPeriod, onSelect }: {
  currentTier: string
  currentBillingPeriod: string
  onSelect: (catalogKey: string) => void
}) {
  const options = React.useMemo(
    () => listActiveSubscriptionCatalog().filter((entry) => !(entry.tier === currentTier && entry.interval === currentBillingPeriod)),
    [currentTier, currentBillingPeriod],
  )
  if (options.length === 0) return null
  return (
    <div data-testid="plan-picker">
      <h3 className="text-sm font-bold text-bh-text mb-2">Change plan</h3>
      <div className="flex flex-wrap gap-2">
        {options.map((entry) => (
          <Button key={entry.key} type="button" variant="secondary" onClick={() => onSelect(entry.key)} data-testid={`plan-picker-${entry.key}`}>
            {TIER_PRESENTATION[entry.tier].label} — {entry.interval === 'monthly' ? 'Monthly' : 'Annual'}
          </Button>
        ))}
      </div>
    </div>
  )
}

function UsageSection({ usage, limits }: {
  usage: { savedSearches: number; savedBuilders: number }
  limits: { savedSearches: number | null; savedBuilders: number | null; rssSubscriptions: number | null }
}) {
  const rows = [
    { key: 'savedSearches' as const, label: 'Saved searches', description: 'Search alerts that notify you when new builders match your criteria.' },
    { key: 'savedBuilders' as const, label: 'Saved builders', description: "Builders you've added to your pipeline for tracking and outreach." },
  ]
  return (
    <section className="glass-panel p-5" data-testid="usage-section">
      <h2 className="font-semibold mb-1">Usage</h2>
      <p className="text-xs text-bh-text-dim mb-4">
        These are limits on how much you can keep saved at once, not a monthly quota — delete old items anytime to
        free up room, or upgrade for more capacity.
      </p>
      <div className="space-y-4">
        {rows.map((row) => {
          const limit = limits[row.key]
          const current = usage[row.key]
          const isUnlimited = limit === null
          const pct = isUnlimited ? 0 : Math.min(100, Math.round((current / limit) * 100))
          return (
            <div key={row.key} data-testid={`usage-${row.key}`}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span>{row.label}</span>
                <span className="text-bh-text-muted">{current} / {isUnlimited ? '∞' : limit}</span>
              </div>
              <p className="text-xs text-bh-text-dim mb-1.5">{row.description}</p>
              <div className="h-1.5 rounded-full bg-bh-surface overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isUnlimited ? 'bg-bh-cyan/30' : pct >= 90 ? 'bg-bh-danger' : pct >= 70 ? 'bg-bh-warning' : 'bg-bh-accent'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {!isUnlimited && pct >= 90 && (
                <p className="text-xs text-bh-danger mt-1">
                  You're almost at your {row.label.toLowerCase()} limit. Delete unused items or{' '}
                  <Link to="/pricing" className="underline">upgrade for more room</Link>.
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
