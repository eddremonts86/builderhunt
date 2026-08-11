# Look-alike Sourcing (plan)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../implemented/22-semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../implemented/23-proactive-discovery/spec.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Builds on shipped code only — `builder_embeddings` + HNSW (`src/shared/lib/db/schema.ts` §"Semantic Search", `drizzle/0013_polite_night_thrasher.sql`), `findSimilarBuilderEmbeddings` / `similarBuilderEmbeddingsQuery` (`src/shared/lib/repositories/public-builder-embeddings.ts`), `upsertEmbeddingStubs` (`src/lib/semantic/index-writer.ts`), the budgeted-embed pattern in `src/lib/semantic/semantic-search.ts`, the Pro-gate/rate-limit/tracked-annotation pattern in `src/routes/api/search/semantic.ts`, and `findOrganizationBuilderByEitherId` (`src/shared/lib/repositories/organization-builders.ts`, whose `privateBuilderFields` projection already exposes `source`/`sourceId`). No new table, no migration, no new env var, nothing added to `AI_TASKS`. The HNSW sort-key correction this plan used to own **already landed** (commit `24a280b`) and is guarded by an EXPLAIN test; this plan asserts it, it does not re-apply it.

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
`seed-doc.ts` (`buildSeedDocFromText`), plus a new `identityKey` export added to `src/lib/dedup.ts`
and imported by `identity-collapse.ts` so the collapse rule lives in one place.
`deduplicateBuilders`' own key stays `username.toLowerCase()` — swapping it would change live
federated-search results (`src/lib/search.ts:106` is its only caller) for no gain this plan needs;
spec.md records that decision and a test pins both behaviours. All four modules get test files
under `tests/unit/lib/**` with table-driven cases, including the "top hit is the seed's own
other-source profile" regression and a `seed: null` (text-mode) case. Nothing is wired up yet.

### Phase 3 — Repository + seed modes `indexed`/`tracked` behind `POST /api/search/similar`

Add `findBuilderEmbeddingSeed` and `countEmbeddedBuilders` (5-minute Redis cache) to
`public-builder-embeddings.ts`. The sort-key change — from ``desc(sql`1 - (${distance})`)`` to
`asc(distance)`, so `builder_embeddings_hnsw_idx` can serve it — **has already landed** outside
phase 2 (commit `24a280b`), together with the exported `similarBuilderEmbeddingsQuery` builder and
the EXPLAIN regression test in
`tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`. Reuse
`findSimilarBuilderEmbeddings` unchanged; do not re-apply the change. `SET LOCAL hnsw.ef_search`
is **not** set: it buys recall quality, not correctness — `LIMIT 60` returns 60 rows at the default
`ef_search = 40` (measured; see spec.md). Implement `src/lib/similar/lookalike.ts` (seed resolution
→ index-size check → HNSW top-60 → collapse → rank → floor/min-results states) and the route:
`requireTenantPrincipal`, free-tier 403, `rateLimit('search-similar', userId, 30, 60)`, tracked
annotation via `getTrackedBuilderIds`, `pending`/`index_warming`/`weak`/`ok` statuses.
Curl-testable, zero AI calls, no UI yet. `pnpm security:route-coverage` passes on the new route
because it calls `requireTenantPrincipal`; `pnpm security:boundaries` passes because the orchestrator
reaches the table only through the repository.

### Phase 4 — Pasted-seed mode + allowance gating

Add the `text` branch: `buildSeedDocFromText` → org-scoped Redis cache
(`ai:cache:lookalike-seed:{organizationId}:{sha256}`, TTL 3600) → on a miss,
`checkAndConsumeBudget` → `embedTexts`. The budget call is **mandatory, not optional**:
`scripts/check-provider-metering.mjs` fails the build for any `embedTexts(` not preceded by
`checkAndConsumeBudget(`/`reserveCredits(` inside the same top-level function. It uses an inline
pseudo-task `{ id: 'lookalike-seed-embed', allowances: LOOKALIKE_SEED_EMBED_ALLOWANCES }`, exactly
as `embedQueryCached` does for `'semantic-search-embed'`, so `AI_TASKS` stays untouched. Never call
`upsertEmbeddingStubs` on this path; never log the text. Add
`LOOKALIKE_PASTE_LIMITS: Record<OrganizationTier, number>` to `billing-shared.ts` — keyed by
`OrganizationTier` with an explicit `pro_max` row and indexed by `entitlement.tier` directly, per
`resolveLegacyPlanTier`'s own "do NOT reach for this when the allowance is advertised" note — and
enforce it with a daily org-scoped rate-limit window. 503 when the embedding provider is
unavailable, 429 when either ceiling is hit, without affecting the seed modes.

