# Tasks — an index behind every sortable column

> **Status**: `pending`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: 114 indexes exist in `src/shared/lib/db/schema.ts` on 2026-08-07; recount at
> execution time. The migration is always the next free number allocated by `pnpm db:generate`.

- [ ] **Audit which sortable columns are already covered**
  - Files: `04-sort-indexes/plan.md` (record the result there)
  - Do: list every `sortable` entry across registered capabilities beside the existing index that
    covers it, if any. Start from `grep -n "index('" src/shared/lib/db/schema.ts`. Expect the
    `(organization_id, created_at)` composites to already cover most default sorts.
  - Verify: the list accounts for every `sortable` entry as covered or missing, with no
    unexamined remainder.

- [ ] **Declare the missing indexes and generate the migration**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new next-free migration allocated by
    `pnpm db:generate`)
  - Do: add a composite `(tenant?, sortColumn, tiebreaker)` per missing entry, in the declared
    direction, with matching `NULLS LAST` where the capability sets `nullsLast`. Lead with
    `organization_id` on tenant-private tables — RLS adds that predicate, so an index without it
    cannot be walked. Then `pnpm db:generate`.
  - Verify: **read the generated SQL** and confirm it contains only `CREATE INDEX` — no column,
    constraint or data change. `pnpm test:migrations:local` green.

- [ ] **Regenerate the migration hash manifest**
  - Files: `drizzle/migration-hashes.json`
  - Do: `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm test:migration-integrity` prints `{"valid":true,...}` and the reported migration
    count is exactly one above the pre-task count.

- [ ] **Make an unbacked sortable column fail the build**
  - Files: `tests/unit/shared/lib/table/capability-index.test.ts`
  - Do: cross-reference every `sortable` entry against the indexes declared in `schema.ts`; fail
    when no index's leading columns match `(tenant?, sortColumn, tiebreaker)`, including the
    `NULLS LAST` modifier. Exempt capabilities explicitly marked non-SQL (the file-backed blog
    library) rather than skipping by name pattern.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability-index.test.ts` passes; add a bogus
    sortable entry, confirm red, remove it.
