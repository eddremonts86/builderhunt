/**
 * Versioned commercial consent evidence (plans/phase-1/29-stripe-billing-platform/tasks.md §5 "Implement
 * versioned commercial consent"; spec.md §"Checkout, Portal, consent, and billing contact").
 * Checkout requires current Terms and Privacy Policy acceptance and disclosure of renewal,
 * amount, interval, cancellation/refund policy, credit expiry/non-transferability, tax, and
 * total; auto-recharge requires a separate, off-session-specific consent. Every acceptance stores
 * only the already-typed evidence columns (`billing_terms_acceptances`: org, actor, terms/privacy
 * version, commercial action, an optional provider reference, and a timestamp) — never the raw
 * request body or the disclosure text itself.
 */
import { randomUUID } from 'node:crypto'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { CURRENT_CONSENT_VERSIONS, isMaterialVersionChange } from '../legal'
import { createBillingTermsAcceptance, listBillingTermsAcceptances, type BillingTermsAcceptanceRecord } from '../repositories/billing'

export class ConsentError extends Error {
  constructor(message: string, readonly code: 'missing_disclosure' | 'missing_consent' | 'stale_consent') {
    super(message)
    this.name = 'ConsentError'
  }
}

export const REQUIRED_CHECKOUT_DISCLOSURES = [
  'renewal',
  'amount',
  'interval',
  'cancellationRefundPolicy',
  'creditExpiryNonTransferability',
  'tax',
  'total',
] as const

export type CheckoutDisclosureKey = (typeof REQUIRED_CHECKOUT_DISCLOSURES)[number]
export type CheckoutDisclosures = Record<CheckoutDisclosureKey, boolean>

function assertAllDisclosuresAcknowledged(disclosures: CheckoutDisclosures): void {
  const missing = REQUIRED_CHECKOUT_DISCLOSURES.filter((key) => disclosures[key] !== true)
  if (missing.length > 0) {
    throw new ConsentError(`Checkout disclosures not acknowledged: ${missing.join(', ')}`, 'missing_disclosure')
  }
}

export type CheckoutCommercialAction = 'checkout_subscription' | 'checkout_credits'

export interface RecordCheckoutConsentInput {
  action: CheckoutCommercialAction
  disclosures: CheckoutDisclosures
  referenceId?: string
}

/**
 * Stores evidence that the owner accepted the current Terms/Privacy versions and acknowledged
 * every required Checkout disclosure — called before creating (or immediately after resolving)
 * the Stripe Checkout Session. `disclosures` is validated but never persisted: only the resolved
 * version strings, the action, and an optional provider reference (e.g. the Checkout Session id)
 * are stored.
 */
export async function recordCheckoutConsent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: RecordCheckoutConsentInput,
): Promise<BillingTermsAcceptanceRecord> {
  assertAllDisclosuresAcknowledged(input.disclosures)
  return createBillingTermsAcceptance(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    termsVersion: CURRENT_CONSENT_VERSIONS.tos,
    privacyVersion: CURRENT_CONSENT_VERSIONS.privacy,
    commercialAction: input.action,
    referenceId: input.referenceId,
  })
}

export interface RecordAutoRechargeConsentInput {
  /** Auto-recharge is off-session by nature (spec.md: "requires separate versioned off-session consent") — the owner must explicitly acknowledge the card will be charged without further action, distinct from the Checkout disclosure set. */
  acknowledgedOffSessionCharge: boolean
  referenceId?: string
}

export async function recordAutoRechargeConsent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: RecordAutoRechargeConsentInput,
): Promise<BillingTermsAcceptanceRecord> {
  if (input.acknowledgedOffSessionCharge !== true) {
    throw new ConsentError('Auto-recharge off-session charge disclosure not acknowledged', 'missing_disclosure')
  }
  return createBillingTermsAcceptance(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
    termsVersion: CURRENT_CONSENT_VERSIONS.tos,
    privacyVersion: CURRENT_CONSENT_VERSIONS.privacy,
    commercialAction: 'auto_recharge',
    referenceId: input.referenceId,
  })
}

export type BillingCommercialAction = CheckoutCommercialAction | 'auto_recharge'

/**
 * Throws unless this organization has a still-current acceptance on file for `action` — missing
 * entirely, or superseded by a material Terms/Privacy version change, both block. A non-material
 * version bump (a minor/clarification release) does not invalidate an existing acceptance.
 * `listBillingTermsAcceptances` is already organization-scoped (TenantTransaction + explicit
 * filter), so an acceptance recorded under a different organization can never satisfy this check.
 */
export async function requireCurrentCommercialConsent(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  action: BillingCommercialAction,
): Promise<void> {
  const acceptances = await listBillingTermsAcceptances(transaction, principal.organizationId)
  const latest = acceptances.find((acceptance) => acceptance.commercialAction === action)
  if (!latest) {
    throw new ConsentError(`No commercial consent on file for ${action}`, 'missing_consent')
  }
  const termsStale = isMaterialVersionChange(latest.termsVersion, CURRENT_CONSENT_VERSIONS.tos)
  const privacyStale = isMaterialVersionChange(latest.privacyVersion, CURRENT_CONSENT_VERSIONS.privacy)
  if (termsStale || privacyStale) {
    throw new ConsentError(`Commercial consent for ${action} is stale — a material Terms/Privacy version change requires reacceptance`, 'stale_consent')
  }
}
