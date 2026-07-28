import type { TenantTransaction } from '../db/client'
import { getRateCard } from './rate-cards'
import type {
  BillingCreditAllocationRecord,
  BillingCreditReservationRecord,
} from '../repositories/billing-ledger'
import {
  findAllocationForReservationAndGrant,
  findCreditGrant,
  findLedgerEntryByIdempotencyKey,
  findReservationByIdempotencyKey,
  insertAllocation,
  insertLedgerEntry,
  insertReservation,
  listAllocationsForReservation,
  lockActiveCreditGrantsByEarliestExpiry,
  lockReservation,
  updateAllocationAllocated,
  updateAllocationConsumed,
  updateCreditGrantState,
  updateReservation,
} from '../repositories/billing-ledger'

/**
 * Atomic credit reservation lifecycle (plans/stripe-billing-platform/tasks.md
 * §4 "Implement atomic reservation lifecycle"; spec.md §Credit authorization
 * contract). A provider-backed operation must never begin before
 * `reserveCredits` succeeds, and must stop if `extendReservation` fails.
 *
 * Every allocation walk locks eligible grants with `SELECT ... FOR UPDATE`
 * (via `lockActiveCreditGrantsByEarliestExpiry`) so two concurrent
 * reservations against the same organization can never both read the same
 * pre-allocation balance and overspend it — the second transaction blocks
 * until the first commits or rolls back.
 *
 * Once units are allocated to a reservation, they remain valid for
 * settlement through the reservation's own `deadlineAt` + settlement grace
 * even if the source grant's `expiresAt` passes in the meantime ("protect
 * in-flight allocations across grant expiry"). Only the UNUSED remainder,
 * released at settlement/release time, is subject to the source grant's
 * expiry: if the grant has expired by then, the remainder is forfeited
 * (ledger `expire`) instead of returned to the grant's spendable balance
 * (ledger `release`) — "expire released remainder when original grant has
 * expired." Client input can never widen `maximumUnits`/duration beyond what
 * the server itself set at `reserveCredits`/`extendReservation` time.
 */

export class ReservationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ReservationError'
  }
}

export interface ReservationResult {
  reservation: BillingCreditReservationRecord
  allocations: BillingCreditAllocationRecord[]
  replayed: boolean
}

interface AllocationWalkResult {
  allocations: BillingCreditAllocationRecord[]
  totalAllocated: number
}

/** Shared by `reserveCredits` and `extendReservation` — locks eligible grants earliest-expiry-first and slices `unitsNeeded` across them. Throws `ReservationError('insufficient_credits')` (no allocation partially applied — the caller's transaction rolls back everything) if the organization's total available balance is short. */
async function allocateFromEarliestExpiryGrants(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
  unitsNeeded: number,
  ledgerIdempotencyKeyPrefix: string,
  now: Date,
): Promise<AllocationWalkResult> {
  const grants = (await lockActiveCreditGrantsByEarliestExpiry(transaction, organizationId))
    .filter((grant) => grant.expiresAt.getTime() > now.getTime())

  const allocations: BillingCreditAllocationRecord[] = []
  let remaining = unitsNeeded

  for (const grant of grants) {
    if (remaining <= 0) break
    const take = Math.min(grant.remainingUnits, remaining)
    if (take <= 0) continue

    await updateCreditGrantState(transaction, organizationId, grant.id, {
      state: grant.state,
      remainingUnits: grant.remainingUnits - take,
    })
    // A reservation can only have one allocation row per grant — widen the existing one (e.g. from
    // extendReservation drawing on the same earliest-expiry grant again) instead of inserting a
    // second row, which would violate billing_credit_allocations_reservation_grant_unique.
    const existingAllocation = await findAllocationForReservationAndGrant(transaction, organizationId, reservationId, grant.id)
    const allocation = existingAllocation
      ? await updateAllocationAllocated(transaction, organizationId, existingAllocation.id, existingAllocation.allocatedUnits + take)
      : await insertAllocation(transaction, {
        id: `${ledgerIdempotencyKeyPrefix}-alloc-${grant.id}`,
        organizationId,
        reservationId,
        grantId: grant.id,
        allocatedUnits: take,
      })
    await insertLedgerEntry(transaction, {
      id: `${ledgerIdempotencyKeyPrefix}-entry-${grant.id}`,
      organizationId,
      entryType: 'reserve',
      grantId: grant.id,
      reservationId,
      unitsDelta: -take,
      sourceIdempotencyKey: `${ledgerIdempotencyKeyPrefix}-${grant.id}`,
    })
    allocations.push(allocation)
    remaining -= take
  }

  if (remaining > 0) {
    throw new ReservationError(`Insufficient credits: ${unitsNeeded - remaining} of ${unitsNeeded} available`, 'insufficient_credits')
  }

  return { allocations, totalAllocated: unitsNeeded }
}

