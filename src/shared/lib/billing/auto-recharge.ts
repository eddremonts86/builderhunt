/**
 * Capped auto-recharge and SCA recovery (plans/phase-1/29-stripe-billing-platform/tasks.md §8 task 2
 * "Implement capped auto-recharge and SCA recovery"; spec.md §Packs and auto-recharge). One rule row
 * per organization (`billing_auto_recharge_rules.organization_id` is its own primary key) — off by
 * default (`enabled: false`, `state: 'inactive'`), owner-only, and requires a fresh sign-in at the
 * route layer (`billing:auto-recharge` is in `permissions.ts`'s `RECENT_AUTH_REQUIRED_BILLING_ACTIONS`).
 *
 * Two halves live in this file:
 * - `configureAutoRecharge`/`disableAutoRecharge`/`getAutoRechargeRuleForOwner`: the owner-facing,
 *   `TenantTransaction`-scoped configuration surface (called from the route).
 * - `maybeTriggerAutoRecharge`: the cross-org WORKER-side trigger decision, called once per
 *   organization by `worker.ts`'s new `sweepAutoRecharge` sweep. Locks the rule row first
 *   (`lockAutoRechargeRule`) so two concurrent sweep ticks for the same org can't both decide to
 *   charge, then — if eligible — creates an off-session PaymentIntent and immediately claims it via
 *   `pending_payment_intent_id` (`claimAutoRechargeTrigger`) as the guard against a LATER tick
 *   re-triggering before this charge's outcome is known (the row lock alone only prevents
 *   *concurrent* double-triggers, not *sequential* ones across separate ticks/transactions).
 *
 * Credits are granted only by the `payment_intent.succeeded` webhook handler
 * (`webhook-handlers.ts`'s `handleAutoRechargePaymentIntentEvent`), never here — matching
 * `packs.ts`'s own "never grant before a webhook confirms success" contract. `requires_action` or a
 * failed off-session attempt pauses the rule (`paused_needs_auth`/`paused_failed`) rather than
 * silently retrying — spec.md: "Authentication-required or failed off-session payment pauses
 * auto-recharge and sends the owner to an on-session recovery." The UI
 * (`AutoRechargeSettings.tsx`) reads `state`/`lastFailureReason` and links to the existing Customer
 * Portal (`billing/portal.ts`) for that on-session recovery — no new payment-collection surface.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { CURRENT_CONSENT_VERSIONS } from '../legal'
import { resolvePackCatalogEntryByKey, resolvePackCatalogKey } from './catalog'
import { recordAutoRechargeConsent } from './consent'
import { getAvailableCreditBalance, isActivePaidSubscription } from './credits'
import { assertWithinRollingPackChargeLimit, ROLLING_RISK_MAX_AMOUNT_CENTS } from './packs'
import { BillingProviderError, type BillingProvider } from './provider'
import { assertNotRiskBlocked, recordPaymentFailure } from './risk'
import {
  claimAutoRechargeTrigger,
  disableAutoRechargeRule,
  findActiveBillingSubscription,
  findAutoRechargeRule,
  findBillingCustomer,
  lockAutoRechargeRule,
  pauseAutoRechargeRule,
  resolveAutoRechargeTrigger,
  upsertAutoRechargeRule,
  type BillingAutoRechargeRuleRecord,
} from '../repositories/billing'
import { listRecentGrantsBySource } from '../repositories/billing-ledger'
import { idempotencyKeyFor, isLiveMode } from './stripe-client'

export type AutoRechargeErrorCode =
  | 'no_active_subscription'
  | 'unknown_pack_catalog_key'
  | 'invalid_threshold'
  | 'invalid_monthly_cap'
  | 'setup_requires_action'
  | 'provider_error'

export class AutoRechargeError extends Error {
  constructor(message: string, readonly code: AutoRechargeErrorCode) {
    super(message)
    this.name = 'AutoRechargeError'
  }
}

export interface ConfigureAutoRechargeInput {
  packCatalogKey: string
  balanceThresholdUnits: number
  monthlyCapCents: number
  /** Separate off-session-specific consent (spec.md: "requires separate versioned off-session consent") — distinct from the Checkout disclosure set `consent.ts`'s `recordCheckoutConsent` validates. */
  acknowledgedOffSessionCharge: boolean
}

export interface ConfigureAutoRechargeOptions {
  provider: BillingProvider
}

