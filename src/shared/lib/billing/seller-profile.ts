import { desc } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { z } from 'zod'
import { platformDb } from '../db/client'
import { billingSellerProfiles } from '../db/schema'
import { USER_SCOPED_LIMIT } from '../db/read-bounds'

/**
 * Platform-admin-only seller/country/tax configuration (spec.md §Seller,
 * country, currency, and tax configuration; plans/phase-1/30-stripe-billing-platform/
 * tasks.md §3 "Build private seller and country configuration"). Versioned,
 * insert-only history over `billing_seller_profiles` — no `organization_id`,
 * no RLS, `builderhunt_platform` gets SELECT+INSERT only (never UPDATE; see
 * drizzle/0028_billing_rls_grants.sql) so a historical version is never
 * mutated, only superseded by a newer one. Uses `platformDb` directly (not a
 * `TenantTransaction`) — same convention as `platform-billing.ts` for
 * platform-scoped, non-tenant tables.
 *
 * CPR and bank/card fields are excluded by schema, not by convention: neither
 * the table nor `SellerProfileInputSchema` below has a column/field for them
 * at all, and the schema is `.strict()` so a caller that includes one anyway
 * (a stray `cpr`/`cardNumber`/`bankAccountNumber` key) is rejected outright
 * rather than silently dropped — a compliance-sensitive form should fail
 * loudly on an unexpected field, not quietly discard it.
 */

export const TaxRegistrationSchema = z.object({
  country: z.string().min(1),
  registrationId: z.string().min(1),
  effectiveAt: z.string(),
}).strict()

export const SellerProfileInputSchema = z.object({
  legalName: z.string().min(1),
  publicBusinessAddress: z.string().min(1),
  establishmentCountry: z.string().min(1),
  approvedTaxIds: z.array(z.string().min(1)).default([]),
  supportEmail: z.string().email(),
  statementDescriptor: z.string().min(1).max(22),
  countryAllowlist: z.array(z.string().min(1)).default([]),
  taxRegistrations: z.array(TaxRegistrationSchema).default([]),
  effectiveAt: z.string(),
}).strict()

export type SellerProfileInput = z.infer<typeof SellerProfileInputSchema>

export interface SellerProfileRecord {
  id: string
  version: number
  legalName: string
  publicBusinessAddress: string
  establishmentCountry: string
  approvedTaxIds: string[]
  supportEmail: string
  statementDescriptor: string
  countryAllowlist: string[]
  taxRegistrations: Array<{ country: string; registrationId: string; effectiveAt: string }>
  effectiveAt: Date
  createdByUserId: string
  createdAt: Date
}

/**
 * `db` defaults to the real `platformDb` singleton in production; tests inject a `PostgresJsDatabase`
 * bound to a disposable database instead, the same dependency-injection pattern used throughout this
 * codebase (`resolveStripeClientConfig`, `withTenantContext`) rather than mutating environment
 * variables to redirect a module-level singleton.
 */

/** The highest-`version` row, i.e. the currently effective seller configuration — null before any version has ever been recorded. */
export async function getCurrentSellerProfile(db: PostgresJsDatabase = platformDb): Promise<SellerProfileRecord | null> {
  const [row] = await db
    .select()
    .from(billingSellerProfiles)
    .orderBy(desc(billingSellerProfiles.version))
    .limit(1)
  return row ?? null
}

/** Every recorded version, most recent first — "historical invoices keep the seller snapshot effective when they were issued" (spec.md) depends on every prior version staying readable forever, never deleted or overwritten. */
export async function listSellerProfileHistory(db: PostgresJsDatabase = platformDb): Promise<SellerProfileRecord[]> {
  // Versions of the one seller profile — a monotonic counter bumped by an operator, never in bulk.
  return db.select().from(billingSellerProfiles).orderBy(desc(billingSellerProfiles.version))
    .limit(USER_SCOPED_LIMIT)
}

/** Inserts the next version (current max + 1, or 1 if none exists yet) — never updates a prior row. */
export async function createSellerProfileVersion(
  input: SellerProfileInput,
  createdByUserId: string,
  db: PostgresJsDatabase = platformDb,
): Promise<SellerProfileRecord> {
  const current = await getCurrentSellerProfile(db)
  const nextVersion = (current?.version ?? 0) + 1

  const [row] = await db
    .insert(billingSellerProfiles)
    .values({
      version: nextVersion,
      legalName: input.legalName,
      publicBusinessAddress: input.publicBusinessAddress,
      establishmentCountry: input.establishmentCountry,
      approvedTaxIds: input.approvedTaxIds,
      supportEmail: input.supportEmail,
      statementDescriptor: input.statementDescriptor,
      countryAllowlist: input.countryAllowlist,
      taxRegistrations: input.taxRegistrations,
      effectiveAt: new Date(input.effectiveAt),
      createdByUserId,
    })
    .returning()
  return row
}
