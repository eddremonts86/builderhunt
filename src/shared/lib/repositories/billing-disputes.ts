import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingDisputes } from '../db/schema'

/**
 * Data access for chargeback tracking (plans/stripe-billing-platform/tasks.md §8 "Implement dispute
 * freeze, outcome, and alerts"). Entirely worker/webhook-written — see `billing/disputes.ts`'s
 * module comment; this file only inserts/reads/updates, all invariants live one layer up.
 */

export interface BillingDisputeRecord {
  id: string
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  stripePaymentIntentId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  outcome: string
  evidenceDueBy: Date | null
  fundsReinstatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateDisputeInput {
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  stripePaymentIntentId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  evidenceDueBy: Date | null
}

/** `ON CONFLICT DO NOTHING` on the org+stripeDisputeId unique index, then re-select — a duplicate `charge.dispute.created` delivery never creates a second row. */
export async function createDisputeIfAbsent(
  transaction: TenantTransaction,
  input: CreateDisputeInput,
): Promise<BillingDisputeRecord> {
  await transaction.insert(billingDisputes).values({ id: randomUUID(), ...input }).onConflictDoNothing({
    target: [billingDisputes.organizationId, billingDisputes.stripeDisputeId],
  })
  const existing = await findDisputeByStripeId(transaction, input.organizationId, input.stripeDisputeId)
  if (!existing) throw new Error(`Dispute for ${input.stripeDisputeId} vanished immediately after insert-or-fetch`)
  return existing
}

export async function findDisputeByStripeId(
  transaction: TenantTransaction,
  organizationId: string,
  stripeDisputeId: string,
): Promise<BillingDisputeRecord | null> {
  const [row] = await transaction
    .select()
    .from(billingDisputes)
    .where(and(eq(billingDisputes.organizationId, organizationId), eq(billingDisputes.stripeDisputeId, stripeDisputeId)))
    .limit(1)
  return row ?? null
}

export async function listDisputes(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingDisputeRecord[]> {
  return transaction
    .select()
    .from(billingDisputes)
    .where(eq(billingDisputes.organizationId, organizationId))
}

export interface UpdateDisputeStatusInput {
  stripeStatus: string
  outcome?: 'won' | 'lost'
  evidenceDueBy?: Date | null
}

export async function updateDisputeStatus(
  transaction: TenantTransaction,
  organizationId: string,
  stripeDisputeId: string,
  input: UpdateDisputeStatusInput,
): Promise<BillingDisputeRecord | null> {
  const [row] = await transaction
    .update(billingDisputes)
    .set({
      stripeStatus: input.stripeStatus,
      outcome: input.outcome,
      evidenceDueBy: input.evidenceDueBy,
      updatedAt: new Date(),
    })
    .where(and(eq(billingDisputes.organizationId, organizationId), eq(billingDisputes.stripeDisputeId, stripeDisputeId)))
    .returning()
  return row ?? null
}

export async function markDisputeFundsReinstated(
  transaction: TenantTransaction,
  organizationId: string,
  stripeDisputeId: string,
  reinstatedAt: Date,
): Promise<BillingDisputeRecord | null> {
  const [row] = await transaction
    .update(billingDisputes)
    .set({ fundsReinstatedAt: reinstatedAt, updatedAt: new Date() })
    .where(and(eq(billingDisputes.organizationId, organizationId), eq(billingDisputes.stripeDisputeId, stripeDisputeId)))
    .returning()
  return row ?? null
}
