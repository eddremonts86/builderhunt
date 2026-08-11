# Tasks — the table shell

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`06-row-virtualization`](../06-row-virtualization/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `src/shared/components/table/` — 16 files. 68 unit tests across `grid-roles`, `useTableKeyboard`, `useTableSelection` and `DataTable`. `@tanstack/react-table@9` (not v8 — see task 1).

- [x] **Add the table dependency, nothing else**
  - Files: `package.json`, `pnpm-lock.yaml`
  - Do: `pnpm add @tanstack/react-table`. No other change in this commit.
  - Verify: `pnpm install --frozen-lockfile` succeeds; `pnpm build` succeeds.
  - Done, in its own commit. What installed was **v9.0.0**, a major whose API is not the one this
    plan's `spec.md` describes: v8's `manualSorting`/`manualFiltering`/`manualGrouping`/
    `manualPagination` flags are replaced by opt-in feature registration, and the flags only exist
    at all when their feature is registered. v9 ships a `./legacy` entry point with `useLegacyTable`,
    but its helpers are marked `@deprecated` on arrival, so that path is debt from day one.

    Confirmed with the repository owner before writing against it: **v9 native**. Its features are
    tree-shakable, which this repo cares about — a phase-1 plan already had to pull the admin
    metrics page out of everyone's bundle.

    The practical consequence is that "manual mode" is expressed by *not registering* the features
    rather than by setting four flags to `true`. See task 2.

- [x] **Build the ARIA grid skeleton**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/shared/components/table/grid-roles.ts`
  - Do: div tree with `role="grid"|row|columnheader|gridcell`, CSS grid template columns from
    `ColumnDef`, sticky header. `aria-rowcount` from a known `PageResult.total` and omitted when
    `total` is null; `aria-rowindex` from the **absolute** row index. `@tanstack/react-table` in manual mode. Required
    `rowTestId: (row) => string` prop forwarded as `data-testid`.
  - Verify: `pnpm type-check`, `pnpm lint`; render a 20-row fixture and confirm
    `aria-rowcount` reflects a `total` larger than the rendered rows.
  - Done. The fixture is a permanent test rather than a manual render: three loaded rows, `total:
    214`, and the assertion that the grid reports 214 and not 3.

    **`aria-rowcount` is `total + 1`, which diverges from this plan's success metric.** The metric
    says it "equals `PageResult.total`". Taken literally that is internally inconsistent: the header
    row carries `aria-rowindex={1}` and data rows run 2…215, so a count of 214 makes the last row
    announce "row 215 of 214". The metric's *intent* — never `rows.length` — is what is implemented
    and tested; the `+1` is the header row, and `grid-roles.test.ts` asserts the count and the
    indices describe the same sequence.

    **What TanStack Table actually contributes**, since v9 made it a choice: the column model and
    column-visibility state, and nothing else. No `rowSortingFeature`, no `rowPaginationFeature` —
    the server did that work, so registering them would create state slices for behaviour nothing
    may perform. Columns are registered as `display` columns because plan 02's `ColumnDef.cell` takes
    a row rather than a cell context; giving the library an accessor as well would leave the shell
    with two ideas about how a cell renders.

- [x] **Add keyboard navigation**
  - Files: `src/shared/components/table/useTableKeyboard.ts`,
    `tests/unit/shared/components/table/useTableKeyboard.test.tsx`
  - Do: roving tabindex with a single focusable cell; the full keymap from `spec.md`; a
    `navigation: 'cell' | 'row'` option defaulting to `cell`.
  - Verify: `pnpm test tests/unit/shared/components/table/useTableKeyboard.test.ts` covering
    arrows, `Home`/`End`, `PageUp`/`PageDown` clamping at both ends.
  - Done: 19 tests. Beyond the required clamping — the shift-range **anchor stays where the range
    started** (a moving anchor makes shift-arrow select two rows forever), `/` is left alone while
    the user is typing in an input, and arrow keys are not stolen from a cell's own textarea.

    Two React-correctness fixes the linter caught and that were real, not stylistic:
    - `move` used to compute inside a functional `setState` updater so it could see the current
      position. Extending a selection and requesting the next page are side effects, and React may
      call an updater twice. Callers pass their origin in instead.
    - The out-of-range clamp was an effect. One frame would then render with `tabIndex={0}` on a
      cell that no longer exists, and a Tab press in that frame leaves the grid. It is adjusted
      during render.

    `onReachEnd` fires on *arrival* at the last loaded row rather than on the key press, so a
    held-down arrow asks for the next page once instead of once per repeat.

    The test file needs a `renderHook`, and there is no `@testing-library/react` here. Rather than
    add one, `render-hook.tsx` wraps `react-dom/client` + `act` — the same primitives, and the same
    pattern `HydrationSignal.test.tsx` already uses.

- [x] **Add selection, honest about partial data**
  - Files: `src/shared/components/table/useTableSelection.ts`,
    `src/shared/components/table/SelectionBar.tsx`
  - Do: tri-state header checkbox meaning **loaded rows only**, `⇧`+arrow range extension, and a
    separate "Select all N matching" action that requests a predicate token. When the table
    provides no `selectAllMatching`, hide the action rather than render something that means
    something narrower than it says.
  - Verify: unit test asserts the header checkbox reports the loaded count, and that the
    select-all action is absent when the capability omits it.
  - Done: 12 tests. Both required assertions, plus the three that keep the two meanings from
    merging back together: the predicate selection does not check 3,204 boxes (those rows were never
    loaded), touching any row checkbox retires it, and changing the query retires it — a token
    minted for `status=open` must not survive a switch to `status=closed`.

    This is why selection is *not* `rowSelectionFeature`. The library's model is a row-id map, and
    the meaningful selection here is sometimes a predicate over rows that do not exist on the
    client. Two selection models would be one too many.

    The header checkbox's accessible name is "Select loaded rows", not "Select all".

- [x] **Render the four states**
  - Files: `src/shared/components/table/states/SkeletonRows.tsx`, `BlankState.tsx`,
    `FilteredEmptyState.tsx`, `ErrorRow.tsx`
  - Do: skeleton rows matching real column widths; **two separate** empty states — no data at all
    versus no rows matching the filters, the latter naming the active filters and offering to clear
    them; an inline error row that keeps loaded rows visible and offers retry.
  - Verify: a fixture drives all four; assertions land in plan 07's e2e spec.
  - Done, and the fixture is a test rather than a story: all four states asserted in
    `DataTable.test.tsx`, including that the error row keeps `result-r1` on screen and that
    filtered-empty names `gitlab` while blank does not appear.

    Skeleton rows are `aria-hidden`; the grid's `aria-busy` carries the state. Eight announced rows
    of nothing is worse than silence.

- [x] **Build the toolbar and command sheet**
  - Files: `src/shared/components/table/TableToolbar.tsx`, `TableCommandSheet.tsx`
  - Do: search input (`/` focuses it), facet chips carrying counts from `PageResult.facets`, group
    control, column-visibility control. `⌘K` opens the command sheet listing filter/sort/group
    verbs with their facet counts attached.
  - Verify: chips show counts from the fixture's `facets`; `⌘K` opens and `Esc` closes.
  - Done. Chips read 140 and 74 from the fixture's facets, asserted. `Esc` closing is Radix's
    `Dialog`, which the repo already uses and which also traps focus and restores it.

    The chips' counts come from the server and are never derived from loaded rows — a count computed
    here would be wrong the moment there is more than one page, which is always.

- [x] **Build the four renderers**
  - Files: `src/shared/components/table/renderers/{TableRenderer,GroupedRenderer,BoardRenderer,StackedRenderer}.tsx`,
    `src/shared/components/table/GroupRow.tsx`, `src/shared/components/table/index.ts`
  - Do: one model, four presentations selected by `?as=`. Group rows are sticky and show the
    server's aggregate for the whole group with the loaded count beside it — never a count derived
    from loaded rows alone, which is wrong and looks right. `stacked` is the default below `md`,
    driven by `ColumnDef.priority`.
  - Verify: switch renderers against one fixture and confirm no renderer re-implements filtering,
    sorting or grouping.
  - Done: all four render every fixture row, asserted per renderer. The "no renderer re-sorts"
    check is an explicit test — the fixture asks for `score` ascending, which would be r3/r2/r1, and
    every renderer shows the server's r1/r2/r3.

    The group total comes from `PageResult.facets[groupBy]`, which the server computed over the
    whole filtered set. That has a consequence worth carrying into plans 08–11: **a groupable
    dimension should also be declared a facet**, or the header has no honest total. When the facet
    is missing the header shows the loaded count alone rather than substituting it for the total —
    also asserted.

    `GridRow` is shared by the table and grouped renderers so the ARIA indices, the roving tabindex
    and the selection affordance are written once. Three renderers with their own rows would be
    three chances for `aria-rowindex` to drift from `aria-rowcount`.

- [x] **Check the visual contract**
  - Files: `src/shared/components/table/*`
  - Do: colours from `--color-bh-*` tokens only; control heights 32/36/44; 24px card frame;
    hairline dividers; numeric columns `font-variant-numeric: tabular-nums` and **not**
    `font-mono` (`DESIGN.md:221`).
  - Verify: `grep -nE '#[0-9a-fA-F]{3,6}|font-mono' src/shared/components/table/` returns nothing;
    `pnpm test:a11y` green.
  - Done: the grep is clean (exit 1). Colours are `bh-*` token classes throughout, controls are
    `h-8` or the shared `.btn-*` sizes, and the frame is the existing `.card`.

    **`pnpm test:a11y` was not run against the grid, because there is nothing to run it against
    yet.** It drives the live app with axe, and no route renders a `DataTable` until plan 07. Saying
    it is green here would mean it passed over pages that do not contain the component. Plan 07's
    first surface is where axe first sees the grid, and its checklist already runs it.

    Gates that were run, on the whole repository: `tsc --noEmit` 0 · `eslint .` 0 errors (113
    pre-existing warnings) · `vitest run` 428 files, 6107 passed, 23 skipped · `vite build` 0.
