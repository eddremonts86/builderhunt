# Plan — row virtualization

> **Status**: `implemented`
> **Depends on**: [`05-table-shell`](../05-table-shell/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: One new dependency (`@tanstack/react-virtual`) and one hook plus a change inside `DataTable`. No surface changes.

## Sequence

1. **Add `@tanstack/react-virtual`** on its own.
2. **`useTableVirtual` with the focus pin from the start.** Not "virtualize, then fix focus" —
   adding the pin afterwards means a window where keyboard navigation is broken and the tests that
   would catch it do not exist yet.
3. **Wire it into `DataTable`** behind a fixed row height per density.
4. **Prove both hazards closed** with assertions, not inspection.

## Why this is a separate plan from the shell

Both failure modes are silent. A virtualized grid with broken focus looks perfect in a screenshot
and passes axe. Giving it its own plan means its own verification gate, rather than one line in a
nine-task checklist where "it scrolls" reads as done.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Focused cell unmounts and keyboard navigation dies | **High** if the pin is skipped | High — the feature breaks in exactly the case it exists for | Focus pin built in step 2, not retrofitted; e2e round-trip assertion |
| `aria-rowindex` reports the window position | Medium | High — accessibility regression axe cannot see | Index derived from the absolute row index; explicit assertion on the last rendered row |
| A wrong `estimateSize` causes scroll jitter | Low | Medium | Row height is a fixed token per density, so the estimate is exact; no dynamic measurement |
| Density read during render causes a hydration mismatch | Medium | Low — a console warning and a flash | Reuse `useBentoDensity`, which already reads localStorage in an effect and documents why |
| Group rows sit outside the virtual list and break sticky offsets | Medium | Medium | Group headers are items in the virtual list, asserted by a fixture with several groups |

## Rollback

Remove the hook and render all loaded rows again. The shell works without virtualization — it is
slower, not broken — so this is a genuine one-file revert.
