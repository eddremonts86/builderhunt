/**
 * Fraud and high-volume exception controls (plans/implemented/30-stripe-billing-platform/tasks.md §8 "Add fraud and
 * high-volume exception controls"; spec.md §Packs and auto-recharge: "Provider-requested 3DS, Radar,
 * failure/card-rotation velocity checks, and a reviewed time-bounded high-volume exception protect
 * against spend-then-chargeback abuse.").
 *
 * "Consume Radar/3DS results": this codebase's `BillingProvider` abstraction has no separate Radar
 * risk-score field — the practical signal every real Stripe integration (and this one) actually acts
 * on is the outcome itself: a `BillingProviderError` from `createCheckoutSession`/`createPaymentIntent`
 * IS Stripe's (Radar-informed, possibly-3DS-gated) decline decision. `recordPaymentFailure` is called
 * from exactly those two failure paths (`packs.ts`'s Checkout-creation catch block,
 * `auto-recharge.ts`'s off-session-charge catch block) — no separate Radar-score plumbing invented
 * for signals this provider boundary doesn't expose.
 *
 * `recordPaymentFailure` deliberately takes an organizationId, never the caller's own (about-to-fail)
 * `TenantTransaction` — `packs.ts`'s Checkout-creation catch block records the failure and then
 * re-throws, and that throw propagates out through `withTenantContext`'s `database.transaction(...)`
 * wrapper, rolling back everything written inside it. A risk event written on the SAME doomed
 * transaction would be rolled back right along with it — the one signal this module most needs to
 * survive a failure. It runs its own independent, already-committed transaction instead.
 *
 * "Track failure/payment-method/dispute velocity": failure velocity is fully implemented below
 * (`assertNotRiskBlocked`). Payment-method-rotation velocity has no data to track yet — this codebase
 * never stores or observes payment-method changes (Stripe's Customer Portal owns that entirely, see
 * `portal.ts`) — and dispute velocity depends on disputes existing at all (§8 task 5, not yet built).
 * Both are accounted for in `billing_risk_events`' schema today (`'card_rotation'`/`'dispute_opened'`
 * are valid `eventType`s the CHECK constraint already allows) specifically so task 5 (and a future
 * payment-method-tracking task) can call `recordRiskEvent` directly — a small additive integration,
 * not a redesign — the moment either signal exists; `assertNotRiskBlocked` already counts whichever
 * `eventType`s a caller asks it to.
 *
 * "Block only new purchases": every caller of `assertNotRiskBlocked` is a Checkout/PaymentIntent
 * CREATION path (`packs.ts`, `auto-recharge.ts`) — never a read, never subscription access, never
 * data/export access, matching `dunning.ts`'s own "preserves all data/export access" precedent.
 *
 * "A reviewed time-bounded high-volume exception that never bypasses successful payment or ledger
 * rules": `issueRiskException`/`revokeRiskException` only ever affect whether
 * `assertNotRiskBlocked` throws — they touch nothing in `credits.ts`/`grantCredits`, no Checkout
 * Session, no PaymentIntent. A purchase still has to succeed through the normal path to grant
 * anything; the exception merely permits attempting it.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PlatformAdminPrincipal } from '../auth/platform-admin'
import { platformDb, runtimeDb, type TenantTransaction } from '../db/client'
import {
  findActiveRiskException,
  issueRiskExceptionForOrganization,
  listRecentRiskEvents,
  listRiskExceptionsForOrganization,
  recordRiskEvent,
  revokeRiskExceptionForOrganization,
  type BillingRiskExceptionRecord,
} from '../repositories/billing-risk'

export const PAYMENT_FAILURE_VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000
/** 3+ failed payment attempts in the trailing 24h blocks further new-purchase attempts until reviewed. */
export const PAYMENT_FAILURE_VELOCITY_THRESHOLD = 3
export const MAX_RISK_EXCEPTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

export class RiskBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RiskBlockedError'
  }
}

/**
 * Independent, always-committed write — see this module's top comment for why this cannot reuse the
 * caller's own (possibly-about-to-roll-back) `TenantTransaction`. `db` overrides the connection used
 * for this one-off transaction — defaults to the real `runtimeDb` singleton; tests inject a
 * disposable database.
 */
export async function recordPaymentFailure(
  organizationId: string,
  detail?: string,
  db: PostgresJsDatabase | typeof runtimeDb = runtimeDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'app', true),
        set_config('app.request_id', ${randomUUID()}, true)
    `)
    await recordRiskEvent(tx, { organizationId, eventType: 'payment_failure', detail: detail?.slice(0, 500) })
  })
}

/** Throws `RiskBlockedError` if the organization has hit the payment-failure velocity threshold and has no currently-active operator exception. A no-op (never throws) otherwise — the common case for every well-behaved organization. */
export async function assertNotRiskBlocked(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date = new Date(),
): Promise<void> {
  const since = new Date(now.getTime() - PAYMENT_FAILURE_VELOCITY_WINDOW_MS)
  const failures = await listRecentRiskEvents(transaction, organizationId, 'payment_failure', since)
  if (failures.length < PAYMENT_FAILURE_VELOCITY_THRESHOLD) return

  const exception = await findActiveRiskException(transaction, organizationId, now)
  if (exception) return

  throw new RiskBlockedError(
    'This organization is temporarily blocked from new purchases due to repeated payment failures — contact support for review',
  )
}

export class RiskExceptionError extends Error {
  constructor(message: string, readonly code: 'invalid_duration') {
    super(message)
    this.name = 'RiskExceptionError'
  }
}

export interface IssueRiskExceptionInput {
  organizationId: string
  reason: string
  durationMs: number
}

/** Platform-operator-only (never a `TenantPrincipal`/organization role — matches `requirePlatformBillingConfigurationAccess`'s own separation) time-bounded exception. `db` overrides where the platform-scoped write lands — defaults to the real `platformDb` singleton; tests inject a disposable database. */
export async function issueRiskException(
  principal: PlatformAdminPrincipal,
  input: IssueRiskExceptionInput,
  db?: PostgresJsDatabase | typeof platformDb,
): Promise<BillingRiskExceptionRecord> {
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > MAX_RISK_EXCEPTION_DURATION_MS) {
    throw new RiskExceptionError(`Exception duration must be between 1ms and ${MAX_RISK_EXCEPTION_DURATION_MS}ms (30 days)`, 'invalid_duration')
  }
  return issueRiskExceptionForOrganization({
    organizationId: input.organizationId,
    reason: input.reason,
    issuedByUserId: principal.userId,
    expiresAt: new Date(Date.now() + input.durationMs),
  }, db)
}

export function listRiskExceptions(organizationId: string, db?: PostgresJsDatabase | typeof platformDb): Promise<BillingRiskExceptionRecord[]> {
  return listRiskExceptionsForOrganization(organizationId, db)
}

export function revokeRiskException(
  organizationId: string,
  exceptionId: string,
  db?: PostgresJsDatabase | typeof platformDb,
): Promise<BillingRiskExceptionRecord | null> {
  return revokeRiskExceptionForOrganization(organizationId, exceptionId, new Date(), db)
}