### Phase 5 — UI integration

`SimilarBuildersCard` in `BuilderProfilePage.tsx`'s left column (the `space-y-6` div at
`BuilderProfilePage.tsx:324`, beside `HygieneCard`/`CodeStyleCard`); optional `similarHref` on the
shared `PersonResultCard.tsx` (and the same link on `SearchPage.tsx`'s local shadowing card at
line 1345); `/similar` route + `SimilarSourcingPage` hosting both modes with the four explicit
states; a `Look-alikes` entry in the `discover` area of
`src/modules/dashboard/ui/shell/nav-config.ts` — **not** `DashboardLayout`'s `NAV`, which commit
`1e2ac57` removed — plus `'/similar'` in that area's `routes` array; free-tier lock + `/pricing`
link; `'Look-alike sourcing'` added to `PLAN_PRICING.pro.features`.

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
| pgvector falls back to a seq scan (self-joined seed vector, or a derived/descending sort key) | Low — the sort key was fixed in `24a280b` and is pinned by an EXPLAIN test | Medium (latency) | Seed vector fetched into Node and bound as a parameter (a joined CTE operand is not a constant and would seq-scan regardless); the sort key is already `asc(distance)` and `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` EXPLAINs the SQL drizzle actually emits, with a negative control. This plan adds no new query shape — it reuses `findSimilarBuilderEmbeddings` |
| Switching semantic search onto HNSW changes its result set (exact → approximate KNN) | Medium | Medium | `hnsw.ef_search` is left at its default and **not** set per-statement: it is a recall knob, not a correctness requirement — pgvector 0.8.5 searches with `ef = max(ef_search, limit)`, so `LIMIT 60` returns 60 rows at the default 40 (measured, see spec.md). The before/after comparison already ran for the shipped ordering fix — identical 30 builders in identical order through `POST /api/search/semantic` — but only proved the *exact* regime, since at 352 rows the planner still chose the seq scan. Re-running it past the ~2k-row crossover is an open, unchecked Phase 3 task |
| `pnpm security:provider-metering` fails the build on the pasted-seed `embedTexts` call | Certain without mitigation — the gate requires `checkAndConsumeBudget`/`reserveCredits` in the same top-level function, and a `rateLimit` does not satisfy it | High (CI red, and genuinely unmetered spend) | Phase 4 calls `checkAndConsumeBudget` with an inline `{ id: 'lookalike-seed-embed', allowances }` pseudo-task immediately before `embedTexts`, mirroring `embedQueryCached`'s `'semantic-search-embed'`. Keeps `AI_TASKS` untouched while the spend is counted. `pnpm security:provider-metering` is in Phase 4's verify step, not only the final gate |
| The paste allowance drifts from what `/pricing` advertises | Medium | Medium | `LOOKALIKE_PASTE_LIMITS` is keyed by `OrganizationTier` with an explicit `pro_max` row and read with `entitlement.tier` directly — the shape `SOURCING_SPRINT_LIMITS` was migrated to after the `PlanTier` + `resolveLegacyPlanTier` version drifted by 7 sprints. `PLAN_PRICING.pro.features` states the capability without a number, so there is no figure to disagree with |
| The `/similar` nav entry breaks shell C's registry-integrity test | Medium — easy to add the item and forget the route prefix | Low (red test) | The Phase 5 task adds `'/similar'` to the `discover` area's `routes` **and** its `items`, and runs `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts` |
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
- **Phase 5**: remove the `Look-alikes` nav item **and its `/similar` route prefix** from
  `nav-config.ts` (removing only one of the two leaves the registry-integrity test red), the
  `SimilarBuildersCard` render, and the `similarHref` props — the shared `PersonResultCard` renders
  identically when the prop is absent, so `/explore` and the sprint pages are unaffected either way.
- **Kill switch for paste mode only**: set `LOOKALIKE_PASTE_LIMITS` to `0` for every tier — the
  seed modes keep working with zero AI dependency, which is the whole point of separating them.
  Setting `LOOKALIKE_SEED_EMBED_ALLOWANCES` to `0` is the equivalent per-user switch.
