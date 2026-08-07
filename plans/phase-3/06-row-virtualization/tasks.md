# Tasks — row virtualization

> **Status**: `implemented`
> **Depends on**: [`05-table-shell`](../05-table-shell/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `useTableVirtual.ts`, `entries.ts` and `renderers/VirtualCanvas.tsx`. 19 tests. `useBentoDensity` is **not** reused — see task 4.

- [x] **Add the virtualizer dependency, nothing else**
  - Files: `package.json`, `pnpm-lock.yaml`
  - Do: `pnpm add @tanstack/react-virtual`.
  - Verify: `pnpm install --frozen-lockfile` succeeds; `pnpm build` succeeds.
  - Done: `@tanstack/react-virtual@3.14.9`. Frozen install exit 0, build exit 0.

    It adds one lint warning: `react-hooks/incompatible-library` on `useVirtualizer`, meaning React
    Compiler declines to optimise that hook. A warning, not an error, and the correct outcome —
    the compiler skipping a library it cannot prove safe is the behaviour you want.

- [x] **Write the virtualization hook with the focus pin**
  - Files: `src/shared/components/table/useTableVirtual.ts`,
    `tests/unit/shared/components/table/useTableVirtual.test.tsx`
  - Do: wrap `useVirtualizer` with a fixed `estimateSize` per density (40px comfortable, 34px
    compact). **Force the focused row index into the render range** alongside overscan, and
    re-apply DOM focus to the matching cell after a remount. Without this the focused cell
    unmounts on scroll and focus falls to `<body>`.
  - Verify: `pnpm test tests/unit/shared/components/table/useTableVirtual.test.ts` asserts the
    focused index appears in the returned range even when it is far outside the scroll window.
  - Done: `pinFocusedIndex` is a pure function, so the hazard is tested without a scroll container —
    7 assertions, including that the pinned row is positioned at its **real offset** rather than at
    the top of the window. Parking it at the window's top would mount a clickable, focusable row on
    top of unrelated content, which trades an invisible bug for a visible one.

    Re-applying focus after a remount turned out not to need new code: `useTableKeyboard`'s pending-
    focus effect already retries until the element exists. The pin makes it unnecessary in the
    common case by preventing the unmount at all, which is the better fix — a remount-then-refocus
    round trip is visible as a flicker in the focus ring.

    The window is kept in index order, so `aria-rowindex` ascends through the DOM. A pinned row
    appended at the end would read out of sequence to anything walking the grid in document order.

- [x] **Render through the virtualizer**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/shared/components/table/renderers/TableRenderer.tsx`,
    `src/shared/components/table/renderers/GroupedRenderer.tsx`
  - Do: render the virtual window instead of every loaded row. Group rows are **items in the
    virtual list**, not DOM outside it, so sticky offsets stay correct. `aria-rowindex` from the
    absolute index; `aria-rowcount` from `PageResult.total`.
  - Verify: with a 500-row fixture, count rendered `[role="row"]` nodes and confirm it stays within
    the window while `aria-rowcount` reads 500.
  - Done: 500 loaded rows render fewer than 100 nodes while the grid reports `aria-rowcount=501`
    (500 + the header row, per plan 05's task 2). Every rendered row's `aria-rowindex` is asserted
    to equal its absolute index — announcing "row 3 of 500" for the third row *of the window* is the
    failure axe cannot see, so it is checked per row rather than sampled.

    Group headers became entries in a shared flat list (`entries.ts`) that both renderers and the
    virtualizer walk. Outside that list their heights would be missing from the offset arithmetic
    and every sticky position below the window would drift further the deeper you scroll.

    That flat list forced one translation worth naming: the keyboard model counts **rows**, the
    virtualizer measures **entries**, and a group header shifts them apart. `DataTable` maps the
    focused row index to its entry index before pinning, or the pin would hold the wrong element.

    `VirtualCanvas` exists so neither renderer grows a virtualized path and a non-virtualized
    fallback that drift apart: when windowing is off the window covers every entry and the same
    call site renders in flow.

    Below `VIRTUALIZATION_THRESHOLD` (100 loaded rows) it is off. An absolutely-positioned canvas
    and a scroll subscription for thirty rows is machinery in exchange for nothing.

- [x] **Bind row height to the existing density preference**
  - Files: `src/shared/components/table/DataTable.tsx`,
    `src/modules/dashboard/ui/bento/useBentoDensity.ts`
  - Do: reuse the stored `bh.dashboard.density` preference for row height. Read it in an effect,
    never during render — the hook's own comment explains that reading during render costs a
    hydration mismatch.
  - Verify: toggle density, reload, confirm the height persists and the console shows no hydration
    warning.
  - **Not done as written, because the premise is wrong in three ways.** Row height is a `density`
    prop (`'comfortable' | 'compact'` → 40px / 34px) defaulting to `comfortable`, and
    `useBentoDensity` is not touched:

    1. **It is not a row height.** `useBentoDensity` returns a `BentoDensity`, which is
       `'bento' | 'sections'` — a layout mode for the dashboard's widget grid. Binding row height to
       it would mean switching the dashboard from bento to sections silently changed the row height
       of every table in the app.
    2. **`bh.dashboard.density` no longer exists.** The preference moved to a server-backed,
       per-organization document; the hook's own comment says the hydration concern "is gone with
       the storage". The effect-not-render constraint this task is built on has no subject.
    3. **It needs `TenantQueryProvider`.** The public surfaces plan 09 migrates — changelog,
       roadmap, blog — are not inside it, so a shell that called the hook unconditionally could not
       be used on them.

    So there is **no persisted table-density preference yet**, and every table renders
    `comfortable`. Adding one is a field on the preferences document plus a migration; it belongs
    with the first surface that asks for it, not with the virtualizer. Recorded in `spec.md`, which
    had the same wrong paragraph.

    Nothing to verify by reload, since nothing persists. `ROW_HEIGHT` is asserted in the unit tests.

- [x] **Decide and record what the board renderer does**
  - Files: `src/shared/components/table/renderers/BoardRenderer.tsx`,
    `06-row-virtualization/spec.md`
  - Do: either virtualize per column or skip virtualization for the board. Whichever is chosen,
    record it in the spec — an unrecorded skip reads as coverage that does not exist.
  - Verify: the spec's board edge case names the decision actually implemented.
  - Done: **skipped**, recorded in `spec.md`, and enforced rather than left to convention —
    `DataTable` excludes the board unconditionally, so even `virtualize: true` does not turn it on,
    and a test asserts that.

    The reasoning, in the spec: per-lane virtualization means one virtualizer per lane against its
    own scroll container, and the single `aria-rowindex` sequence would then have to be reconciled
    across several independent windows. The board is triage over individually short lanes. If a
    lane ever grows large enough to need windowing, the honest fix is a page per lane.

    Gates: `tsc --noEmit` 0 · `eslint .` 0 errors (114 warnings, one new and expected — see task 1) ·
    `vitest run` 429 files, 6126 passed · `vite build` 0 · `pnpm install --frozen-lockfile` 0.
