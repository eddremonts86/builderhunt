# Look-alike Sourcing (spec)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../proactive-discovery/spec.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: The vector substrate already ships: `builder_embeddings` (global, `unique(source, source_id)`, HNSW cosine index — `src/shared/lib/db/schema.ts:643`), `findSimilarBuilderEmbeddings(queryVector, limit)` (`src/shared/lib/repositories/public-builder-embeddings.ts`), the write-through indexer (`src/lib/semantic/index-writer.ts`), the embed worker (`src/routes/api/admin/embeddings/run-worker.ts`), and the query path (`src/lib/semantic/semantic-search.ts`, `src/routes/api/search/semantic.ts`). This plan adds **no table and no migration**: a second query mode over the same index (vector-as-seed instead of query-as-seed), a pure hybrid re-ranker, and an identity-collapse step.
> **Pre-existing finding**: `findSimilarBuilderEmbeddings` sorts by ``desc(sql`1 - (${distance})`)`` (`public-builder-embeddings.ts:100`) — a derived, descending expression that `builder_embeddings_hnsw_idx` cannot serve. Its only current caller is `semanticSearch` (`src/lib/semantic/semantic-search.ts:133`), so **`/api/search/semantic` is sequentially scanning the whole index today**, not using HNSW. That is shipped behaviour this plan did not cause; see "The HNSW index is not actually being used today — RESOLVED".

## Problem

Semantic search makes the recruiter *describe* what they want. Their strongest signal is not a
description but a person: "my best backend engineer", or a builder they already found here. There
is no way to say "more like this one". Nearest-neighbour queries over `builder_embeddings` are
technically possible today, but no seed resolution, self-hit suppression, explanation, or entry
point exists — and a naive `ORDER BY embedding <=> seed` puts the seed's *own* other-source
profiles at the top, which reads as broken.

## Goal

1. From any builder already in the index: a ranked list of similar builders in one HNSW query with
   **zero AI calls**.
2. From a pasted profile (someone who may not be in BuilderHunt at all): the same list for **one
   embedding call**, with the pasted text **never persisted**.
3. Rank with an honest hybrid score (vector + structured signals) and explain every result without
   a model call.
4. Never a bad list shown silently — a thin index, a pending seed, and too-few matches each have
   their own explicit state.

## Non-goals

- **No federated/keyword fallback.** "More like this" has no keyword form — the seed *is* a vector.
  Turning a whole profile into a keyword query is exactly what
  [`ai-sourcing-sprints`](../../ai-sourcing-sprints/spec.md) already does, so the thin-index state
  links to "start a sprint" instead of inventing a worse second fallback. Deliberate, not an
  omission.
- No URL, file, or résumé ingestion — pasted **text only**. Server-side URL fetching is an SSRF
  surface and already owned by `src/lib/enrichment/` (disabled by default).
- No persistence of a pasted seed: not `builder_embeddings`, not a new table, not logs.
- No new AI task in `src/shared/lib/ai/tasks.ts` — no LLM exists in this path, and no
  LLM-generated explanations (see Explainability).
- No new table, migration, re-embed, dimension change, or worker. No pagination (one fixed page of
  `LOOKALIKE_RESULT_LIMIT = 20`).
- No identity resolution beyond the handle/display-name heuristic below; no commit-level or
  code-level similarity (that is `work-sample`); no anonymous endpoint (`/explore` stays
  keyword-only).

## User stories

1. As a **Pro user** on a builder profile, a "Similar builders" card shows 5 look-alikes with a
   `% match` chip and reasons ("4 shared topics: rust, wasm, compilers, +1") — and the seed person
   never appears in their own list.
2. As a **Pro user** on a search result row, "Similar" opens `/similar?source=github&sourceId=…`
   with the full list, trackable inline.
3. As a **Pro user** with a private best-engineer profile, I paste their bio into `/similar` with
   optional topics/language and get a ranking — and the page tells me the text was used once and
   not stored.
4. As a **free user**, entry points render locked with a "Pro" pill linking to `/pricing`; as a
   **Pro user on a near-empty index**, I get "index is still warming (137 profiles indexed)" with
   links to search/sprints — never a two-person list dressed up as a ranking.

## The two input modes are different problems — RESOLVED

The source idea conflates them. Separated explicitly:

