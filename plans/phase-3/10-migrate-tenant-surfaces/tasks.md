# Tasks — migrate the tenant and billing surfaces

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`11-migrate-search`](../11-migrate-search/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `listPlatformUsersWithPlans()` is unbounded; `admin/users.tsx:110` filters client-side.

- [ ] **Bound the platform users read and migrate the admin users page**
  - Files: `src/routes/_dashboard/admin/users.tsx`,
    `src/shared/lib/repositories/platform-billing.ts`,
    `src/shared/lib/table/capabilities/platform-users.ts`
  - Do: replace `listPlatformUsersWithPlans()` with a cursor-and-limit form. Capability: sortable
    created-at (default), name, plan; `searchable` name and email so search covers **all** users,
    not the loaded 50; `tiebreaker` the user id. Delete the client-side filter at `users.tsx:110`.
    Move the inline edit row into the shell's `expansion` slot keyed by row id — the plan select,
    end date, reason field and PATCH all stay in this file.
  - Verify: `grep -rn 'listPlatformUsersWithPlans' src` shows no unbounded form; search for an email
    that belongs to a user beyond the first page and confirm it is found; edit a plan and confirm
    the PATCH still works.

- [ ] **Migrate the refund queue**
  - Files: `src/modules/admin/billing/RefundQueue.tsx`,
    `src/shared/lib/repositories/billing.ts`,
    `src/shared/lib/table/capabilities/billing-refunds.ts`
  - Do: `listBillingRefunds` gains a cursor. The organization id becomes a filter dimension rather
    than a precondition for reading the whole queue. The decision form stays in the `expansion`
    slot with its existing `data-testid` values.
  - Verify: billing regression specs green; record a refund decision and confirm the state
    transition is unchanged.

- [ ] **Migrate the dispute queue**
  - Files: `src/modules/admin/billing/DisputeQueue.tsx`,
    `src/shared/lib/repositories/billing-disputes.ts`,
    `src/shared/lib/table/capabilities/billing-disputes.ts`
  - Do: same shape as refunds over `listDisputes`.
  - Verify: billing regression specs green; the queue lists the same rows as before for a known
    organization.

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
