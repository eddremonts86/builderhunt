/**
 * Refund request and operator workflow (plans/implemented/30-stripe-billing-platform/tasks.md §8 task 4
 * "Implement refund request and operator workflow"; spec.md §Refund contract).
 *
 * Three actors, three entry points:
 * - Owner (`requestPackRefund`): self-service, and ONLY for a fully unused pack (spec.md: "Full
 *   unused pack: full refund plus revocation of its grant" is the one case that needs no human
 *   review). A partially-used pack is explicitly rejected here — "Partially used pack: no
 *   self-service; support may approve proportional refund" — the owner is told to contact support
 *   rather than silently failing.
 * - Platform operator (`decideRefund`): reviews a pending request and records the actual policy
 *   decision (which policyDecision, exact amountCents, and for a partial pack how many units to
 *   revoke) — this is the ONLY path for `partial_pack_operator`, since spec.md is explicit that a
 *   partial refund is never self-service.
 * - Worker (`processPendingPackRefund`, wired into `worker.ts`'s new `sweepPendingRefunds`):
 *   actually sends the refund to Stripe and applies the compensating credit revocation, once a
 *   request has a decided `policyDecision`/`amountCents` (self-service requests already have both
 *   set at creation; operator-decided ones get them via `decideRefund`).
 *
 * Subscription refunds (`full_subscription_invoice`/`partial_subscription_operator`) are OUT OF
 * SCOPE for actual processing in this pass — `decideRefund` can record the decision (including
 * `revisedServiceEndAt`), but no code in this codebase implements immediately ending a
 * subscription's paid period or revoking invoice-scoped included credits yet (confirmed: no
 * existing function in `subscription-changes.ts` does this — every cancellation path there is
 * deliberately scheduled at the NEXT period end, never immediate). `processPendingPackRefund`
 * only ever processes pack policyDecisions; a subscription refund decision stays `pending`
 * indefinitely until a follow-up task builds that mechanism, which is an honest, visible gap
 * (a `pending` row an operator can see), not a silent no-op.
 *
 * "Create idempotent Stripe refund": `provider.createRefund`'s own `idempotencyKey` (keyed off this
 * refund row's own id) means a retried worker tick never double-refunds.
 * "Revoke only eligible unused linked credits, preserve consumed history": `full_unused_pack` fully
 * revokes (the grant is, by construction, still 100% unused); `partial_pack_operator` uses
 * `adjustCreditGrant` for exactly `creditRevocationUnits`, never touching consumed history.
 * "Lock conflicts and expose repair state": `lockBillingRefund`'s row lock held for the FULL
 * duration of the provider call serializes concurrent worker ticks; a grant that's vanished or has
 * no PaymentIntent to refund against is marked `repair_needed` rather than silently skipped.
 */
import { randomUUID } from 'node:crypto'
import type { PlatformAdminPrincipal } from '../auth/platform-admin'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { resolvePackCatalogEntryByKey } from './catalog'
import { adjustCreditGrant, revokeCreditGrant } from './credits'
import { BillingProviderError, type BillingProvider } from './provider'
import {
  createBillingRefundRequestIfAbsent,
  findBillingRefundByIdempotencyKey,
  findFullBillingRefund,
  lockBillingRefund,
  listPendingBillingRefundsWithoutProviderRefund,
  PENDING_REFUND_REPAIR_BATCH,
  markBillingRefundProviderRefund,
  recordOperatorRefundDecision,
  updateBillingRefundState,
  type FullBillingRefundRecord,
} from '../repositories/billing'
import { findCreditGrant } from '../repositories/billing-ledger'

export type RefundErrorCode =
  | 'grant_not_found'
  | 'not_a_pack_grant'
  | 'partially_used'
  | 'not_active'
  | 'unknown_pack_catalog_key'
  | 'decision_conflict'

export class RefundError extends Error {
  constructor(message: string, readonly code: RefundErrorCode) {
    super(message)
    this.name = 'RefundError'
  }
}

export interface RequestPackRefundInput {
  grantId: string
  idempotencyKey: string
}

/** Owner-facing self-service request — see this module's top comment for why only a fully unused pack qualifies. */
export async function requestPackRefund(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: RequestPackRefundInput,
): Promise<FullBillingRefundRecord> {
  const existing = await findBillingRefundByIdempotencyKey(transaction, principal.organizationId, input.idempotencyKey)
  if (existing) return existing

  const grant = await findCreditGrant(transaction, principal.organizationId, input.grantId)
  if (!grant) throw new RefundError('Grant not found', 'grant_not_found')
  if (grant.source !== 'pack') throw new RefundError('Only pack purchases are eligible for self-service refund', 'not_a_pack_grant')
  if (grant.state !== 'active') throw new RefundError('This pack is not in a refundable state', 'not_active')
  if (grant.remainingUnits !== grant.originalUnits) {
    throw new RefundError('This pack has already been partially used — contact support for a partial refund', 'partially_used')
  }
  const catalogEntry = grant.sourceReference ? resolvePackCatalogEntryByKey(grant.sourceReference) : null
  if (!catalogEntry) throw new RefundError('Pack catalog entry no longer resolves', 'unknown_pack_catalog_key')

  return createBillingRefundRequestIfAbsent(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    requestedByUserId: principal.userId,
    idempotencyKey: input.idempotencyKey,
    policyDecision: 'full_unused_pack',
    amountCents: catalogEntry.amountCents,
    grantId: input.grantId,
  })
}

export interface DecideRefundInput {
  refundId: string
  policyDecision: 'full_unused_pack' | 'partial_pack_operator' | 'full_subscription_invoice' | 'partial_subscription_operator'
  amountCents: number
  creditRevocationUnits?: number
  revisedServiceEndAt?: Date
}