| Mode | Seed | Cost | AI required |
| --- | --- | --- | --- |
| `indexed` | `(source, sourceId)` from a search result | 1 unique-index lookup + 1 HNSW query | none |
| `tracked` | `builderId` from the profile page, resolved server-side | + 1 tenant-scoped lookup | none |
| `text` | pasted prose (+ optional topics/language) | + 1 `embedTexts` call | embedding adapter |

`indexed`/`tracked` are exact vector-to-vector nearest-neighbour queries: the vector already
exists, so both work with `AI_DISABLED=true` and no embedding provider configured. Only `text`
needs the provider. `tracked` never accepts a client-supplied `(source, sourceId)` for a private
builder — the route resolves `builderId` through
`findOrganizationBuilderByEitherId(tx, principal.organizationId, id)` under `withTenantContext`
(`src/shared/lib/repositories/organization-builders.ts`, whose `privateBuilderFields` projection
already returns `source`/`sourceId`), falling back to `findPublishedBuilderProfile` for claimed
public profiles. An org can only seed from a builder it tracks or one that is public.

### The pasted seed is ephemeral — RESOLVED

`_meta/security-policy.md`: "Global public embeddings contain only approved public-source data and
never tenant notes, searches, private enrichments, or contact data." A pasted employee bio is
tenant-supplied text about someone who never consented to a global index. Therefore:

- embedded in-request and **never written to `builder_embeddings`** — the one place the
  write-through must *not* fire;
- vector cached in Redis under an **organization-scoped** key
  `ai:cache:lookalike-seed:{organizationId}:{sha256(doc)}`, TTL 3600s. Unlike `semantic-search`'s
  global `ai:cache:query-embed:*`, because a private profile's derived vector must not be shared
  across tenants (security-policy: cache keys include the server-resolved organization ID);
- **never logged**. `src/shared/lib/log.ts`'s redaction regex covers `bio`, `prompt`,
  `displayname` — but **not** a key named `text`, so this is code discipline, not something
  redaction saves us from. Log `{ seedKind, chars, seedHash }` only;
- no prompt exists on this path, so prompt injection does not apply — embedding a hostile string
  cannot execute instructions. Deterministic explanations keep it that way.

## What similarity actually measures — RESOLVED

A `builder_embeddings` document is `buildEmbeddingDoc()` (`src/lib/semantic/embedding-doc.ts`):
name, source, bio, language, country, topics, followers. In practice the vector is dominated by
**bio prose**. It does not measure activity pattern, and captures "project type" only as far as the
bio and topic list state it. Pretending otherwise is the fastest way to lose the user's trust.

So the ranking is a **hybrid**: HNSW recall on the vector, then a deterministic re-rank over
structured signals from the stored `profile` payload — pure, tested, weights in one constant
(`src/lib/similar/lookalike-score.ts`):

```ts
export interface LookAlikeSignals {
  vector: number         // 0..1 cosine similarity from pgvector
  topicOverlap: number   // Jaccard over normalized topic sets
  languageMatch: number  // 1 same, 0.5 unknown on either side, 0 different
  magnitude: number      // 1 - min(1, |log10(1+a) - log10(1+b)| / 2) on followersCount
  recency: number        // <7d 1 | <30d .8 | <90d .5 | <365d .2 | else 0 | unknown .5
}
export const LOOKALIKE_WEIGHTS: Record<keyof LookAlikeSignals, number> = {
  vector: 0.55, topicOverlap: 0.25, languageMatch: 0.08, magnitude: 0.07, recency: 0.05,
}
// matchScore = Math.round(100 * Σ weight_i * signal_i)   (weights sum to exactly 1.0)
```

0.55 on the vector because it is the only signal that captures "type of work" in words, and also
the noisiest. Topics are the highest-precision structured signal actually present. `magnitude`
brackets follower counts so a 200k-follower celebrity is not "similar" to a 300-follower IC.
Unknowns score 0.5 rather than 0: a missing field is not evidence of dissimilarity, and most
non-GitHub sources simply do not expose recency or follower counts. (`src/lib/score.ts` follows the
same never-zero principle but a stingier value — 5 of a 30-point recency band, ≈0.17; 0.5 here is a
deliberate choice for a *comparison* signal, not a borrowed constant.)

### Two payload fields the re-ranker needs — and they are free