export async function configureAutoRecharge(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: ConfigureAutoRechargeInput,
  options: ConfigureAutoRechargeOptions,
): Promise<BillingAutoRechargeRuleRecord> {
  const livemode = isLiveMode()

  if (!Number.isInteger(input.balanceThresholdUnits) || input.balanceThresholdUnits < 0) {
    throw new AutoRechargeError('balanceThresholdUnits must be a non-negative integer', 'invalid_threshold')
  }
  // spec.md: "Owner chooses pack, balance threshold, and monthly cap up to $1,000" — the same
  // absolute ceiling the DB CHECK constraint enforces (belt-and-suspenders, not a substitute for it).
  if (!Number.isInteger(input.monthlyCapCents) || input.monthlyCapCents <= 0 || input.monthlyCapCents > ROLLING_RISK_MAX_AMOUNT_CENTS) {
    throw new AutoRechargeError(`monthlyCapCents must be a positive integer up to ${ROLLING_RISK_MAX_AMOUNT_CENTS}`, 'invalid_monthly_cap')
  }
  const catalogEntry = resolvePackCatalogKey(input.packCatalogKey)
  if (!catalogEntry) {
    throw new AutoRechargeError(`Unknown or retired pack catalog key: ${input.packCatalogKey}`, 'unknown_pack_catalog_key')
  }

  const activeSubscription = await findActiveBillingSubscription(transaction, principal.organizationId, livemode)
  if (!isActivePaidSubscription(activeSubscription)) {
    throw new AutoRechargeError('Auto-recharge requires an active paid subscription', 'no_active_subscription')
  }
  const customer = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (!customer) {
    throw new AutoRechargeError('Billing customer not found — subscribe first', 'no_active_subscription')
  }

  const consent = await recordAutoRechargeConsent(transaction, principal, {
    acknowledgedOffSessionCharge: input.acknowledgedOffSessionCharge,
  })

  // "Prepare off-session method": confirm the org's saved payment method actually supports being
  // charged without the customer present BEFORE turning the rule on — a SetupIntent that comes back
  // anything other than `succeeded` (e.g. `requires_action`, a 3DS-mandated card) means auto-recharge
  // cannot yet be safely enabled; the owner must complete that authentication on-session first.
  let setupIntent
  try {
    setupIntent = await options.provider.createSetupIntent({
      customerId: customer.stripeCustomerId,
      idempotencyKey: idempotencyKeyFor('auto-recharge-setup', principal.organizationId, consent.id),
    })
  } catch (error) {
    if (error instanceof BillingProviderError) {
      throw new AutoRechargeError(`Setup provider error: ${error.message}`, 'provider_error')
    }
    throw error
  }
  if (setupIntent.status !== 'succeeded') {
    throw new AutoRechargeError(
      'Off-session payment method needs additional authentication before auto-recharge can be enabled',
      'setup_requires_action',
    )
  }

  return upsertAutoRechargeRule(transaction, {
    organizationId: principal.organizationId,
    ownerUserId: principal.userId,
    enabled: true,
    packCatalogKey: catalogEntry.key,
    balanceThresholdUnits: input.balanceThresholdUnits,
    monthlyCapCents: input.monthlyCapCents,
    state: 'active',
    consentVersion: CURRENT_CONSENT_VERSIONS.tos,
  })
}

export function disableAutoRecharge(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
): Promise<BillingAutoRechargeRuleRecord | null> {
  return disableAutoRechargeRule(transaction, principal.organizationId)
}

export function getAutoRechargeRuleForOwner(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
): Promise<BillingAutoRechargeRuleRecord | null> {
  return findAutoRechargeRule(transaction, principal.organizationId)
}

export interface MaybeTriggerAutoRechargeOptions {
  provider: BillingProvider
  now?: Date
  /** Overrides where `risk.ts`'s `recordPaymentFailure` writes its independent, always-committed risk event — defaults to the real `runtimeDb`; tests inject a disposable database. */
  riskDb?: PostgresJsDatabase
}

export type AutoRechargeTriggerOutcome =
  | { triggered: false; reason: string }
  | { triggered: true; paymentIntentId: string }

/**
 * The worker-side trigger decision for one organization — called once per sweep tick by
 * `worker.ts`'s `sweepAutoRecharge`, inside a `withWorkerOrganization` transaction. Every early
 * return that does NOT mutate rule state (balance above threshold, rolling-limit hit, no active
 * subscription) is a genuinely TEMPORARY condition that should simply be re-evaluated next tick —
 * only a configuration problem (retired pack) or a real payment failure pauses the rule.
 */
