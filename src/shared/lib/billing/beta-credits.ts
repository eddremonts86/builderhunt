import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { grantCredits } from './credits'
import { findCreditGrantByMonthlyWindowKey } from '../repositories/billing-ledger'
import type { BetaModeState } from './beta-mode'

/**
 * The 700-unit promotional beta allowance, one per organization per UTC calendar month (plan 58).
 *
 * ## Why real ledger rows, and not a tier projection
 *
 * This is the defect that made the earlier draft unimplementable: it raised the tier and assumed
 * credits followed. They do not. Spendable balance in this product comes from rows in
 * `billing_credit_grants` and the append-only `billing_ledger_entries` — changing a tier mints nothing,
 * so a "Pro Max" beta organization would have passed every feature check and then failed every metered
 * reservation with `insufficient_credits`.
 *
 * ## Additive, and deliberately not "exactly 700"
 *
 * The 700 units are promotional and stack on top of paid included credits and purchased packs. Paid
 * value must not be reduced to make an artificial total, and the ledger cannot claw back units already
 * consumed. So admin copy says "700 beta credits per month", never "your balance is capped at 700".
 *
 * ## Just in time, under a lock
 *
 * The grant is minted before the first non-zero metered reservation of the month rather than by a sweep
 * over every organization when the flag flips. Two concurrent first reservations must produce **one**
 * grant, not one success and one aborted transaction, so this takes a transaction-scoped advisory lock
 * derived from the organization and the month before it looks.
 *
 * `monthlyWindowKey` is the second line of defence and it already exists: `grantCredits` refuses a
 * second grant for the same key (`findCreditGrantByMonthlyWindowKey`). The lock avoids the error; the
 * key guarantees the outcome even if the lock is ever removed.
 */
export const BETA_MONTHLY_UNITS = 700

/** A namespace distinct from the beta-mode flag lock, so the two can never wait on each other. */
const BETA_CREDIT_LOCK_NAMESPACE = 0x62637264 // 'bcrd'

export interface BetaCreditWindow {
  /** `YYYY-MM`, UTC. */
  key: string
  /** What the grant records, and what eligibility matches on: `beta-mode:YYYY-MM`. */
  sourceReference: string
  /** The at-most-once key: `beta-mode:<organizationId>:YYYY-MM`. */
  monthlyWindowKey: string
  /** First instant of the next UTC month. */
  expiresAt: Date
}

export function deriveBetaCreditWindow(now: Date, organizationId: string): BetaCreditWindow {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const key = `${year}-${String(month + 1).padStart(2, '0')}`
  return {
    key,
    sourceReference: `beta-mode:${key}`,
    monthlyWindowKey: `beta-mode:${organizationId}:${key}`,
    // `Date.UTC` with month+1 rolls December into January of the next year on its own.
    expiresAt: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  }
}

/**
 * A stable 32-bit lock id from the organization and month.
 *
 * A collision costs two organizations a moment of serialisation and nothing else — the
 * `monthlyWindowKey` is what actually guarantees one grant — so a cheap hash is the right trade.
 */
function lockIdFor(window: BetaCreditWindow): number {
  let hash = BETA_CREDIT_LOCK_NAMESPACE
  for (const char of window.monthlyWindowKey) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  return hash
}

/**
 * Mints this month's grant if it does not exist. Safe to call on every reservation.
 */
export async function ensureBetaMonthlyCreditGrant(
  transaction: TenantTransaction,
  organizationId: string,
  state: Pick<BetaModeState, 'enabled'>,
  now: Date,
): Promise<void> {
  if (!state.enabled) return
  const window = deriveBetaCreditWindow(now, organizationId)

  await transaction.execute(sql`select pg_advisory_xact_lock(${lockIdFor(window)})`)

  const existing = await findCreditGrantByMonthlyWindowKey(transaction, organizationId, window.monthlyWindowKey)
  if (existing) return

  await grantCredits(transaction, {
    grantId: randomUUID(),
    ledgerEntryId: randomUUID(),
    organizationId,
    source: 'promotional',
    sourceReference: window.sourceReference,
    monthlyWindowKey: window.monthlyWindowKey,
    units: BETA_MONTHLY_UNITS,
    expiresAt: window.expiresAt,
    // Derived, not random: a retried request must not mint a second grant.
    idempotencyKey: `beta-grant:${window.monthlyWindowKey}`,
  })
}

/**
 * What a read-only surface may show as claimable, without writing anything.
 *
 * The grant is lazy, so before the first reservation of the month there is no row — and a billing
 * summary that reported the balance from rows alone would tell a beta organization it has 0 credits and
 * cannot act, moments before its first action succeeds. This closes that gap **without writing from a
 * GET**: it returns 700 when beta is on and no grant exists for the current window, and 0 otherwise.
 *
 * The caller adds it to the persisted eligible balance and reports it separately as
 * `betaCreditsClaimableUnits`, so a virtual allowance never appears in `activeCreditGrants` as if it
 * were a ledger row.
 */
export async function getClaimableBetaCreditUnits(
  transaction: TenantTransaction,
  organizationId: string,
  state: Pick<BetaModeState, 'enabled'>,
  now: Date,
): Promise<0 | typeof BETA_MONTHLY_UNITS> {
  if (!state.enabled) return 0
  const window = deriveBetaCreditWindow(now, organizationId)
  const existing = await findCreditGrantByMonthlyWindowKey(transaction, organizationId, window.monthlyWindowKey)
  return existing ? 0 : BETA_MONTHLY_UNITS
}

/**
 * The one predicate every consumer shares.
 *
 * Reservation, spendable balance, the active-grant projection, auto-recharge thresholds and the
 * Solutions billing adapter all have to agree on which grants are spendable *right now*. A
 * `promotional` grant whose reference starts with `beta-mode:` is eligible only when it matches the
 * active reference exactly — which is what makes disable immediate and rollover automatic:
 *
 * - beta off  → `activeBetaSourceReference` is null → no beta grant is eligible, and paid and pack
 *   grants are untouched.
 * - new month → the reference changes → last month's grant stops being eligible before the expiry
 *   worker has run.
 * - re-enabled in the same month → the unused remainder becomes eligible again, because nothing was
 *   mutated or deleted.
 */
export function isBetaGrantEligible(
  grant: { source: string; sourceReference: string | null },
  activeBetaSourceReference: string | null,
): boolean {
  const isBetaGrant = grant.source === 'promotional' && (grant.sourceReference?.startsWith('beta-mode:') ?? false)
  if (!isBetaGrant) return true
  return activeBetaSourceReference !== null && grant.sourceReference === activeBetaSourceReference
}

/** The reference to pass into the raw reservation, or null when beta is off. */
export function activeBetaSourceReference(
  state: Pick<BetaModeState, 'enabled'>,
  organizationId: string,
  now: Date,
): string | null {
  return state.enabled ? deriveBetaCreditWindow(now, organizationId).sourceReference : null
}
