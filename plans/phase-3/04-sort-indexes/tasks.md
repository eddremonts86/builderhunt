# Tasks — an index behind every sortable column

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: The migration this plan generated is `drizzle/0155_table_sort_indexes.sql`, not `0115` — the tip was `0154`, not `0114`, when it ran. `migration-hashes.json` covers 156 migrations. The guard is `src/shared/lib/table/capability-index.ts` with 13 tests.

- [x] **Audit which sortable columns are already covered**
  - Files: `04-sort-indexes/plan.md` (record the result there)
  - Do: list every `sortable` entry across registered capabilities beside the existing index that
    covers it, if any. Start from `grep -n "index('" src/shared/lib/db/schema.ts`. Expect the
    `(organization_id, created_at)` composites to already cover most default sorts.
  - Verify: the list accounts for every `sortable` entry as covered or missing, with no
    unexamined remainder.
  - Done, and the honest answer is **zero registered capabilities today** — `TABLE_CAPABILITIES` is
    empty until plan 07 declares the first one. Auditing "every sortable entry" would have been a
    one-line report saying nothing, so the audit covers the one capability whose columns plan 07
    already pins down (score, created-at, source, country on `sprint_results`) and the guard covers
    everything after it. Recorded in [`plan.md`](./plan.md).

    **The expectation in this task's own text did not survive contact.**
    `sprint_results_sprint_created_idx` exists and covers `created_at`, and plan 07's reality-check
    line says because of it "no new index is needed here". It is not usable for this: it leads with
    `sprint_id` rather than the tenant, and RLS adds `organization_id = current_setting(…)` to every
    query, so the planner cannot walk it. It also has no trailing `id`, so the keyset tuple
    comparison needs a sort above the scan regardless. It is kept — the worker's per-sprint scans
    carry no tenant predicate and still use it — and a tenant-leading composite was added beside it.

    **`country` cannot be made sortable as specified.** It lives inside the `profile` jsonb column,
    and `SortableColumn.column` is a `PgColumn`. An expression index would back it, but the
    capability type has no way to name an expression, so no index is added here for a column that
    cannot be declared. Plan 07 has to either drop `country` from `sortable` or extend the
    capability to carry SQL expressions; that is a contract decision, and it belongs where the
    surface is built.

- [x] **Declare the missing indexes and generate the migration**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0155_table_sort_indexes.sql`
  - Do: add a composite `(tenant?, sortColumn, tiebreaker)` per missing entry, in the declared
    direction, with matching `NULLS LAST` where the capability sets `nullsLast`. Lead with
    `organization_id` on tenant-private tables — RLS adds that predicate, so an index without it
    cannot be walked. Then `pnpm db:generate`.
  - Verify: **read the generated SQL** and confirm it contains only `CREATE INDEX` — no column,
    constraint or data change. `pnpm test:migrations:local` green.
  - Done: three indexes, all `(organization_id, sprint_id, sortColumn, id)`. `sprint_id` sits
    between the tenant and the sort column because every read of this table is scoped to one
    sprint, and an equality predicate there still leaves the planner an ordered range.

    The generated file is three `CREATE INDEX` statements and nothing else — read, not assumed.
    None carries `NULLS LAST`: all three columns are `NOT NULL`, so the modifier would be noise.
    The guard still checks it, on synthetic descriptors, so the rule is tested before the first
    nullable sort needs it.

    `verify-migrations-local.mjs` needs `TEST_MIGRATION_URL` pointing at a
    `builderhunt_security_test_*` database; run against a throwaway one it reports
    `{"firstRun":"ok","secondRun":"ok","applied":156}` — from zero, twice, so the migration is
    re-runnable and the whole chain still applies to an empty database.

- [x] **Regenerate the migration hash manifest**
  - Files: `drizzle/migration-hashes.json`
  - Do: `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm test:migration-integrity` prints `{"valid":true,"migrations":116}` (115 today + this one).
  - Done: `{"valid":true,"migrations":156}`. The plan's 116 was arithmetic on a stale tip; the count
    is 155 pre-existing migrations plus this one.

- [x] **Make an unbacked sortable column fail the build**
  - Files: `tests/unit/shared/lib/table/capability-index.test.ts`
  - Do: cross-reference every `sortable` entry against the indexes declared in `schema.ts`; fail
    when no index's leading columns match `(tenant?, sortColumn, tiebreaker)`, including the
    `NULLS LAST` modifier. Exempt capabilities explicitly marked non-SQL (the file-backed blog
    library) rather than skipping by name pattern.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability-index.test.ts` passes; add a bogus
    sortable entry, confirm red, remove it.
  - Done: 13 tests. The sweep over `TABLE_CAPABILITIES` is written as a sweep rather than a list, so
    plan 08's and plan 11's capabilities are checked the day they are registered without anyone
    remembering to come back here.

    The "add a bogus entry, confirm red, remove it" step is a permanent test instead of a manual
    ritual — `matchedVariant` is a real column with no index, and the assertion is that the guard
    reports it. Manual verification that is deleted afterwards verifies the guard once; this
    verifies it on every run.

    Four refusals are asserted separately, because they are four different ways to be wrong: no
    index at all, an index that does not lead with the tenant, an index that omits the trailing
    tiebreaker, and an index whose tiebreaker is not *immediately* after the sort column. Plus the
    `NULLS LAST` rule, on synthetic index descriptors so it is testable before a nullable sort
    exists.

    Direction is deliberately not checked: Postgres walks a b-tree backwards, so one ascending index
    serves both directions, and plan 03 already rejects the mixed-direction sort that would break it.

    Unique constraints and primary keys are read as indexes, because they are — otherwise every
    "sort by the tiebreaker" would demand a duplicate index over the primary key.

    `nonSql?: true` was added to `TableCapability` for the blog library's exemption. Explicit, so a
    table genuinely missing its indexes cannot be mistaken for one that never needed them.

    Full suite after the schema change: 424 files, 6039 passed, 23 skipped. `tsc --noEmit` 0,
    `eslint` 0 errors.
