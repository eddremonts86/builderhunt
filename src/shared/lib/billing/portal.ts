/**
 * Restricted Stripe Customer Portal session creation (plans/phase-1/29-stripe-billing-platform/tasks.md §5
 * "Create restricted Customer Portal sessions"; spec.md: "Customer Portal is owner-only and limited
 * to payment methods, tax identity, invoices, and receipts. All plan changes/cancellation remain
 * BuilderHunt-owned."). Owner-only and recent-auth enforcement happen at the route layer
 * (`requireBillingPermission(principal, 'billing:portal', session)` — `'billing:portal'` is already
 * one of `permissions.ts`'s `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`), matching every other billing
 * service file's separation of concerns. The restriction to payment methods/tax identity/invoices/
 * receipts (no plan switching, no cancellation) is a Stripe-account-side Billing Portal
 * Configuration this code cannot introspect or enforce itself — it is confirmed once, manually, via
 * `readiness.ts`'s `portalConfigurationRestricted` gate before `STRIPE_BILLING_ENABLED` ever goes
 * live (see docs/operations/stripe-customer-portal.md).
 */
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { findBillingCustomer } from '../repositories/billing'
import type { BillingProvider } from './provider'
import { isAllowedReturnUrl, isLiveMode } from './stripe-client'

export class PortalError extends Error {
  constructor(message: string, readonly code: 'no_customer' | 'invalid_url') {
    super(message)
    this.name = 'PortalError'
  }
}

export interface CreateBillingPortalSessionInput {
  returnUrl: string
}

/** Only a redirect URL — never a plan, price, or product field, since the Portal itself is never used to change what an organization is subscribed to. */
export interface BillingPortalSessionResult {
  url: string
}

export interface CreateBillingPortalSessionOptions {
  provider: BillingProvider
}

export async function createBillingPortalSession(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: CreateBillingPortalSessionInput,
  options: CreateBillingPortalSessionOptions,
): Promise<BillingPortalSessionResult> {
  if (!isAllowedReturnUrl(input.returnUrl)) {
    throw new PortalError("returnUrl must be within this app's own origin", 'invalid_url')
  }

  const livemode = isLiveMode()
  const customer = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (!customer) {
    throw new PortalError('No billing customer exists for this organization yet', 'no_customer')
  }

  const session = await options.provider.createPortalSession({
    customerId: customer.stripeCustomerId,
    returnUrl: input.returnUrl,
  })
  return { url: session.url }
}
