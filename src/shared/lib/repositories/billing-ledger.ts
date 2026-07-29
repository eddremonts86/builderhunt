import { and, asc, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingCreditAllocations, billingCreditGrants, billingCreditReservations, billingLedgerEntries } from '../db/schema'

/**
 * Raw, tenant-scoped data access for the append-only credit ledger
 * (billing_credit_grants + billing_ledger_entries). This file only inserts
 * and reads rows — every invariant (non-negative balance, idempotency,
 * compensating-entries-only) is enforced one layer up in
 * `~/shared/lib/billing/credits.ts`, which is the only caller this
 * repository should have. Same `TenantTransaction`-first, defense-in-depth
 * `organizationId`-filtered convention as `repositories/billing.ts`.
 */

export interface BillingCreditGrantRecord {
  id: string
  organizationId: string
  source: string
  sourceReference: string | null
  stripePaymentReference: string | null
  stripePaymentIntentId: string | null
  monthlyWindowKey: string | null
  originalUnits: number
  remainingUnits: number
  state: string
  activeAt: Date
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface InsertCreditGrantInput {
  id: string
  organizationId: string
  source: string
  sourceReference?: string
  stripePaymentReference?: string
  stripePaymentIntentId?: string
  monthlyWindowKey?: string
  originalUnits: number
  remainingUnits: number
  expiresAt: Date
}

export async function insertCreditGrant(
  transaction: TenantTransaction,
  input: InsertCreditGrantInput,
): Promise<BillingCreditGrantRecord> {
  const [row] = await transaction.insert(billingCreditGrants).values(input).returning()
  return row
}

export async function findCreditGrant(
  transaction: TenantTransaction,
  organizationId: string,
  grantId: string,
): Promise<BillingCreditGrantRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.id, grantId)))
    .limit(1)
  return row ?? null
}

/** The pack grant a disputed PaymentIntent paid for (§8 task 5) — the same column §8 task 4's refunds use, read the other direction. */
export async function findCreditGrantByStripePaymentIntentId(
  transaction: TenantTransaction,
  organizationId: string,
  stripePaymentIntentId: string,
): Promise<BillingCreditGrantRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.stripePaymentIntentId, stripePaymentIntentId)))
    .limit(1)
  return row ?? null
}

/** Every eligible-to-consume grant, earliest expiry first — the order every consumption/reservation path must follow (spec.md: earliest-expiring grants are used first). */
export async function listActiveCreditGrantsByEarliestExpiry(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.state, 'active')))
    .orderBy(asc(billingCreditGrants.expiresAt))
}

/**
 * Same as `listActiveCreditGrantsByEarliestExpiry` but takes `SELECT ... FOR UPDATE` row locks —
 * every reservation/extension allocation walk must use this, never the unlocked list, so two
 * concurrent reservations against the same organization can't both read the same pre-allocation
 * `remainingUnits` and overspend it.
 */
export async function lockActiveCreditGrantsByEarliestExpiry(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.state, 'active')))
    .orderBy(asc(billingCreditGrants.expiresAt))
    .for('update')
}

/** The only mutation path onto a grant row — state and remainingUnits are always changed together, from `credits.ts`, never independently. */
export async function updateCreditGrantState(
  transaction: TenantTransaction,
  organizationId: string,
  grantId: string,
  update: { state: string; remainingUnits: number },
): Promise<BillingCreditGrantRecord> {
  const [row] = await transaction
    .update(billingCreditGrants)
    .set({ state: update.state, remainingUnits: update.remainingUnits, updatedAt: new Date() })
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.id, grantId)))
    .returning()
  return row
}

export interface BillingLedgerEntryRecord {
  id: string
  organizationId: string
  entryType: string
  grantId: string | null
  reservationId: string | null
  unitsDelta: number
  sourceIdempotencyKey: string
  reason: string | null
  createdAt: Date
}

