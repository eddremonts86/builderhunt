# Tasks — adopt the canonical table visual system

> **Status**: `implemented`
> **Depends on**: [`13-pagination-ci-gates`](../../../implemented/phase-3/13-pagination-ci-gates/spec.md)
> **Blocks**: nothing
> **Reality check**: all tasks modify the existing phase-3 shell; none may replace its server-owned query model, keyset cursors or virtualized ARIA behavior.

- [x] **Turn the surface gate into an instance-aware adoption ledger**
  - Files: `scripts/check-table-surfaces.mjs`, `tests/unit/scripts/check-table-surfaces.test.ts`
  - Do: report every `<DataTable>` and raw `<table>` instance rather than one record per source file;
    classify each as interactive, visible semantic, screen-reader-only or non-app email output. Add a
    visual-system marker and fail on visible app tables that use neither `DataTable` nor
    `SemanticTable`. Preserve capability/bounded/exempt validation and the provider-pagination rule.
  - Verify: `pnpm check:table-surfaces` reports all 20 `DataTable` call sites, five visible raw-table
    instances, the `BarSeries` screen-reader equivalent and the internal shell; deliberate unmarked
    scratch instances fail and pass again after removal.

- [x] **Add the canonical table tokens with dark-theme equivalents**
  - Files: `src/shared/styles/globals.css`, `tests/unit/shared/lib/accessibility.test.ts`, `docs/visual-system.md`
  - Do: add `--tbl-*` properties for the validated colors, typography, 58/34/44px anatomy,
    44/52/64px densities, 16px padding, 20px gap, fixed column widths, row states, chips, focus ring
    and transition. Use the supplied literals in light mode and semantic BuilderHunt mappings in
    dark mode; do not add Sass. Document the HTML/PDF provenance and the intentional CSS-variable
    adaptation.
  - Verify: `pnpm test -- tests/unit/shared/lib/accessibility.test.ts` passes contrast assertions for
    table text, status chips and focus boundaries in both themes; `rg` finds no new table literal
    outside the token block or approved tests.

- [x] **Type column kind, width and density in the shared contract**
  - Files: `src/shared/lib/table/columns.ts`, `src/shared/components/table/grid-roles.ts`, `src/shared/components/table/useTableVirtual.ts`, `tests/unit/shared/components/table/grid-roles.test.ts`, `tests/unit/shared/components/table/useTableVirtual.test.tsx`
  - Do: add the nine canonical cell kinds and a width policy that maps status/category/date/number/
    ratio/actions to their fixed widths while leaving only primary flexible. Replace
    `comfortable|compact` with container densities `sm|md|lg`, mapped to 44/52/64px, and name the
    search-card height as an explicit specialized token. Keep compatibility defaults until every
    column definition is migrated.
  - Verify: `pnpm test -- tests/unit/shared/components/table/grid-roles.test.ts tests/unit/shared/components/table/useTableVirtual.test.tsx` proves exact templates, density heights,
    virtual offsets and focus pinning.

- [x] **Restyle the shell anatomy and interaction states**
  - Files: `src/shared/components/table/DataTable.tsx`, `src/shared/components/table/GridRow.tsx`, `src/shared/components/table/TableToolbar.tsx`, `src/shared/components/table/SelectionBar.tsx`, `src/shared/components/table/renderers/TableRenderer.tsx`, `src/shared/components/table/renderers/GroupedRenderer.tsx`, `src/shared/components/table/renderers/StackedRenderer.tsx`, `src/shared/components/table/renderers/BoardRenderer.tsx`, `tests/unit/shared/components/table/DataTable.test.tsx`
  - Do: consume only `--tbl-*` tokens for the canonical container, toolbar, sticky header, row
    separators, inherited `data-density`, hover/selected/danger/muted states and sticky 44px action
    column. Add the 44px count/cursor footer without page numbers. Convert selection to the floating
    bottom action bar while retaining select-loaded/select-all-matching semantics. Keep stacked and
    board layouts, but make them consume the same type, state and color tokens.
  - Verify: `pnpm test -- tests/unit/shared/components/table/DataTable.test.tsx` covers all anatomy,
    density and state attributes; keyboard, selection, grouping and virtualization tests remain
    green.

