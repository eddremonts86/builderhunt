# Tasks — migrate search onto the shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `SearchPage.tsx` is 1,731 lines; its scroll loop is at 399-449 and its client sort at 157 and 496-504.

- [ ] **Record today's ranking as a fixture before changing anything**
  - Files: `tests/e2e/fixtures/search-ranking.json`
  - Do: capture the first page of results for one fixed keyword query and one fixed semantic query
    against a seeded database — ids in order. This is how "ranking preserved" becomes checkable.
  - Verify: the fixture is deterministic across two runs on the same seed.

- [ ] **Declare the search capability**
  - Files: `src/shared/lib/table/capabilities/search-builders.ts`
  - Do: sortable relevance (default), score, followers and last-active; filterable source, country
    and language; `tiebreaker` the builder id. Relevance means "preserve the order of the supplied
    id set", not an `ORDER BY` over a column.
  - Verify: plan 04's guard passes — add any missing index here rather than dropping the sort.

- [ ] **Paginate keyword search server-side**
  - Files: `src/routes/api/search/builders.ts`
  - Do: route through `tablePageHandler` + `buildKeysetPage`. Replace `page`/`perPage`/`hasMore`
    with a cursor and `total`.
  - Verify: page 1 and page 2 share no ids; the first page matches the keyword half of the recorded
    fixture exactly.

- [ ] **Paginate semantic search as a pre-filter pass-through**
  - Files: `src/routes/api/search/semantic.ts`
  - Do: the vector query still produces a ranked id set. Pass that set to `buildKeysetPage` as an
    **opaque pre-filter** and let the capability's relevance sort preserve its order. Do not
    translate relevance into the generic sort vocabulary — that would either lose the ranking or
    leak vector internals into the URL.
  - Verify: the first page matches the semantic half of the recorded fixture **exactly**, id for id,
    in order.

- [ ] **Move the result list onto the shell**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: replace the result list with `DataTable`. Delete the `sortBy` state (line 157) and its
    client-side application (496-504), and the `IntersectionObserver` loop (399-449) — but only
    after the shell's loop is in place, so scrolling is never broken in between. Leave the filter
    panel, source toggles and semantic mode switch alone; they are out of scope.
  - Verify: `grep -n 'perPage\|hasMore\|IntersectionObserver\|sortBy' src/modules/search/components/SearchPage.tsx`
    returns nothing; existing search e2e specs green.

- [ ] **Confirm the DOM stays flat while scrolling**
  - Files: `tests/e2e/data-tables.spec.ts`
  - Do: add search to the shared spec's parameter list, so the virtualization and focus-survival
    assertions cover the surface where they matter most.
  - Verify: `pnpm test:e2e tests/e2e/data-tables.spec.ts` green with search included; run twice via
    `pnpm test:e2e:repeat` to catch flakiness.
