# Tasks — tenant-safe keyset pagination

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`04-sort-indexes`](../04-sort-indexes/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: `capability.ts`, `keyset.ts` and `handler.ts` live in `src/shared/lib/table/`. 48 tests across `capability.test.ts`, `keyset.test.ts`, `facets.test.ts` and `tests/unit/security/table-keyset-isolation.test.ts`. No existing read path changed; plan 07 is the first caller.

- [x] **Declare the capability type and registry**
  - Files: `src/shared/lib/table/capability.ts`, `tests/unit/shared/lib/table/capability.test.ts`
  - Do: `TableCapability` exactly as in `spec.md`, plus a `TABLE_CAPABILITIES` registry keyed by
    table id. Construction throws when `tiebreaker` is missing or a `defaultSort` id is absent
    from `sortable` — a broken capability must fail at import, not at request time.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability.test.ts`, including both throw cases.
  - Done: 9 tests. Both required throw cases, plus four the spec implies and does not list — an
    empty `defaultSort` (page one would have no deterministic order), a `defaultSort` mixing
    directions (a tuple comparison has one), a `groupable` id with no column behind it, and a
    column belonging to a different table than the tiebreaker's.

    Two fields were added to the declared interface:
    - `filterable[id].facet?: boolean` — the spec says facets are opt-in per capability but does
      not say where the opt-in lives. On the dimension, because that is where the cost is.
    - `organizationColumn?: PgColumn` — the spec's example SQL emits
      `organization_id = current_setting(…)` and the interface had no way to name that column.
      This is the security policy's two-layer rule made concrete: RLS is forced and would exclude
      other tenants on its own, and the predicate is emitted anyway so a table whose policy is
      ever dropped fails closed at the query. `table-keyset-isolation.test.ts` runs with RLS
      absent precisely so it is testing this layer and not the other one.

- [x] **Build the keyset page builder**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/keyset.test.ts`
  - Do: `buildKeysetPage(tx, capability, query, page): Promise<PageResult>`. Resolve ids through
    the capability only; append `capability.tiebreaker` to every `ORDER BY`; emit row-value tuple
    comparison; clamp `limit` to `TABLE_PAGE_SIZE`; run rows + `COUNT(*)` + one aggregate per
    declared facet in a single transaction. Honour `nullsLast`.
  - Verify: `pnpm test tests/unit/shared/lib/table/keyset.test.ts` — asserts the SQL contains the
    tiebreaker, contains no `offset`, and that an unknown sort id throws instead of falling back
    to `defaultSort`.
  - Done: 24 tests, asserting on rendered SQL rather than on behaviour that implies it. Planning
    is split from execution (`planKeysetPage` is pure, `buildKeysetPage` runs it) for exactly that
    reason: a test that has to reach a database to find out whether the tiebreaker is in the
    `ORDER BY` is a test nobody writes.

    **`nullsLast` needed two forms, not a flag on one.** A row-value comparison has no notion of
    null ordering, so on a nullable column `(ends_at, id) > (:a, :b)` silently skips rows on one
    side of the null boundary — the failure `nullsLast` exists to prevent, reintroduced by the
    syntax the spec's example uses. So: row-value comparison when every sort column is `NOT NULL`
    (the common case, and the form plan 04's `EXPLAIN` assertions want), and the lexicographic
    OR-form with `IS NOT DISTINCT FROM` chains when any column is nullable. `IS NOT DISTINCT FROM`
    rather than `=`, because `null = null` is null and would drop the branch entirely.

- [x] **Compute facet counts that cannot disagree with the rows**
  - Files: `src/shared/lib/table/keyset.ts`, `tests/unit/shared/lib/table/facets.test.ts`
  - Do: per dimension, count with the other dimensions' filters applied but not this one's, in the
    same transaction as the rows.
  - Verify: `pnpm test tests/unit/shared/lib/table/facets.test.ts` — a two-dimension fixture where
    a naive implementation reports 0 for the active dimension's other values.
  - Done: 7 tests against a real disposable Postgres, on the fixture the checklist describes —
    six rows over `source` × `matchedVariant`. With `source=gitlab` selected, the naive
    implementation reports `github: 0`; this one reports `github: 4`, which is what the user would
    switch to. The mirror case is asserted too: `matchedVariant` *does* narrow to gitlab's rows,
    because a chip promising rows the table will not show is the opposite failure.

    Two more that were not asked for and belong here: `total` is the filtered set rather than the
    page, and a six-row table walked two at a time returns each row exactly once — the assertion
    that actually proves there is no `OFFSET` drift.

    Facet rows are capped at `FACET_VALUE_LIMIT` (50). A facet is a list read, and "nothing loads
    a whole result set" does not stop being true because the rows are counts.

- [x] **Prove the tenant boundary cannot be crossed**
  - Files: `tests/unit/security/table-keyset-isolation.test.ts`
  - Do: negative tenant A/B — organization A mints a cursor, organization B presents it, assert
    rejection. Assert a throw when `app.organization_id` is unset. Assert a filter value
    containing quotes and SQL keywords is bound as a parameter and changes nothing structural.
  - Verify: `pnpm test tests/unit/security/table-keyset-isolation.test.ts` and
    `pnpm security:boundaries` both green.
  - Done: 8 tests, `security:boundaries` green ("Tenant boundary ratchet passed").

    The disposable harness does not enable RLS, and that is what makes the file worth having: the
    layer under test is the emitted `organization_id` predicate and the organization-bound cursor,
    not the policy. If either were the tautology it looks like, org B would read org A's rows here.

    Beyond the three required: org B's *facet counts* stay inside the boundary (`github` exists in
    the table and not in B's counts); the same cursor is accepted by the organization that minted
    it, so the rejection is about the boundary and not about cursors being broken; and
    `app.organization_id` set to the empty string is refused as firmly as unset, which is the
    shape `set_config` leaves behind after a failed context.

    The injection assertion is deliberately loud. If the filter value were interpolated,
    `github'); drop table sprint_results; --` would drop the table and every later assertion in
    the file would fail with "relation does not exist" rather than with a diff.

- [x] **Wrap auth, parse and transaction in one handler**
  - Files: `src/shared/lib/table/handler.ts`
  - Do: `tablePageHandler({ capability, request, load })` — `requireTenantPrincipal`, parse with
    `tableSearchSchema`, run inside `withTenantContext`, return a `PageResult` DTO built from an
    explicit field allowlist, never a raw ORM row (output-minimisation rule). 400 on an unknown
    id or an invalid cursor.
  - Verify: `pnpm type-check`; first real use is plan 07.
  - Done. Authentication happens before parsing, per `security:auth-before-validate`: a parse error
    answered first tells an anonymous caller which parameters the endpoint takes. `TableQueryError`
    and `TableCursorError` both map to 400 — an unknown sort id and a forged cursor are the same
    thing from the server's side, and a 403 would confirm that the thing named exists.

    The explicit field allowlist is the `load` callback's `select` projection, and `mapRow` is
    where the DTO is built; `buildKeysetPage` strips its own internal cursor columns before
    handing rows over, so a projection cannot leak them by accident.

    `tsc --noEmit` exit 0. Not re-exported from `index.ts` — it reaches the auth and database
    layers, and `index.ts` is what the shell imports (see 02's task 4).