- [x] **Implement the nine canonical cell presentations**
  - Files: `src/shared/components/table/cells/PrimaryCell.tsx`, `src/shared/components/table/cells/StatusCell.tsx`, `src/shared/components/table/cells/DateCell.tsx`, `src/shared/components/table/cells/NumberCell.tsx`, `src/shared/components/table/cells/RatioCell.tsx`, `src/shared/components/table/cells/IdentityCell.tsx`, `src/shared/components/table/cells/EmptyCell.tsx`, `src/shared/components/table/cells/ActionsCell.tsx`, `src/shared/components/table/cells/index.ts`, `tests/unit/shared/components/table/TableCells.test.tsx`
  - Do: encode the reference typography and semantics in reusable cells. Enforce semantic status
    colors, right-aligned tabular numbers, relative+absolute dates, 26px identities, em-dash empties,
    ratio bars and one visible action plus overflow. Only primary/free-text content may truncate,
    and it must expose the complete accessible value.
  - Verify: `pnpm test -- tests/unit/shared/components/table/TableCells.test.tsx` covers output,
    accessible names, no truncation for date/number/status, semantic status variants and keyboard
    reachability of actions.

- [x] **Migrate every interactive surface to typed cells and widths**
  - Files: `src/routes/_dashboard/alerts.tsx`, `src/routes/_dashboard/admin/incidents.tsx`, `src/routes/_dashboard/sprints/index.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`, `src/routes/_dashboard/settings/privacy.tsx`, `src/modules/dashboard/components/TeamSettingsPage.tsx`, `src/modules/dashboard/components/ActiveSessionsPanel.tsx`, `src/modules/dashboard/components/AbuseConsole.tsx`, `src/modules/admin/billing/RefundQueue.tsx`, `src/modules/admin/billing/DisputeQueue.tsx`, `src/modules/admin/users/AdminUsersPage.tsx`, `src/modules/admin/integrations/IntegrationsPage.tsx`, `src/modules/admin/operations/OperationsPage.tsx`, `src/modules/admin/content/BlogLibrary.tsx`, `src/modules/admin/content/RoadmapManager.tsx`, `src/modules/admin/content/ChangelogManager.tsx`, `src/modules/search/components/SearchPage.tsx`
  - Do: classify every `ColumnDef`, use the shared cells, choose density at each table container and
    remove local table visual overrides. Merge members and invitations into one row model when they
    share the same schema, distinguishing them by status as required by the reference. Do not add
    sorting to status/actions or change server capability allowlists merely for presentation.
  - Verify: `pnpm check:table-surfaces`, `pnpm test:e2e tests/e2e/data-tables.spec.ts`,
    `pnpm test:e2e tests/e2e/settings-journeys.spec.ts` and the existing admin/billing journey specs
    pass with unchanged query, pagination and tenant behavior.

- [x] **Add and adopt the native semantic-table primitive**
  - Files: `src/shared/components/table/SemanticTable.tsx`, `src/shared/components/table/index.ts`, `src/routes/_landing/legal/cookies.tsx`, `src/routes/_landing/pricing.tsx`, `src/modules/admin/metrics/sections/ConversionSection.tsx`, `src/shared/components/HygieneCard.tsx`, `src/modules/dashboard/ui/BarSeries.tsx`, `tests/unit/shared/components/table/SemanticTable.test.tsx`
  - Do: create a native `table/thead/tbody` primitive using the same tokens, `scope="col"`, caption
    support, numeric alignment and responsive table-owned scrolling. Migrate all five visible raw
    tables. Keep `BarSeries` screen-reader-only and verify its semantics without applying visible
    chrome. Do not migrate `src/shared/lib/email.ts`; record its email-client exemption in the gate.
  - Verify: `pnpm test -- tests/unit/shared/components/table/SemanticTable.test.tsx`,
    `pnpm test:a11y` and `pnpm test:visual -- tests/e2e/visual/public-surfaces.spec.ts` pass; source
    inventory finds no visible ungoverned raw app table.

