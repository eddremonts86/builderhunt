/**
 * Fail-closed gate for enabling live (real-money) Stripe billing
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §3 "Implement live billing
 * readiness gate"; docs/operations/stripe-launch-register.md's "Release
 * gates" checklist). Pure evidence-in, decision-out — mirrors
 * `~/shared/lib/migration/tenant-readiness.ts`'s `assessTenantReadiness`
 * shape exactly, for the same reason: gathering each piece of evidence
 * requires real I/O (Stripe API calls, DB queries, env reads), but the
 * DECISION whether they're collectively sufficient should be pure and
 * trivially testable. `scripts/billing/check-live-readiness.ts` gathers the
 * real evidence and calls `assessLiveBillingReadiness` — this file never
 * calls Stripe, the database, or reads `process.env` itself.
 *
 * Reason codes are the evidence struct's own field names (never a secret
 * value) — "missing: ['webhookSecretConfigured']" tells an operator what to
 * fix without ever printing the actual (possibly still-unset) secret.
 */

export interface LiveBillingReadinessEvidence {
  /** `STRIPE_BILLING_ENABLED === 'true'` AND a live secret key (`sk_live_...`) — the on/off switch itself. */
  billingFlagEnabledInLiveMode: boolean
  /** Stripe account KYC complete and able to accept real charges (`stripe.accounts.retrieve().charges_enabled`). */
  chargesEnabled: boolean
  /** A seller profile version has been recorded (`getCurrentSellerProfile()` is non-null) with legal name, address, and establishment country set. */
  sellerProfileRecorded: boolean
  /** The current seller profile's statement descriptor and support email are both non-empty. */
  supportContactConfigured: boolean
  /** Every currently-active catalog entry (subscriptions and packs) has a real, non-null live Stripe Price ID. */
  catalogLivePriceIdsComplete: boolean
  /** `STRIPE_WEBHOOK_SECRET` and `STRIPE_API_VERSION` are both configured (env.ts already fails closed on malformed values in every environment; this confirms they're present at all). */
  webhookAndApiVersionConfigured: boolean
  /** `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` is configured as 64 hex characters — without it, `encryptWebhookPayload()` throws on every real webhook receipt (`webhook-inbox.ts`'s `minimizeForStorage` call), so this is not optional hygiene, it's a hard prerequisite for the webhook endpoint to work at all. */
  webhookPayloadEncryptionKeyConfigured: boolean
  /** The seller profile has at least one recorded tax registration — a proxy for "tax/product code decided," since no separate product-tax-code store exists yet (see readiness.test.ts / stripe-live-readiness.md for the known gap). */
  taxConfigurationRecorded: boolean
  /** The seller profile's production customer-country allowlist includes Denmark, matching spec.md's Denmark-only initial launch. */
  denmarkAllowlisted: boolean
  /** An operator has confirmed the Terms/Privacy versions currently required (`CURRENT_CONSENT_VERSIONS`) are the ones reviewed for this launch — this is a manual attestation, not something derivable from the constant's mere presence. */
  termsPrivacyVersionsConfirmed: boolean
  /** An operator has confirmed incident, secret-rotation, refund, and backup/restore runbooks exist and have had a tabletop exercise. */
  operatorRunbooksConfirmed: boolean
  /** A `billing_reconciliation_runs` row with `result: 'clean'` exists from within the required freshness window (see `scripts/billing/check-live-readiness.ts`'s freshness check). */
  reconciliationEvidenceRecent: boolean
  /** An operator has confirmed the Stripe Billing Portal configuration in actual use (Stripe Dashboard or a specific Configuration id our code passes) restricts the owner to payment methods, tax identity, invoices, and receipts — no plan switching, no cancellation. This is a Stripe-account-side setting our code cannot introspect, so it is a manual attestation, not something derivable from a database row. */
  portalConfigurationRestricted: boolean
}

export function assessLiveBillingReadiness(evidence: LiveBillingReadinessEvidence): {
  ready: boolean
  missing: Array<keyof LiveBillingReadinessEvidence>
} {
  const missing: Array<keyof LiveBillingReadinessEvidence> = []
  if (!evidence.billingFlagEnabledInLiveMode) missing.push('billingFlagEnabledInLiveMode')
  if (!evidence.chargesEnabled) missing.push('chargesEnabled')
  if (!evidence.sellerProfileRecorded) missing.push('sellerProfileRecorded')
  if (!evidence.supportContactConfigured) missing.push('supportContactConfigured')
  if (!evidence.catalogLivePriceIdsComplete) missing.push('catalogLivePriceIdsComplete')
  if (!evidence.webhookAndApiVersionConfigured) missing.push('webhookAndApiVersionConfigured')
  if (!evidence.webhookPayloadEncryptionKeyConfigured) missing.push('webhookPayloadEncryptionKeyConfigured')
  if (!evidence.taxConfigurationRecorded) missing.push('taxConfigurationRecorded')
  if (!evidence.denmarkAllowlisted) missing.push('denmarkAllowlisted')
  if (!evidence.termsPrivacyVersionsConfirmed) missing.push('termsPrivacyVersionsConfirmed')
  if (!evidence.operatorRunbooksConfirmed) missing.push('operatorRunbooksConfirmed')
  if (!evidence.reconciliationEvidenceRecent) missing.push('reconciliationEvidenceRecent')
  if (!evidence.portalConfigurationRestricted) missing.push('portalConfigurationRestricted')
  return { ready: missing.length === 0, missing }
}
