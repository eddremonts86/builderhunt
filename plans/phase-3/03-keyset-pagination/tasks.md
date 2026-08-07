# Tasks — scope-safe keyset pagination

> **Status**: `pending`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`04-sort-indexes`](../04-sort-indexes/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: Reuses the existing tenant and platform principals/connections. Account and
> public adapters must be explicit too; no existing read path changes here.

- [ ] **Declare the capability type and registry**
  - Files: `src/shared/lib/table/capability.ts`, `tests/unit/shared/lib/table/capability.test.ts`
  - Do: `TableCapability` exactly as in `spec.md`, including mandatory `scope`, plus a
    `TABLE_CAPABILITIES` registry keyed by table id. Construction throws when `tiebreaker` is
    missing or a `defaultSort` id is absent
    from `sortable` — a broken capability must fail at import, not at request time.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability.test.ts`, including both throw cases.

- [ ] **Build the keyset page builder**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/keyset.test.ts`
  - Do: `buildKeysetPage(tx, capability, query, page): Promise<PageResult>`. Resolve ids through
    the capability only; append `capability.tiebreaker` to every `ORDER BY`; emit row-value tuple
    comparison; clamp `limit` to `TABLE_PAGE_SIZE`; run rows + `COUNT(*)` + one aggregate per
    declared facet in a single transaction. Honour `nullsLast`; bind the cursor to the normalized
    query fingerprint and the server-resolved access scope.
  - Verify: `pnpm test tests/unit/shared/lib/table/keyset.test.ts` — asserts the SQL contains the
    tiebreaker, contains no `offset`, and that an unknown sort id throws instead of falling back
    to `defaultSort`.

- [ ] **Compute facet counts that cannot disagree with the rows**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/facets.test.ts`
  - Do: per dimension, count with the other dimensions' filters applied but not this one's, in the
    same transaction as the rows.
  - Verify: `pnpm test tests/unit/shared/lib/table/facets.test.ts` — a two-dimension fixture where
    a naive implementation reports 0 for the active dimension's other values.

- [ ] **Prove no access scope can be crossed**
  - Files: `tests/unit/security/table-keyset-isolation.test.ts`
  - Do: negative tenant A/B and account A/B; assert rejection across tenant/account/platform/public
    scope kinds. Assert a throw when the capability's required context is unset. Assert a filter value
    containing quotes and SQL keywords is bound as a parameter and changes nothing structural.
  - Verify: `pnpm test tests/unit/security/table-keyset-isolation.test.ts` and
    `pnpm security:boundaries` both green.

- [ ] **Wrap auth, parsing, and DB context in scope-specific adapters**
  - Files: `src/shared/lib/table/handler.ts`
  - Do: expose tenant, account, platform and public adapters. Each checks that `capability.scope`
    matches, establishes only its own principal/connection context, parses `tableSearchSchema`, and
    returns an explicit allowlisted DTO rather than an ORM row. Unknown ids and invalid/mismatched
    cursors are 400; missing auth is 401/403 as appropriate.
  - Verify: handler unit tests prove the happy path and wrong-scope refusal for all four adapters;
    `pnpm type-check` is clean. The first real tenant use is plan 07.
