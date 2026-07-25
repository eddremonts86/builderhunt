# Look-alike Sourcing (plan)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../proactive-discovery/spec.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Builds on shipped code only — `builder_embeddings` + HNSW (`src/shared/lib/db/schema.ts:643`), `findSimilarBuilderEmbeddings` (`src/shared/lib/repositories/public-builder-embeddings.ts`), `upsertEmbeddingStubs` (`src/lib/semantic/index-writer.ts`), the Pro-gate/rate-limit/tracked-annotation pattern in `src/routes/api/search/semantic.ts`, and `findOrganizationBuilderByEitherId` (`src/shared/lib/repositories/organization-builders.ts`, whose projection already exposes `source`/`sourceId`). No new table, no migration. One shipped-code correction is in scope: `findSimilarBuilderEmbeddings`' derived descending sort key means `/api/search/semantic` is not using `builder_embeddings_hnsw_idx` today (spec.md documents the finding).

## Phases (dependency order — shippable after each)

### Phase 1 — Index payload enrichment (invisible, zero embedding cost)

Add optional `kind` and `lastActiveAt` to `embeddedProfileSchema` and derive them in
`toEmbeddedProfile` (from a new optional `kind`/`metadata` on `EmbeddableSource`, which
`RawBuilder` already satisfies structurally — no call-site changes). **Do not touch
`buildEmbeddingDoc` or `contentHashOf`**: changing the embedded document would invalidate every
`contentHash` and re-embed the whole index. Because `upsertBuilderEmbeddingStub` always refreshes
`profile` on conflict while hash-gating only `embedding`/`embeddedAt`, the fields backfill
organically as search and the discovery worker touch rows. No user-visible change.

### Phase 2 — Pure libs: scoring, collapse, explanation, seed doc

`src/lib/similar/lookalike-score.ts` (`LOOKALIKE_WEIGHTS`, `signalsFor`, `scoreLookAlike`,
`explainLookAlike`), `identity-collapse.ts` (`collapseLookAlikes`, `normalizeDisplayName`),
`seed-doc.ts` (`buildSeedDocFromText`), plus `identityKey` extracted from `src/lib/dedup.ts` and
imported by both so the collapse rule lives in one place. All four have sibling `*.test.ts`
files with table-driven cases, including the "top hit is the seed's own other-source profile"
regression. Nothing is wired up yet.

### Phase 3 — Repository + seed modes `indexed`/`tracked` behind `POST /api/search/similar`

Add `findBuilderEmbeddingSeed` and `countEmbeddedBuilders` (5-minute Redis cache) to
`public-builder-embeddings.ts`, and change `findSimilarBuilderEmbeddings`' sort key from
``desc(sql`1 - (${distance})`)`` to `asc(distance)` so `builder_embeddings_hnsw_idx` can serve it
(same total order, so no caller's ordering changes; `/api/search/semantic` is the one other caller
and gains the index too — see spec.md). Run the query with `SET LOCAL hnsw.ef_search = 100` so
approximate recall covers a `LIMIT 60`. Implement
`src/lib/similar/lookalike.ts` (seed resolution → index-size check → HNSW top-60 → collapse →
rank → floor/min-results states) and the route: `requireTenantPrincipal`, free-tier 403,
`rateLimit('search-similar', userId, 30, 60)`, tracked annotation via `getTrackedBuilderIds`,
`pending`/`index_warming`/`weak`/`ok` statuses. Curl-testable, zero AI calls, no UI yet.

### Phase 4 — Pasted-seed mode + allowance gating

Add the `text` branch: `buildSeedDocFromText` → `embedTexts` → org-scoped Redis cache
(`ai:cache:lookalike-seed:{organizationId}:{sha256}`, TTL 3600). Never call
`upsertEmbeddingStubs` on this path; never log the text. Add `LOOKALIKE_PASTE_LIMITS` to
`billing-shared.ts` and enforce it with a daily org-scoped rate-limit window. 503 when the
embedding provider is unavailable, without affecting the seed modes.

### Phase 5 — UI integration

