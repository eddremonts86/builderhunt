# Tasks — the table shell

> **Status**: `pending`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`06-row-virtualization`](../06-row-virtualization/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: New files under `src/shared/components/table/`. `src/components/ui/` already provides Button, Input, Select, Checkbox, Dialog.

- [ ] **Add the table dependency, nothing else**
  - Files: `package.json`, `pnpm-lock.yaml`
  - Do: `pnpm add @tanstack/react-table`. No other change in this commit.
  - Verify: `pnpm install --frozen-lockfile` succeeds; `pnpm build` succeeds.

- [ ] **Build the ARIA grid skeleton**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/shared/components/table/grid-roles.ts`
  - Do: div tree with `role="grid"|row|columnheader|gridcell`, CSS grid template columns from
    `ColumnDef`, sticky header. `aria-rowcount` from `PageResult.total`, `aria-rowindex` from the
    **absolute** row index. `@tanstack/react-table` in manual mode. Required
    `rowTestId: (row) => string` prop forwarded as `data-testid`.
  - Verify: `pnpm type-check`, `pnpm lint`; render a 20-row fixture and confirm
    `aria-rowcount` reflects a `total` larger than the rendered rows.

- [ ] **Add keyboard navigation**
  - Files: `src/shared/components/table/useTableKeyboard.ts`,
    `tests/unit/shared/components/table/useTableKeyboard.test.ts`
  - Do: roving tabindex with a single focusable cell; the full keymap from `spec.md`; a
    `navigation: 'cell' | 'row'` option defaulting to `cell`.
  - Verify: `pnpm test tests/unit/shared/components/table/useTableKeyboard.test.ts` covering
    arrows, `Home`/`End`, `PageUp`/`PageDown` clamping at both ends.

- [ ] **Add selection, honest about partial data**
  - Files: `src/shared/components/table/useTableSelection.ts`,
    `src/shared/components/table/SelectionBar.tsx`
  - Do: tri-state header checkbox meaning **loaded rows only**, `⇧`+arrow range extension, and a
    separate "Select all N matching" action that requests a predicate token. When the table
    provides no `selectAllMatching`, hide the action rather than render something that means
    something narrower than it says.
  - Verify: unit test asserts the header checkbox reports the loaded count, and that the
    select-all action is absent when the capability omits it.

- [ ] **Render the four states**
  - Files: `src/shared/components/table/states/SkeletonRows.tsx`, `BlankState.tsx`,
    `FilteredEmptyState.tsx`, `ErrorRow.tsx`
  - Do: skeleton rows matching real column widths; **two separate** empty states — no data at all
    versus no rows matching the filters, the latter naming the active filters and offering to clear
    them; an inline error row that keeps loaded rows visible and offers retry.
  - Verify: a fixture drives all four; assertions land in plan 07's e2e spec.

- [ ] **Build the toolbar and command sheet**
  - Files: `src/shared/components/table/TableToolbar.tsx`, `TableCommandSheet.tsx`
  - Do: search input (`/` focuses it), facet chips carrying counts from `PageResult.facets`, group
    control, column-visibility control. `⌘K` opens the command sheet listing filter/sort/group
    verbs with their facet counts attached.
  - Verify: chips show counts from the fixture's `facets`; `⌘K` opens and `Esc` closes.

- [ ] **Build the four renderers**
  - Files: `src/shared/components/table/renderers/{TableRenderer,GroupedRenderer,BoardRenderer,StackedRenderer}.tsx`,
    `src/shared/components/table/GroupRow.tsx`, `src/shared/components/table/index.ts`
  - Do: one model, four presentations selected by `?as=`. Group rows are sticky and show the
    server's aggregate for the whole group with the loaded count beside it — never a count derived
    from loaded rows alone, which is wrong and looks right. `stacked` is the default below `md`,
    driven by `ColumnDef.priority`.
  - Verify: switch renderers against one fixture and confirm no renderer re-implements filtering,
    sorting or grouping.

- [ ] **Check the visual contract**
  - Files: `src/shared/components/table/*`
  - Do: colours from `--color-bh-*` tokens only; control heights 32/36/44; 24px card frame;
    hairline dividers; numeric columns `font-variant-numeric: tabular-nums` and **not**
    `font-mono` (`DESIGN.md:221`).
  - Verify: `grep -nE '#[0-9a-fA-F]{3,6}|font-mono' src/shared/components/table/` returns nothing;
    `pnpm test:a11y` green.
