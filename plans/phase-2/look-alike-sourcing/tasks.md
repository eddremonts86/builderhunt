# Look-alike Sourcing (tasks)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../semantic-search/tasks.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../proactive-discovery/tasks.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Extends shipped files only — `src/lib/semantic/embedding-doc.ts`, `src/lib/dedup.ts`, `src/shared/lib/repositories/public-builder-embeddings.ts`, `src/shared/lib/billing-shared.ts`, `src/modules/search/components/{PersonResultCard,SearchPage}.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `scripts/db/verify-api-isolation-local.mjs`. No new table, no migration, no new env var.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — Index payload enrichment (invisible, zero embedding cost)

- [ ] **Add optional `kind` and `lastActiveAt` to the stored embedding payload**
  - Files: `src/lib/semantic/embedding-doc.ts`
  - Do: Extend `embeddedProfileSchema` with `kind: z.enum(['person', 'repo']).optional()` and
    `lastActiveAt: z.number().int().optional()` (epoch ms). Extend `EmbeddableSource` with
    `kind?: string | null` and `metadata?: Record<string, unknown> | null` — `RawBuilder` already
    satisfies both structurally, so no call site changes. In `toEmbeddedProfile`, set
    `kind: profile.kind === 'repo' ? 'repo' : profile.kind === 'person' ? 'person' : undefined`
    and `lastActiveAt: typeof profile.metadata?.lastSeen === 'number' ? profile.metadata.lastSeen : undefined`.
  - Do NOT touch `buildEmbeddingDoc` or `contentHashOf` — a changed document invalidates every
    `content_hash` and re-embeds the entire index.
  - Verify: `pnpm test embedding-doc` and `pnpm type-check`.

- [ ] **Lock the content hash against accidental re-embed**
  - Files: `src/lib/semantic/embedding-doc.test.ts`
  - Do: Add a test asserting `contentHashOf(buildEmbeddingDoc(fixture))` equals a hard-coded
    sha256 literal for a fixed fixture profile, and that adding `kind`/`lastActiveAt`/`metadata`
    to that fixture does not change it. Add a test that `toEmbeddedProfile` round-trips both new
    fields and omits them when absent.
  - Verify: `pnpm test embedding-doc` — the hash test fails loudly if anyone edits the document
    template later.

