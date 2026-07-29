# Specification — migrate the admin and account surfaces

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Seven surfaces render rows today with no shared behaviour: `src/modules/dashboard/components/AbuseConsole.tsx` (a real `<table>`), `src/routes/_dashboard/admin/incidents.tsx`, `admin/plan-requests.tsx`, `src/modules/dashboard/components/ActiveSessionsPanel.tsx`, `src/routes/_dashboard/settings/privacy.tsx`, `me/index.tsx`, `src/modules/scheduling/components/InvitationStatus.tsx`. Their reads are already narrow, so this is mostly presentation.

## Problem

These are the seven surfaces where the current implementation is closest to acceptable and
furthest from consistent: seven header styles, no keyboard access, no shared empty state, and
selection nowhere.

## Goal

All seven on the shell, so the visible payoff of plans 02–07 arrives before the harder migrations.

## Non-goals

- **Redesigning what any of them shows.** Same columns, same actions, same data.
- **New filters or sorts** beyond what each already offers, except where a column is trivially
  sortable and the index already exists.
- **`HygieneCard`.** `src/shared/components/HygieneCard.tsx` contains table markup but is a
  summary card, not a data grid. Audit it and, if it is not a grid, record that and leave it.

## Why this group first

Their reads are already bounded or trivially boundable, so no repository work blocks them. That
makes them the cheapest proof that the shell survives contact with seven different shapes of data —
and any shell assumption that only fits sprint results shows up here, while the fix is still cheap.

## Per-surface notes

| Surface | Note |
|---|---|
| `AbuseConsole` | A real `<table>` today; becomes the ARIA grid. Signals are append-only, so created-at descending is the natural default sort. |
| `admin/incidents` | Has create/edit actions that move into `rowActions` and the `expansion` slot. |
| `admin/plan-requests` | An approve/deny queue; selection plus a bulk action is the first genuine use of "select loaded". |
| `ActiveSessionsPanel` | Account-subject data. Revoke stays a per-row action. |
| `settings/privacy` | Small, model-bounded lists (consents, export requests). One page is always the last page. |
| `me/index` | Several short lists on one page; each becomes its own small grid rather than one merged table. |
| `InvitationStatus` | Bounded by the invitation's slots; presentation only. |

## Success metrics

- All seven appear in `tests/e2e/data-tables.spec.ts`'s parameter list and pass every assertion.
- `grep -rl '<table' src/modules/dashboard src/routes/_dashboard/admin` returns nothing.
- Each surface's existing e2e or regression coverage still passes.
- `node scripts/check-unbounded-reads.mjs` count does not increase.

## Resolved edge cases

- **A list of three consent records under a 50-row page.** Page one is the last page; the footer
  reads "3 of 3". No branch, no special case.
- **Row actions that need a confirmation dialog.** The dialog is the surface's own concern, rendered
  from `rowActions`; the shell does not learn about confirmations.
- **`me/index`'s multiple lists.** Separate grids, because merging unrelated record types into one
  table to reuse a component is the wrong trade.
