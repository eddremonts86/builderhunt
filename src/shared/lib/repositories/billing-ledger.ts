import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
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

/**
 * How many rows the bounded grant reads return.
 *
 * `CREDIT_GRANT_BATCH` is a *batch* size, not a page: every caller that uses it drains its query in
 * a loop, because a grant left unexpired or unallocated is money the ledger is wrong about. It is
 * large enough that the loop almost always runs once and small enough that one iteration is a
 * bounded amount of memory.
 *
 * `GRANT_VELOCITY_WINDOW_LIMIT` is different, and smaller on purpose: its caller counts grants
 * inside a short abuse window to decide whether an organization is buying too fast. Any window with
 * more than this many purchases is already far past every threshold that read exists to compare
 * against, so the exact number stops mattering before the bound bites.
 */
const CREDIT_GRANT_BATCH = 500
const GRANT_VELOCITY_WINDOW_LIMIT = 100

/** Where a grant batch resumes: the last row's place in the total order `(expires_at, id)`. */
export interface CreditGrantCursor {
  expiresAt: Date
  id: string
}

export interface ActiveCreditGrantBatch {
  /** Drop grants whose expiry has already passed. Applied in SQL, not by the caller. */
  notExpiredAt?: Date
  /** Resume after this grant. Absent means the first batch. */
  after?: CreditGrantCursor | null
  /** Defaults to `CREDIT_GRANT_BATCH`. */
  limit?: number
  /**
   * The beta window whose promotional grant may be spent right now, or null (plan 58).
   *
   * **Absent means excluded**, and that default is deliberate. A caller that has not been taught about
   * beta mode must not spend promotional beta units: a new consumer that forgets this field should
   * under-count a balance, never over-spend one. The other default's failure mode is a customer
   * spending an allowance an operator has already switched off.
   */
  activeBetaSourceReference?: string | null
}

/**
 * The predicate and the order shared by the locked and unlocked grant walks.
 *
 * `id` trails `expires_at` because two grants can expire in the same instant — a pack and a
 * subscription window bought together do — and a batch boundary inside that tie would hand the same
 * grant out twice or skip it. That is money, not a display glitch.
 */
function activeGrantConditions(organizationId: string, options: ActiveCreditGrantBatch) {
  const conditions = [
    eq(billingCreditGrants.organizationId, organizationId),
    eq(billingCreditGrants.state, 'active'),
  ]
  if (options.notExpiredAt) conditions.push(gt(billingCreditGrants.expiresAt, options.notExpiredAt))
  if (options.after) {
    conditions.push(sql`(${billingCreditGrants.expiresAt}, ${billingCreditGrants.id}) > (${options.after.expiresAt}, ${options.after.id})`)
  }

  /**
   * The one beta-grant predicate, in the one place every consumer already routes through (plan 58).
   *
   * `lockActiveCreditGrantsByEarliestExpiry`, `listActiveCreditGrantsByEarliestExpiry` and
   * `drainActiveCreditGrants` all build their WHERE here — so reservation, spendable balance, the
   * active-grant projection and auto-recharge share this by construction rather than by four callers
   * remembering to pass the same flag. A fifth consumer added later inherits it instead of being the
   * one that forgot.
   *
   * Three behaviours fall out of this single clause:
   *   - **disable is immediate** — the reference goes null and the grant stops matching, with no row
   *     mutated and no ledger history lost;
   *   - **a new month retires the old grant** before the expiry worker has run;
   *   - **re-enabling in the same month restores the unused remainder**, because nothing was clawed back.
   *
   * `coalesce` is load-bearing, not defensive. `source_reference` is nullable, and `NULL LIKE
   * 'beta-mode:%'` is NULL — so `not (source = 'promotional' and NULL)` is NULL rather than true, and a
   * grant with no reference would be silently **dropped from every balance**. Verified against Postgres
   * directly: `select (not ('promotional' = 'promotional' and null like 'beta-mode:%')) is null` → `t`.
   * There are no such rows in development today, which is precisely why this would have shipped unseen
   * and taken somebody's `legacy_manual` balance with it.
   */
  const isBetaGrant = sql`(${billingCreditGrants.source} = 'promotional'
    and coalesce(${billingCreditGrants.sourceReference}, '') like 'beta-mode:%')`
  const activeBeta = options.activeBetaSourceReference ?? null
  conditions.push(
    activeBeta === null
      ? sql`not ${isBetaGrant}`
      : sql`(not ${isBetaGrant} or ${billingCreditGrants.sourceReference} = ${activeBeta})`,
  )

  return conditions
}

/**
 * One batch of eligible-to-consume grants, earliest expiry first — the order every
 * consumption/reservation path must follow (spec.md: earliest-expiring grants are used first).
 *
 * Bounded since plan 12, and a **batch** rather than a page: a caller that stops early because it
 * has enough units is done, and a caller that needs every grant drains the loop. What neither may
 * do is take the first batch and treat it as the whole set — `drainActiveCreditGrants` below is the
 * shape that cannot get that wrong.
 */
