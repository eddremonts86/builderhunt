# Tasks — migrate the admin and account surfaces

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: All seven accounted for — four on the shell (abuse console, incidents, active sessions, privacy exports), three audited and deliberately left as they are (`HygieneCard`, `InvitationStatus`, `me/index`), and `plan-requests` no longer exists. The one thing not done is the shared e2e parameter list; see the closing note.

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

- [x] **Migrate incidents, keeping create and edit**
  - Files: `src/routes/_dashboard/admin/incidents.tsx`,
    `src/shared/lib/table/capabilities/incidents.ts`
  - Do: `DataTable` with the edit form in the `expansion` slot and create above the grid. Sortable
    started-at (default) and status.
  - Verify: create an incident, edit it, confirm the public `/status` page still reflects it.
  - Done, and verified exactly that way in a browser against the isolated database: created
    "Phase 3 shell check", edited its title through the row expansion, resolved it, and confirmed
    `/api/incidents` returned the edited title with `status: resolved` and a `resolvedAt`.

    Rows here **are** tabular — every incident shows the same fields — which is what separates this
    one from the three audited below.

    The edit form in the expansion slot needed a new shell capability: **expansion state a surface
    can own**. Opening a row here *is* editing that incident, so the page has to load it into its
    form; with the shell keeping the flag the page would have had to mirror it, which is how the
    old markup ended up keeping a row and a form in sync by hand. `expandedRowId` +
    `onExpandedChange` hand it over.

    That found its own trap immediately: `expandedRowId` is compared against `rowId`, and `rowId`
    defaults to `rowTestId`. The page held a raw id while the shell looked for
    `admin-incident-row-<id>`, so no row opened. Fixed by passing `rowId`, and the coupling is
    written on the prop rather than left for the next caller.

    One `renderForm()` serves create and edit. Every test id
    `tests/regression/test-status-and-trust.mjs` drives is unchanged.

- [ ] ~~**Migrate plan requests, with the first bulk action**~~ — **the surface does not exist.**
  `plan_requests` was dropped on 2026-08-03 with `plans` and `plan_changes` (`schema.ts:1058-1067`:
  the pre-organization billing model, 0 rows, every new request already refused by
  `LegacyPlanMutationDisabledError`), and there is no route file. This was also where the plan put
  "the first genuine use of select-loaded plus a bulk action", so that demonstration has no host in
  this group; `admin/access-requests` is the nearest live equivalent if it is wanted. Recorded in
  `spec.md`.

- [x] **Migrate the four small surfaces**
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
  - **`settings/privacy` — done.** The past-exports list is a grid; `.slice(0, 5)` was already the
    bound and stays one. Verified in a browser: requested an export and the row appeared in a grid
    labelled "Past data exports" with `aria-rowcount` 2.
  - **`me/index` — audited, deliberately not migrated.** It is a card per claimed builder profile,
    with an inline edit mode that replaces most of the card; viewing and editing show different
    fields, and there is nothing to align between one avatar-plus-bio block and the next. It is also
    one to three profiles. Recorded in `spec.md`.

    So the "four small surfaces" resolved to **one grid and three verdicts**, which is what the
    audit was for: the plan counted files with row-shaped markup, and three of them turned out to be
    cards.

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

## The one thing not done

**None of these are in `tests/e2e/data-tables.spec.ts`'s parameter list.** The spec's harness
authenticates as an organization owner and drives a route; the abuse console needs a platform-admin
principal (`createPlatformAdminPrincipal`), and active sessions and privacy exports are components
inside larger pages rather than table routes, so each needs its own seeding to reach a populated
grid. That is real work, not a line in `SURFACES`, and claiming these green would be claiming runs
that have not happened. Incidents was verified by hand in a browser end to end instead, and the
shell's own behaviour is covered by 68 unit tests.

## A bug this plan found in plan 04

`capability-index.test.ts` was **green over an empty registry**. A capability registers itself as a
side effect of its module being evaluated, and the guard imported none of them — so its sweep found
zero tables and passed. `capabilities/index.ts` is the barrel it now imports, and the guard asserts
the registry is non-empty before sweeping it. A guard that passes over nothing is the most
convincing kind of wrong, and it would have stayed that way until a surface shipped an unindexed
sort.
