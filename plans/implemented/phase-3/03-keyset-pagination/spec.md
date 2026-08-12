# Specification — scope-safe keyset pagination

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`04-sort-indexes`](../04-sort-indexes/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `src/routes/api/sprints/$sprintId/results.ts:82-85` is the only cursor-shaped read and it filters, sorts and slices in memory over a full table read. Tenant context already exists (`withTenantContext`, `requireTenantPrincipal`) and RLS is forced after the 2026-07-27 cutover. `pnpm security:boundaries` and `scripts/check-tenant-boundaries.mjs` guard this area.

## Problem

Moving filter, sort and group into SQL means a client-supplied string ends up near a column
reference and a comparison value. That is the highest-risk endpoint shape in a multi-tenant app
with forced RLS — "sort by whatever column you name" is one bad line from a cross-tenant read.

It is also easy to get *quietly* wrong. `ORDER BY score DESC` is not a total order, and a 50-row
page boundary landing inside a tie means a row appears on two pages or on none.

## Goal

One SQL function — `buildKeysetPage` — and scope-specific request adapters that are the only places
table filtering, sorting and grouping reach SQL, safe by construction rather than by review.

## Non-goals

- **Indexes.** Declaring a column sortable is here; making it fast is plan 04.
- **UI.** Plan 05.
- **Migrating any caller.** Plan 07 is the first.

## Capability allowlist

A client never names a column. It names an **id**, resolved through a per-table descriptor:

```ts
export interface TableCapability {
  table: string
  /** Which server-resolved principal/context may execute this capability. */
  scope: 'tenant' | 'account' | 'platform' | 'public'
  /** An id absent here cannot reach SQL. */
  sortable: Record<string, { column: PgColumn; nullsLast?: boolean }>
  filterable: Record<string, { column: PgColumn; values?: readonly string[] }>
  groupable: readonly string[]
  /** Free-text search: ILIKE over these columns only. */
  searchable: readonly PgColumn[]
  /** Unique column appended to every ORDER BY, making the sort a total order. */
  tiebreaker: PgColumn
  /** Default sort when the URL carries none. Must be index-backed (plan 04). */
  defaultSort: Array<{ id: string; dir: 'asc' | 'desc' }>
}
```

An unknown id is a 400 — not a fallback to the default sort, and not a silent ignore. Either of
those teaches a caller that a typo is harmless and hides the bug until the day the id matters.

## Keyset, not offset

```sql
-- page 2 of: ORDER BY score DESC, id ASC
WHERE organization_id = current_setting('app.organization_id')
  AND (score, id) < (:lastScore, :lastId)
ORDER BY score DESC, id ASC
LIMIT 50
```

`OFFSET` is never emitted. It walks and discards every skipped row, and it shifts under
concurrent writes, so a row inserted during paging is seen twice or missed.

## Counts and facets

`total` and each facet dimension cost a query. All of them run in the **same**
`withTenantContext` transaction as the rows, so they cannot disagree with what was returned.
Facet dimensions are opt-in per capability; a table declaring none pays for two queries.

Facet counts within a dimension are computed with the *other* dimensions' filters applied but not
this one's, so multi-select chips show what each option would add rather than zero.

## Success metrics

- Generated SQL contains the tiebreaker on every `ORDER BY` and the string `offset` nowhere.
- An unknown sort id, an unknown filter id, and an out-of-allowlist filter value each throw.
- A tenant cursor crossing organizations, an account cursor crossing users, and any cursor crossing
  scope kinds are rejected.
- Each adapter proves its required context: tenant uses `withTenantContext`, account uses the
  authenticated subject context, platform uses `requirePlatformAdminPrincipal` plus the platform
  connection, and public uses an explicit public projection. No adapter falls back to a broader DB.
- `pnpm security:boundaries` green.

## Resolved edge cases

- **A nullable sort column.** `nullsLast` is part of the capability and the tuple comparison
  accounts for it — otherwise nulls make the keyset predicate skip rows.
- **Multi-column sort.** Tuple comparison over all terms plus the tiebreaker. Mixed directions
  across terms are rejected in this version rather than emitted incorrectly.
- **Search plus filters plus group.** Search narrows, filters narrow; grouping only affects
  presentation and aggregates and never changes which rows a page contains.
- **A table with no natural unique column.** It cannot be paginated safely, so the capability
  fails to construct at import time rather than at request time.
- **A filter/search/group change with an old cursor.** The normalized query fingerprint is part of
  the signed cursor, so it is rejected rather than mixing two result sets.
