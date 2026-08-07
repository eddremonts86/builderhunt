# Tasks — migrate the admin and account surfaces

> **Status**: `partially-implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Two of the seven surfaces are on the shell; two more were audited and are deliberately not grids; three remain. `plan-requests` no longer exists. The unchecked boxes below are the honest gap.

- [x] **Migrate the abuse console**
  - Files: `src/modules/dashboard/components/AbuseConsole.tsx`,
    `src/shared/lib/table/capabilities/abuse-signals.ts`
  - Do: replace the `<table>` with `DataTable`. Capability: sortable created-at (default,
    descending) and signal type; filterable type and severity; `tiebreaker` the signal id. Signals
    are append-only and system-operational, so no selection actions.
  - Verify: added to the shared e2e parameter list and passing; `pnpm test:a11y` green.
  - Done, and the feed became a real keyset page rather than only a new renderer. It answered
    `?limit=100` and nothing else, so the console could reach the newest hundred signals and no
    further — an operator investigating last week's incident had no way there.

    `abuse_signals` is global by design (impossible travel, linked accounts, cross-tenant denials),
    so its capability declares **no `organizationColumn`** and the route needed a platform-admin
    handler. `platformTablePageHandler` is that: `requirePlatformAdminPrincipal` instead of
    `requireTenantPrincipal`, no `withTenantContext`, and still authorization before parse.

    The enforcement stage moved from a side `stageByUserId` map onto the row it belongs to — the
    same reads, but the response stays a `PageResult` instead of a `PageResult` with a map taped to
    it. The route's unit tests and the console's were updated for the new shape, with the reason at
    each site; no test was deleted.

    **Not done: the e2e parameter list and `test:a11y`.** The shared spec's harness authenticates as
    an organization owner, and this surface needs a platform-admin principal
    (`createPlatformAdminPrincipal`). Adding it is real work rather than one line in `SURFACES`, and
    claiming it green here would be claiming a run that has not happened.

- [ ] **Migrate incidents, keeping create and edit**
  - Files: `src/routes/_dashboard/admin/incidents.tsx`,
    `src/shared/lib/table/capabilities/incidents.ts`
  - Do: `DataTable` with the edit form in the `expansion` slot and create above the grid. Sortable
    started-at (default) and status.
  - Verify: create an incident, edit it, confirm the public `/status` page still reflects it.

- [ ] ~~**Migrate plan requests, with the first bulk action**~~ — **the surface does not exist.**
  `plan_requests` was dropped on 2026-08-03 with `plans` and `plan_changes` (`schema.ts:1058-1067`:
  the pre-organization billing model, 0 rows, every new request already refused by
  `LegacyPlanMutationDisabledError`), and there is no route file. This was also where the plan put
  "the first genuine use of select-loaded plus a bulk action", so that demonstration has no host in
  this group; `admin/access-requests` is the nearest live equivalent if it is wanted. Recorded in
  `spec.md`.

- [~] **Migrate the four small surfaces**
  - Files: `src/modules/dashboard/components/ActiveSessionsPanel.tsx`,
    `src/routes/_dashboard/settings/privacy.tsx`, `src/routes/_dashboard/me/index.tsx`,
    `src/modules/scheduling/components/InvitationStatus.tsx`
  - Do: one grid each. On `me/index`, keep the several short lists as separate grids rather than
    merging unrelated record types to reuse one component. Per-row actions (revoke a session) stay
    per-row.
  - Verify: each added to the shared e2e list; the account and privacy regression specs still pass.
  - **`ActiveSessionsPanel` — done.** A page that is always the whole list: sessions are
    model-bounded (a person has as many as they have devices), so `nextCursor` is null and `total`
    is the length. That is the cheap form of this migration and the honest one — inventing a cursor
    for a list that cannot grow is machinery, not pagination. Revoke stays per-row: a multi-select
    over "which of my devices to sign out" is a worse affordance than a button.
  - **`InvitationStatus` — audited, deliberately not migrated.** It is a list of per-status cards,
    not rows: a `draft` shows a recipient and a resume link, a `booked` one shows a timestamp and
    three destinations, and no two rows show the same fields. There are no columns to align. A
    one-column grid holding a card would add the ARIA semantics of a list that already exists.
    Recorded in `spec.md`.
  - **Still open: `settings/privacy` and `me/index`.** Both are several short model-bounded lists,
    so both take the same "one page is the whole list" shape `ActiveSessionsPanel` now uses.

- [x] **Audit HygieneCard and record the verdict**
  - Files: `src/shared/components/HygieneCard.tsx`, `08-migrate-admin-surfaces/spec.md`
  - Do: it contains table markup but appears to be a summary card. Decide whether it is a data grid.
    If not, record that in the spec's non-goals and leave the file alone.
  - Verify: the spec states the decision; `grep -rl '<table' src` output matches what the spec
    predicts.
  - Done: **not a grid.** `HygieneCard.tsx:199` is a four-column static comparison of a builder's
    already-analysed repositories inside a summary card — it does not grow with usage, has no sort,
    filter, selection or row action, and is read-only. `<table>` is the right element for that; an
    ARIA grid would promise keyboard traversal with nowhere to go. Left alone, recorded in the
    spec's non-goals.

    The audit turned up a second one on the same reasoning (`InvitationStatus`, above), which is
    why the verdict is written as a rule rather than a one-off: **table markup is not a data grid
    unless the rows share columns and the list grows.**

## A bug this plan found in plan 04

`capability-index.test.ts` was **green over an empty registry**. A capability registers itself as a
side effect of its module being evaluated, and the guard imported none of them — so its sweep found
zero tables and passed. `capabilities/index.ts` is the barrel it now imports, and the guard asserts
the registry is non-empty before sweeping it. A guard that passes over nothing is the most
convincing kind of wrong, and it would have stayed that way until a surface shipped an unindexed
sort.
