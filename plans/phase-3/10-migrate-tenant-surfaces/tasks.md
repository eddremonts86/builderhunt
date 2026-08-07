# Tasks — migrate the tenant and billing surfaces

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`11-migrate-search`](../11-migrate-search/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `listPlatformUsersWithPlans()` is unbounded; `admin/users.tsx:110` filters client-side.

- [x] **Bound the platform users read and migrate the admin users page**
  - Files: `src/routes/_dashboard/admin/users.tsx`, `src/modules/admin/users/AdminUsersPage.tsx`,
    `src/shared/lib/repositories/platform-billing.ts`,
    `src/shared/lib/table/capabilities/platform-users.ts`
  - Do: replace `listPlatformUsersWithPlans()` with a cursor-and-limit form. Capability: sortable
    created-at (default), name, plan; `searchable` name and email so search covers **all** users,
    not the loaded 50; `tiebreaker` the user id. Delete the client-side filter from
    `AdminUsersPage.tsx`.
    Move the inline edit row into the shell's `expansion` slot keyed by row id — the plan select,
    end date, reason field and PATCH all stay in this file.
  - Verify: `grep -rn 'listPlatformUsersWithPlans' src` shows no unbounded form; search for an email
    that belongs to a user beyond the first page and confirm it is found; edit a plan and confirm
    the PATCH still works.

- [x] **Migrate the refund queue**
  - Files: `src/modules/admin/billing/RefundQueue.tsx`,
    `src/shared/lib/repositories/billing.ts`,
    `src/shared/lib/table/capabilities/billing-refunds.ts`
  - Do: `listBillingRefunds` gains a cursor. The organization id becomes a filter dimension rather
    than a precondition for reading the whole queue. The decision form stays in the `expansion`
    slot with its existing `data-testid` values.
  - Verify: billing regression specs green; record a refund decision and confirm the state
    transition is unchanged.
  - **Done, with one boundary the plan did not anticipate.** `pageBillingRefunds` is the queue's
    read; `listBillingRefunds` stays for the accounting export, the operations roll-up and the
    owner's billing summary, which need the whole set to produce a total and would be *wrong*
    rather than slow at fifty rows. The organization id is now `filter.organizationId`: it is in
    the URL, in the cursor's binding, and in the filtered-empty copy.
    It is still **required**, and exactly one value. `builderhunt_platform`'s SELECT policy on
    `billing_refunds` is org-scoped (`drizzle/0028_billing_rls_grants.sql`), so a genuinely
    cross-organization queue is a new RLS policy over financial rows, not a pagination change —
    and plan 10's own non-goals say "same behaviour, same permissions". Left as a deliberate gap.
    Found on the way: the shell's expand toggle is a second way into the expansion, so the
    decision form could be opened on an already-decided refund, which the Decide button had made
    impossible. Non-pending rows now render a read-only note instead.
    Indexes `billing_refunds_org_{created,amount}_id_idx` in `drizzle/0158`.

- [x] **Migrate the dispute queue**
  - Files: `src/modules/admin/billing/DisputeQueue.tsx`,
    `src/shared/lib/repositories/billing-disputes.ts`,
    `src/shared/lib/table/capabilities/billing-disputes.ts`
  - Do: same shape as refunds over `listDisputes`.
  - Verify: billing regression specs green; the queue lists the same rows as before for a known
    organization.
  - **Done — and "the same rows as before" turned out to be an assumption the old code could not
    make.** `listDisputes` had no `ORDER BY`, so the queue's order was whatever Postgres returned;
    a keyset needs a total order to exist, which is how that surfaced. The rows are the same set,
    now in a defined one. `stripePaymentIntentId` stopped being sent: the old route projected
    `select()` and the page displayed six columns of it.
    `evidenceDueBy` is sortable — "which deadline is closest" is what this read-only view is for —
    and it is nullable, which exposed a real gap in plan 04's guard. Recorded there; the short
    version is that declaring `nullsLast` would have made the descending sort unservable by the
    index the guard reported as covering it, so the declaration is deliberately absent and the
    null placement follows the scan direction.
    Indexes `billing_disputes_org_{created,evidence_due}_id_idx` in `drizzle/0159`.

- [ ] **Migrate team settings as two grids**
  - Files: `src/modules/dashboard/components/TeamSettingsPage.tsx`,
    `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/shared/lib/table/capabilities/{organization-members,organization-invitations}.ts`
  - Do: `listOrganizationMembers` and `listPendingInvitations` gain cursors. Two grids, not one
    merged list — members and invitations are different record types.
  - Verify: invite someone, confirm the invitation grid updates; remove a member, confirm seat usage
    still recalculates.

- [ ] **Migrate the sprints index**
  - Files: `src/routes/_dashboard/sprints/index.tsx`, `src/lib/sprints/service.ts`,
    `src/shared/lib/table/capabilities/sprints.ts`
  - Do: `listSprints` gains a cursor. Sortable last-run (default, descending) and status;
    `sourcing_sprints_org_status_last_run_idx` already exists and should back it — confirm with
    plan 04's guard.
  - Verify: the guard test passes with the new capability; the list matches the previous ordering.

- [ ] **Migrate alerts, moving grouping to the server**
  - Files: `src/routes/_dashboard/alerts.tsx`,
    `src/shared/lib/repositories/organization-alerts.ts`,
    `src/shared/lib/table/capabilities/alerts.ts`
  - Do: `listOrganizationAlerts` gains a cursor. The local `groupByAlert` helper (`alerts.tsx:100`)
    is replaced by the shell's grouping, with aggregates from the server so a group count covers the
    **whole** group rather than the loaded part.
  - Verify: group counts compared before and after on the same data; where they differ, confirm the
    new number is the correct whole-group count and not a bug.

- [ ] **Confirm the read count actually dropped**
  - Files: none
  - Do: `node scripts/check-unbounded-reads.mjs`.
  - Verify: the count is at least six lower than before this plan, and every remaining entry is
    accounted for by plan 11 or 12.
