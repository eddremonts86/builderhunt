# Tasks — migrate search onto the table shell

> **Status**: `implemented`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Keyword search is a live federation, not a Drizzle query. Semantic search has
> both SQL and federation legs. Preserve source health, degradation and fallback metadata.

- [x] **Record deterministic before-images of both search modes**
  - Files: `tests/e2e/fixtures/search-ranking.json`, `tests/e2e/search.spec.ts`
  - Do: capture ordered first-page ids and source-health/mode metadata for a fixed keyword query and
    semantic query against the seeded harness before changing code. Normalize timestamps/durations;
    do not hide source order or health.
  - Verify: two consecutive runs produce byte-identical fixture content.
  - **Done, and the recording is what made the next five tasks checkable.** 60 fused ids across two
    sources, plus per-source health and the degraded flag; two recording runs produced a
    byte-identical file (`cmp` on the two, not a visual diff).

    Determinism comes from two seams that already existed. Keyword mode never contacts a connector:
    the spec seeds the app's own Redis cache under the exact key `search.ts` computes, and the rows
    carry no `metadata.lastSeen`, which is the only input `scoreBuilders` derives from `Date.now()`.
    Semantic mode uses `E2E_EMBEDDINGS_SCENARIO=success`, whose `deterministicE2EVector` is a pure
    hash, so the spec can seed rows at *chosen* distances from the query's own vector.

    **The semantic similarities are seeded far apart on purpose, and that is a finding rather than a
    convenience.** The local leg ordered by `ORDER BY embedding <=> $vec` and nothing else — no
    tiebreaker — so two rows at the same distance came back in whatever order the index produced. A
    before-image over tied rows would have recorded noise and failed on its second run. Task 4 is
    what makes tied rows recordable; until it existed, a deterministic before-image could only be
    taken over distinct distances.

    `durationMs` is dropped from the fixture rather than normalised to a placeholder. A cache hit
    reports 0 for it anyway, and a field whose only honest value is "not measured" invites someone
    to read meaning into it.

- [x] **Define a signed, bounded provider continuation**
  - Files: `src/lib/search-continuation.ts`, `tests/unit/lib/search-continuation.test.ts`
  - Do: encode version, normalized-query fingerprint, mode, filters, access scope, enabled-source
    snapshot and bounded per-source continuation/page state. Sign with the existing server signing
    secret and HMAC pattern. Reject tampering, expiry, query/filter/mode/scope/source mismatch and
    oversized payloads. Never accept a DB column name.
  - Verify: unit tests cover every rejection independently and round-trip every active connector's
    continuation shape; token size stays below the documented HTTP-header/query limit.
  - **Done: 49 tests.** Same construction as `shared/lib/table/cursor.ts` — base64url payload,
    HMAC-SHA256 over a versioned prefix, `timingSafeEqual` — with a different prefix, so neither
    token can be replayed as the other (asserted).

    "Bounded per-source page state" turned out to be a claim the fan-out cannot support, and the
    honest shape is different. `searchBuildersWithStatus` passes **one** `page` to every connector,
    so a per-source page number would be a change to how the federation pages rather than a property
    of the token. What *is* per-source is which sources answered, and that is what the snapshot
    carries and what the round-trip test covers at its widest — every implemented connector, which
    is also the token's worst-case size (well under 2 KB).

    "Never accept a DB column name" is asserted as a *structural* property, not a validation: the
    payload has no field a column name could go in. The semantic state is three fixed slots whose
    meaning is this module's code, and the test asserts the exact key set of both variants.

    `mode` accepts a **list** in the expectation. `/api/search/semantic` mints two — `semantic` when
    the vector leg answered, `hybrid` when it degraded — and which one a request resumes is decided
    by the token's own signed state kind, not by anything the client says. It is still a real check:
    a `keyword` or `keyword-fallback` token is in neither endpoint's list.