- [ ] **Confirm the payload backfills without a migration**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts` (read-only check)
  - Do: Re-read `upsertBuilderEmbeddingStub`'s `onConflictDoUpdate`: `profile` is always set to
    `excluded.profile` while `embedding`/`embeddedAt` are hash-gated. Confirm no DDL is needed
    (the column is `jsonb`) and note it in the PR description.
  - Verify: `pnpm db:generate` produces **no** new migration file (`git status drizzle/` clean).

## Phase 2 — Pure libs: scoring, collapse, explanation, seed doc

- [ ] **Extract the shared identity key out of the deduper**
  - Files: `src/lib/dedup.ts`, `src/lib/dedup.test.ts` (new)
  - Do: `export function identityKey(username: string): string { return username.toLowerCase().replace(/[^a-z0-9]/g, '') }`
    and use it inside `deduplicateBuilders` in place of the inline `username.toLowerCase()`.
    Keep the merge behaviour identical.
  - Verify: `pnpm test dedup` — new tests cover `Edd-Remonts` / `eddremonts` collapsing and the
    existing follower/topic merge semantics being unchanged.

- [ ] **Implement the hybrid look-alike score (pure)**
  - Files: `src/lib/similar/lookalike-score.ts` (new)
  - Do: Export `LookAlikeSignals`, `LOOKALIKE_WEIGHTS = { vector: 0.55, topicOverlap: 0.25,
    languageMatch: 0.08, magnitude: 0.07, recency: 0.05 }`, `signalsFor(seed, candidate, now)` and
    `scoreLookAlike(...) => Math.round(100 * Σ w*s)`. Topic overlap = Jaccard over
    lowercased/trimmed topic sets; language 1/0.5/0 (equal / unknown either side / different);
    magnitude `1 - Math.min(1, Math.abs(Math.log10(1+a) - Math.log10(1+b)) / 2)`; recency buckets
    `<7d 1 | <30d .8 | <90d .5 | <365d .2 | else 0`, `0.5` when `lastActiveAt` is absent.
  - Verify: `pnpm test lookalike-score` — asserts weights sum to exactly 1, identical profiles
    score 100, disjoint profiles with vector 0 score 0, and unknown fields land at neutral.

- [ ] **Implement deterministic per-result reasons (pure, no LLM)**
  - Files: `src/lib/similar/lookalike-score.ts`, `src/lib/similar/lookalike-score.test.ts` (new)
  - Do: `explainLookAlike(seed, candidate, now): string[]` returning at most 3 strings in priority
    order — shared topics (`"4 shared topics: rust, wasm, compilers, +1"`), same language
    (`"Both primarily Rust"`), recency when known and ≤ 30 days (`"Active in the last 7 days"`),
    similar reach (`"Similar reach (~2k vs ~3k followers)"`). No reason may echo raw bio text.
  - Verify: `pnpm test lookalike-score` — a candidate sharing nothing yields `[]`; a candidate
    sharing everything yields exactly 3 reasons in the documented order.

- [ ] **Implement identity collapse (pure)**
  - Files: `src/lib/similar/identity-collapse.ts` (new), `src/lib/similar/identity-collapse.test.ts` (new)
  - Do: `normalizeDisplayName(name)` (lowercase, collapse whitespace, strip punctuation) and
    `collapseLookAlikes(seed, scored)` applying, in order: drop the seed's own
    `(source, sourceId)`; drop `kind === 'repo'` (keep `undefined`); drop
    `identityKey(candidate.username) === identityKey(seed.username)`; drop equal normalized
    display names when both have ≥ 2 tokens; then group survivors by `identityKey`, keep the
    highest `matchScore` as representative, union topics, and put the rest in `collapsedFrom`.
    Return `{ results, collapsedCount, selfHitsSuppressed, repoRowsDropped }`.
  - Verify: `pnpm test identity-collapse` — regression fixture: a seed GitHub profile plus the
    same person on DEV.to and Hashnode with a copy-pasted bio at similarity 0.98 must produce
    zero results from those three rows and `selfHitsSuppressed: 3`.

- [ ] **Implement the pasted-seed document builder (pure)**
  - Files: `src/lib/similar/seed-doc.ts` (new), `src/lib/similar/seed-doc.test.ts` (new)
  - Do: `buildSeedDocFromText({ text, topics?, language? }): string` emitting the same line
    grammar as `buildEmbeddingDoc` minus `Name:`/`Source:` — `Bio: <whitespace-collapsed text>`,
    then `Language:` and `Topics: a, b, c` when provided — truncated to 6000 chars. Pure: no I/O,
    no logging.
  - Verify: `pnpm test seed-doc` — line order matches `buildEmbeddingDoc`'s, a 10k-char input is
    truncated to 6000, and empty optional fields emit no line.

## Phase 3 — Repository + `indexed`/`tracked` modes behind the API

- [ ] **Add the seed lookup and index-size count to the public repository**
  - Files: `src/shared/lib/repositories/public-builder-embeddings.ts`
  - Do: `findBuilderEmbeddingSeed(source, sourceId): Promise<{ embedding: number[]; profile: EmbeddedProfile; embeddedAt: Date | null } | null>`
    selecting on `builder_embeddings_source_unique`, and `countEmbeddedBuilders(): Promise<number>`
    (`count(*) where embedding is not null`, wrapped in a 5-minute Redis cache keyed
    `lookalike:index-count`, falling through to a live count when Redis is absent). Use `publicDb`
    only — this table has no `organization_id`.
  - Verify: `pnpm type-check`.

- [x] **Make the vector search index-eligible (shared with semantic-search)** — **DONE, shipped
      outside fase 2.** `findSimilarBuilderEmbeddings` now orders by `asc(distance)` with
      ``sql`1 - (${distance})` `` kept as the returned `similarity` column, and the query builder is
      exported as `similarBuilderEmbeddingsQuery(db, queryVector, limit)` so callers and tests can
      EXPLAIN the SQL the module actually emits. This plan **reuses that function unchanged** and
      asserts the shape; do not re-apply the change.
  - Note on `SET LOCAL hnsw.ef_search = 100`: keep it only if the extra recall is wanted. The
    original rationale — "`ef_search` must be ≥ the requested `LIMIT` (default 40 would silently
    under-return at `LIMIT 60`)" — is **false** on pgvector 0.8.5, which searches with
    `ef = max(ef_search, limit)`. Measured with `EXPLAIN (ANALYZE)` on a 5k-row HNSW index at
    `ef_search = 40`, index scan chosen: `LIMIT 50 → 50 rows`, `LIMIT 60 → 60 rows`,
    `LIMIT 100 → 100 rows`.
  - Also note: an indexable `ORDER BY` makes the index *available*, not mandatory. The planner
    still costs it against a seq scan, and below ~2k embedded rows the seq scan wins. Any
    `EXPLAIN` acceptance check needs either `enable_seqscan = off` or a corpus past that
    crossover, or it will fail on a correct query.

- [x] **Prove the shared change does not disturb semantic search** — **DONE.** `POST
      /api/search/semantic` was captured before and after the ordering change against the local
      index (352 embedded rows), through real Better Auth sign-up and a `pro` entitlement:
      **30 builders, identical order, identical `similarity` values, element for element**, with
      `mode: "semantic"` both times. A repository-level A/B over three probe vectors at `LIMIT 50`
      likewise returned 50/50 identical rows. Zero membership delta — expected, since at this
      corpus size the planner still chooses the seq scan, so retrieval was exact in both runs.
  - Still open for **this plan**: re-run the comparison once the corpus is past the ~2k-row
    crossover, where the index actually engages and approximate recall can move the tail. That is
    the run where a membership delta may legitimately appear.

- [ ] **Implement the look-alike orchestrator (seed modes only)**
  - Files: `src/lib/similar/lookalike.ts` (new)
  - Do: Export `LOOKALIKE_CANDIDATE_LIMIT = 60`, `LOOKALIKE_SIMILARITY_FLOOR = 0.55`,
    `LOOKALIKE_MIN_RESULTS = 5`, `LOOKALIKE_MIN_INDEX_ROWS = 500`, `LOOKALIKE_RESULT_LIMIT = 20`
    and `findLookAlikes(input)`. Flow: `countEmbeddedBuilders()` → `index_warming` when below the
    floor; resolve the seed vector via `findBuilderEmbeddingSeed` → `pending` when the row is
    missing or `embedding` is null; `findSimilarBuilderEmbeddings(vector, 60)` → drop below the
    similarity floor → `scoreLookAlike` → `collapseLookAlikes` → sort by `matchScore` desc → slice
    to 20 → `ok` when ≥ 5 else `weak`.
  - Verify: `pnpm test lookalike` with the repository functions stubbed — asserts each of the four
    statuses and that results are ordered by `matchScore`, not raw similarity.

- [ ] **Upsert a stub for an unindexed seed**
  - Files: `src/lib/similar/lookalike.ts`
  - Do: When `findBuilderEmbeddingSeed` returns null and the caller supplied a resolved public
    profile, call `upsertEmbeddingStubs([profile])` from `~/lib/semantic/index-writer` (awaited —
    the response depends on it having happened) and return `pending`. This is the only write this
    feature performs, and only ever for already-public profile data.
  - Verify: `pnpm test lookalike` — a stubbed writer is called exactly once for a missing seed and
    **never** for the `text` mode (guard test lands in Phase 4).

- [ ] **Add `POST /api/search/similar` with the tenant + plan gates**
  - Files: `src/routes/api/search/similar.ts` (new)
  - Do: Mirror `src/routes/api/search/semantic.ts`: `requireTenantPrincipal` →
    `withTenantContext(principal, tx => getOrganizationEntitlement(tx, principal.organizationId))`
    → `403 { error: 'plan' }` when `tier === 'free'` → `rateLimit('search-similar', principal.userId, 30, 60)`
    → parse the `SimilarBody` discriminated union (`indexed` | `tracked`; `text` in Phase 4) →
    `findLookAlikes` → annotate with `getTrackedBuilderIds` + `trackedKey`. Return the
    `LookAlikeResponse` DTO allowlist from spec.md (never a raw row); `pending` → 202, everything
    else → 200. Never read `organizationId` from the body.
  - Verify: `curl -X POST localhost:3000/api/search/similar -H 'Content-Type: application/json' -d '{"kind":"indexed","source":"github","sourceId":"1"}'`
    returns 401 unauthenticated, 403 `{"error":"plan"}` as a free org, and a `status` field as a
    Pro org.

- [ ] **Resolve the `tracked` seed server-side**
  - Files: `src/routes/api/search/similar.ts`
  - Do: For `kind: 'tracked'`, resolve `builderId` inside `withTenantContext` via
    `findOrganizationBuilderByEitherId(tx, principal.organizationId, builderId)` (its
    `privateBuilderFields` projection already returns `source`/`sourceId`), falling back to
    `findPublishedBuilderProfile(builderId)` for claimed public profiles. `404` when neither
    resolves — never leak whether another organization tracks that id.
  - Verify: `pnpm test:api-isolation:local` after Phase 6's check is added; manually, org A asking
    for org B's private `builderId` gets 404 with no timing/existence difference from an unknown id.

- [ ] **Reject non-person seeds**
  - Files: `src/routes/api/search/similar.ts`, `src/lib/similar/lookalike.ts`
  - Do: When the resolved seed payload has `kind === 'repo'`, return
    `400 { error: 'seed_not_a_person' }`. Repos legitimately live in `builder_embeddings` (GitHub,
    npm, GitLab, Codeberg and Hugging Face sources all emit `kind: 'repo'` rows).
  - Verify: `pnpm test lookalike` covers the repo-seed rejection.

## Phase 4 — Pasted-seed mode + allowance gating

- [ ] **Add the paste allowance to the shared billing table**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: Add `export const LOOKALIKE_PASTE_LIMITS: Record<PlanTier, number> = { free: 0, pro: 20, team: 100 }`
    next to `SOURCING_SPRINT_LIMITS`, with a comment that it is enforced per organization per day
    and that `pro_max` resolves through `resolveLegacyPlanTier` to the `team` row.
  - Verify: `pnpm type-check`.

- [ ] **Embed the pasted seed ephemerally, org-scoped cached**
  - Files: `src/lib/similar/lookalike.ts`
  - Do: For `kind: 'text'`, build the doc with `buildSeedDocFromText`, then look up
    `ai:cache:lookalike-seed:{organizationId}:{sha256(doc)}` in Redis (TTL 3600) before calling
    `embedTexts([doc])` from `~/shared/lib/ai/embeddings`. Store only the vector. **Never** call
    `upsertEmbeddingStubs` on this path and never write the text anywhere. The cache key is
    organization-scoped on purpose — `semantic-search`'s global `ai:cache:query-embed:*` key is
    wrong for private text (`_meta/security-policy.md`: cache keys include the server-resolved
    organization ID).
  - Verify: `pnpm test lookalike` — a spy on the index writer is never called for `text` mode; two
    calls with the same text in the same org produce one `embedTexts` call; the same text in a
    different org produces a second one.

- [ ] **Gate paste mode on tier, allowance and provider availability**
  - Files: `src/routes/api/search/similar.ts`
  - Do: Accept the `text` branch (`min(120).max(6000)` plus optional `topics`/`language`).
    `400 { error: 'seed_too_short' }` below 120 chars. Enforce
    `rateLimit('lookalike-paste', principal.organizationId, LOOKALIKE_PASTE_LIMITS[resolveLegacyPlanTier(entitlement.tier)], 86400)`
    → `429` with `Retry-After`. Catch embedding failures (unconfigured provider,
    `AIDimensionMismatchError`) → `503 { error: 'seed_embedding_unavailable' }` without touching
    the seed modes.
  - Verify: `curl` a 50-char paste → 400 `seed_too_short`; 21 pastes in a day as a Pro org → the
    21st returns 429; unset `AI_EMBEDDING_URL` → paste returns 503 while
    `{"kind":"indexed",...}` still returns 200.

- [ ] **Never log the pasted text**
  - Files: `src/lib/similar/lookalike.ts`, `src/routes/api/search/similar.ts`
  - Do: Log `log.info('lookalike_query', { seedKind, status, chars, seedHash, candidates, kept })`
    only. `src/shared/lib/log.ts`'s redaction regex covers `bio`/`prompt`/`displayname` but **not**
    a key named `text`, so passing the text would leak it verbatim into logs.
  - Verify: grep the two files for `text` inside any `log.` call — zero matches; run a paste
    request in dev and confirm the log line contains `chars`/`seedHash` and no prose.

## Phase 5 — UI integration

- [ ] **Add the "Similar builders" card to the builder profile**
  - Files: `src/modules/builder-profile/components/SimilarBuildersCard.tsx` (new),
    `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: New card component posting `{ kind: 'tracked', builderId }` to `/api/search/similar`,
    rendering the top 5 with a `% match` chip (`matchScore`, tooltip carrying
    `vectorSimilarity` and "Profile-text similarity plus shared topics, language and reach"),
    the reason lines, `collapsedFrom` as "also on DEV.to, Hashnode", and a "See all" link to
    `/similar?builderId=…`. Render the four statuses explicitly. Mount it in the left column
    beside `HygieneCard`/`CodeStyleCard`.
  - Verify: `pnpm dev`, open `/builder/<trackedIdentityId>` as a Pro org — the card lists matches
    and the profile's own person never appears in it.

