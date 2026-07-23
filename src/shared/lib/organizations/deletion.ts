/**
 * Subscription-safe organization deletion (plans/stripe-billing-platform/tasks.md §9 "Integrate
 * subscription-safe organization deletion"). Two request paths, one shared finalize step:
 *
 * - Normal (scheduled): `requestNormalDeletion` wraps the existing 30-day-grace-period request
 *   (`organization-lifecycle.ts`'s `requestOrganizationDeletion`, unchanged) and additionally stops
 *   subscription renewal RIGHT NOW via `cancelSubscriptionAtPeriodEnd` — the organization keeps paid
 *   access through the current billing period (nothing about entitlements changes), it just never
 *   renews. If the grace period genuinely reaches 30 days before the billing period's own end, the
 *   worker-driven `finalizeOrganizationDeletion` defensively force-cancels whatever is left.
 * - Immediate: `requestImmediateDeletion` is a distinct, more destructive action a UI must present
 *   with an explicit forfeiture warning (this module enforces no UI, only the authority/recent-auth
 *   gate) — it cancels the subscription immediately (no grace, no partial-period credit) and
 *   deletes the organization's product data right now, not after 30 days.
 * - `finalizeOrganizationDeletion` is the ONE place that ever removes an organization row. Both
 *   paths route through it: capture a durable financial-retention snapshot, force-cancel any
 *   still-active subscription, THEN hard-delete (whose cascade removes every other table, including
 *   `billing_customers`/`billing_subscriptions` themselves — the retention row is the only thing
 *   built to survive that on purpose).
 * - Cancelling a pending deletion is deliberately left untouched (`/api/organizations/deletion.ts`'s
 *   existing `DELETE` handler, calling `organization-lifecycle.ts`'s `cancelOrganizationDeletion`
 *   directly) — it only un-schedules the future hard-delete and must do NOTHING billing-related. A
 *   subscription already stopped from renewing by `requestNormalDeletion` STAYS stopped —
 *   "cancelling deletion never restores renewal automatically" (spec). Resuming billing is the
 *   owner's own separate action (subscribe/change plan), same as any other lapsed subscription.
 */
import { randomUUID } from 'node:crypto'
import {
  getOrganizationLifecycle,
  hardDeleteOrganization,
  OrganizationLifecycleError,
  RECENT_AUTH_MAX_AGE_SECONDS,
  STALE_SESSION_ERROR_MESSAGE,
  type OrganizationDeletionRecord,
} from '../auth/organization-lifecycle'
import { can, type TenantPrincipal } from '../authorization/permissions'
import { findOrganizationName } from '../repositories/account-privacy'
import { organizationDeletionFinancialRecords } from '../db/schema'
import { withTenantContext } from '../db/tenant-context'
import type { BillingProvider } from '../billing/provider'
import { cancelSubscriptionAtPeriodEnd, cancelSubscriptionImmediately, SubscriptionChangeError } from '../billing/subscription-changes'
import { findBillingCustomer, findFullActiveBillingSubscription } from '../repositories/billing'
import { withWorkerOrganization } from '../repositories/billing-worker'
import { isLiveMode } from '../billing/stripe-client'
import { emitSecurityAudit } from '../security/audit'
import { consoleSecurityAuditSink } from '../security/audit-sink'

export class OrganizationDeletionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'OrganizationDeletionError'
  }
}

export interface OrganizationDeletionDeps {
  provider: BillingProvider
  now?: () => Date
}

/** Owner-only + recent-auth-gated, matching `requestOrganizationDeletion`'s own authority check one layer up in `organization-lifecycle.ts` — this repeats the check because it ALSO governs the billing call this function makes, which `organization-lifecycle.ts` has no knowledge of. */
export async function requestNormalDeletion(
  request: Request,
  principal: TenantPrincipal,
  deps: OrganizationDeletionDeps,
): Promise<OrganizationDeletionRecord & { gracePeriodEndsAt: Date }> {
  const lifecycle = await getOrganizationLifecycle()
  const result = await lifecycle.requestOrganizationDeletion(request, principal.organizationId)

  try {
    await withTenantContext(principal, (transaction) => cancelSubscriptionAtPeriodEnd(transaction, principal, deps))
  } catch (error) {
    // A free-tier organization (no subscription at all) is the overwhelmingly common case — not an
    // error, just nothing to stop. Any other failure is swallowed too: the deletion REQUEST itself
    // already succeeded and must not be rolled back because a best-effort billing call failed;
    // `finalizeOrganizationDeletion` force-cancels defensively at execution time regardless.
    if (!(error instanceof SubscriptionChangeError && error.code === 'no_active_subscription')) {
      console.error('organizations.deletion.request_normal.cancel_at_period_end_failed', { error, organizationId: principal.organizationId })
    }
  }

  return { id: result.id, status: 'pending', gracePeriodEndsAt: result.gracePeriodEndsAt, requestedByUserId: principal.userId }
}

