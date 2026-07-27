# Tasks — tenant-safe keyset pagination

> **Status**: `pending`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`04-sort-indexes`](../04-sort-indexes/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: Reuses `withTenantContext` and `requireTenantPrincipal`. No existing read path changes here.

- [ ] **Declare the capability type and registry**
  - Files: `src/shared/lib/table/capability.ts`, `tests/unit/shared/lib/table/capability.test.ts`
  - Do: `TableCapability` exactly as in `spec.md`, plus a `TABLE_CAPABILITIES` registry keyed by
    table id. Construction throws when `tiebreaker` is missing or a `defaultSort` id is absent
    from `sortable` — a broken capability must fail at import, not at request time.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability.test.ts`, including both throw cases.

- [ ] **Build the keyset page builder**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/keyset.test.ts`
  - Do: `buildKeysetPage(tx, capability, query, page): Promise<PageResult>`. Resolve ids through
    the capability only; append `capability.tiebreaker` to every `ORDER BY`; emit row-value tuple
    comparison; clamp `limit` to `TABLE_PAGE_SIZE`; run rows + `COUNT(*)` + one aggregate per
    declared facet in a single transaction. Honour `nullsLast`.
  - Verify: `pnpm test tests/unit/shared/lib/table/keyset.test.ts` — asserts the SQL contains the
    tiebreaker, contains no `offset`, and that an unknown sort id throws instead of falling back
    to `defaultSort`.

- [ ] **Compute facet counts that cannot disagree with the rows**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/facets.test.ts`
  - Do: per dimension, count with the other dimensions' filters applied but not this one's, in the
    same transaction as the rows.
  - Verify: `pnpm test tests/unit/shared/lib/table/facets.test.ts` — a two-dimension fixture where
    a naive implementation reports 0 for the active dimension's other values.

- [ ] **Prove the tenant boundary cannot be crossed**
  - Files: `tests/unit/security/table-keyset-isolation.test.ts`
  - Do: negative tenant A/B — organization A mints a cursor, organization B presents it, assert
    rejection. Assert a throw when `app.organization_id` is unset. Assert a filter value
    containing quotes and SQL keywords is bound as a parameter and changes nothing structural.
  - Verify: `pnpm test tests/unit/security/table-keyset-isolation.test.ts` and
    `pnpm security:boundaries` both green.

- [ ] **Wrap auth, parse and transaction in one handler**
  - Files: `src/shared/lib/table/handler.ts`
  - Do: `tablePageHandler({ capability, request, load })` — `requireTenantPrincipal`, parse with
    `tableSearchSchema`, run inside `withTenantContext`, return a `PageResult` DTO built from an
    explicit field allowlist, never a raw ORM row (output-minimisation rule). 400 on an unknown
    id or an invalid cursor.
  - Verify: `pnpm type-check`; first real use is plan 07.
