import type { TenantTransaction } from '../db/client'
import type { BillingCreditGrantRecord, BillingLedgerEntryRecord } from '../repositories/billing-ledger'
import {
  findCreditGrant,
  findCreditGrantByMonthlyWindowKey,
  findLedgerEntryByIdempotencyKey,
  insertCreditGrant,
  insertLedgerEntry,
  listActiveCreditGrantsByEarliestExpiry,
  updateCreditGrantState,
} from '../repositories/billing-ledger'

/**
 * The append-only credit grant/balance layer (plans/phase-1/30-stripe-billing-platform/tasks.md
 * §4 "Implement append-only grant and balance logic"). Every operation here:
 *
 * - Is idempotent by `idempotencyKey` — a retried call with the same key
 *   returns the original result instead of creating a second effect,
 *   checked via `findLedgerEntryByIdempotencyKey` before any mutation.
 * - Writes exactly one `billing_ledger_entries` row per call, never updates
 *   or deletes an existing one — corrections use `adjustCreditGrant`
 *   (a compensating entry), never a second call to grant/expire/revoke.
 * - Keeps `remainingUnits` denormalized on the grant row in lockstep with the
 *   ledger: every mutation updates both in the same transaction.
 *
 * Invariant enforced everywhere: `0 <= remainingUnits <= originalUnits`.
 */

export class CreditLedgerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'CreditLedgerError'
  }
}

export interface GrantCreditsInput {
  grantId: string
  ledgerEntryId: string
  organizationId: string
  source: 'subscription_monthly' | 'subscription_annual_window' | 'subscription_upgrade_delta' | 'pack' | 'legacy_manual' | 'promotional' | 'operator_trial'
  sourceReference?: string
  stripePaymentReference?: string
  stripePaymentIntentId?: string
  monthlyWindowKey?: string
  units: number
  expiresAt: Date
  idempotencyKey: string
}

export interface CreditMutationResult {
  grant: BillingCreditGrantRecord
  ledgerEntry: BillingLedgerEntryRecord
  /** True when this call found an existing ledger entry for the idempotency key and replayed it, rather than mutating anything new. */
  replayed: boolean
}

/**
 * Read-only replay lookup for a caller that needs to know WHETHER a given `idempotencyKey` was
 * already fully processed — without attempting a new grant (and without needing to know the
 * original `units`/`expiresAt` again just to ask). `subscription-changes.ts` uses this to recognize
 * a retried or raced request that already succeeded, distinct from `grantCredits`'s own internal
 * check (which requires the full input to also perform the grant if none exists yet).
 */
export async function findGrantedByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<CreditMutationResult | null> {
  const ledgerEntry = await findLedgerEntryByIdempotencyKey(transaction, organizationId, idempotencyKey)
  if (!ledgerEntry) return null
  const grant = ledgerEntry.grantId ? await findCreditGrant(transaction, organizationId, ledgerEntry.grantId) : null
  if (!grant) throw new CreditLedgerError('Idempotency key already used by an entry with no matching grant', 'idempotency_conflict')
  return { grant, ledgerEntry, replayed: true }
}

/** Grants a new batch of credits. Idempotent by `idempotencyKey`; also refuses a second grant for the same `monthlyWindowKey` (annual-subscription anniversary windows are granted at most once each — spec.md). */
export async function grantCredits(transaction: TenantTransaction, input: GrantCreditsInput): Promise<CreditMutationResult> {
  if (!Number.isInteger(input.units) || input.units <= 0) {
    throw new CreditLedgerError('Grant units must be a positive integer', 'invalid_units')
  }

  const existingEntry = await findLedgerEntryByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (existingEntry) {
    const grant = existingEntry.grantId ? await findCreditGrant(transaction, input.organizationId, existingEntry.grantId) : null
    if (!grant) throw new CreditLedgerError('Idempotency key already used by an entry with no matching grant', 'idempotency_conflict')
    return { grant, ledgerEntry: existingEntry, replayed: true }
  }

  if (input.monthlyWindowKey) {
    const existingWindow = await findCreditGrantByMonthlyWindowKey(transaction, input.organizationId, input.monthlyWindowKey)
    if (existingWindow) {
      throw new CreditLedgerError(`Monthly window ${input.monthlyWindowKey} was already granted`, 'monthly_window_already_granted')
    }
  }

  const grant = await insertCreditGrant(transaction, {
    id: input.grantId,
    organizationId: input.organizationId,
    source: input.source,
    sourceReference: input.sourceReference,
    stripePaymentReference: input.stripePaymentReference,
    stripePaymentIntentId: input.stripePaymentIntentId,
    monthlyWindowKey: input.monthlyWindowKey,
    originalUnits: input.units,
    remainingUnits: input.units,
    expiresAt: input.expiresAt,
  })

  const ledgerEntry = await insertLedgerEntry(transaction, {
    id: input.ledgerEntryId,
    organizationId: input.organizationId,
    entryType: 'grant',
    grantId: grant.id,
    unitsDelta: input.units,
    sourceIdempotencyKey: input.idempotencyKey,
  })

  return { grant, ledgerEntry, replayed: false }
}

