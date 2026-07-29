# Tasks — row virtualization

> **Status**: `pending`
> **Depends on**: [`05-table-shell`](../05-table-shell/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `useBentoDensity` (`src/modules/dashboard/ui/bento/useBentoDensity.ts`) is the existing density preference to reuse.

- [ ] **Add the virtualizer dependency, nothing else**
  - Files: `package.json`, `pnpm-lock.yaml`
  - Do: `pnpm add @tanstack/react-virtual`.
  - Verify: `pnpm install --frozen-lockfile` succeeds; `pnpm build` succeeds.

- [ ] **Write the virtualization hook with the focus pin**
  - Files: `src/shared/components/table/useTableVirtual.ts`,
    `tests/unit/shared/components/table/useTableVirtual.test.ts`
  - Do: wrap `useVirtualizer` with a fixed `estimateSize` per density (40px comfortable, 34px
    compact). **Force the focused row index into the render range** alongside overscan, and
    re-apply DOM focus to the matching cell after a remount. Without this the focused cell
    unmounts on scroll and focus falls to `<body>`.
  - Verify: `pnpm test tests/unit/shared/components/table/useTableVirtual.test.ts` asserts the
    focused index appears in the returned range even when it is far outside the scroll window.

- [ ] **Render through the virtualizer**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/shared/components/table/renderers/TableRenderer.tsx`,
    `src/shared/components/table/renderers/GroupedRenderer.tsx`
  - Do: render the virtual window instead of every loaded row. Group rows are **items in the
    virtual list**, not DOM outside it, so sticky offsets stay correct. `aria-rowindex` from the
    absolute index; `aria-rowcount` from `PageResult.total`.
  - Verify: with a 500-row fixture, count rendered `[role="row"]` nodes and confirm it stays within
    the window while `aria-rowcount` reads 500.

- [ ] **Bind row height to the existing density preference**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/modules/dashboard/ui/bento/useBentoDensity.ts`
  - Do: reuse the stored `bh.dashboard.density` preference for row height. Read it in an effect,
    never during render — the hook's own comment explains that reading during render costs a
    hydration mismatch.
  - Verify: toggle density, reload, confirm the height persists and the console shows no hydration
    warning.

- [ ] **Decide and record what the board renderer does**
  - Files: `src/shared/components/table/renderers/BoardRenderer.tsx`,
    `06-row-virtualization/spec.md`
  - Do: either virtualize per column or skip virtualization for the board. Whichever is chosen,
    record it in the spec — an unrecorded skip reads as coverage that does not exist.
  - Verify: the spec's board edge case names the decision actually implemented.
