# Specification — an index behind every sortable column

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `src/shared/lib/db/schema.ts` declares 85 indexes, several already the composite this plan needs — `sprint_results_sprint_created_idx`, `billing_ledger_entries_org_created_idx`, `organization_plan_changes_org_created_idx`. Sorting by score, followers, name or status is unindexed everywhere. The last migration is `drizzle/0114`, so this one is the next free index at execution time (`drizzle/0115` today); let `drizzle-kit generate` allocate it. `drizzle/migration-hashes.json` is an immutability manifest regenerated with `node scripts/db/verify-migration-integrity.mjs --write`.

## Problem

With `LIMIT 50`, an index the planner can walk returns 50 rows and stops. Without one, Postgres
sorts the entire matching set to find the top 50 — so adding pagination to an unindexed sort makes
the query *slower* than the unbounded read it replaced, and only in production, and only once a
tenant grows.

## Goal

Every column a capability declares sortable has a backing index in the same direction with the
tiebreaker trailing, and a test that makes it impossible to declare one without the other.

## Non-goals

- **New columns, constraints or data changes.** Index-only, so there is no expand-backfill-contract
  sequence and nothing to reverse beyond dropping an index.
- **Indexing filterable columns.** Filters narrow; the sort forces an ordering. Revisit only if a
  real filter proves slow.
- **Tuning slow queries** unrelated to table sorts.

## Shape

For each `sortable` entry, an index on `(tenant?, sortColumn, tiebreaker)` in the declared
direction. Tenant-private tables lead with `organization_id`, because RLS adds that predicate to
every query and an index without it cannot be walked.

Existing composites are reused, not duplicated. A second index on `(sprint_id, created_at)` when
`sprint_results_sprint_created_idx` already exists is pure write amplification.

## The guard

`tests/unit/shared/lib/table/capability-index.test.ts` cross-references every `sortable` entry in
every registered capability against the indexes declared in `schema.ts`, and fails when no index's
leading columns match. Declaring a column sortable then costs a migration, which is the correct
price.

This is a test rather than a review checklist because the failure it prevents is invisible
locally — a table scan over 200 rows is instant.

## Success metrics

- The generated migration (`drizzle/0115_*.sql` at today's tip) contains only `CREATE INDEX` statements.
- `pnpm test:migrations:local` and `pnpm test:migration-integrity` green at 116 migrations.
- The guard test fails when a bogus sortable entry is added and passes when it is removed.
- `EXPLAIN` on each capability's `defaultSort` shows an index scan and no `Sort` node above the
  limit — asserted in plan 13, which has a seeded database to run it against.

## Resolved edge cases

- **A low-cardinality sort column** (a two-value status). Still indexed as part of the composite,
  because the trailing tiebreaker makes the index usable for the keyset predicate even when the
  leading column barely discriminates.
- **Descending sorts.** Postgres walks a b-tree backwards, so one ascending index serves both
  directions — unless the sort mixes directions across terms, which plan 03 rejects.
- **`nullsLast` sorts.** The index needs a matching `NULLS LAST` or the walk is unusable; the guard
  checks the modifier, not only the column list.
- **A file-backed table.** `BlogLibrary` reads the filesystem, so no index applies; its capability
  is marked non-SQL and exempted explicitly rather than silently.
