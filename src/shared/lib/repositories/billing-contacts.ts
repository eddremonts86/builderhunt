import { and, eq, gt } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingContacts } from '../db/schema'

/**
 * Data access for the verified billing contact (plans/implemented/30-stripe-billing-platform/tasks.md §9 "Add
 * verified billing contact management"). All invariants live one layer up in `billing/billing-
 * contact.ts` — this file only inserts/reads/updates.
 */

export interface BillingContactRecord {
  organizationId: string
  email: string
  status: string
  verificationSecretHash: string | null
  verificationExpiresAt: Date | null
  verifiedAt: Date | null
  setByUserId: string
  createdAt: Date
  updatedAt: Date
}

export async function findBillingContact(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingContactRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingContacts)
    .where(eq(billingContacts.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

export interface UpsertPendingBillingContactInput {
  organizationId: string
  email: string
  verificationSecretHash: string
  verificationExpiresAt: Date
  setByUserId: string
}

/** Owner sets a new contact email — always overwrites any prior row (one current contact per org, not a history), resetting to `pending` even if the previous email was already verified. */
export async function upsertPendingBillingContact(
  transaction: TenantTransaction,
  input: UpsertPendingBillingContactInput,
): Promise<BillingContactRecord> {
  const values = {
    organizationId: input.organizationId,
    email: input.email,
    status: 'pending',
    verificationSecretHash: input.verificationSecretHash,
    verificationExpiresAt: input.verificationExpiresAt,
    verifiedAt: null,
    setByUserId: input.setByUserId,
    updatedAt: new Date(),
  }
  const [row] = await transaction
    .insert(billingContacts)
    .values(values)
    .onConflictDoUpdate({ target: billingContacts.organizationId, set: values })
    .returning()
  return row
}

/**
 * Verifies a pending contact — scoped to `organizationId` AND the exact hash AND still-`pending` AND
 * not expired, mirroring `builder_claims`' replay/wrong-org defenses. Returns `null` (never a
 * distinguishable error) on ANY mismatch — a caller can't tell "wrong token" from "already verified"
 * from "expired," which is intentional: no oracle for guessing a valid token.
 */
export async function verifyPendingBillingContact(
  transaction: TenantTransaction,
  organizationId: string,
  verificationSecretHash: string,
  now: Date,
): Promise<BillingContactRecord | null> {
  const [row] = await transaction
    .update(billingContacts)
    .set({ status: 'verified', verifiedAt: now, verificationSecretHash: null, verificationExpiresAt: null, updatedAt: now })
    .where(and(
      eq(billingContacts.organizationId, organizationId),
      eq(billingContacts.verificationSecretHash, verificationSecretHash),
      eq(billingContacts.status, 'pending'),
      gt(billingContacts.verificationExpiresAt, now),
    ))
    .returning()
  return row ?? null
}
