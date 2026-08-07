# Plan — an index behind every sortable column

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: One generated migration (`drizzle/0155_table_sort_indexes.sql` — the tip was `0154`, not `0114`) plus `capability-index.ts` and 13 tests.

## Audit result (2026-08-07)

Task 1 asked for every `sortable` entry beside the index covering it. `TABLE_CAPABILITIES` is empty
until plan 07, so the audit covers the one capability whose columns are already pinned down, in
[`07-first-surface-sprint-results/tasks.md`](../07-first-surface-sprint-results/tasks.md).

| Sortable column | Covered before | Now |
|---|---|---|
| `created_at` | **No.** `sprint_results_sprint_created_idx` leads with `sprint_id`, not the tenant, and has no trailing `id` | `sprint_results_org_sprint_created_id_idx` |
| `score` | No index at all | `sprint_results_org_sprint_score_id_idx` |
| `source` | Only `sprint_results_sprint_source_unique` `(sprint_id, source, source_id)` — wrong lead, wrong tail | `sprint_results_org_sprint_source_id_idx` |
| `country` | n/a — lives in the `profile` jsonb, so no `PgColumn` can name it | **Not indexed.** See below |
| `id` (tiebreaker) | `sprint_results_pkey` | unchanged |

Two things this contradicts, both in the plans rather than in the database:

1. **`sprint_results_sprint_created_idx` does not cover the default sort**, though plan 07's
   reality-check line says it does. RLS puts `organization_id = current_setting(…)` in every query,
   so an index that does not lead with the tenant cannot be walked; and without a trailing `id` the
   keyset tuple comparison needs a sort above the scan anyway. The old index is kept: the worker's
   per-sprint scans carry no tenant predicate and still use it.

2. **`country` cannot be declared sortable at all** with the current contract. It is a key inside
   the `profile` jsonb column and `SortableColumn.column` is a `PgColumn`. An expression index would
   back it, but there is no way to declare the sort, so adding the index here would be provisioning
   for something no capability can name. Plan 07 decides: drop `country` from `sortable`, or extend
   the capability to carry SQL expressions.

The other four migration plans (08–11) name their sortable columns only in prose. Rather than
guess indexes for capabilities that do not exist, the guard makes each of them pay for its own
migration when it registers — which is the "declaring a column sortable costs a migration" property
this plan is for.

## Sequence

1. **Audit the existing 85 indexes against the capabilities' `sortable` sets.** Most tenant tables
   already carry `(organization_id, created_at)`, which covers the common default sort for free.
   Write down what is already covered before generating anything.
2. **Declare only the missing indexes**, generate, regenerate the hash manifest.
3. **Add the guard test last**, against a schema that already satisfies it, so its first red run is
   a deliberate one.

## Why this comes before the UI

A header is either sortable or it is not, and that has to be true before a column header becomes
clickable. Wiring the shell first would mean shipping headers that sort correctly and slowly —
the hardest kind of regression to notice.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Index bloat: a composite per sortable column across 19 tables | Medium | Medium — write amplification and disk | Step 1 reuses existing composites; only genuinely missing indexes are added, and the list is reviewed before generating |
| The migration is generated with an unintended schema diff | Medium | High — an accidental column change reaching production | Read the generated `drizzle/0115_*.sql` before committing and confirm it is `CREATE INDEX` only; `pnpm test:migrations:local` rehearses it |
| Forgetting the hash manifest regeneration | **High** — it happened on `0082` and `0083` | Low — a red gate, caught locally | `verify-migration-integrity.mjs --write` is its own task with its own verify step |
| A `NULLS LAST` mismatch makes an index unusable while the guard passes | Medium | Medium — a slow sort that looks guarded | The guard checks the modifier; plan 13's `EXPLAIN` assertion catches what the guard cannot |

## Rollback

Index-only. `DROP INDEX` is safe and immediate, and no application code depends on an index beyond
its speed. If the phase is abandoned the indexes are harmless to keep.