export async function maybeTriggerAutoRecharge(
  transaction: TenantTransaction,
  organizationId: string,
  options: MaybeTriggerAutoRechargeOptions,
): Promise<AutoRechargeTriggerOutcome> {
  const now = options.now ?? new Date()
  const livemode = isLiveMode()

  const rule = await lockAutoRechargeRule(transaction, organizationId)
  if (!rule || !rule.enabled || rule.state !== 'active') return { triggered: false, reason: 'auto-recharge is not active' }
  if (rule.pendingPaymentIntentId) return { triggered: false, reason: 'a charge is already in flight' }

  const activeSubscription = await findActiveBillingSubscription(transaction, organizationId, livemode)
  if (!isActivePaidSubscription(activeSubscription)) return { triggered: false, reason: 'no active paid subscription' }

  const balance = await getAvailableCreditBalance(transaction, organizationId, now)
  if (rule.balanceThresholdUnits === null || balance > rule.balanceThresholdUnits) {
    return { triggered: false, reason: 'balance is above the configured threshold' }
  }

  const catalogEntry = rule.packCatalogKey ? resolvePackCatalogKey(rule.packCatalogKey) : null
  if (!catalogEntry) {
    await pauseAutoRechargeRule(transaction, organizationId, {
      state: 'paused_failed',
      lastFailureAt: now,
      lastFailureReason: 'Configured pack is no longer available — choose a different pack',
    })
    return { triggered: false, reason: 'configured pack catalog key no longer resolves' }
  }
  const priceId = livemode ? catalogEntry.stripePriceId.live : catalogEntry.stripePriceId.test
  if (!priceId) return { triggered: false, reason: 'no Stripe Price configured for this pack yet' }

  // Monthly cap (spec.md: "Owner chooses ... monthly cap up to $1,000") is scoped to THIS
  // organization's auto-recharge spend specifically — distinguished from a manually-purchased pack
  // of the same catalog key by Stripe's own `pi_`/`cs_` id-prefix convention on
  // `stripePaymentReference` (auto-recharge charges a PaymentIntent directly, with no Checkout
  // Session in between; manual purchases always go through one — see `packs.ts`'s
  // `handlePackCheckoutCompleted`).
  if (rule.monthlyCapCents !== null) {
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const monthGrants = await listRecentGrantsBySource(transaction, organizationId, 'pack', startOfMonth)
    const spentThisMonthCents = monthGrants
      .filter((grant) => grant.stripePaymentReference?.startsWith('pi_'))
      .reduce((total, grant) => {
        const entry = grant.sourceReference ? resolvePackCatalogEntryByKey(grant.sourceReference) : null
        return total + (entry?.amountCents ?? 0)
      }, 0)
    if (spentThisMonthCents + catalogEntry.amountCents > rule.monthlyCapCents) {
      return { triggered: false, reason: 'monthly auto-recharge cap reached' }
    }
  }

  // Shared with manual pack purchases (packs.ts) — spec.md: "Manual and automatic pack charges
  // share a rolling limit."
  try {
    await assertWithinRollingPackChargeLimit(transaction, organizationId, catalogEntry.amountCents, now)
  } catch {
    return { triggered: false, reason: 'shared rolling 24h risk limit reached' }
  }

  // §8 task 3 fraud/high-volume exception controls — a temporary condition like the rolling limit
  // above, never a rule-pausing failure: it lifts automatically once failures age out of the
  // window, or immediately once a platform operator issues a reviewed exception (`risk.ts`).
  try {
    await assertNotRiskBlocked(transaction, organizationId, now)
  } catch {
    return { triggered: false, reason: 'blocked pending fraud review' }
  }

  const customer = await findBillingCustomer(transaction, organizationId, livemode)
  if (!customer) return { triggered: false, reason: 'no billing customer on file' }

  let paymentIntent
  try {
    paymentIntent = await options.provider.createPaymentIntent({
      customerId: customer.stripeCustomerId,
      amount: catalogEntry.amountCents,
      currency: catalogEntry.currency,
      idempotencyKey: idempotencyKeyFor('auto-recharge-charge', organizationId, randomUUID()),
    })
  } catch (error) {
    const detail = error instanceof BillingProviderError ? error.message : 'Off-session charge failed'
    await recordPaymentFailure(organizationId, detail, options.riskDb)
    await pauseAutoRechargeRule(transaction, organizationId, {
      state: 'paused_failed',
      lastFailureAt: now,
      lastFailureReason: detail,
    })
    return { triggered: false, reason: 'provider declined the off-session charge' }
  }

  const claimed = await claimAutoRechargeTrigger(transaction, organizationId, paymentIntent.id)
  if (!claimed) {
    // Unreachable under the row lock taken above in normal operation — kept as a safe no-op rather
    // than a thrown error, since the PaymentIntent was already created regardless; its own webhook
    // still resolves it once the rule becomes claimable again.
    return { triggered: false, reason: 'rule became ineligible before the charge could be claimed' }
  }

  if (paymentIntent.status === 'requires_action') {
    await resolveAutoRechargeTrigger(transaction, organizationId, paymentIntent.id, {
      state: 'paused_needs_auth',
      lastFailureAt: now,
      lastFailureReason: 'Additional authentication required for this off-session charge',
    })
    return { triggered: false, reason: 'requires additional authentication' }
  }

  // 'succeeded' and 'processing' both leave `pendingPaymentIntentId` set — the
  // `payment_intent.succeeded`/`payment_intent.payment_failed` webhook is the only place credits are
  // granted or the rule's pending marker is cleared, exactly like a synchronously-`complete` fake
  // Checkout Session still waits for its own webhook before packs.ts grants anything.
  return { triggered: true, paymentIntentId: paymentIntent.id }
}
