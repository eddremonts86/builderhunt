import { billingDisputes } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The platform-operator chargeback view.
 *
 * Read-only by design — evidence submission and the won/lost outcome both live in the Stripe
 * Dashboard (see `billing/disputes.ts`), so there is no expansion form here and no mutation route
 * to protect. What the surface is *for* is knowing which grants are frozen and which evidence
 * deadline is closest, which is why `evidenceDueBy` is sortable and not merely displayed.
 *
 * `listDisputes` had no `ORDER BY` at all. Postgres was free to return the queue in a different
 * order on any two requests, and the page rendered whatever arrived — so "the top of the list" was
 * never a fact about the data. A keyset needs a total order to exist, which is how that surfaced.
 *
 * The organization is both `organizationColumn` and a filter, for the same two reasons as
 * `billing-refunds.ts`: the tenant column proves the transaction is scoped and binds the cursor,
 * the filter puts the id in the URL and in the filtered-empty copy.
 */
export const BILLING_DISPUTES_TABLE = 'billing_disputes'

/** The `billing_disputes_outcome_check` constraint's vocabulary. */
export const DISPUTE_OUTCOMES = ['open', 'won', 'lost'] as const

export const billingDisputesCapability = registerTableCapability(defineTableCapability({
  table: BILLING_DISPUTES_TABLE,
  sortable: {
    // Backed by `billing_disputes_org_created_id_idx`.
    createdAt: { column: billingDisputes.createdAt },
    /*
     * Backed by `billing_disputes_org_evidence_due_id_idx`, and deliberately **without**
     * `nullsLast`.
     *
     * `evidence_due_by` is nullable, so the instinct is to declare `nullsLast: true` — a dispute
     * with no deadline is not "due soonest". That declaration is wrong here, and subtly:
     * `resolveSort` applies it to *both* directions, and `ORDER BY x DESC NULLS LAST` is the one
     * combination a `(org, x, id)` b-tree cannot produce from either scan direction. Forward gives
     * `ASC NULLS LAST`, backward gives `DESC NULLS FIRST`. So the sort would be declared covered,
     * the index would exist, and Postgres would sort the whole set anyway.
     *
     * Left undefined, the null placement follows the scan direction and both directions are index
     * ranges. Ascending — "which deadline is closest" — already puts nulls last, which is the
     * question this column exists to answer.
     *
     * `capability-index.ts` does not catch the declared-`nullsLast`-with-`DESC` case; noted
     * against plan 04 for plan 13's gates.
     */
    evidenceDueBy: { column: billingDisputes.evidenceDueBy },
  },
  filterable: {
    outcome: { column: billingDisputes.outcome, values: DISPUTE_OUTCOMES, facet: true },
    // No `values`: Stripe owns this vocabulary and adds to it, so an allowlist here would 400 on a
    // status the webhook had already written into the row.
    stripeStatus: { column: billingDisputes.stripeStatus, facet: true },
    organizationId: { column: billingDisputes.organizationId },
  },
  groupable: [],
  // An operator arrives from Stripe with a dispute id, or from a support thread with a reason.
  searchable: [billingDisputes.stripeDisputeId, billingDisputes.reason],
  tiebreaker: billingDisputes.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
}))

export const BILLING_DISPUTE_FILTER_LABELS: Record<string, string> = {
  outcome: 'Outcome',
  stripeStatus: 'Stripe status',
  organizationId: 'Organization',
}
