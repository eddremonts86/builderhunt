import { and, asc, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingCreditGrants, billingLedgerEntries } from '../db/schema'

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
