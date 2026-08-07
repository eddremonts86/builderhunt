# Tasks — migrate search onto the table shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Keyword search is a live federation, not a Drizzle query. Semantic search has
> both SQL and federation legs. Preserve source health, degradation and fallback metadata.

- [ ] **Record deterministic before-images of both search modes**
  - Files: `tests/e2e/fixtures/search-ranking.json`, `tests/e2e/search.spec.ts`
  - Do: capture ordered first-page ids and source-health/mode metadata for a fixed keyword query and
    semantic query against the seeded harness before changing code. Normalize timestamps/durations;
    do not hide source order or health.
  - Verify: two consecutive runs produce byte-identical fixture content.

- [ ] **Define a signed, bounded provider continuation**
  - Files: `src/lib/search-continuation.ts`, `tests/unit/lib/search-continuation.test.ts`
  - Do: encode version, normalized-query fingerprint, mode, filters, access scope, enabled-source
    snapshot and bounded per-source continuation/page state. Sign with the existing server signing
    secret and HMAC pattern. Reject tampering, expiry, query/filter/mode/scope/source mismatch and
    oversized payloads. Never accept a DB column name.
  - Verify: unit tests cover every rejection independently and round-trip every active connector's
    continuation shape; token size stays below the documented HTTP-header/query limit.

- [ ] **Return bounded keyword pages without inventing keyset guarantees**
  - Files: `src/lib/search.ts`, `src/routes/api/search/builders.ts`,
    `tests/unit/routes/api/search-builders.test.ts`
  - Do: replace public `page/perPage` with the signed continuation at the route boundary while
    preserving provider-specific paging internally. Clamp each response to `TABLE_PAGE_SIZE`, return
    `total: null`, `consistency: 'provider-best-effort'`, next cursor, source statuses and degraded
    flag. Keep relevance as the only global sort.
  - Verify: two pages are bounded; query/source/filter cursor reuse is 400; disabled sources are not
    served from cache; source timeout/failure still yields partial results with truthful status.

- [ ] **Keyset-page the local semantic leg and preserve hybrid fallback**
  - Files: `src/lib/semantic/semantic-search.ts`,
    `src/shared/lib/repositories/public-builder-embeddings.ts`,
    `src/routes/api/search/semantic.ts`,
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
  - Do: replace local pgvector offset paging with a total-order cursor over distance, source and
    source id, bound to query-vector hash and filters. When local results degrade to federation,
    switch atomically to the provider-continuation kind and keep `mode` explicit. Never pass a
    federated result set to `buildKeysetPage`.
  - Verify: seeded pages have no duplicate ids; a row inserted between local pages does not duplicate
    or skip the original snapshot boundary; tampered/cross-query cursor fails; keyword fallback and
    entitlement tests stay green.

- [ ] **Adapt both modes to the shared shell contract**
  - Files: `src/shared/lib/table/capabilities/search-builders.ts`,
    `src/modules/search/components/SearchPage.tsx`,
    `tests/unit/modules/search/components/SearchPage.test.tsx`
  - Do: define a non-SQL/provider-backed capability for keyword mode and a semantic adapter for the
    local leg. Use `PageResult` with `total: null` where unknowable, preserve cards/actions/test ids,
    and clear rows/cursor on every query/mode/filter/source change. Remove client sorting of the
    loaded prefix; hide unsupported sort controls.
  - Verify: component tests cover reset, degraded empty, retry-with-loaded-rows and unknown total;
    grep confirms no loaded-results `.sort()` remains in `SearchPage.tsx`.

- [ ] **Prove ranking, bounded DOM, and source semantics end to end**
  - Files: `tests/e2e/data-tables.spec.ts`, `tests/e2e/search.spec.ts`
  - Do: add both modes to the shared shell suite; compare first-page ids with the before-image;
    load 500 fixture rows and assert the rendered window stays bounded; exercise keyboard focus,
    tracking, provider failure on page two, mode switch and filter reset.
  - Verify: `pnpm test:e2e tests/e2e/search.spec.ts tests/e2e/data-tables.spec.ts` is green twice via
    `pnpm test:e2e:repeat`; `pnpm test:a11y` is green.