export interface ReserveCreditsInput {
  reservationId: string
  organizationId: string
  operation: string
  rateCardVersion: number
  idempotencyKey: string
  maximumUnits: number
  maxDurationSeconds: number
}

export async function reserveCredits(transaction: TenantTransaction, input: ReserveCreditsInput, now: Date = new Date()): Promise<ReservationResult> {
  if (!Number.isInteger(input.maximumUnits) || input.maximumUnits <= 0) {
    throw new ReservationError('maximumUnits must be a positive integer', 'invalid_units')
  }

  const existing = await findReservationByIdempotencyKey(transaction, input.organizationId, input.idempotencyKey)
  if (existing) {
    const allocations = await listAllocationsForReservation(transaction, input.organizationId, existing.id)
    return { reservation: existing, allocations, replayed: true }
  }

  const deadlineAt = new Date(now.getTime() + input.maxDurationSeconds * 1000)
  const reservation = await insertReservation(transaction, {
    id: input.reservationId,
    organizationId: input.organizationId,
    operation: input.operation,
    rateCardVersion: input.rateCardVersion,
    idempotencyKey: input.idempotencyKey,
    maximumUnits: input.maximumUnits,
    deadlineAt,
  })

  const { allocations } = await allocateFromEarliestExpiryGrants(
    transaction, input.organizationId, reservation.id, input.maximumUnits, input.idempotencyKey, now,
  )

  return { reservation, allocations, replayed: false }
}

/**
 * `billing_credit_reservations.idempotencyKey` is set once, at `reserveCredits` time — it identifies
 * that ONE reserve call, not every later extend/settle/release call against the same reservation.
 * Each of those has its own idempotency key, so replay detection for them must check the ledger (via
 * a dedicated marker entry each writes with `sourceIdempotencyKey` set to its own raw key), not the
 * reservation row.
 */
