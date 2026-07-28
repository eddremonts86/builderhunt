/**
 * Read-only live billing readiness check (plans/phase-1/29-stripe-billing-platform/tasks.md
 * §3 "Implement live billing readiness gate"; docs/operations/stripe-launch-register.md's
 * "Release gates" checklist). Gathers real evidence — env config, the catalog,
 * the recorded seller profile, and recent reconciliation runs — and hands it
 * to the pure `assessLiveBillingReadiness` evaluator
 * (src/shared/lib/billing/readiness.ts). Never mutates anything.
 *
 * Usage:
 *   pnpm billing:check-readiness              # local/config-only evidence, Stripe account check skipped
 *   pnpm billing:check-readiness --live        # also calls Stripe's real Accounts API for charges_enabled
 *                                              # (requires STRIPE_SECRET_KEY; still entirely read-only)
 *
 * The three manual-attestation gates (Terms/Privacy sign-off, operator runbooks,
 * Stripe Billing Portal configuration) cannot be verified from source or a
 * database row — they require --confirm-terms-privacy / --confirm-runbooks /
 * --confirm-portal-configuration, an explicit operator assertion that the
 * corresponding "Release gates" checklist items in
 * docs/operations/stripe-launch-register.md have real evidence attached.
 * Omitting any flag reports that gate as missing — this script never assumes
 * an unconfirmed attestation.
 */
import Stripe from 'stripe'
import { desc, eq } from 'drizzle-orm'
import { assessLiveBillingReadiness } from '../../src/shared/lib/billing/readiness.ts'
import { PACK_CATALOG, SUBSCRIPTION_CATALOG, isActive } from '../../src/shared/lib/billing/catalog.ts'
import { platformDb } from '../../src/shared/lib/db/client.ts'
import { billingReconciliationRuns } from '../../src/shared/lib/db/schema.ts'

const RECONCILIATION_FRESHNESS_HOURS = 48

interface Flags {
  live: boolean
  confirmTermsPrivacy: boolean
  confirmRunbooks: boolean
  confirmPortalConfiguration: boolean
}

function parseFlags(argv: string[]): Flags {
  return {
    live: argv.includes('--live'),
    confirmTermsPrivacy: argv.includes('--confirm-terms-privacy'),
    confirmRunbooks: argv.includes('--confirm-runbooks'),
    confirmPortalConfiguration: argv.includes('--confirm-portal-configuration'),
  }
}

async function checkChargesEnabled(live: boolean): Promise<boolean> {
  if (!live) return false
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) return false
  const apiVersion = (process.env.STRIPE_API_VERSION ?? '2026-06-24.dahlia') as Stripe.LatestApiVersion
  const stripe = new Stripe(secretKey, { apiVersion })
  const account = await stripe.accounts.retrieve()
  return account.charges_enabled === true
}

function checkCatalogLivePriceIds(): boolean {
  const now = new Date()
  const activeSubscriptions = Object.values(SUBSCRIPTION_CATALOG).filter((entry) => isActive(entry, now))
  const activePacks = Object.values(PACK_CATALOG).filter((entry) => isActive(entry, now))
  return [...activeSubscriptions, ...activePacks].every((entry) => entry.stripePriceId.live !== null)
}

async function checkRecentCleanReconciliation(): Promise<boolean> {
  const [latestClean] = await platformDb
    .select({ windowEnd: billingReconciliationRuns.windowEnd })
    .from(billingReconciliationRuns)
    .where(eq(billingReconciliationRuns.result, 'clean'))
    .orderBy(desc(billingReconciliationRuns.windowEnd))
    .limit(1)
  if (!latestClean) return false
  const ageHours = (Date.now() - latestClean.windowEnd.getTime()) / (1000 * 60 * 60)
  return ageHours <= RECONCILIATION_FRESHNESS_HOURS
}

/**
 * Each DB/network-dependent check runs independently and defaults to "not
 * ready" (never throws) on failure — e.g. a database that hasn't been
 * migrated yet, or Stripe being unreachable, should still produce a complete,
 * correctly-fail-closed report on every OTHER gate rather than crashing the
 * whole command with a raw stack trace.
 */
async function safeCheck(label: string, check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check()
  } catch (error) {
    console.error(`[readiness] ${label} check failed, treating as not ready:`, error instanceof Error ? error.message : error)
    return false
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))

  const { getCurrentSellerProfile } = await import('../../src/shared/lib/billing/seller-profile.ts')
  const seller = await getCurrentSellerProfile().catch((error) => {
    console.error('[readiness] seller profile lookup failed, treating as not recorded:', error instanceof Error ? error.message : error)
    return null
  })

  const evidence = {
    billingFlagEnabledInLiveMode: process.env.STRIPE_BILLING_ENABLED === 'true' && Boolean(process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')),
    chargesEnabled: await safeCheck('Stripe charges_enabled', () => checkChargesEnabled(flags.live)),
    sellerProfileRecorded: Boolean(seller?.legalName && seller.publicBusinessAddress && seller.establishmentCountry),
    supportContactConfigured: Boolean(seller?.statementDescriptor && seller?.supportEmail),
    catalogLivePriceIdsComplete: checkCatalogLivePriceIds(),
    webhookAndApiVersionConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_API_VERSION),
    webhookPayloadEncryptionKeyConfigured: /^[0-9a-f]{64}$/i.test(process.env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY ?? ''),
    taxConfigurationRecorded: Boolean(seller && seller.taxRegistrations.length > 0),
    denmarkAllowlisted: Boolean(seller?.countryAllowlist.includes('DK')),
    termsPrivacyVersionsConfirmed: flags.confirmTermsPrivacy,
    operatorRunbooksConfirmed: flags.confirmRunbooks,
    reconciliationEvidenceRecent: await safeCheck('reconciliation evidence', checkRecentCleanReconciliation),
    portalConfigurationRestricted: flags.confirmPortalConfiguration,
  }

  const result = assessLiveBillingReadiness(evidence)
  console.log(JSON.stringify({ ready: result.ready, missing: result.missing }, null, 2))
  if (!result.ready) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('Readiness check failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0)
  })