- [ ] **Add an optional "Similar" action to the shared result card**
  - Files: `src/modules/search/components/PersonResultCard.tsx`,
    `src/routes/_dashboard/sprints/new.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: Add `similarHref?: string` to `PersonCardData`'s component props (not to the data shape)
    and render a "Similar" ghost link beside "View" **only when provided**. Pass it from the two
    sprint pages. `src/routes/_landing/explore/index.tsx` passes nothing, so the anonymous public
    page is unchanged (the endpoint requires a tenant principal).
  - Verify: `pnpm type-check`; `/explore` renders no "Similar" link; a sprint result row links to
    `/similar?source=…&sourceId=…`.

- [ ] **Add the action to the search page's own card**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: `SearchPage` defines a **local** `PersonResultCard` (~line 1342) that shadows the shared
    component — add the same "Similar" link there, gated on the same Pro check the semantic toggle
    already uses (locked + "Pro" pill → `/pricing` for free tier).
  - Verify: `pnpm dev` → `/search`, run a query, each row shows "Similar" for a Pro org and a
    locked pill for a free org.

- [ ] **Add the `/similar` page hosting both modes**
  - Files: `src/routes/_dashboard/similar.tsx` (new),
    `src/modules/similar/components/SimilarSourcingPage.tsx` (new)
  - Do: Read `?source=&sourceId=` / `?builderId=` and render a seed header + results; with no
    params render the paste box (textarea, optional topics, optional primary language) with the
    copy "Used once to find matches. Not stored." Render `index_warming` with the indexed count
    and links to `/search` and `/sprints`; `weak` with "Only N close matches — treat as
    exploratory"; `pending` with the check-back copy. Include an inline track button reusing
    `/api/builders/track`. Hide the paste box when the embedding provider is unavailable while
    keeping seed results working.
  - Verify: `pnpm dev` → `/similar` with an empty index shows `index_warming` and never a list;
    pasting a real 300-char bio returns a ranked list.

- [ ] **Add the nav entry and the pricing promise**
  - Files: `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/shared/lib/billing-shared.ts`
  - Do: Add `{ to: '/similar', icon: UsersRound, label: 'Look-alikes', end: false }` to `NAV`
    (import the icon from `lucide-react` alongside the existing set). Add
    `'Look-alike sourcing'` to `PLAN_PRICING.pro.features` so the advertised feature matches the
    real gate (conventions rule 8).
  - Verify: `pnpm type-check`; the topbar shows the pill and `/pricing` lists the feature under
    Pro.

## Phase 6 — Isolation proof, docs, observability

- [ ] **Extend the API isolation harness**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkSimilarSourcing()` alongside `checkSearchTrackedAnnotationScoping()`, registered
    in `main()`, covering: unauthenticated → 401; authenticated with no active organization → 403;
    free-tier org → 403 `plan`; `organizationId` injected into the body is ignored; org A posting
    `{ kind: 'tracked', builderId }` for a builder only org B tracks → 404; and the same
    `indexed` seed requested by orgs A and B returns identical public rows but org-specific
    `tracked`/`trackedRowId` annotations.
  - Verify: `pnpm test:api-isolation:local` — all checks pass against the non-owner
    `builderhunt_app` role, and the total check count increases.