async function replayIfAlreadyProcessed(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<ReservationResult | null> {
  const marker = await findLedgerEntryByIdempotencyKey(transaction, organizationId, idempotencyKey)
  if (!marker || !marker.reservationId) return null
  const reservation = await lockReservation(transaction, organizationId, marker.reservationId)
  if (!reservation) throw new ReservationError('Idempotency key already used by an entry with no matching reservation', 'idempotency_conflict')
  const allocations = await listAllocationsForReservation(transaction, organizationId, reservation.id)
  return { reservation, allocations, replayed: true }
}

export interface ExtendReservationInput {
  organizationId: string
  reservationId: string
  additionalMaximumUnits: number
  idempotencyKey: string
}

/** Adds units to an in-flight reservation's budget and refreshes its heartbeat — the "still alive, need more" signal a long-running operation sends. Refuses to extend a reservation that is no longer `reserved` or has already passed its deadline (an abandoned reservation must be released and re-reserved, never silently resurrected). */
export async function extendReservation(transaction: TenantTransaction, input: ExtendReservationInput, now: Date = new Date()): Promise<ReservationResult> {
  if (!Number.isInteger(input.additionalMaximumUnits) || input.additionalMaximumUnits <= 0) {
    throw new ReservationError('additionalMaximumUnits must be a positive integer', 'invalid_units')
  }

  const replay = await replayIfAlreadyProcessed(transaction, input.organizationId, input.idempotencyKey)
  if (replay) return replay

  const reservation = await lockReservation(transaction, input.organizationId, input.reservationId)
  if (!reservation) throw new ReservationError('Reservation not found', 'reservation_not_found')
  if (reservation.state !== 'reserved') {
    throw new ReservationError(`Reservation is ${reservation.state}, cannot extend`, 'invalid_state')
  }
  if (reservation.deadlineAt.getTime() < now.getTime()) {
    throw new ReservationError('Reservation deadline has already passed — abandoned, cannot extend', 'deadline_passed')
  }

  await allocateFromEarliestExpiryGrants(
    transaction, input.organizationId, reservation.id, input.additionalMaximumUnits, `${input.idempotencyKey}-alloc`, now,
  )
  await insertLedgerEntry(transaction, {
    id: `${input.idempotencyKey}-marker`,
    organizationId: input.organizationId,
    entryType: 'reserve',
    reservationId: reservation.id,
    unitsDelta: 0,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: 'extend marker',
  })

  const updated = await updateReservation(transaction, input.organizationId, reservation.id, {
    maximumUnits: reservation.maximumUnits + input.additionalMaximumUnits,
    heartbeatAt: now,
  })
  const allocations = await listAllocationsForReservation(transaction, input.organizationId, reservation.id)

  return { reservation: updated, allocations, replayed: false }
}

export interface HeartbeatReservationInput {
  organizationId: string
  reservationId: string
}

/** Pure liveness signal — no ledger effect, no idempotency key (safe to call repeatedly; each call just refreshes `heartbeatAt`). Refuses to heartbeat a reservation that is no longer `reserved` or already past its deadline. */
export async function heartbeatReservation(transaction: TenantTransaction, input: HeartbeatReservationInput, now: Date = new Date()): Promise<BillingCreditReservationRecord> {
  const reservation = await lockReservation(transaction, input.organizationId, input.reservationId)
  if (!reservation) throw new ReservationError('Reservation not found', 'reservation_not_found')
  if (reservation.state !== 'reserved') {
    throw new ReservationError(`Reservation is ${reservation.state}, cannot heartbeat`, 'invalid_state')
  }
  if (reservation.deadlineAt.getTime() < now.getTime()) {
    throw new ReservationError('Reservation deadline has already passed — abandoned', 'deadline_passed')
  }
  return updateReservation(transaction, input.organizationId, reservation.id, { heartbeatAt: now })
}

/** For each allocation's unconsumed leftover: returns it to the source grant's spendable balance if the grant hasn't expired yet, or forfeits it (an `expire` ledger entry, no balance change) if it has. */
async function releaseOrExpireLeftover(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
  allocation: BillingCreditAllocationRecord,
  leftoverUnits: number,
  ledgerIdempotencyKeyPrefix: string,
  now: Date,
): Promise<void> {
  if (leftoverUnits <= 0) return
  const grant = await findCreditGrant(transaction, organizationId, allocation.grantId)
  if (!grant) throw new ReservationError('Allocated grant vanished unexpectedly', 'grant_not_found')

  const grantStillValid = grant.expiresAt.getTime() > now.getTime() && grant.state === 'active'
  if (grantStillValid) {
    await updateCreditGrantState(transaction, organizationId, grant.id, {
      state: grant.state,
      remainingUnits: grant.remainingUnits + leftoverUnits,
    })
    await insertLedgerEntry(transaction, {
      id: `${ledgerIdempotencyKeyPrefix}-release-${allocation.grantId}`,
      organizationId, entryType: 'release', grantId: grant.id, reservationId,
      unitsDelta: leftoverUnits, sourceIdempotencyKey: `${ledgerIdempotencyKeyPrefix}-release-${allocation.grantId}`,
    })
  } else {
    // The grant expired (or was otherwise terminated) while this reservation was in flight — the
    // held units are forfeited, not returned; remainingUnits is left as-is (already reduced at
    // reserve time), and this entry exists purely for audit traceability.
    await insertLedgerEntry(transaction, {
      id: `${ledgerIdempotencyKeyPrefix}-expire-${allocation.grantId}`,
      organizationId, entryType: 'expire', grantId: grant.id, reservationId,
      unitsDelta: 0, sourceIdempotencyKey: `${ledgerIdempotencyKeyPrefix}-expire-${allocation.grantId}`,
      reason: 'Source grant expired before reservation leftover was released',
    })
  }
}

export interface SettleReservationInput {
  organizationId: string
  reservationId: string
  actualUnits: number
  idempotencyKey: string
  settlementGraceSeconds: number
}

/** Consumes `actualUnits` from the reservation's own allocations (earliest-expiring grant first, so soon-to-expire credits are spent before longer-lived ones), then releases or expires whatever's left. Refuses `actualUnits > maximumUnits` (over-settlement) and refuses settling a reservation that isn't `reserved`. */
export async function settleReservation(transaction: TenantTransaction, input: SettleReservationInput, now: Date = new Date()): Promise<ReservationResult> {
  if (!Number.isInteger(input.actualUnits) || input.actualUnits < 0) {
    throw new ReservationError('actualUnits must be a non-negative integer', 'invalid_units')
  }

  const replay = await replayIfAlreadyProcessed(transaction, input.organizationId, input.idempotencyKey)
  if (replay) return replay

  const reservation = await lockReservation(transaction, input.organizationId, input.reservationId)
  if (!reservation) throw new ReservationError('Reservation not found', 'reservation_not_found')
  if (reservation.state !== 'reserved') {
    throw new ReservationError(`Reservation is ${reservation.state}, cannot settle`, 'invalid_state')
  }
  if (input.actualUnits > reservation.maximumUnits) {
    throw new ReservationError(`actualUnits (${input.actualUnits}) exceeds reserved maximumUnits (${reservation.maximumUnits})`, 'over_settlement')
  }

  const allocations = await listAllocationsForReservation(transaction, input.organizationId, reservation.id)
  let remainingToConsume = input.actualUnits
  const finalAllocations: BillingCreditAllocationRecord[] = []

  for (const allocation of allocations) {
    const consumeFromThis = Math.min(allocation.allocatedUnits, remainingToConsume)
    if (consumeFromThis > 0) {
      await insertLedgerEntry(transaction, {
        id: `${input.idempotencyKey}-consume-${allocation.grantId}`,
        organizationId: input.organizationId, entryType: 'consume', grantId: allocation.grantId, reservationId: reservation.id,
        unitsDelta: 0, // Already removed from remainingUnits at reserve time — consumption just marks it permanent, no further balance change.
        sourceIdempotencyKey: `${input.idempotencyKey}-consume-${allocation.grantId}`,
      })
    }
    const updated = await updateAllocationConsumed(transaction, input.organizationId, allocation.id, consumeFromThis)
    finalAllocations.push(updated)
    remainingToConsume -= consumeFromThis

    const leftover = allocation.allocatedUnits - consumeFromThis
    await releaseOrExpireLeftover(transaction, input.organizationId, reservation.id, allocation, leftover, input.idempotencyKey, now)
  }

  await insertLedgerEntry(transaction, {
    id: `${input.idempotencyKey}-marker`,
    organizationId: input.organizationId,
    entryType: 'consume',
    reservationId: reservation.id,
    unitsDelta: 0,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: 'settle marker',
  })

  // The rate card owns the grace window, the same way it owns `maxUnits` and `maxDurationSeconds`:
  // a caller must not be able to widen it. `input.settlementGraceSeconds` is the fallback for
  // operations that have no card (internal `ai_task` work), not an override for ones that do —
  // until now every card's value was ignored and every settlement used whatever the caller passed.
  const card = getRateCard(reservation.operation)
  const graceSeconds = card?.settlementGraceSeconds ?? input.settlementGraceSeconds

  const updatedReservation = await updateReservation(transaction, input.organizationId, reservation.id, {
    state: 'settled',
    settledUnits: input.actualUnits,
    settlementGraceEndsAt: new Date(now.getTime() + graceSeconds * 1000),
  })

  return { reservation: updatedReservation, allocations: finalAllocations, replayed: false }
}

export interface ReleaseReservationInput {
  organizationId: string
  reservationId: string
  idempotencyKey: string
  reason?: string
}

/** Releases every allocated unit back (or expires it, per the same grant-expiry rule as settlement) with nothing consumed — the operation never ran, or failed before starting. */
export async function releaseReservation(transaction: TenantTransaction, input: ReleaseReservationInput, now: Date = new Date()): Promise<ReservationResult> {
  const replay = await replayIfAlreadyProcessed(transaction, input.organizationId, input.idempotencyKey)
  if (replay) return replay

  const reservation = await lockReservation(transaction, input.organizationId, input.reservationId)
  if (!reservation) throw new ReservationError('Reservation not found', 'reservation_not_found')
  if (reservation.state !== 'reserved') {
    throw new ReservationError(`Reservation is ${reservation.state}, cannot release`, 'invalid_state')
  }

  const allocations = await listAllocationsForReservation(transaction, input.organizationId, reservation.id)
  for (const allocation of allocations) {
    await releaseOrExpireLeftover(transaction, input.organizationId, reservation.id, allocation, allocation.allocatedUnits, input.idempotencyKey, now)
  }

  await insertLedgerEntry(transaction, {
    id: `${input.idempotencyKey}-marker`,
    organizationId: input.organizationId,
    entryType: 'release',
    reservationId: reservation.id,
    unitsDelta: 0,
    sourceIdempotencyKey: input.idempotencyKey,
    reason: input.reason ?? 'release marker',
  })

  const updatedReservation = await updateReservation(transaction, input.organizationId, reservation.id, {
    state: 'released',
    settledUnits: 0,
  })

  return { reservation: updatedReservation, allocations, replayed: false }
}
