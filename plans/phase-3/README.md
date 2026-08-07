# Phase 3 — bounded reads, one table system

Every list in BuilderHunt is built independently and every read loads whatever the database
returns. This phase makes both uniform: one table shell with one interaction model, and no read
path anywhere that can return an unbounded result set.

## Why this phase exists

An audit of `src/` found **50 request-serving list reads with no `.limit()`**, plus 13 worker
scans and 11 scalar aggregates. `listPlatformUsersWithPlans` returns every user in the system;
`src/routes/api/sprints/$sprintId/results.ts:82-85` reads every result for a sprint, then
filters, sorts and slices **in memory** behind a base64 *offset* it calls a cursor. They work
today because the tables are small. Each is a latent incident, and it costs twice — once in
Postgres, again in a browser holding thousands of rows in a React list.

Meanwhile 19 surfaces render tabular data, only 5 with `<table>`, exactly 1 with sorting
(`src/modules/search/components/SearchPage.tsx`) and 0 with keyboard navigation.

## Non-negotiable principles

1. **Nothing loads a whole result set.** Every read declares one of three mechanisms — page,
   model-bounded, or batch — and a CI gate fails the build when it declares none.
2. **The default page is 50 rows**, exported once from `TABLE_PAGE_SIZE`. No route literals it.
3. **Partial data changes what is correct, not just what is fast.** Sorting 50 of 214 rows in the
   browser and calling it "sorted by score" is wrong, so filter, sort and group execute in SQL.
4. **Every sort is a total order.** A tiebreaker column is appended to every `ORDER BY`, or a
   50-row page boundary landing inside a tie duplicates or drops rows.
5. **Keyset for SQL-owned growing lists.** `OFFSET` is forbidden on BuilderHunt database list
   reads because it is O(offset) and shifts under concurrent writes. Federated third-party search
   uses bounded provider continuation/page state because BuilderHunt cannot impose a database
   keyset on APIs it does not own; that exception is explicit in plan 11.
6. **A column is only sortable when an index backs it.** Enforced by a unit test and an `EXPLAIN`
   assertion, not by discipline.
7. **A client never names a database column.** Sort and filter ids resolve through a per-table
   allowlist; an unknown id is a 400, not a query.
8. **Rows are virtualized**, so a 5,000-row scrollback costs the same DOM as 50.
9. **Table state lives in the URL** via `validateSearch`, so a filtered view is a link.

## The three mechanisms

"Paginate everything" is the right instinct and the wrong instruction for part of the original
audit snapshot: a deletion must cover every row, an accounting export must be complete, and a
worker must process every enabled alert. Plan 01 refreshes that inventory before implementation;
the durable rule is that every read declares its bound.

| Mechanism | For | Shape |
|---|---|---|
| **Page** | anything feeding a list UI that grows with usage | SQL keyset cursor, or signed provider continuation for federated APIs; `LIMIT 50`, `PageResult` |
| **Model-bounded** | maximum fixed by the data model (the 3 rows of `public_surface_indexing`, a user's organizations, seats for one org-day) | `.limit(n)` plus a comment naming why n is the ceiling |
| **Batch** | must cover everything (`hardDeleteAccountSubject`, `getAccountingExport`, and worker scans reported by the fresh inventory) | chunked cursor loop, never materialising the set |

Scalar aggregates (`sumSettledUnitsSince`, `getPlatformAccountMetrics`) are exempt by nature —
they return a number, not rows.

## Plans

Small and sequential. Plans 01–02 change no product behaviour; 03–06 are additive; 07 proves the
whole stack on one real surface before 08–12 repeat it.

| Order | Plan | Result |
|---|---|---|
| 1 | [`01-read-path-audit`](./01-read-path-audit/spec.md) | Every unbounded read found, classified, and measurable by a script |
| 2 | [`02-table-query-contract`](./02-table-query-contract/spec.md) | `ColumnDef`, `TableQuery`, `PageResult`, URL codec, signed cursor |
| 3 | [`03-keyset-pagination`](./03-keyset-pagination/spec.md) | Server-side filter/sort/group with a tenant-safe keyset page builder |
| 4 | [`04-sort-indexes`](./04-sort-indexes/spec.md) | An index behind every sortable column, guarded by a test |
| 5 | [`05-table-shell`](./05-table-shell/spec.md) | One ARIA grid: keyboard, selection, grouping, four states |
| 6 | [`06-row-virtualization`](./06-row-virtualization/spec.md) | Flat DOM cost, and a focused cell that survives scrolling |
| 7 | [`07-first-surface-sprint-results`](./07-first-surface-sprint-results/spec.md) | Real pagination end to end on one surface, plus the shared e2e spec |
| 8 | [`08-migrate-admin-surfaces`](./08-migrate-admin-surfaces/spec.md) | 7 admin/account surfaces on the shell |
| 9 | [`09-migrate-platform-content`](./09-migrate-platform-content/spec.md) | Changelog, roadmap, blog library — test ids preserved |
| 10 | [`10-migrate-tenant-surfaces`](./10-migrate-tenant-surfaces/spec.md) | Users, refunds, disputes, team, sprints, alerts |
| 11 | [`11-migrate-search`](./11-migrate-search/spec.md) | Search on the shell, semantic ranking preserved |
| 12 | [`12-bounded-reads-sweep`](./12-bounded-reads-sweep/spec.md) | The reads with no table UI: bounded or batched |
| 13 | [`13-pagination-ci-gates`](./13-pagination-ci-gates/spec.md) | The gate turns red on a new unbounded read |

## Dependency waves

```
01 ────────────────────────────────────────► 12 ──┐
02 ──► 03 ──► 04 ──┐                              │
02 ──► 05 ──► 06 ──┴──► 07 ──► 08 ──┬─────────────┼──► 13
                                    ├── 09 ───────┤
                                    ├── 10 ──► 11 ┘
```

01 and 02 can start in parallel. 08, 09 and 10 are independent of each other once 07 lands.

## Language

Plan files are English, per [`../_meta/conventions.md`](../_meta/conventions.md) rule 9. Phase 2's
Spanish is a documented one-off for sharing with a Spanish-speaking team and does not extend here.