- [x] **Return bounded keyword pages without inventing keyset guarantees**
  - Files: `src/lib/search.ts`, `src/routes/api/search/builders.ts`,
    `tests/unit/routes/api/search-builders.test.ts`
  - Do: replace public `page/perPage` with the signed continuation at the route boundary while
    preserving provider-specific paging internally. Clamp each response to `TABLE_PAGE_SIZE`, return
    `total: null`, `consistency: 'provider-best-effort'`, next cursor, source statuses and degraded
    flag. Keep relevance as the only global sort.
  - Verify: two pages are bounded; query/source/filter cursor reuse is 400; disabled sources are not
    served from cache; source timeout/failure still yields partial results with truthful status.
  - **Done — and the response was never bounded by `perPage` at all.** Every connector is asked for
    `perPage` rows and the results are concatenated, so one response held up to `sources × 30`; the
    recorded before-image is 60 rows for a two-source query. `hasMore` compared that cross-source
    total against a per-source ask, so it was true on virtually every response, and nothing ever
    ended the walk. Worse, a connector that ignores its `page` parameter returns the same rows
    forever and dedup runs only *within* one fan-out — there was no natural end.

    `pageBuilderSearch` slices the fused ordering at `TABLE_PAGE_SIZE` and carries two numbers, not
    one: the provider page, and how many of its rows have been served. The second slice of a
    provider page costs **no upstream request** — it comes out of the same cache entry — and
    concatenating the slices reproduces the old response exactly, which is what the fixture asserts.
    `SEARCH_MAX_PROVIDER_PAGES = 10` is the end the old code had no way to reach.

    The test file is named for the route and tests `src/lib/search.ts`. Exporting a helper from a
    route module drags whatever it imports into the client bundle — `search.ts` reaches `postgres`
    through `repositories/search-sources` — and the route stays a thin wrapper precisely so this is
    testable without that.

    `resolveContactableSources` had to be extracted from `searchBuildersWithStatus`, because the
    snapshot has to be known *before* the fan-out: a token can only be checked against a set someone
    computed separately from the search that used it. Verified end to end by switching `hn` off in
    the register between two pages and getting a 400.

- [x] **Keyset-page the local semantic leg and preserve hybrid fallback**
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
  - **Done. 15 tests, four of them new properties an offset could not give.**
    The corpus is walked exactly once; a row inserted between two pages neither repeats nor shifts
    the boundary; and a page boundary *inside a distance tie* serves each row once — that last one
    is why the trailing `source, source_id` terms exist, and tied rows are ordinary here because a
    re-indexed profile keeps its vector.

    **The `EXPLAIN` guard had to be sharpened rather than relaxed.** The old assertion was
    `expect(plan).not.toContain('Sort Key:')`, and the new ORDER BY produces an `Incremental Sort`
    above the HNSW index scan — which is correct, since Postgres supplies the leading distance term
    from the index and sorts only inside each distance group. `Sort Key:` is emitted by both node
    kinds, so the assertion now matches the node line (`Sort  (cost=`) and additionally asserts the
    positive form, `Presorted Key: ((embedding <=>`. A substring that appears in a correct plan is a
    bad thing to assert the absence of.

    Two things the task did not anticipate:
    1. **The `SEMANTIC_MIN_LOCAL_MATCHES` gate had to learn about page two.** It asks "did the vector
       index have enough to say", which is a question about the query, not about page four. Left
       unchanged, walking to the tail of a genuinely good semantic result set would degrade to the
       federation the moment the last page came back short, and merge federated rows in behind a
       `hybrid` label the user never saw a reason for. It now applies to page one only.
    2. **The hybrid leg must skip the local query when resuming.** Those few local matches were all
       served on page one by definition — there were fewer than ten of them — so re-running the
       local leg would re-prepend the same rows to every page after it. A provider-kind continuation
       is the signal, and it comes from the signed token rather than from the client.

    `consistency` gained a third value rather than reusing one. `approximate` is what the vector leg
    is: a keyset, so no row is served twice or stepped over, but HNSW explores a candidate set and
    can miss a row outright. Calling that `provider-best-effort` would blame a third party for the
    index's own approximation; calling it `exact` would promise recall nothing here has.

    One deliberate gap, recorded rather than closed: the local index is filtered by the *requested*
    sources and does not consult the operator register at all. The continuation binds the register
    snapshot anyway, so a source switched off mid-session restarts the walk on both legs — the
    cheaper end of being wrong. Closing it properly is a permissions change, and this plan's
    non-goals say same behaviour, same permissions.

