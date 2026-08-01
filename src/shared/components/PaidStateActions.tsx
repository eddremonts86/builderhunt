import { useLocation } from '@tanstack/react-router'
import { LinkButton } from '~/components/ui'

export type PaidStateReason =
  /** Feature requires a higher tier than the caller currently has (Free hitting a Pro feature, Pro
   * hitting a Team feature, etc.) — the common case. */
  | 'not_entitled'
  /** The org is entitled by tier, but paid actions are paused for a payment problem (grace period /
   * `paymentBlockedAt`) — the fix is resolving billing, not comparing plans. */
  | 'past_due'
  /** The caller's own request for entitlement/billing data came back unauthenticated — the session
   * itself needs refreshing, not a plan change. */
  | 'stale_session'

/**
 * The consistent action pair every authenticated paid-gated surface offers (plans/UI/tasks.md
 * Wave 6 "Connect paid-state actions consistently"): Billing settings as the primary action (where
 * a plan is actually managed), Pricing details as secondary (where tiers are compared) — except for
 * `past_due`, where Pricing is irrelevant (the org already has the right tier), and `stale_session`,
 * where neither applies until the caller can prove who they are again.
 *
 * `returnTo` defaults to the current path via `useLocation`, so a detour through sign-in lands the
 * visitor back on the exact gated surface that sent them there, not a generic dashboard page.
 */
export function PaidStateActions({ reason, returnTo, className = '' }: { reason: PaidStateReason; returnTo?: string; className?: string }) {
  const location = useLocation()
  const back = returnTo ?? location.pathname

  if (reason === 'stale_session') {
    return (
      <div className={`flex flex-wrap items-center justify-center gap-3 ${className}`}>
        <LinkButton to="/auth/sign-in" search={{ redirect: back }} variant="primary" data-testid="paid-state-sign-in">
          Sign in again
        </LinkButton>
      </div>
    )
  }

  return (
    <div className={`flex flex-wrap items-center justify-center gap-3 ${className}`}>
      <LinkButton to="/settings/billing" variant="primary" data-testid="paid-state-billing">
        Billing settings
      </LinkButton>
      {reason === 'not_entitled' && (
        <LinkButton to="/pricing" variant="secondary" data-testid="paid-state-pricing">
          Pricing details
        </LinkButton>
      )}
    </div>
  )
}
