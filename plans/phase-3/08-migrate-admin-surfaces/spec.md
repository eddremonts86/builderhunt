# Specification — migrate the admin and account surfaces

> **Status**: `implemented`
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
- **`HygieneCard` — audited, and it is not a grid.** `src/shared/components/HygieneCard.tsx:199`
  renders a four-column `<table>` of a builder's repositories (close rate, docs, CI) inside a
  summary card. It is a static comparison table over a handful of already-analysed repos: it does
  not grow with usage, has no sort, filter, selection or per-row action, and is read-only. `<table>`
  is the correct element for exactly that, and an ARIA grid is not — a grid promises keyboard
  traversal that would have nowhere to go. **Left alone.**

- **`InvitationStatus` — audited, and it is not a grid either.**
  `src/modules/scheduling/components/InvitationStatus.tsx:107` is a list of per-status cards, not
  rows: a `draft` shows a recipient address and a resume link, a `booked` one shows a timestamp and
  three different destinations, and the fields present differ per status. There are no columns to
  align, because no two rows show the same fields. A one-column grid holding a card gains the ARIA
  semantics of a list that already exists and aligns nothing. **Left alone**, with the same
  reasoning as `HygieneCard`.

- **`me/index` — audited, and it is not a grid.** `src/routes/_dashboard/me/index.tsx:175` renders
  a card per claimed builder profile: avatar, verification badge, topic chips, and an inline edit
  mode with topic editors and open-to selectors that replaces most of the card. Viewing and editing
  show different fields, and there is no column alignment to be had between an avatar-plus-bio
  block and another one. It is also model-bounded at one to three profiles. **Left alone**, same
  reasoning as `HygieneCard` and `InvitationStatus`. The plan's "keep the several short lists as
  separate grids" is the right instruction for a page that had several tabular lists; this page has
  one list of editors.

- **`admin/plan-requests` — the surface no longer exists.** `plan_requests` was dropped on
  2026-08-03 along with `plans` and `plan_changes` (`schema.ts:1058-1067`: the pre-organization
  billing model, 0 rows, every new request already refused by
  `LegacyPlanMutationDisabledError`). There is no route file. Its task was also where the plan
  placed "the first genuine use of select-loaded plus a bulk action"; that demonstration now has no
  host in this group, and `admin/access-requests` is the nearest live equivalent if it is wanted.

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
  **Not met** — see the closing note in `tasks.md`. The harness authenticates as an organization
  owner, the abuse console needs a platform admin, and two of these are components inside larger
  pages rather than table routes.
- `grep -rl '<table' src/modules/dashboard src/routes/_dashboard/admin` returns nothing.
  **One left, correctly**: `src/modules/dashboard/ui/BarSeries.tsx:91` is an `sr-only` `<table>`
  carrying the accessible text alternative for a bar chart — the data a sighted reader gets from the
  bars. Removing it would take the chart's accessibility with it. A chart's data table is the one
  place `<table>` markup in this directory is not a list waiting to be migrated.
- Each surface's existing e2e or regression coverage still passes.
- `node scripts/check-unbounded-reads.mjs` count does not increase.

## Resolved edge cases

- **A list of three consent records under a 50-row page.** Page one is the last page; the footer
  reads "3 of 3". No branch, no special case.
- **Row actions that need a confirmation dialog.** The dialog is the surface's own concern, rendered
  from `rowActions`; the shell does not learn about confirmations.
- **`me/index`'s multiple lists.** Separate grids, because merging unrelated record types into one
  table to reuse a component is the wrong trade.
