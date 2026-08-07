# Plan — the table shell

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`06-row-virtualization`](../06-row-virtualization/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: All new files under `src/shared/components/table/`. No existing surface changes; plan 07 is the first consumer.

## Sequence

1. **Add `@tanstack/react-table`** as its own commit, so a dependency change is never mixed with
   behaviour.
2. **The grid skeleton** — roles, indices, CSS grid columns, sticky header. Static data.
3. **Keyboard, then selection.** Selection ranges depend on a caret position existing.
4. **The four states.**
5. **The four renderers**, table first, stacked last since it is the mobile default.

Static data throughout: the shell is verified against a fixture, not a live query, so a failure
here is unambiguous. Plan 07 is where it meets a real endpoint.

## Why the grid is a div tree

Decided here rather than in plan 06 because reversing it later means rebuilding the layout. Named
in the spec so it is not re-litigated per surface.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ARIA indices report the rendered position instead of the position in the full set | Medium | High — a screen reader hears "row 3 of 50" inside a 5,000-row list, and axe will not catch it | `aria-rowindex` derived from the absolute row index and `aria-rowcount` from `total`; explicit index assertions in plan 07's e2e spec, on top of `pnpm test:a11y` |
| Dropping `<table>` loses semantics reviewers expect | Medium | Medium | Roles and indices asserted in e2e; the two prose tables keep real `<table>`; rationale recorded in the spec |
| The shell grows per-table special cases | Medium | Medium — the thing this phase exists to prevent | Anything table-specific goes in a slot (`expansion`, `rowActions`, `toolbarExtra`); a second `if (table === …)` in the shell is the signal to add a slot instead |
| `data-testid` churn breaks the regression suite | High if forgotten | Medium | `rowTestId` is a required prop, not optional, so a caller cannot omit it by accident |
| One accent and hairline dividers drift toward per-surface styling | Low | Low | Colours come from `--color-bh-*` tokens only; `DESIGN.md` forbids raw hex in components |

## Rollback

New directory with one consumer at most (plan 07). Revert the directory and plan 07's two files.