/** Platform-operator review/decision on a pending request — never succeeds once a provider refund was already sent (see `recordOperatorRefundDecision`'s own `WHERE` guard). */
export async function decideRefund(
  transaction: TenantTransaction,
  principal: PlatformAdminPrincipal,
  organizationId: string,
  input: DecideRefundInput,
): Promise<FullBillingRefundRecord> {
  const decided = await recordOperatorRefundDecision(transaction, organizationId, input.refundId, {
    operatorUserId: principal.userId,
    policyDecision: input.policyDecision,
    amountCents: input.amountCents,
    revisedServiceEndAt: input.revisedServiceEndAt,
    creditRevocationUnits: input.creditRevocationUnits,
  })
  if (!decided) {
    throw new RefundError('Refund not found, already resolved, or already sent to the provider', 'decision_conflict')
  }
  return decided
}

async function applyCreditRevocationForRefund(
  transaction: TenantTransaction,
  organizationId: string,
  refund: FullBillingRefundRecord,
  grant: { id: string },
): Promise<void> {
  if (refund.policyDecision === 'full_unused_pack') {
    await revokeCreditGrant(transaction, {
      organizationId,
      grantId: grant.id,
      ledgerEntryId: `refund-revoke-${refund.id}`,
      idempotencyKey: `refund-revoke-${refund.id}`,
      reason: 'Full unused-pack refund',
    })
    return
  }
  if (refund.policyDecision === 'partial_pack_operator' && refund.creditRevocationUnits) {
    await adjustCreditGrant(transaction, {
      organizationId,
      grantId: grant.id,
      ledgerEntryId: `refund-revoke-${refund.id}`,
      idempotencyKey: `refund-revoke-${refund.id}`,
      unitsDelta: -refund.creditRevocationUnits,
      reason: 'Partial pack refund — operator-approved revocation',
    })
  }
}

export interface ProcessRefundOptions {
  provider: BillingProvider
}

export type ProcessRefundOutcome =
  | { processed: false; reason: string }
  | { processed: true; stripeRefundId: string }

/**
 * Sends one decided pack refund to the provider and applies the compensating credit revocation on
 * immediate success — called once per pending refund by `worker.ts`'s `sweepPendingRefunds`. Locks
 * the refund row for the entire provider call (`lockBillingRefund`) so a second concurrent tick
 * can't also send it.
 */
export async function processPendingPackRefund(
  transaction: TenantTransaction,
  organizationId: string,
  refundId: string,
  options: ProcessRefundOptions,
): Promise<ProcessRefundOutcome> {
  const refund = await lockBillingRefund(transaction, organizationId, refundId)
  if (!refund || refund.state !== 'pending' || refund.stripeRefundId) {
    return { processed: false, reason: 'not eligible for processing' }
  }
  if (refund.policyDecision !== 'full_unused_pack' && refund.policyDecision !== 'partial_pack_operator') {
    return { processed: false, reason: 'not a pack refund — subscription refund processing is not built yet' }
  }
  if (!refund.grantId) {
    await updateBillingRefundState(transaction, organizationId, refundId, 'repair_needed')
    return { processed: false, reason: 'refund has no linked grant' }
  }

  const grant = await findCreditGrant(transaction, organizationId, refund.grantId)
  if (!grant || !grant.stripePaymentIntentId) {
    await updateBillingRefundState(transaction, organizationId, refundId, 'repair_needed')
    return { processed: false, reason: 'linked grant is missing or has no PaymentIntent to refund' }
  }

  let providerRefund
  try {
    providerRefund = await options.provider.createRefund({
      paymentIntentId: grant.stripePaymentIntentId,
      amount: refund.policyDecision === 'partial_pack_operator' ? refund.amountCents : undefined,
      idempotencyKey: `refund:${refund.id}`,
    })
  } catch (error) {
    await updateBillingRefundState(transaction, organizationId, refundId, 'failed')
    return { processed: false, reason: error instanceof BillingProviderError ? error.message : 'Refund provider error' }
  }

  await markBillingRefundProviderRefund(transaction, organizationId, refundId, {
    stripeRefundId: providerRefund.id,
    state: providerRefund.status === 'succeeded' ? 'succeeded' : 'pending',
  })

  if (providerRefund.status === 'succeeded') {
    await applyCreditRevocationForRefund(transaction, organizationId, refund, grant)
  }
  // A 'pending'/'failed' provider status leaves the row awaiting `refund.updated`/`refund.failed`
  // (webhook-handlers.ts) to finalize — never applied speculatively here.

  return { processed: true, stripeRefundId: providerRefund.id }
}

/** Shared by the worker's synchronous success path above and the async webhook resolution path (webhook-handlers.ts) — exported so both apply the exact same revocation logic. */
export { applyCreditRevocationForRefund }

export async function listPendingPackRefundIds(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<string[]> {
  // Drained: the read is bounded (plan 12) and every row in this queue is a refund the operator
  // approved that Stripe never received, so stopping at a batch boundary leaves money owed.
  const ids: string[] = []
  let after: string | null = null
  for (;;) {
    const rows = await listPendingBillingRefundsWithoutProviderRefund(transaction, organizationId, after)
    if (rows.length === 0) break
    ids.push(...rows
      .filter((row) => row.policyDecision === 'full_unused_pack' || row.policyDecision === 'partial_pack_operator')
      .map((row) => row.id))
    after = rows[rows.length - 1].id
    if (rows.length < PENDING_REFUND_REPAIR_BATCH) break
  }
  return ids
}

export { findFullBillingRefund }