export async function listActiveCreditGrantsByEarliestExpiry(
  transaction: TenantTransaction,
  organizationId: string,
  options: ActiveCreditGrantBatch = {},
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(...activeGrantConditions(organizationId, options)))
    .orderBy(asc(billingCreditGrants.expiresAt), asc(billingCreditGrants.id))
    .limit(options.limit ?? CREDIT_GRANT_BATCH)
}

/**
 * Same as `listActiveCreditGrantsByEarliestExpiry` but takes `SELECT ... FOR UPDATE` row locks —
 * every reservation/extension allocation walk must use this, never the unlocked list, so two
 * concurrent reservations against the same organization can't both read the same pre-allocation
 * `remainingUnits` and overspend it.
 *
 * The lock is per batch and the transaction outlives every batch, so a walk that fetches three
 * batches holds all three batches' locks until it commits — which is the behaviour the unbounded
 * version had, minus reading every grant into memory first.
 */
export async function lockActiveCreditGrantsByEarliestExpiry(
  transaction: TenantTransaction,
  organizationId: string,
  options: ActiveCreditGrantBatch = {},
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(...activeGrantConditions(organizationId, options)))
    .orderBy(asc(billingCreditGrants.expiresAt), asc(billingCreditGrants.id))
    .limit(options.limit ?? CREDIT_GRANT_BATCH)
    .for('update')
}

/**
 * Spendable units, added up in Postgres.
 *
 * The balance is read on every metered call. Computing it by fetching each unexpired grant and
 * reducing in JavaScript meant the busiest read in billing grew with the number of grants an
 * account had ever been given — and the number it produced was one integer.
 */
export async function sumAvailableCreditUnits(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
): Promise<number> {
  const [row] = await transaction
    .select({ value: sql<number>`coalesce(sum(${billingCreditGrants.remainingUnits}), 0)::int` })
    .from(billingCreditGrants)
    .where(and(...activeGrantConditions(organizationId, { notExpiredAt: now })))
  return row?.value ?? 0
}

/** The cursor for a batch's last row, or null when the batch was short and the walk is over. */
export function nextCreditGrantCursor(
  batch: readonly BillingCreditGrantRecord[],
  limit = CREDIT_GRANT_BATCH,
): CreditGrantCursor | null {
  if (batch.length < limit) return null
  const last = batch[batch.length - 1]
  return { expiresAt: last.expiresAt, id: last.id }
}

/**
 * Every eligible grant, one batch at a time, stopping when `consume` says it has enough.
 *
 * The loop lives here rather than at each call site because "take the first batch and call it the
 * set" is the one way this change does damage, and there are two callers. `consume` returning
 * `false` ends the walk; returning `true` asks for the next batch.
 */
export async function drainActiveCreditGrants(
  transaction: TenantTransaction,
  organizationId: string,
  options: Omit<ActiveCreditGrantBatch, 'after'> & { locked?: boolean },
  consume: (batch: BillingCreditGrantRecord[]) => Promise<boolean> | boolean,
): Promise<void> {
  const limit = options.limit ?? CREDIT_GRANT_BATCH
  const read = options.locked ? lockActiveCreditGrantsByEarliestExpiry : listActiveCreditGrantsByEarliestExpiry
  let after: CreditGrantCursor | null = null
  for (;;) {
    const batch = await read(transaction, organizationId, { ...options, after, limit })
    if (batch.length === 0) return
    if (!(await consume(batch))) return
    after = nextCreditGrantCursor(batch, limit)
    if (!after) return
  }
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
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(
      eq(billingCreditGrants.organizationId, organizationId),
      eq(billingCreditGrants.source, source),
      // Was a JS filter over every grant this organization ever received from this source.
      gte(billingCreditGrants.createdAt, since),
    ))
    .orderBy(desc(billingCreditGrants.createdAt))
    .limit(GRANT_VELOCITY_WINDOW_LIMIT)
}

/** Grant `source` values that represent an actual payment, distinct from promotional/manual/trial grants — used by `abuse/credit-abuse.ts`'s first-payer spend-velocity cap (G6) to define "when did this organization first pay us". */
const PAID_GRANT_SOURCES: ReadonlySet<string> = new Set(['pack', 'subscription_monthly', 'subscription_annual_window', 'subscription_upgrade_delta'])

