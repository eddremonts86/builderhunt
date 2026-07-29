# Tasks — migrate the admin and account surfaces

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Add each surface to `tests/e2e/data-tables.spec.ts`'s parameter list as it lands.

- [ ] **Migrate the abuse console**
  - Files: `src/modules/dashboard/components/AbuseConsole.tsx`,
    `src/shared/lib/table/capabilities/abuse-signals.ts`
  - Do: replace the `<table>` with `DataTable`. Capability: sortable created-at (default,
    descending) and signal type; filterable type and severity; `tiebreaker` the signal id. Signals
    are append-only and system-operational, so no selection actions.
  - Verify: added to the shared e2e parameter list and passing; `pnpm test:a11y` green.

- [ ] **Migrate incidents, keeping create and edit**
  - Files: `src/routes/_dashboard/admin/incidents.tsx`,
    `src/shared/lib/table/capabilities/incidents.ts`
  - Do: `DataTable` with the edit form in the `expansion` slot and create above the grid. Sortable
    started-at (default) and status.
  - Verify: create an incident, edit it, confirm the public `/status` page still reflects it.

- [ ] **Migrate plan requests, with the first bulk action**
  - Files: `src/routes/_dashboard/admin/plan-requests.tsx`,
    `src/shared/lib/table/capabilities/plan-requests.ts`
  - Do: `DataTable` with selection plus an approve/deny bulk action over the **loaded** selection.
    Do not offer "select all matching" unless the endpoint accepts a predicate token.
  - Verify: select several rows, apply a bulk action, confirm only the selected rows changed.

- [ ] **Migrate the four small surfaces**
  - Files: `src/modules/dashboard/components/ActiveSessionsPanel.tsx`,
    `src/routes/_dashboard/settings/privacy.tsx`, `src/routes/_dashboard/me/index.tsx`,
    `src/modules/scheduling/components/InvitationStatus.tsx`
  - Do: one grid each. On `me/index`, keep the several short lists as separate grids rather than
    merging unrelated record types to reuse one component. Per-row actions (revoke a session) stay
    per-row.
  - Verify: each added to the shared e2e list; the account and privacy regression specs still pass.

- [ ] **Audit HygieneCard and record the verdict**
  - Files: `src/shared/components/HygieneCard.tsx`, `08-migrate-admin-surfaces/spec.md`
  - Do: it contains table markup but appears to be a summary card. Decide whether it is a data grid.
    If not, record that in the spec's non-goals and leave the file alone.
  - Verify: the spec states the decision; `grep -rl '<table' src` output matches what the spec
    predicts.