export interface InsertLedgerEntryInput {
  id: string
  organizationId: string
  entryType: 'grant' | 'reserve' | 'release' | 'consume' | 'expire' | 'freeze' | 'unfreeze' | 'revoke' | 'adjust'
  grantId?: string
  reservationId?: string
  unitsDelta: number
  sourceIdempotencyKey: string
  reason?: string
}

/** Append-only — there is no update/delete function for this table, matching billing_ledger_entries having no updatedAt column and no role ever receiving an UPDATE grant on it. */
export async function insertLedgerEntry(
  transaction: TenantTransaction,
  input: InsertLedgerEntryInput,
): Promise<BillingLedgerEntryRecord> {
  const [row] = await transaction.insert(billingLedgerEntries).values(input).returning()
  return row
}

/** The idempotency check every `credits.ts` operation runs first: if a ledger entry already exists for this exact idempotency key, the operation already happened — replay its recorded result instead of repeating the mutation. */
export async function findLedgerEntryByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  sourceIdempotencyKey: string,
): Promise<BillingLedgerEntryRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingLedgerEntries)
    .where(and(
      eq(billingLedgerEntries.organizationId, organizationId),
      eq(billingLedgerEntries.sourceIdempotencyKey, sourceIdempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

export async function findCreditGrantByMonthlyWindowKey(
  transaction: TenantTransaction,
  organizationId: string,
  monthlyWindowKey: string,
): Promise<BillingCreditGrantRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditGrants)
    .where(and(
      eq(billingCreditGrants.organizationId, organizationId),
      eq(billingCreditGrants.monthlyWindowKey, monthlyWindowKey),
    ))
    .limit(1)
  return row ?? null
}

/** Every grant of one `source` created since `since`, regardless of state — the shared pack/auto-recharge rolling risk-limit check (spec.md: "at most three successful charges or $1,000 in 24 hours") counts successful purchases, not just currently-active ones, so a since-consumed or since-expired grant still counts against the window it was created in. */
export async function listRecentGrantsBySource(
  transaction: TenantTransaction,
  organizationId: string,
  source: string,
  since: Date,
): Promise<BillingCreditGrantRecord[]> {
  const rows = await transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.source, source)))
  return rows.filter((row) => row.createdAt.getTime() >= since.getTime())
}

/** Grant `source` values that represent an actual payment, distinct from promotional/manual/trial grants — used by `abuse/credit-abuse.ts`'s first-payer spend-velocity cap (G6) to define "when did this organization first pay us". */
const PAID_GRANT_SOURCES: ReadonlySet<string> = new Set(['pack', 'subscription_monthly', 'subscription_annual_window', 'subscription_upgrade_delta'])