/** The organization's earliest paid-source grant, or `null` if it has never paid — the "new payer" clock for the G6 first-payer cap starts here, not at organization/customer creation (a long-dormant free org that just made its first purchase is a new payer today). */
export async function findEarliestPaidGrantCreatedAt(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Date | null> {
  // `min()` in SQL over the paid sources, rather than every grant the organization has ever
  // received followed by `Math.min` over the survivors. `PAID_GRANT_SOURCES` is a set in code, so
  // it reaches the query as an `inArray` — the source of truth stays where it is documented.
  const [row] = await transaction
    .select({ earliest: sql<Date | null>`min(${billingCreditGrants.createdAt})` })
    .from(billingCreditGrants)
    .where(and(
      eq(billingCreditGrants.organizationId, organizationId),
      inArray(billingCreditGrants.source, [...PAID_GRANT_SOURCES]),
    ))
  return row?.earliest ? new Date(row.earliest) : null
}

/** Units actually reserved (removed from a grant's balance) since `since` — the `reserve` ledger entry carries `unitsDelta: -take` at the moment credits leave the pool (see `billing/reservations.ts`), unlike `consume`/`release` markers which record `0`. Counts every reservation attempt in the window regardless of whether it was later settled or released, since the point is capping how much a possibly-fraudulent new payment method can spend before it's caught, not netting out refunds. */
export async function sumReservedUnitsSince(
  transaction: TenantTransaction,
  organizationId: string,
  since: Date,
): Promise<number> {
  // Summed in SQL, and the window is a predicate rather than a JS filter (plan 12).
  //
  // This read used to fetch **every** `reserve` entry the organization has ever written and then
  // drop the ones outside the window in JavaScript. The number it returns caps how much a possibly
  // fraudulent new payment method can spend, so it runs on the reservation path — the busiest one
  // in billing — and the row count it moved grew with the account's whole history while the
  // predicate that bounds it sat one step too late.
  const [row] = await transaction
    .select({ value: sql<number>`coalesce(sum(-${billingLedgerEntries.unitsDelta}), 0)::int` })
    .from(billingLedgerEntries)
    .where(and(
      eq(billingLedgerEntries.organizationId, organizationId),
      eq(billingLedgerEntries.entryType, 'reserve'),
      lt(billingLedgerEntries.unitsDelta, 0),
      gte(billingLedgerEntries.createdAt, since),
    ))
  return row?.value ?? 0
}

/** Grants still marked `active` whose `expiresAt` has already passed — the daily worker's expiry sweep target (a later task builds the actual worker; this is the read it will use). */
export async function listExpiredButStillActiveGrants(
  transaction: TenantTransaction,
  organizationId: string,
  now: Date,
): Promise<BillingCreditGrantRecord[]> {
  return transaction
    .select()
    .from(billingCreditGrants)
    .where(and(
      eq(billingCreditGrants.organizationId, organizationId),
      eq(billingCreditGrants.state, 'active'),
      // Was a JS filter applied after reading every active grant.
      lte(billingCreditGrants.expiresAt, now),
    ))
    .orderBy(asc(billingCreditGrants.expiresAt), asc(billingCreditGrants.id))
    .limit(CREDIT_GRANT_BATCH)
}

// ---------------------------------------------------------------------------
// Reservations and allocations (plans/implemented/30-stripe-billing-platform/tasks.md §4
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
    // One allocation per grant this reservation drew on, and the walk that creates them stops as soon
    // as it has enough units — so the real ceiling is how many grants it took to cover one
    // reservation. `CREDIT_GRANT_BATCH` is that walk's own batch size, which is the same bound.
    .orderBy(asc(billingCreditAllocations.id))
    .limit(CREDIT_GRANT_BATCH)
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
  // Every predicate the JS filter applied, in the WHERE clause. Same reasoning as
  // `sumReservedUnitsSince`: the old form read every `adjust` entry in the account's history.
  const [row] = await transaction
    .select({ value: sql<number>`coalesce(sum(${billingLedgerEntries.unitsDelta}), 0)::int` })
    .from(billingLedgerEntries)
    .where(and(
      eq(billingLedgerEntries.organizationId, organizationId),
      eq(billingLedgerEntries.entryType, 'adjust'),
      isNotNull(billingLedgerEntries.reservationId),
      gt(billingLedgerEntries.unitsDelta, 0),
      gte(billingLedgerEntries.createdAt, since),
    ))
  return row?.value ?? 0
}

/** Units actually settled (permanently consumed) since `since` — the denominator for the G4 refund-to-settle ratio. Only a `settled` reservation can ever be refunded, so this is the correct base to compare refunded units against. */
export async function sumSettledUnitsSince(
  transaction: TenantTransaction,
  organizationId: string,
  since: Date,
): Promise<number> {
  // `coalesce` covers both "no matching rows" and a matching row with a null `settledUnits`, which
  // is what the JS `?? 0` did. Read every reservation the organization ever made, before plan 12.
  const [row] = await transaction
    .select({ value: sql<number>`coalesce(sum(${billingCreditReservations.settledUnits}), 0)::int` })
    .from(billingCreditReservations)
    .where(and(
      eq(billingCreditReservations.organizationId, organizationId),
      eq(billingCreditReservations.state, 'settled'),
      isNotNull(billingCreditReservations.settledUnits),
      gte(billingCreditReservations.updatedAt, since),
    ))
  return row?.value ?? 0
}