/**
 * The distinct, more destructive path: forfeits any remaining paid period (no partial-period
 * credit — see this file's own top comment), cancels the subscription immediately, and deletes the
 * organization's product data right now instead of after a 30-day grace period. A UI surfacing this
 * MUST show an explicit forfeiture warning before calling it; this function enforces only the
 * authority and recent-auth gate, not any UI-level confirmation.
 */
export async function requestImmediateDeletion(
  principal: TenantPrincipal,
  session: { authenticatedAt: Date } | undefined,
  deps: OrganizationDeletionDeps,
): Promise<{ requestId: string }> {
  if (!can(principal, 'organization:delete')) throw new OrganizationDeletionError('Forbidden', 403)
  if (!session) throw new OrganizationDeletionError(STALE_SESSION_ERROR_MESSAGE, 401)
  const ageSeconds = ((deps.now ?? (() => new Date()))().getTime() - session.authenticatedAt.getTime()) / 1000
  if (ageSeconds > RECENT_AUTH_MAX_AGE_SECONDS) throw new OrganizationDeletionError(STALE_SESSION_ERROR_MESSAGE, 401)

  await finalizeOrganizationDeletion(principal.organizationId, 'immediate', deps)

  await emitSecurityAudit(
    {
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: 'organization.delete.immediate',
      targetType: 'organization',
      targetId: principal.organizationId,
      result: 'allowed',
      requestId: principal.requestId,
    },
    consoleSecurityAuditSink,
  )

  return { requestId: principal.requestId }
}

/**
 * The one place an organization row is ever hard-deleted. Called both by the immediate path (right
 * away) and by the grace-period worker sweep (`processPendingOrganizationDeletions`, once a
 * scheduled request's grace period has elapsed). Idempotent: a no-op if the organization is already
 * gone (a concurrent finalize, or a retried worker tick).
 *
 * Ordering matters: the financial snapshot and subscription cancellation happen in a
 * `builderhunt_worker`-scoped transaction FIRST (the only role the retention table and
 * `billing_subscriptions` grant writes to), then the organization row is hard-deleted via
 * `hardDeleteOrganization` (`builderhunt_auth` is the only role with delete authority on
 * `organizations` — see drizzle/0008_tenant_rls.sql; this file itself is deliberately NOT in
 * `check-tenant-boundaries.mjs`'s auth-broker allowlist, so it never imports `authDb` directly).
 * These are two separate connections/roles, not one atomic transaction — a crash between them
 * leaves a retained financial record with no corresponding deletion, which is the safe direction to
 * fail in (never loses billing evidence).
 */
export async function finalizeOrganizationDeletion(
  organizationId: string,
  deletionType: 'scheduled' | 'immediate',
  deps: OrganizationDeletionDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()

  const organizationName = await findOrganizationName(organizationId)
  if (!organizationName) return

  const livemode = isLiveMode()

  await withWorkerOrganization(organizationId, async (transaction) => {
    const [subscription, customer] = await Promise.all([
      findFullActiveBillingSubscription(transaction, organizationId, livemode),
      findBillingCustomer(transaction, organizationId, livemode),
    ])

    let subscriptionCanceledAt: Date | null = null
    if (subscription) {
      const result = await cancelSubscriptionImmediately(transaction, organizationId, deps)
      subscriptionCanceledAt = result.canceledAt ? new Date(result.canceledAt) : now
    }

    await transaction.insert(organizationDeletionFinancialRecords).values({
      id: randomUUID(),
      organizationId,
      organizationName,
      deletionType,
      livemode,
      stripeCustomerId: customer?.stripeCustomerId ?? null,
      lastSubscriptionTier: subscription?.tier ?? null,
      lastSubscriptionInterval: subscription?.interval ?? null,
      subscriptionCanceledAt,
    })
  })

  await hardDeleteOrganization(organizationId)
}

export { OrganizationLifecycleError }