`EmbeddedProfile` lacks both. **`kind`**: `builder_embeddings` mixes people and repositories —
write-through indexes whatever flows through search, and
`github.ts`/`npm.ts`/`gitlab.ts`/`codeberg.ts`/`huggingface.ts` all emit `kind: 'repo'`, and a
repository in a look-alike list is broken output. **`lastActiveAt`**: `metadata.lastSeen` exists on
`RawBuilder` (it is what `score.ts` reads) but `toEmbeddedProfile` drops it.

Both become optional fields on `embeddedProfileSchema`, **deliberately not added to
`buildEmbeddingDoc`**: a changed document invalidates every `contentHash` and re-embeds the whole
index. Since `upsertBuilderEmbeddingStub` always refreshes `profile` on conflict while hash-gating
only `embedding`/`embeddedAt`, the fields backfill organically at **zero embedding cost**. Rows not
yet refreshed lack them and score neutrally (unknown `kind` is kept, not filtered).

**Shared surface** (conventions rule 6): this plan co-owns `EmbeddedProfile`/`EmbeddableSource` in
`src/lib/semantic/embedding-doc.ts` with `semantic-search` and `proactive-discovery`. The change is
additive-optional and touches neither `buildEmbeddingDoc` nor `contentHashOf`.

## The near-duplicate problem — RESOLVED

Per `semantic-search/spec.md`'s own resolved edge cases, the same human is distinct
`(source, sourceId)` rows by design. So the nearest neighbour of a GitHub profile is very often
that person's DEV.to or Hashnode profile, sometimes at ~0.98 similarity because the bio is
copy-pasted. `collapseLookAlikes(seed, scored)` (`src/lib/similar/identity-collapse.ts`, pure +
tested) applies in order:

1. drop the seed's own `(source, sourceId)`;
2. drop `kind === 'repo'` (keep `undefined`);
3. drop candidates whose `identityKey` equals the seed's;
4. drop equal normalized display names **when both have ≥ 2 tokens** (collapses "Jane Q.
   Developer" across sources without collapsing everyone called "Alex");
5. group survivors by `identityKey`, keep the highest-scoring representative, union topics, list
   the rest in `collapsedFrom` so the UI can say "also on DEV.to, Hashnode".

**Reuse of `src/lib/dedup.ts`**: `deduplicateBuilders(builders: RawBuilder[])` cannot be called
directly — candidates are `EmbeddedProfile`-shaped (no `id`/`kind`/`metadata`), so adapting them
would be lossy. What is reused is its *rule*: `identityKey(username)` (lowercase, strip
non-`[a-z0-9]`) is extracted from `dedup.ts` and imported by both so the two paths cannot drift.
`deduplicateBuilders`' behaviour is unchanged.

## Result quality on a thin index — RESOLVED

Constants (`src/lib/similar/lookalike.ts`): `LOOKALIKE_CANDIDATE_LIMIT = 60`,
`LOOKALIKE_SIMILARITY_FLOOR = 0.55`, `LOOKALIKE_MIN_RESULTS = 5`,
`LOOKALIKE_MIN_INDEX_ROWS = 500`, `LOOKALIKE_RESULT_LIMIT = 20`.

| Condition | `status` | HTTP | User sees |
| --- | --- | --- | --- |
| `< 500` embedded rows | `index_warming` | 200 | "Look-alikes need a broader index — 137 profiles indexed so far. Run a few searches or start a sprint." Empty list. |
| Seed missing or `embedding IS NULL` | `pending` | 202 | "Just queued for indexing — check back in a few minutes." A stub is upserted for a missing seed so the existing embed worker picks it up. |
| `≥ 5` above the floor | `ok` | 200 | Ranked list. |
| `1–4` above the floor | `weak` | 200 | Same list, labelled "Only 3 close matches — treat as exploratory." |
| `0` above the floor | `weak` | 200 | Empty list + the same explanation. |

Never a silently truncated ranking, and never "similar builders" that is really "the four people
who happen to be indexed".

## Architecture

```
src/lib/similar/
  lookalike-score.ts     # pure: signals, LOOKALIKE_WEIGHTS, scoreLookAlike, explainLookAlike
  identity-collapse.ts   # pure: collapseLookAlikes, normalizeDisplayName
  seed-doc.ts            # pure: buildSeedDocFromText (buildEmbeddingDoc's line grammar)
  lookalike.ts           # orchestrator: seed resolution -> HNSW -> collapse -> rank
src/routes/api/search/similar.ts        # POST, tenant principal, Pro gate, rate limits
src/routes/_dashboard/similar.tsx + src/modules/similar/components/SimilarSourcingPage.tsx
src/modules/builder-profile/components/SimilarBuildersCard.tsx
```

Two additions to `src/shared/lib/repositories/public-builder-embeddings.ts`:
`findBuilderEmbeddingSeed(source, sourceId)` → `{ embedding, profile, embeddedAt } | null`, and
`countEmbeddedBuilders()` (5-minute Redis cache).

### The HNSW index is not actually being used today — RESOLVED

Two conditions must both hold for pgvector to use `builder_embeddings_hnsw_idx`
(`drizzle/0013_polite_night_thrasher.sql:19`): the `ORDER BY` operand must be a
parameter/constant, **and** the sort key must be the bare distance operator ascending. The shipped
`findSimilarBuilderEmbeddings` satisfies the first and fails the second —
``.orderBy(desc(sql`1 - (${distance})`))`` (`public-builder-embeddings.ts:100`) sorts by a derived
expression, descending, which no HNSW index can serve. **`semanticSearch` calls that same
function, so `/api/search/semantic` runs a sequential scan over the whole index today.** That is a
pre-existing property of shipped code, not something this plan introduces, and it is recorded here
rather than silently inherited.

So `findSimilarBuilderEmbeddings` is **not** reused unchanged. It gets a one-line ordering change:

```ts
// src/shared/lib/repositories/public-builder-embeddings.ts
.orderBy(asc(distance))               // was: desc(sql`1 - (${distance})`)
// `similarity: sql<number>`1 - (${distance})`` stays a returned column, not the sort key
```

Ascending cosine distance and descending `1 - distance` are the same total order, so **every
caller's result ordering is mathematically identical** — this is why modifying the shared function
is preferable to duplicating it: the alternative (a second, index-eligible copy for look-alikes)
would leave the semantic-search path permanently on a seq scan while doubling the code that has to
stay correct. The change is picked up automatically by `/api/search/semantic`, which is the one
other caller (verified: `src/lib/semantic/semantic-search.ts:133`).

Two consequences must be handled, not assumed away:

- **Exact → approximate.** A seq scan returns exact KNN; HNSW returns approximate KNN. Recall
  quality is bounded by `hnsw.ef_search` (default 40) — raising it explores more candidates and
  improves recall, at proportional cost.

  Correction (measured, pgvector 0.8.5): an earlier draft of this spec claimed `ef_search` must be
  **≥ the requested `LIMIT`** or the query "silently returns fewer rows than asked for". That is
  false. pgvector searches with `ef = max(hnsw.ef_search, limit)`, so the requested row count
  always comes back. Verified by `EXPLAIN (ANALYZE)` on a 5k-row HNSW index with `ef_search = 40`
  and the index scan actually chosen: `LIMIT 50 → 50 rows`, `LIMIT 60 → 60 rows`,
  `LIMIT 100 → 100 rows`. `SET LOCAL hnsw.ef_search = 100` is therefore a **recall-quality
  tuning knob, not a correctness requirement** — this plan's `LIMIT 60` is safe without it. Keep it
  if the extra recall is wanted; drop it if the cost isn't worth it. Either way, do not justify it
  by an under-return that does not happen.
- **Cross-plan touchpoint** (conventions rule 6): `findSimilarBuilderEmbeddings` is co-owned with
  `semantic-search`. The ordering change has already landed and its before/after comparison already
  ran — `POST /api/search/semantic` returned 30 identical builders in identical order with identical
  `similarity`, no membership delta, because at the current corpus (352 embedded rows) the planner
  still chooses the exact seq scan. What remains for *this* plan is the run that matters: once the
  corpus is past the ~2k-row crossover the index actually engages and approximate recall can move
  the tail, so repeat the comparison then rather than treating the existing zero-delta result as
  proof for the indexed regime.

**Why the seed vector still round-trips through Node** rather than a self-joining SQL statement:
the parameter/constant condition above. `ORDER BY e.embedding <=> seed.embedding` against a joined
CTE is not a constant operand and falls back to a seq scan regardless of the ordering fix. Fetching
the seed's ~12 KB of floats and binding them as a parameter is what makes the second query
index-eligible at all.

```ts
// src/routes/api/search/similar.ts
const SimilarBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('indexed'), source: z.enum(SOURCE_NAMES), sourceId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('tracked'), builderId: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('text'),
    text: z.string().min(120).max(6000),   // under 120 chars produces a meaningless vector
    topics: z.array(z.string().min(1).max(40)).max(20).optional(),
    language: z.string().min(2).max(40).optional(),
  }),
])

interface LookAlikeResult {
  source: string; sourceId: string; username: string; displayName?: string
  avatarUrl?: string; bio?: string; profileUrl: string; followersCount?: number
  language?: string; topics: string[]
  vectorSimilarity: number   // raw cosine, shown in the chip tooltip
  matchScore: number         // 0..100 hybrid, drives the ranking
  reasons: string[]          // <= 3, deterministic
  collapsedFrom?: string[]   // other `source:sourceId` rows judged the same person
  tracked: boolean; trackedRowId?: string
}
interface LookAlikeResponse {
  status: 'ok' | 'weak' | 'pending' | 'index_warming'
  seed: { kind: 'indexed' | 'tracked' | 'text'; label: string }
  results: LookAlikeResult[]
  indexedCount?: number      // index_warming only
}
```

Tracked annotation reuses `getTrackedBuilderIds` + `trackedKey` under `withTenantContext`, exactly
as `src/routes/api/search/semantic.ts` does. Results are annotated, never filtered, so "you
already track 3 of these" stays visible. `buildSeedDocFromText` emits `buildEmbeddingDoc`'s line
grammar minus `Name:`/`Source:` (nothing honest to put there): `Bio: …`, then optional
`Language:`/`Topics:`, whitespace-collapsed, truncated to 6000 chars. Known bias: the two missing
lines shift the seed vector slightly relative to indexed documents — a small fraction of a long
document, and a constant offset shared by every candidate, so it largely cancels in ranking.

## UX integration

- **`SimilarBuildersCard.tsx`** (new) in `BuilderProfilePage.tsx`'s left column beside
  `HygieneCard`/`CodeStyleCard`: posts `{ kind: 'tracked', builderId }`, top 5, "See all" →
  `/similar?builderId=…`.
- **`src/modules/search/components/PersonResultCard.tsx`** (shared; used by
  `_dashboard/sprints/*` and `_landing/explore`) gains an optional `similarHref?: string`, rendering
  a "Similar" ghost link only when passed — `/explore` (anonymous) passes nothing, so the public
  page is untouched. **`SearchPage.tsx` defines its own local `PersonResultCard`** (~line 1342) that
  shadows the shared one; the same link goes there too. Verified — that is the card search results
  actually render.
- **`/similar`** hosts both modes: seed header when `?source=&sourceId=`/`?builderId=` is present,
  otherwise the paste box (textarea + optional topics/language) with "Used once to find matches.
  Not stored." A `Look-alikes` pill is added to `NAV` in
  `src/modules/dashboard/ui/shell/DashboardLayout.tsx`.
- Free tier: lock + "Pro" pill → `/pricing`, same treatment as the semantic toggle. The paste box
  additionally hides when the embedding provider is unconfigured; seed modes stay available.

## Explainability

A bare similarity number is the distrust problem [`match-evidence-panel`](../match-evidence-panel/spec.md)
exists to fix, so every result carries up to three reasons from `explainLookAlike(...)` — **pure,
deterministic, no model call** — in priority order: shared topics (`"4 shared topics: rust, wasm,
compilers, +1"`), same language (`"Both primarily Rust"`), recency when known and ≤ 30 days
(`"Active in the last 7 days"`), similar reach (`"Similar reach (~2k vs ~3k followers)"`). The chip
shows `matchScore` with `vectorSimilarity` in its tooltip plus "Profile-text similarity plus shared
topics, language and reach." Deterministic reasons cost nothing, survive `AI_DISABLED`, and cannot
be prompt-injected by a hostile bio.

## Tier / billing gating

- `entitlement.tier === 'free'` → `403 { error: 'plan' }`, mirroring `/api/search/semantic`. Pro,
  Pro Max and Team allowed.
- Paste mode has a per-organization daily allowance
  `LOOKALIKE_PASTE_LIMITS: Record<PlanTier, number> = { free: 0, pro: 20, team: 100 }` in
  `src/shared/lib/billing-shared.ts` (beside `SOURCING_SPRINT_LIMITS`), enforced by
  `rateLimit('lookalike-paste', principal.organizationId, limit, 86400)` — org-scoped because the
  entitlement is. `pro_max` resolves to the `team` row via `resolveLegacyPlanTier`
  (`src/shared/lib/repositories/entitlements.ts`), the convention every other legacy
  `Record<PlanTier, …>` table uses.
- All modes: `rateLimit('search-similar', principal.userId, 30, 60)`.
- No AI task registered → nothing in `tasks.ts` allowances, nothing for `AI_DISABLED_TASKS`.
- **With `STRIPE_BILLING_ENABLED=false` (today) the gate is not theoretical**:
  `organization_entitlements` is already populated by admin action (`setPlatformUserPlan`), so the
  403 and the allowance are live and testable. No Checkout, webhook, or credit ledger is touched.
- `PLAN_PRICING.pro.features` gains `'Look-alike sourcing'` so promise and gate match
  (conventions rule 8).

## Cost model

- **`indexed`/`tracked`: zero AI spend.** Three queries (seed lookup on
  `builder_embeddings_source_unique`, HNSW top-60, tracked ids), p95 target < 150 ms warm; the
  index count is Redis-cached 5 minutes.
- **`text`: one `embedTexts` call** of ≤ 6000 chars (≈1.5k tokens) per unique (organization,
  normalized text) per hour — fractions of a cent at typical OpenAI-compatible embedding rates;
  the 100/day Team ceiling bounds it well under $1/month per organization. Exact cost is a property
  of the configured `AI_EMBEDDING_URL` provider, as in `semantic-search`.
- No new env vars, tables, migrations, or workers.

## Success metrics

- p95 < 150 ms for `indexed`/`tracked` on a warm index, with `EXPLAIN ANALYZE` on the emitted query
  confirming `Index Scan using builder_embeddings_hnsw_idx` — the number is only meaningful if the
  index is actually in use (see the HNSW finding above).
- **Zero** responses whose top result is the seed person — asserted in `collapseLookAlikes` tests
  and counted in production via the `lookalike_query` log event's `selfHitsSuppressed`.
- ≥ 30% of `/similar` result views end in a track (baseline: the current search→track rate).
- < 10% of requests returning `index_warming` after four weeks of organic use.
- Repos in a look-alike list: 0 once `kind` has backfilled (`repoRowsDropped` logged).

## Resolved edge cases

- **Seed not in the index**: upsert a stub via `upsertEmbeddingStubs` from the resolved public
  profile and return `pending`; the existing embed worker fills it on the next cron run. This is
  the only write this feature performs, and only for data that is already public.
- **Seed pending embed** (`embedding IS NULL`): `pending`, no write.
- **Seed is a repo**: `400 { error: 'seed_not_a_person' }`.
- **Paste under 120 chars**: `400 { error: 'seed_too_short' }` with copy explaining a one-liner
  cannot be matched.
- **Embedding provider unconfigured / dimension mismatch**: `text` →
  `503 { error: 'seed_embedding_unavailable' }`; seed modes unaffected.
- **`AI_DISABLED=true`**: seed modes keep working (no AI call is made); the paste box hides.
- **Every candidate collapses into the seed**: `weak` with an empty list and the collapsed count in
  the copy — "3 profiles look like the same person, and no distinct matches yet".
- **Two different people with punctuation-variant handles** collapse into one (`identityKey` strips
  non-alphanumerics). Accepted: dropping a genuine look-alike is strictly less damaging than
  showing the seed back to the user. Rate observable via `collapsedCount`.
- **Cross-tenant leakage**: the only tenant-private data in the response is the
  `tracked`/`trackedRowId` annotation, resolved from `principal.organizationId`; an
  `organizationId` in the body is never read. Proven by a negative A/B check in
  `scripts/db/verify-api-isolation-local.mjs`.
- **Stale index rows** (profile gone upstream): inherited from `semantic-search` — the stored
  public snapshot is acceptable and the same soft-TTL prune applies.