interface TerminalTransitionInput {
  organizationId: string
  grantId: string
  ledgerEntryId: string
  idempotencyKey: string
  reason?: string
}

async function applyTerminalTransition(
  transaction: TenantTransaction,
  input: TerminalTransitionInput,
  entryType: 'expire' | 'revoke',
  targetState: 'expired' | 'revoked',
): Promise<CreditMutationResult> {
  const existingEntry = await findLedgerEntryByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (existingEntry) {
    const grant = existingEntry.grantId ? await findCreditGrant(transaction, input.organizationId, existingEntry.grantId) : null
    if (!grant) throw new CreditLedgerError('Idempotency key already used by an entry with no matching grant', 'idempotency_conflict')
    return { grant, ledgerEntry: existingEntry, replayed: true }
  }

  const grant = await findCreditGrant(transaction, input.organizationId, input.grantId)
  if (!grant) throw new CreditLedgerError('Grant not found', 'grant_not_found')
  if (grant.state === 'expired' || grant.state === 'revoked') {
    throw new CreditLedgerError(`Grant is already ${grant.state} — use its original idempotency key to replay, not a new one`, 'already_terminal')
  }

  const forfeitedUnits = grant.remainingUnits
  const updated = await updateCreditGrantState(transaction, input.organizationId, input.grantId, {
    state: targetState,
    remainingUnits: 0,
  })
  const ledgerEntry = await insertLedgerEntry(transaction, {
    id: input.ledgerEntryId,
    organizationId: input.organizationId,
    entryType,
    grantId: grant.id,
    unitsDelta: -forfeitedUnits,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })

  return { grant: updated, ledgerEntry, replayed: false }
}

/** Ends a grant's usable life at its natural expiry, forfeiting whatever remains. */
export function expireCreditGrant(transaction: TenantTransaction, input: TerminalTransitionInput): Promise<CreditMutationResult> {
  return applyTerminalTransition(transaction, input, 'expire', 'expired')
}

/** Ends a grant permanently outside its natural expiry (e.g. a lost dispute revoking unused included credits) — spec.md's revocation path, distinct from expiry. */
export function revokeCreditGrant(transaction: TenantTransaction, input: TerminalTransitionInput): Promise<CreditMutationResult> {
  return applyTerminalTransition(transaction, input, 'revoke', 'revoked')
}

interface FreezeTransitionInput {
  organizationId: string
  grantId: string
  ledgerEntryId: string
  idempotencyKey: string
  reason?: string
}

async function applyFreezeTransition(
  transaction: TenantTransaction,
  input: FreezeTransitionInput,
  entryType: 'freeze' | 'unfreeze',
  fromState: 'active' | 'frozen',
  toState: 'frozen' | 'active',
): Promise<CreditMutationResult> {
  const existingEntry = await findLedgerEntryByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (existingEntry) {
    const grant = existingEntry.grantId ? await findCreditGrant(transaction, input.organizationId, existingEntry.grantId) : null
    if (!grant) throw new CreditLedgerError('Idempotency key already used by an entry with no matching grant', 'idempotency_conflict')
    return { grant, ledgerEntry: existingEntry, replayed: true }
  }

  const grant = await findCreditGrant(transaction, input.organizationId, input.grantId)
  if (!grant) throw new CreditLedgerError('Grant not found', 'grant_not_found')
  if (grant.state !== fromState) {
    throw new CreditLedgerError(`Grant must be ${fromState} to transition to ${toState}, was ${grant.state}`, 'invalid_state_transition')
  }

  // Freeze/unfreeze never change units — only usability. remainingUnits is carried forward as-is.
  const updated = await updateCreditGrantState(transaction, input.organizationId, input.grantId, {
    state: toState,
    remainingUnits: grant.remainingUnits,
  })
  const ledgerEntry = await insertLedgerEntry(transaction, {
    id: input.ledgerEntryId,
    organizationId: input.organizationId,
    entryType,
    grantId: grant.id,
    unitsDelta: 0,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })

  return { grant: updated, ledgerEntry, replayed: false }
}

