import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { billingDisputes } from '../db/schema'
import { billingDisputesCapability } from '../table/capabilities/billing-disputes'
import { buildKeysetPage } from '../table/keyset'
import type { PageRequest, PageResult, TableQuery } from '../table/types'
import { OPERATOR_LIST_LIMIT } from '../db/read-bounds'

/**
 * Data access for chargeback tracking (plans/phase-1/30-stripe-billing-platform/tasks.md §8 "Implement dispute
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

/**
 * Every dispute an organization has, in no particular order.
 *
 * The missing `ORDER BY` is not an oversight to fix in passing — the alert path and the freeze
 * check consume this as a set, and adding a sort would only make the absence of one harder to
 * notice later. The **operator queue** needs an order and a bound, and reads `pageDisputes` below.
 */
export async function listDisputes(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingDisputeRecord[]> {
  return transaction
    .select()
    .from(billingDisputes)
    .where(eq(billingDisputes.organizationId, organizationId))
    // `pageBillingDisputes` (plan 10) is the queue's read; this one is the operations roll-up over a
    // single organization, and the accounting export that needed every row counts in SQL now.
    .orderBy(desc(billingDisputes.createdAt), desc(billingDisputes.id))
    .limit(OPERATOR_LIST_LIMIT)
}

/** The chargeback view's wire shape — the reviewed subset of the row, timestamps serialized. */
export interface BillingDisputePageRow extends Record<string, unknown> {
  id: string
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  outcome: string
  evidenceDueBy: string | null
  fundsReinstatedAt: string | null
  createdAt: string
}

/**
 * One keyset page of the chargeback view.
 *
 * `stripePaymentIntentId` is deliberately not projected. The old route returned `select()` — every
 * column — and the page displayed six of them; the payment intent id rode along to the browser for
 * nobody. Must run inside `withPlatformOrganization`, which `buildKeysetPage` verifies rather than
 * assumes.
 */
export async function pageDisputes(
  transaction: TenantTransaction,
  query: TableQuery,
  page: PageRequest,
): Promise<PageResult<BillingDisputePageRow>> {
  return buildKeysetPage<BillingDisputePageRow>(transaction, billingDisputesCapability, query, page, {
    select: {
      id: billingDisputes.id,
      organizationId: billingDisputes.organizationId,
      grantId: billingDisputes.grantId,
      stripeDisputeId: billingDisputes.stripeDisputeId,
      amountCents: billingDisputes.amountCents,
      reason: billingDisputes.reason,
      stripeStatus: billingDisputes.stripeStatus,
      outcome: billingDisputes.outcome,
      evidenceDueBy: billingDisputes.evidenceDueBy,
      fundsReinstatedAt: billingDisputes.fundsReinstatedAt,
      createdAt: billingDisputes.createdAt,
    },
    mapRow: (row) => ({
      id: row.id as string,
      organizationId: row.organizationId as string,
      grantId: (row.grantId as string | null) ?? null,
      stripeDisputeId: row.stripeDisputeId as string,
      amountCents: row.amountCents as number,
      reason: (row.reason as string | null) ?? null,
      stripeStatus: row.stripeStatus as string,
      outcome: row.outcome as string,
      evidenceDueBy: (row.evidenceDueBy as Date | null)?.toISOString() ?? null,
      fundsReinstatedAt: (row.fundsReinstatedAt as Date | null)?.toISOString() ?? null,
      createdAt: (row.createdAt as Date).toISOString(),
    }),
  })
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