- [ ] **Assert the pasted seed never reaches the global index**
  - Files: `src/lib/similar/lookalike.test.ts` (new)
  - Do: A dedicated test that mocks `~/lib/semantic/index-writer` and asserts
    `upsertEmbeddingStubs` is not called for `kind: 'text'` under any status branch, and that no
    `builder_embeddings` write occurs. This is the executable form of
    `_meta/security-policy.md`'s "global public embeddings contain only approved public-source
    data".
  - Verify: `pnpm test lookalike`.

- [ ] **Update the architecture docs**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: In data-classification, record that this feature adds **no table** and note the ephemeral
    pasted seed (tenant-supplied text, never persisted, org-scoped 1-hour vector cache, excluded
    from the global-public index by policy). In the authorization matrix, add
    `POST /api/search/similar`: tenant principal required, any organization role, `free` tier
    denied, per-user 30/min and per-org daily paste allowance.
  - Verify: both files mention `/api/search/similar`; `pnpm lint` passes (markdown untouched by
    lint, so this is a review check).

- [ ] **Add the structured observability event**
  - Files: `src/lib/similar/lookalike.ts`
  - Do: Emit `log.info('lookalike_query', { seedKind, status, indexedCount, candidates,
    collapsedCount, selfHitsSuppressed, repoRowsDropped, kept, durationMs })` on every request.
    These are the fields the spec's success metrics are measured from. No metrics counter is added
    — `src/shared/lib/metrics.ts` has a closed `Counters` type and the admin metrics page reads
    it, so widening it is deliberately out of scope.
  - Verify: `pnpm dev`, issue one request per mode, and confirm one `lookalike_query` line per
    request with all fields populated and no profile prose in it.

- [ ] **Full gate before marking implemented**
  - Files: none
  - Do: Run the whole suite plus a warm-index latency spot check.
  - Verify: `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm test:api-isolation:local`, and a
    p95 under 150 ms for `{"kind":"indexed",…}` measured over 20 sequential curls on an index of
    ≥ 500 embedded rows — with `EXPLAIN ANALYZE` on the emitted query confirming
    `Index Scan using builder_embeddings_hnsw_idx`, since the target is only meaningful if the
    index is genuinely in use.