- [x] **Add exhaustive responsive and visual table coverage**
  - Files: `tests/e2e/visual/table-system.spec.ts`, `tests/e2e/responsive-device-matrix.spec.ts`, `tests/e2e/data-tables.spec.ts`, `tests/regression/test-accessibility.mjs`
  - Do: seed representative primary/status/date/number/ratio/identity/empty/action cells and capture
    interactive plus semantic tables at desktop and 375px in light and dark mode. Exercise normal,
    skeleton, genuine empty, filtered empty and retryable error; selected/danger/muted rows; sticky
    header/actions; horizontal scroll; floating bulk actions; and all four renderers. Assert the
    document never widens beyond the viewport and the grid keeps valid ARIA indices.
  - Verify: `pnpm test:visual`, `pnpm test:a11y`, `pnpm test:e2e tests/e2e/data-tables.spec.ts` and
    `pnpm test:e2e tests/e2e/responsive-device-matrix.spec.ts` pass on Chromium desktop/mobile.

- [x] **Run the full route walk, update documentation and close the plan**
  - Files: `docs/visual-system.md`, `DESIGN.md`, `README.md`, `plans/phase-3/14-unified-table-visual-style/spec.md`, `plans/phase-3/14-unified-table-visual-style/plan.md`, `plans/phase-3/14-unified-table-visual-style/tasks.md`
  - Do: visit every surface emitted by the instance-aware ledger with real seeded IDs and required
    roles. Record desktop/mobile and light/dark evidence, explicitly list any inaccessible role or
    unprovoked state, update the table authoring guide, then mark the plan implemented and move it to
    `plans/implemented/phase-3/` only when no open or partial task remains.
  - Verify: `pnpm ci:local` is fully green; the browser walk confirms all classified visual tables,
    all five states and all supported renderers; `pnpm plans:check-tasks` and
    `pnpm plans:check-implemented` pass after archival.

## What was decided differently, and why

Three things this plan asked for were not built as written. Each is recorded here rather than
quietly dropped, because a task list that ticks every box while the code says otherwise is the
failure `pnpm plans:check-implemented` exists to prevent.

**Members and invitations were not merged into one row model.** The task makes the merge conditional
— "when they share the same schema" — and they do not: they are two registered capabilities with two
keyset cursors, and this plan's own reality check forbids replacing the server-owned query model. A
merged client-side list would mean one of the two stopped being server-paginated, which is the
regression phase 3 exists to remove. Both tables are classified and both read the same tokens; what
they do not share is one query.

**The floating selection bar has no visual baseline.** It was rebuilt (a zero-height sticky dock,
so ticking a checkbox no longer pushes every row down 40px) and it is covered in
`DataTable.test.tsx`, but **no surface in the app passes `selectable` today** — so there is no route
on which to photograph it. A permanently-skipped screenshot test is noise, so the capture was
dropped rather than left in place looking like coverage.

**Four of the reference's literals ship at different values.** The specification that supplied them
also requires WCAG AA, and four roles do not clear it on the surface they sit on. Each moved one step
down the reference's own stone ramp; all four are pinned in
[`accessibility.test.ts`](../../../../tests/unit/shared/lib/accessibility.test.ts) and tabulated in
[`docs/visual-system.md`](../../../../docs/visual-system.md).

## What the browser found that the tests could not

Two defects shipped inside this plan and were caught before it closed, both by evidence the plan
asked for and neither by a unit test:

- **An invisible span scrolled the whole document.** `.sr-only` is `position: absolute`, and neither
  `overflow: clip` nor `overflow: auto` clips an absolutely-positioned descendant whose containing
  block sits outside them. One 1px span inside an `EmptyCell` in a horizontally-scrolled table pushed
  `documentElement.scrollWidth` 226px past the viewport on `/admin/operations`, with nothing visibly
  wrong. Fixed by making the scroller and the container positioned; now asserted in
  `data-tables.spec.ts` and `responsive-device-matrix.spec.ts`.
- **The 44px actions column held two wrapping buttons.** Only the first visual baseline showed it:
  "Track & open" and "Open source profile" each wrapped to three lines and spilled into the column
  beside them, which is where the sprint-results 74px rows came from. `BuilderResultActions` gained a
  `compact` layout — one icon action plus an overflow menu — leaving every card call site unchanged.