`SimilarBuildersCard` in `BuilderProfilePage.tsx`'s left column; optional `similarHref` on the
shared `PersonResultCard.tsx` (and the same link on `SearchPage.tsx`'s local shadowing card);
`/similar` route + `SimilarSourcingPage` hosting both modes with the four explicit states; a
`Look-alikes` pill in `DashboardLayout`'s `NAV`; free-tier lock + `/pricing` link;
`'Look-alike sourcing'` added to `PLAN_PRICING.pro.features`.

### Phase 6 — Isolation proof, docs, observability

Extend `scripts/db/verify-api-isolation-local.mjs` with `checkSimilarSourcing` (unauthenticated,
no active org, free tier, spoofed `organizationId` in body, tenant A seeding tenant B's private
`builderId`, tracked annotation not bleeding across orgs). Update
`docs/architecture/authorization-matrix.md` and `docs/architecture/data-classification.md` (no new
table — record the route and the ephemeral-seed rule). Add the `lookalike_query` structured log
event (`seedKind`, `status`, `candidates`, `collapsedCount`, `selfHitsSuppressed`,
`repoRowsDropped`, `kept`, `durationMs` — never the pasted text).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Top result is the seed person's other-source profile | Certain without mitigation | High (feature reads as broken) | `collapseLookAlikes` drops seed key, matching `identityKey`, and ≥2-token display-name matches; regression test uses a copy-pasted-bio fixture across two sources |
| A pasted private profile ends up in the global index | Low | Critical (security-policy violation) | The `text` path never calls `upsertEmbeddingStubs`; a unit test asserts the writer is not invoked; org-scoped cache key; text never logged |
| Repositories appear in a "similar builders" list | High until `kind` backfills | Medium | Optional `kind` on the payload, filtered in collapse; rows without `kind` kept and self-healing; `repoRowsDropped` logged; seeds with `kind: 'repo'` rejected 400 |
| Adding fields to the embedding document triggers a full re-embed | Low (only if Phase 1 is done wrong) | High (cost spike) | Phase 1 explicitly forbids touching `buildEmbeddingDoc`/`contentHashOf`; a test asserts `contentHashOf(buildEmbeddingDoc(p))` is unchanged for a fixture profile |
| pgvector falls back to a seq scan (self-joined seed vector, or a derived/descending sort key) | Certain without mitigation — it is the shipped behaviour of `findSimilarBuilderEmbeddings` today | Medium (latency) | Seed vector fetched into Node and bound as a parameter, **and** the sort key changed to `asc(distance)`; proven by `EXPLAIN ANALYZE` on the SQL drizzle actually emits, not a hand-written equivalent |
| Switching semantic search onto HNSW changes its result set (exact → approximate KNN) | Medium | Medium | `SET LOCAL hnsw.ef_search = 100` (must be ≥ the `LIMIT`, default 40 would silently under-return at `LIMIT 60`); a before/after result-set comparison on a real index is a task, since `findSimilarBuilderEmbeddings` is co-owned with `semantic-search` |
| `identityKey` collapses two genuinely different people | Medium | Low | Documented accepted trade-off (dropping a match beats showing the seed); `collapsedCount` logged so the rate is observable |
| Thin index produces a plausible-looking but useless ranking | High early | Medium | `LOOKALIKE_MIN_INDEX_ROWS = 500` → `index_warming`; `LOOKALIKE_MIN_RESULTS = 5` → `weak` label; no federated fallback that would hide the problem |
| `countEmbeddedBuilders` full count becomes slow as the index grows | Medium | Low | 5-minute Redis cache; the value only gates a copy decision, so staleness is harmless |
| Paste-mode spend grows with abuse | Low | Low | Org-scoped daily `LOOKALIKE_PASTE_LIMITS`, 1-hour vector cache, per-user 30/min burst limit, free tier at 0 |

## Rollback

- **Phases 1–2** are invisible: the optional payload fields and the pure modules can be left in
  place with zero runtime effect (nothing reads them yet), or reverted freely — no schema, no
  migration, no data to undo.
- **Phase 3–4**: delete `src/routes/api/search/similar.ts`, or gate it off by returning
  `403 { error: 'plan' }` unconditionally. `builder_embeddings` is untouched except for the same
  public-profile stub upsert search already performs, so there is nothing to clean up.
- **Phase 5**: remove the `Look-alikes` nav pill, the `SimilarBuildersCard` render, and the
  `similarHref` props — the shared `PersonResultCard` renders identically when the prop is absent,
  so `/explore` and the sprint pages are unaffected either way.
- **Kill switch for paste mode only**: set `LOOKALIKE_PASTE_LIMITS` to `0` for every tier — the
  seed modes keep working with zero AI dependency, which is the whole point of separating them.