/** The organization's earliest paid-source grant, or `null` if it has never paid — the "new payer" clock for the G6 first-payer cap starts here, not at organization/customer creation (a long-dormant free org that just made its first purchase is a new payer today). */
export async function findEarliestPaidGrantCreatedAt(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Date | null> {
  const rows = await transaction
    .select({ source: billingCreditGrants.source, createdAt: billingCreditGrants.createdAt })
    .from(billingCreditGrants)
    .where(eq(billingCreditGrants.organizationId, organizationId))
  const paidTimestamps = rows.filter((row) => PAID_GRANT_SOURCES.has(row.source)).map((row) => row.createdAt.getTime())
  return paidTimestamps.length > 0 ? new Date(Math.min(...paidTimestamps)) : null
}

/** Units actually reserved (removed from a grant's balance) since `since` — the `reserve` ledger entry carries `unitsDelta: -take` at the moment credits leave the pool (see `billing/reservations.ts`), unlike `consume`/`release` markers which record `0`. Counts every reservation attempt in the window regardless of whether it was later settled or released, since the point is capping how much a possibly-fraudulent new payment method can spend before it's caught, not netting out refunds. */
export async function sumReservedUnitsSince(
  transaction: TenantTransaction,
  organizationId: string,
  since: Date,
): Promise<number> {
  const rows = await transaction
    .select({ unitsDelta: billingLedgerEntries.unitsDelta, createdAt: billingLedgerEntries.createdAt })
    .from(billingLedgerEntries)
    .where(and(eq(billingLedgerEntries.organizationId, organizationId), eq(billingLedgerEntries.entryType, 'reserve')))
  return rows
    .filter((row) => row.unitsDelta < 0 && row.createdAt.getTime() >= since.getTime())
    .reduce((sum, row) => sum - row.unitsDelta, 0)
}

/** Grants still marked `active` whose `expiresAt` has already passed — the daily worker's expiry sweep target (a later task builds the actual worker; this is the read it will use). */
export async function listExpiredButStillActiveGrants(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
): Promise<BillingCreditGrantRecord[]> {
  const rows = await transaction
    .select()
    .from(billingCreditGrants)
    .where(and(eq(billingCreditGrants.organizationId, organizationId), eq(billingCreditGrants.state, 'active')))
  return rows.filter((row) => row.expiresAt.getTime() <= now.getTime())
}

// ---------------------------------------------------------------------------
// Reservations and allocations (plans/phase-1/30-stripe-billing-platform/tasks.md §4
// "Implement atomic reservation lifecycle") — business logic and invariants
// live in `~/shared/lib/billing/reservations.ts`, this file only reads/writes.
// ---------------------------------------------------------------------------

export interface BillingCreditReservationRecord {
  id: string
  organizationId: string
  operation: string
  rateCardVersion: number
  idempotencyKey: string
  maximumUnits: number
  settledUnits: number | null
  state: string
  heartbeatAt: Date
  deadlineAt: Date
  settlementGraceEndsAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface InsertReservationInput {
  id: string
  organizationId: string
  operation: string
  rateCardVersion: number
  idempotencyKey: string
  maximumUnits: number
  deadlineAt: Date
}

export async function insertReservation(
  transaction: TenantTransaction,
  input: InsertReservationInput,
): Promise<BillingCreditReservationRecord> {
  const [row] = await transaction
    .insert(billingCreditReservations)
    .values({ ...input, heartbeatAt: new Date() })
    .returning()
  return row
}

export async function findReservationByIdempotencyKey(
  transaction: TenantTransaction,
  organizationId: string,
  idempotencyKey: string,
): Promise<BillingCreditReservationRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditReservations)
    .where(and(
      eq(billingCreditReservations.organizationId, organizationId),
      eq(billingCreditReservations.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

/** Row-locked fetch — every mutation of a reservation (extend/heartbeat/settle/release) must lock it first so two concurrent calls can't both act on a stale read of its state. */
export async function lockReservation(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
): Promise<BillingCreditReservationRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditReservations)
    .where(and(eq(billingCreditReservations.organizationId, organizationId), eq(billingCreditReservations.id, reservationId)))
    .for('update')
    .limit(1)
  return row ?? null
}

export interface UpdateReservationInput {
  maximumUnits?: number
  settledUnits?: number | null
  state?: string
  heartbeatAt?: Date
  deadlineAt?: Date
  settlementGraceEndsAt?: Date | null
}

export async function updateReservation(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
  update: UpdateReservationInput,
): Promise<BillingCreditReservationRecord> {
  const [row] = await transaction
    .update(billingCreditReservations)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(billingCreditReservations.organizationId, organizationId), eq(billingCreditReservations.id, reservationId)))
    .returning()
  return row
}

export interface BillingCreditAllocationRecord {
  id: string
  organizationId: string
  reservationId: string
  grantId: string
  allocatedUnits: number
  consumedUnits: number
  createdAt: Date
  updatedAt: Date
}

export interface InsertAllocationInput {
  id: string
  organizationId: string
  reservationId: string
  grantId: string
  allocatedUnits: number
}

export async function insertAllocation(
  transaction: TenantTransaction,
  input: InsertAllocationInput,
): Promise<BillingCreditAllocationRecord> {
  const [row] = await transaction.insert(billingCreditAllocations).values(input).returning()
  return row
}

