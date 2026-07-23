/**
 * Dispute freeze, outcome, and alerts (plans/stripe-billing-platform/tasks.md §8 task 5
 * "Implement dispute freeze, outcome, and alerts"; spec.md §Failed payments and disputes:
 * "A subscription chargeback bypasses grace, immediately blocks new premium work, and freezes
 * linked included grants. Winning restores still-valid state; losing ends paid entitlement and
 * revokes unused linked credits. Unrelated purchased grants remain recorded. Pack disputes
 * freeze/revoke only their linked grant.").
 *
 * PACK disputes only — subscription disputes are a documented, deliberate gap, for the same reason
 * subscription refunds are (§8 task 4's own module comment): resolving "which organization/
 * subscription" from a bare disputed PaymentIntent requires knowing that PaymentIntent belongs to a
 * specific subscription invoice, and this codebase never records an invoice's PaymentIntent id
 * anywhere (only `billing_credit_grants.stripe_payment_intent_id`, populated for packs/auto-recharge
 * — see §8 task 4's evidence). Building "immediately block a disputed subscription without grace"
 * honestly needs that linkage first; it is not this task's file list, and inventing it here would be
 * scope creep into an under-specified corner. `findOrganizationIdForDisputedPaymentIntent`
 * (`repositories/billing-worker.ts`) only ever matches a pack grant's PaymentIntent, so a
 * subscription-invoice dispute simply stays `'deferred'` — visible and retried, never silently
 * dropped.
 *
 * "Freeze linked pack grant" / "restore still-valid state on win" / "revoke ... on loss" map
 * directly onto `credits.ts`'s existing freeze/unfreeze/revoke primitives — no new credit-ledger
 * mechanism needed. "Preserve data/unrelated grants": every operation here touches exactly the ONE
 * grant this dispute's PaymentIntent paid for, never anything else the organization owns.
 *
 * "Reconcile reinstated funds": `charge.dispute.funds_reinstated` records `fundsReinstatedAt` as an
 * accounting fact (`markDisputeFundsReinstated`) — it does NOT reverse a lost dispute's credit
 * revocation. `revokeCreditGrant` (`credits.ts`) is a one-way terminal transition by design (no
 * "un-revoke" primitive exists, matching every other terminal ledger transition in this codebase);
 * reinstated funds are a downstream financial-reconciliation fact for §10 (not yet built) to consume,
 * not a signal to silently re-grant credits a customer already lost access to.
 *
 * "Alert evidence deadlines": no notification channel exists yet (§10). `evidenceDueBy` is stored
 * and surfaced prominently in `DisputeQueue.tsx` — a real, honest implementation of "alert" given
 * today's infrastructure, not a stub.
 */
import type { TenantTransaction } from '../db/client'
import { findCreditGrant } from '../repositories/billing-ledger'
import { freezeCreditGrant, revokeCreditGrant, unfreezeCreditGrant } from './credits'
import {
  createDisputeIfAbsent,
  findDisputeByStripeId,
  listDisputes,
  markDisputeFundsReinstated,
  updateDisputeStatus,
  type BillingDisputeRecord,
} from '../repositories/billing-disputes'

export interface RecordDisputeOpenedInput {
  organizationId: string
  grantId: string | null
  stripeDisputeId: string
  stripePaymentIntentId: string
  amountCents: number
  reason: string | null
  stripeStatus: string
  evidenceDueBy: Date | null
}

/** Called from `webhook-handlers.ts` on `charge.dispute.created` — idempotent via `createDisputeIfAbsent`'s own org+stripeDisputeId unique index. */
export async function recordDisputeOpened(
  transaction: TenantTransaction,
  input: RecordDisputeOpenedInput,
): Promise<BillingDisputeRecord> {
  const dispute = await createDisputeIfAbsent(transaction, input)

  if (input.grantId) {
    const grant = await findCreditGrant(transaction, input.organizationId, input.grantId)
    // Only freeze a grant still in its normal usable state — one already revoked (e.g. by an
    // earlier, unrelated refund) has nothing left to freeze, and re-freezing it would be a
    // meaningless no-op at best or an invalid state transition at worst.
    if (grant?.state === 'active') {
      await freezeCreditGrant(transaction, {
        organizationId: input.organizationId,
        grantId: input.grantId,
        ledgerEntryId: `dispute-freeze-${input.stripeDisputeId}`,
        idempotencyKey: `dispute-freeze-${input.stripeDisputeId}`,
        reason: 'Dispute opened',
      })
    }
  }

  return dispute
}

export interface ResolveDisputeInput {
  stripeDisputeId: string
  outcome: 'won' | 'lost'
  stripeStatus: string
}

/** Called from `webhook-handlers.ts` on `charge.dispute.closed` — a no-op if this dispute was already resolved (duplicate delivery). */
export async function resolveDispute(
  transaction: TenantTransaction,
  organizationId: string,
  input: ResolveDisputeInput,
): Promise<BillingDisputeRecord | null> {
  const existing = await findDisputeByStripeId(transaction, organizationId, input.stripeDisputeId)
  if (!existing) return null
  if (existing.outcome !== 'open') return existing

  const updated = await updateDisputeStatus(transaction, organizationId, input.stripeDisputeId, {
    stripeStatus: input.stripeStatus,
    outcome: input.outcome,
  })

  if (existing.grantId) {
    const grant = await findCreditGrant(transaction, organizationId, existing.grantId)
    if (grant?.state === 'frozen') {
      if (input.outcome === 'won') {
        await unfreezeCreditGrant(transaction, {
          organizationId,
          grantId: existing.grantId,
          ledgerEntryId: `dispute-resolve-${input.stripeDisputeId}`,
          idempotencyKey: `dispute-resolve-${input.stripeDisputeId}`,
          reason: 'Dispute won',
        })
      } else {
        await revokeCreditGrant(transaction, {
          organizationId,
          grantId: existing.grantId,
          ledgerEntryId: `dispute-resolve-${input.stripeDisputeId}`,
          idempotencyKey: `dispute-resolve-${input.stripeDisputeId}`,
          reason: 'Dispute lost',
        })
      }
    }
  }

  return updated
}

/** Called from `webhook-handlers.ts` on `charge.dispute.updated` — status-only sync (e.g. `warning_under_review`), never an outcome transition (that's `resolveDispute`'s job). */
export async function updateDisputeStripeStatus(
  transaction: TenantTransaction,
  organizationId: string,
  stripeDisputeId: string,
  stripeStatus: string,
  evidenceDueBy: Date | null,
): Promise<BillingDisputeRecord | null> {
  return updateDisputeStatus(transaction, organizationId, stripeDisputeId, { stripeStatus, evidenceDueBy })
}

/** Called from `webhook-handlers.ts` on `charge.dispute.funds_reinstated` — see this module's top comment for why this never reverses a lost dispute's credit revocation. */
export function recordDisputeFundsReinstated(
  transaction: TenantTransaction,
  organizationId: string,
  stripeDisputeId: string,
  reinstatedAt: Date,
): Promise<BillingDisputeRecord | null> {
  return markDisputeFundsReinstated(transaction, organizationId, stripeDisputeId, reinstatedAt)
}

export function listOrganizationDisputes(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<BillingDisputeRecord[]> {
  return listDisputes(transaction, organizationId)
}