- [x] **Adapt both modes to the shared shell contract**
  - Files: `src/shared/lib/table/capabilities/search-builders.ts`,
    `src/modules/search/components/SearchPage.tsx`,
    `tests/unit/modules/search/components/SearchPage.test.tsx`
  - Do: define a non-SQL/provider-backed capability for keyword mode and a semantic adapter for the
    local leg. Use `PageResult` with `total: null` where unknowable, preserve cards/actions/test ids,
    and clear rows/cursor on every query/mode/filter/source change. Remove client sorting of the
    loaded prefix; hide unsupported sort controls.
  - Verify: component tests cover reset, degraded empty, retry-with-loaded-rows and unknown total;
    grep confirms no loaded-results `.sort()` remains in `SearchPage.tsx`.
  - **Done: 6 component tests, and the sort menu is gone rather than hidden.**
    It offered "Best match", "Most recent" and "Most followers", and all three re-sorted the rows the
    browser happened to hold. With up to `sources × 30` rows per response and infinite scroll
    appending more, "most followers" meant "the most-followed of what has loaded so far" and changed
    meaning on every scroll. Neither backend can sort a set it has not exhausted, so
    `searchBuildersCapability.sorts` is empty and says why. The tab split stays — partitioning
    loaded rows by kind is a different claim from ordering them.

    **A `ProviderCapability`, not a `TableCapability`.** Everything the latter says is about columns:
    which of *this table's* columns may reach an `ORDER BY`, a `WHERE`, a `GROUP BY`. A federation of
    thirteen APIs has no columns, no index for plan 04's guard to check, no injection surface to
    close, and no honest value for the required `tiebreaker: PgColumn`. Two shapes beat one shape
    with its fields left blank; a registry entry carries the reason, and plan 13's surface gate can
    read both registries. (`TableCapability.nonSql` stays for what it was added for — a file-backed
    collection that still has stable row identity.)

    **The shell needed three things a card-shaped row exposes.** `rowHeight`, because the virtualizer
    measures nothing and that is plan 06's deliberate boundary, so a surface whose row *is* a card
    has to declare its height. `chrome="minimal"`, because a one-column grid showing a
    column-visibility menu and a header reading "RESULT" above a list of people reads as a mistake —
    the header row stays in the accessibility tree, hidden visually, because `aria-rowcount` counts
    it. And a container-scroll `onLoadMore`: a windowed grid becomes its own `overflow-y: auto` box,
    so a surface's bottom-of-page sentinel is then either permanently visible (asking for every
    remaining page at once) or never visible (infinite scroll silently stopping at the hundredth
    row), and neither is fixable from outside the container.

    **"Preserve source health messaging" described something that did not exist.**
    `/api/search/builders` has reported per-source health since connector isolation landed and this
    page never read it, so a GitHub timeout and an empty result set looked identical. Zero results
    with an unanswered source now says so by name and suppresses the "try a different query" advice,
    which assumed the query was the problem. Confirmed in a real browser: the local deployment has no
    Reddit credentials, and the notice reads "Reddit — Not contacted — REDDIT_CLIENT_ID and
    REDDIT_CLIENT_SECRET not set".

    Two counts stopped lying: the header says "50 results so far" while a cursor remains, and the
    footer says "N loaded" rather than "N total" — the endpoints cannot report a total at all.

- [x] **Prove ranking, bounded DOM, and source semantics end to end**
  - Files: `tests/e2e/data-tables.spec.ts`, `tests/e2e/search.spec.ts`
  - Do: add both modes to the shared shell suite; compare first-page ids with the before-image;
    load 500 fixture rows and assert the rendered window stays bounded; exercise keyboard focus,
    tracking, provider failure on page two, mode switch and filter reset.
  - Verify: `pnpm test:e2e tests/e2e/search.spec.ts tests/e2e/data-tables.spec.ts` is green twice via
    `pnpm test:e2e:repeat`; `pnpm test:a11y` is green.
  - **Done: 25 tests, green twice — "Both runs agree across 25 tests".**
    The before-image comparison is the load-bearing one: the ordering recorded from the *unbounded*
    endpoint is reproduced by the bounded one, as 50 + 10 across two pages.

    **Search is not in `SURFACES`, and that is a statement rather than an omission.** Every assertion
    in that loop is about a SQL table — a sort id that reaches an `ORDER BY`, a facet computed over a
    column, a `total` counting the filtered set, query state in the URL. Search has none of them.
    Putting it in the loop would have meant asserting things that are false about this surface, so it
    gets its own block covering what the *shell* promises: a bounded DOM, absolute row indices, focus
    surviving the virtualizer, and an announced row count of `-1`.

    The 500-row fixture is one cache entry, not ten. A cache hit is restricted to the permitted
    sources and otherwise served whole — `perPage` reaches connectors, not the cache — so a single
    seeded entry gives provider page one a 500-row fused set, which is exactly the path under test.

    **Two versions of this spec were green while measuring nothing**, and both are worth recording.
    The first seeded a two-source cache key while the page sends its five default sources, so it
    missed the cache and asserted against forty-five rows off the live internet. The second walked
    "until the button disappears", which exhausted provider page one and fetched an unseeded page two
    — 517 rows. The walk is now exactly nine clicks, with the reason in the code.

    A third defect was in the test rather than the product: a bare `count()` immediately after
    `dismissOverlays` read the DOM before the mount-time search resolved. It passed alone and failed
    in a full-file run, which is the shape of every race.

    **`pnpm test:a11y` is red, and not because of this plan.** `/dashboard @ narrow` overflows by
    427px, attributed to `BarSeries`'s `sr-only` table and its `<caption>`. Verified pre-existing by
    stashing every change in this plan and re-running: the identical failure at 426px. `BarSeries.tsx`
    and `globals.css` are untouched on this branch. One attempted fix — `relative` on the widget
    wrapper, so the absolutely-positioned `sr-only` table anchors there — did not move the number, so
    it was reverted rather than left in as an unexplained edit. It belongs to whoever owns the
    dashboard's narrow layout; the a11y run is otherwise clean (81 checks, 0 critical/serious).
