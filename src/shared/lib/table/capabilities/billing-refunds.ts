import { REFUND_POLICY_DECISIONS, REFUND_STATES } from '~/shared/lib/billing-shared'
import { billingRefunds } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The platform-operator refund review queue.
 *
 * ## Why `organizationId` is both the tenant column and a filter
 *
 * It looks like a duplicate and it is not. The two do different jobs:
 *
 * - **`organizationColumn`** makes `buildKeysetPage` read `app.organization_id` back out of the
 *   transaction before it builds anything, which is the only proof that the caller really did open
 *   `withPlatformOrganization`. It also binds the cursor to that organization, so a cursor minted
 *   while reviewing one workspace cannot be replayed against another.
 * - **`filterable.organizationId`** is what puts it in the URL and in the table's own state. That
 *   is not cosmetic either: with the id inside `TableQuery.filters`, an empty result under a typed
 *   id renders the *filtered*-empty state naming the organization, rather than the blank state
 *   claiming there are no refunds at all. Those are different facts and the queue used to give the
 *   second when it meant the first.
 *
 * `builderhunt_platform`'s SELECT policy on `billing_refunds` is org-scoped
 * (drizzle/0028_billing_rls_grants.sql), so a genuinely cross-organization queue is not a
 * pagination change — it is a new RLS policy over financial rows. Out of scope here; see the note
 * in plans/phase-3/10-migrate-tenant-surfaces/tasks.md.
 *
 * `state` and `policyDecision` carry facets because triage is the queue's whole purpose: an
 * operator wants "3 pending" visible without filtering to find out.
 */
export const BILLING_REFUNDS_TABLE = 'billing_refunds'

export const billingRefundsCapability = registerTableCapability(defineTableCapability({
  table: BILLING_REFUNDS_TABLE,
  sortable: {
    // Backed by `billing_refunds_org_created_id_idx`.
    createdAt: { column: billingRefunds.createdAt },
    // Backed by `billing_refunds_org_amount_id_idx` — "largest refunds first" is the other way an
    // operator triages this queue, and it is the one that costs money to get wrong.
    amountCents: { column: billingRefunds.amountCents },
  },
  filterable: {
    state: { column: billingRefunds.state, values: REFUND_STATES, facet: true },
    policyDecision: { column: billingRefunds.policyDecision, values: REFUND_POLICY_DECISIONS, facet: true },
    // No facet: it is a free-text id, and a chip listing the one organization already selected
    // tells the operator nothing they did not just type.
    organizationId: { column: billingRefunds.organizationId },
  },
  groupable: [],
  // The operator arrives with a refund id from a support thread far more often than with a name.
  searchable: [billingRefunds.id],
  tiebreaker: billingRefunds.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
}))

export const BILLING_REFUND_FILTER_LABELS: Record<string, string> = {
  state: 'State',
  policyDecision: 'Policy',
  organizationId: 'Organization',
}