/** A reservation can only have one allocation row per grant (`billing_credit_allocations_reservation_grant_unique`) — `extendReservation` widening an existing allocation must go through this, never a second `insertAllocation` for the same (reservationId, grantId) pair. */
export async function findAllocationForReservationAndGrant(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
  grantId: string,
): Promise<BillingCreditAllocationRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingCreditAllocations)
    .where(and(
      eq(billingCreditAllocations.organizationId, organizationId),
      eq(billingCreditAllocations.reservationId, reservationId),
      eq(billingCreditAllocations.grantId, grantId),
    ))
    .limit(1)
  return row ?? null
}

export async function updateAllocationAllocated(
  transaction: TenantTransaction,
  organizationId: string,
  allocationId: string,
  allocatedUnits: number,
): Promise<BillingCreditAllocationRecord> {
  const [row] = await transaction
    .update(billingCreditAllocations)
    .set({ allocatedUnits, updatedAt: new Date() })
    .where(and(eq(billingCreditAllocations.organizationId, organizationId), eq(billingCreditAllocations.id, allocationId)))
    .returning()
  return row
}

export async function listAllocationsForReservation(
  transaction: TenantTransaction,
  organizationId: string,
  reservationId: string,
): Promise<BillingCreditAllocationRecord[]> {
  return transaction
    .select()
    .from(billingCreditAllocations)
    .where(and(
      eq(billingCreditAllocations.organizationId, organizationId),
      eq(billingCreditAllocations.reservationId, reservationId),
    ))
}

export async function updateAllocationConsumed(
  transaction: TenantTransaction,
  organizationId: string,
  allocationId: string,
  consumedUnits: number,
): Promise<BillingCreditAllocationRecord> {
  const [row] = await transaction
    .update(billingCreditAllocations)
    .set({ consumedUnits, updatedAt: new Date() })
    .where(and(eq(billingCreditAllocations.organizationId, organizationId), eq(billingCreditAllocations.id, allocationId)))
    .returning()
  return row
}

/**
 * Units refunded via `feature-authorization.ts`'s `refundUsage` since `since` — the G4
 * refund-farming cap/ratio. `refundUsage`'s own trailing marker entry is the only 'adjust' entry
 * that ever sets `reservationId` (the per-allocation compensating entries it also writes go through
 * `adjustCreditGrant`, whose `AdjustCreditGrantInput` has no `reservationId` field at all — same for
 * `billing/refunds.ts`'s unrelated pack-refund grant revocations), so filtering on
 * `reservationId IS NOT NULL` uniquely identifies a completed usage refund without double-counting
 * the per-allocation entries or catching an unrelated money-refund's credit revocation.
 */
export async function sumRefundedUnitsSince(
  transaction: TenantTransaction,
  organizationId: string,
  since: Date,
): Promise<number> {
  const rows = await transaction
    .select({ unitsDelta: billingLedgerEntries.unitsDelta, reservationId: billingLedgerEntries.reservationId, createdAt: billingLedgerEntries.createdAt })
    .from(billingLedgerEntries)
    .where(and(eq(billingLedgerEntries.organizationId, organizationId), eq(billingLedgerEntries.entryType, 'adjust')))
  return rows
    .filter((row) => row.reservationId !== null && row.unitsDelta > 0 && row.createdAt.getTime() >= since.getTime())
    .reduce((sum, row) => sum + row.unitsDelta, 0)
}

/** Units actually settled (permanently consumed) since `since` — the denominator for the G4 refund-to-settle ratio. Only a `settled` reservation can ever be refunded, so this is the correct base to compare refunded units against. */
export async function sumSettledUnitsSince(
  transaction: TenantTransaction,
  organizationId: string,
  since: Date,
): Promise<number> {
  const rows = await transaction
    .select({ settledUnits: billingCreditReservations.settledUnits, state: billingCreditReservations.state, updatedAt: billingCreditReservations.updatedAt })
    .from(billingCreditReservations)
    .where(eq(billingCreditReservations.organizationId, organizationId))
  return rows
    .filter((row) => row.state === 'settled' && row.settledUnits !== null && row.updatedAt.getTime() >= since.getTime())
    .reduce((sum, row) => sum + (row.settledUnits ?? 0), 0)
}