/** Freezes a still-usable grant (e.g. a payment-grace period) — the grant's units are preserved, just made temporarily unusable. */
export function freezeCreditGrant(transaction: TenantTransaction, input: FreezeTransitionInput): Promise<CreditMutationResult> {
  return applyFreezeTransition(transaction, input, 'freeze', 'active', 'frozen')
}

/** Restores a frozen grant to active (e.g. payment recovery) — only valid units survive; an already-expired frozen grant should be expired instead of unfrozen. */
export function unfreezeCreditGrant(transaction: TenantTransaction, input: FreezeTransitionInput): Promise<CreditMutationResult> {
  return applyFreezeTransition(transaction, input, 'unfreeze', 'frozen', 'active')
}

export interface AdjustCreditGrantInput {
  organizationId: string
  grantId: string
  ledgerEntryId: string
  idempotencyKey: string
  unitsDelta: number
  reason: string
}

/** The only correction mechanism for a mistake — never mutate a past ledger entry, insert a compensating one instead. Refuses any adjustment that would push remainingUnits outside [0, originalUnits]. */
export async function adjustCreditGrant(transaction: TenantTransaction, input: AdjustCreditGrantInput): Promise<CreditMutationResult> {
  if (!Number.isInteger(input.unitsDelta) || input.unitsDelta === 0) {
    throw new CreditLedgerError('Adjustment unitsDelta must be a non-zero integer', 'invalid_units')
  }

  const existingEntry = await findLedgerEntryByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (existingEntry) {
    const grant = existingEntry.grantId ? await findCreditGrant(transaction, input.organizationId, existingEntry.grantId) : null
    if (!grant) throw new CreditLedgerError('Idempotency key already used by an entry with no matching grant', 'idempotency_conflict')
    return { grant, ledgerEntry: existingEntry, replayed: true }
  }

  const grant = await findCreditGrant(transaction, input.organizationId, input.grantId)
  if (!grant) throw new CreditLedgerError('Grant not found', 'grant_not_found')

  const newRemaining = grant.remainingUnits + input.unitsDelta
  if (newRemaining < 0 || newRemaining > grant.originalUnits) {
    throw new CreditLedgerError(
      `Adjustment would move remainingUnits to ${newRemaining}, outside [0, ${grant.originalUnits}]`,
      'adjustment_out_of_bounds',
    )
  }

  const updated = await updateCreditGrantState(transaction, input.organizationId, input.grantId, {
    state: grant.state,
    remainingUnits: newRemaining,
  })
  const ledgerEntry = await insertLedgerEntry(transaction, {
    id: input.ledgerEntryId,
    organizationId: input.organizationId,
    entryType: 'adjust',
    grantId: grant.id,
    unitsDelta: input.unitsDelta,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })

  return { grant: updated, ledgerEntry, replayed: false }
}

/** Sum of `remainingUnits` across every grant that is both `active` and not yet past its `expiresAt` — a grant whose expiry worker hasn't swept it yet must not be counted as spendable. Ordered earliest-expiry-first (spec.md's consumption order), so callers reserving against this balance know which grants to draw from first. */
export async function getAvailableCreditGrantsByEarliestExpiry(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date = new Date(),
): Promise<BillingCreditGrantRecord[]> {
  const grants = await listActiveCreditGrantsByEarliestExpiry(transaction, organizationId)
  return grants.filter((grant) => grant.expiresAt.getTime() > now.getTime())
}

export async function getAvailableCreditBalance(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const grants = await getAvailableCreditGrantsByEarliestExpiry(transaction, organizationId, now)
  return grants.reduce((total, grant) => total + grant.remainingUnits, 0)
}

/** spec.md §Packs and auto-recharge: "Pack Checkout uses payment mode and active-paid-entitlement validation before creation and grant" — a pack purchase requires an active or trialing paid subscription on this NEW catalog, never the legacy manual-billing tier. */
export function isActivePaidSubscription(subscription: { stripeStatus: string } | null): boolean {
  if (!subscription) return false
  return subscription.stripeStatus === 'active' || subscription.stripeStatus === 'trialing'
}
