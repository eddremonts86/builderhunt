import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Crown, Users, Sparkles, Check, ArrowRight, AlertTriangle, Clock } from 'lucide-react'
import { isOwnerRole, type OrganizationEntitlementDto } from '~/shared/lib/organizations/contracts'
import { PLAN_PRICING } from '~/shared/lib/billing-shared'

/**
 * Pure presentation, gated the same way `TeamSettingsPage` gates its own
 * controls: role comes from the DTO (never re-derived from a raw string
 * comparison here), and only an owner ever sees a mutation-capable control.
 * A member sees the tier name and nothing else — the entitlement belongs to
 * the organization, not to them personally, so admin/seat/history detail
 * isn't theirs to see. An admin sees everything an owner sees except the
 * plan-change affordance itself.
 */
export interface OrganizationBillingCardProps {
  entitlement: OrganizationEntitlementDto
}

const PLAN_ICONS: Record<OrganizationEntitlementDto['tier'], React.ComponentType<{ className?: string }>> = {
  free: Sparkles,
  pro: Crown,
  team: Users,
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatPrice(tier: OrganizationEntitlementDto['tier'], billingPeriod: OrganizationEntitlementDto['billingPeriod']): string {
  const pricing = PLAN_PRICING[tier]
  if (tier === 'free' || pricing.monthly === 0) return 'Free'
  if (billingPeriod === 'annual') return `$${pricing.annual}/year`
  return `$${pricing.monthly}/month`
}

export function OrganizationBillingCard({ entitlement }: OrganizationBillingCardProps) {
  const Icon = PLAN_ICONS[entitlement.tier]
  const isOwner = isOwnerRole(entitlement.viewerRole)
  const isAdmin = entitlement.viewerRole === 'admin'
  // "Team lapse": the org was on a paid tier but its status no longer
  // supports paid features (payment failed, canceled, or a trial ended).
  // Membership/data are untouched — this only ever gates paid-feature
  // access elsewhere (already read from the same `paidActionsAllowed` flag),
  // never deletes anything. Visible to every role, including a plain
  // member, because it directly affects what they can still do here.
  const lapsed = entitlement.tier !== 'free' && !entitlement.paidActionsAllowed

  if (!isOwner && !isAdmin) {
    return (
      <section className="glass-panel p-5 mb-6" data-testid="billing-card">
        <div className="flex items-center gap-3" data-testid="billing-member-minimal">
          <Icon className={`w-5 h-5 ${entitlement.tier === 'pro' ? 'text-bh-accent' : entitlement.tier === 'team' ? 'text-bh-cyan' : 'text-bh-text-muted'}`} aria-hidden="true" />
          <p className="text-sm">
            <span className="font-semibold capitalize">{entitlement.organizationName}</span> is on the{' '}
            <span className="font-semibold capitalize">{entitlement.tier}</span> plan.
          </p>
        </div>
        {lapsed && (
          <p className="text-xs text-bh-danger mt-3" data-testid="billing-lapsed-banner">
            This plan isn't in good standing right now — ask an owner or admin to sort out billing.
          </p>
        )}
      </section>
    )
  }

  return (
    <section className="glass-panel p-5 mb-6" data-testid="billing-card">
      {lapsed && (
        <div className="glass-panel border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 flex items-start gap-2 text-sm text-bh-danger" data-testid="billing-lapsed-banner">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>This plan isn't in good standing.</strong>{' '}
            {entitlement.status === 'past_due'
              ? "We couldn't confirm the last payment — paid features are suspended until this is resolved."
              : "This plan was canceled — paid features are suspended. Membership and shared data are untouched."}
          </p>
        </div>
      )}
      {entitlement.status === 'trialing' && (
        <div className="glass-panel border-bh-cyan/30 bg-bh-cyan/5 p-3 mb-4 flex items-start gap-2 text-sm text-bh-cyan" data-testid="billing-trial-banner">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <strong>On a trial of the {entitlement.tier} plan.</strong>{' '}
            {formatDate(entitlement.trialEndsAt)
              ? `It ends ${formatDate(entitlement.trialEndsAt)}.`
              : "We'll email the owner before it ends."}
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 mb-3">
        <Icon className={`w-6 h-6 ${entitlement.tier === 'pro' ? 'text-bh-accent' : entitlement.tier === 'team' ? 'text-bh-cyan' : 'text-bh-text-muted'}`} aria-hidden="true" />
        <div className="flex-1">
          <h2 className="text-lg font-semibold capitalize" data-testid="billing-plan-name">
            {entitlement.tier} plan <span className="font-normal text-bh-text-muted">· {formatPrice(entitlement.tier, entitlement.billingPeriod)}</span>
          </h2>
          <p className="text-xs text-bh-text-dim">
            {entitlement.status === 'active' ? 'Active and in good standing' : `Status: ${entitlement.status}`}
            {entitlement.status === 'active' && formatDate(entitlement.currentPeriodEnd) && ` · Renews ${formatDate(entitlement.currentPeriodEnd)}`}
          </p>
        </div>
        {isOwner && (
          entitlement.tier === 'free' ? (
            <Link to="/pricing" className="btn-primary btn-sm" data-testid="billing-upgrade-cta">
              Upgrade
              <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          ) : (
            <Link to="/pricing" className="btn-secondary btn-sm" data-testid="billing-compare-cta">
              Compare plans
            </Link>
          )
        )}
      </div>

      <p className="text-xs text-bh-text-dim mb-3" data-testid="billing-seats">
        <strong className="text-bh-text">{entitlement.seatUsage.used}</strong> of {entitlement.seatUsage.limit} seats used
        (members plus outstanding invitations).
      </p>

      <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5 mb-3" data-testid="billing-features">
        {PLAN_PRICING[entitlement.tier].features.map((feature) => (
          <li key={feature} className="flex items-center gap-2 text-sm text-bh-text-muted">
            <Check className="w-3.5 h-3.5 text-bh-success shrink-0" aria-hidden="true" />
            {feature}
          </li>
        ))}
      </ul>

      {entitlement.notes && (
        <p className="text-xs text-bh-text-dim italic mb-2">Note from our team: {entitlement.notes}</p>
      )}

      {isOwner && (
        <p className="text-xs text-bh-text-dim" data-testid="billing-email-us">
          We manage billing manually while we're small — there's no self-serve payment portal yet. To change plans,
          seats, or billing cadence, email{' '}
          <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">hello@builderhunt.dev</a>{' '}
          and we'll take care of it, usually within 24 hours.
        </p>
      )}
    </section>
  )
}
