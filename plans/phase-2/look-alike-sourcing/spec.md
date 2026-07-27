# Look-alike Sourcing (spec)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../phase-1/semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW — already shipped); [`proactive-discovery`](../../phase-1/proactive-discovery/spec.md) (index breadth; already shipped — a thin index makes look-alikes weak but must not break them). Enhanced by [`collaboration-graph`](../collaboration-graph/spec.md) and [`availability-signals`](../availability-signals/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: The vector substrate already ships: `builder_embeddings` (global, `unique(source, source_id)`, HNSW cosine index — `src/shared/lib/db/schema.ts` §"Semantic Search", `drizzle/0013_polite_night_thrasher.sql`), `findSimilarBuilderEmbeddings(queryVector, limit)` + the exported `similarBuilderEmbeddingsQuery(db, vector, limit)` builder (`src/shared/lib/repositories/public-builder-embeddings.ts`), the write-through indexer (`src/lib/semantic/index-writer.ts`), the embed worker (`src/routes/api/admin/embeddings/run-worker.ts`), and the query path (`src/lib/semantic/semantic-search.ts`, `src/routes/api/search/semantic.ts`). This plan adds **no table, no migration, no new env var, and no entry in `AI_TASKS`**: a second query mode over the same index (vector-as-seed instead of query-as-seed), a pure hybrid re-ranker, and an identity-collapse step.
> **Inherited premise (verified at HEAD 2026-07-27)**: the HNSW ordering defect this plan used to own is **already fixed and landed** (commit `24a280b`). `similarBuilderEmbeddingsQuery` orders by `asc(distance)` with ``sql`1 - (${distance})` `` kept as a *selected* `similarity` column, and `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` EXPLAINs the emitted SQL under `enable_seqscan = off` to assert `Index Scan using builder_embeddings_hnsw_idx` (plus a negative control on the old derived-descending shape). This plan **asserts** that shape and does not re-apply it — see "The HNSW ordering fix already landed".

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
  [`ai-sourcing-sprints`](../../phase-1/ai-sourcing-sprints/spec.md) already does, so the thin-index state
  links to "start a sprint" instead of inventing a worse second fallback. Deliberate, not an
  omission.
- No URL, file, or résumé ingestion — pasted **text only**. Server-side URL fetching is an SSRF
  surface and already owned by `src/lib/enrichment/` (disabled by default).
- No persistence of a pasted seed: not `builder_embeddings`, not a new table, not logs.
- No new AI task in `src/shared/lib/ai/tasks.ts`'s `AI_TASKS` registry — no LLM exists in this
  path, and no LLM-generated explanations (see Explainability). The `text` mode does call the
  embedding provider, which is metered through an **inline pseudo-task** rather than a registry
  entry; see "Metering the pasted-seed embed".
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

### Metering the pasted-seed embed — RESOLVED

`scripts/check-provider-metering.mjs` (run by `pnpm security:provider-metering`) is a hard CI gate:
every `embedTexts(` call site in `src/` must be preceded, **inside the same top-level function**,
by `checkAndConsumeBudget(` or `reserveCredits(`, unless the whole file is allowlisted with a
justification. A per-organization `rateLimit` does not satisfy it, and this feature is a
tenant-billed surface, so an allowlist entry would be dishonest.

The precedent is `semantic-search.ts`'s `embedQueryCached` (`src/lib/semantic/semantic-search.ts`
lines 71–102): it passes an **inline** task object rather than registering one, because
`checkAndConsumeBudget` only needs `Pick<AITaskDefinition, 'id' | 'allowances'>`:

```ts
// src/lib/similar/lookalike.ts (new) — mirrors src/lib/semantic/semantic-search.ts:28,88-90
const LOOKALIKE_SEED_EMBED_ALLOWANCES: Record<PlanTier, number> = { free: 0, pro: 40, team: 200 }
// … inside the same function as the embedTexts call, after the Redis cache miss:
const budget = await checkAndConsumeBudget(principal, entitlement, {
  id: 'lookalike-seed-embed',
  allowances: LOOKALIKE_SEED_EMBED_ALLOWANCES,
})
if (!budget.allowed) throw new LookAlikeBudgetError()
const [vector] = await embedTexts([doc])
```

So `AI_TASKS` genuinely stays untouched (nothing to add to `AI_DISABLED_TASKS`, no output schema,
no prompt), while the spend is counted per `(organizationId, userId, 'lookalike-seed-embed', UTC
date)` exactly like every other provider call. This budget is the **per-user** ceiling; the
per-organization product allowance is `LOOKALIKE_PASTE_LIMITS` below, and the two are deliberately
distinct — the budget exists to satisfy the metering boundary and to bound one runaway user, the
allowance is what the plan sells.

## What similarity actually measures — RESOLVED

A `builder_embeddings` document is `buildEmbeddingDoc()` (`src/lib/semantic/embedding-doc.ts`):
name, source, bio, language, country, topics, followers. In practice the vector is dominated by
**bio prose**. It does not measure activity pattern, and captures "project type" only as far as the
bio and topic list state it. Pretending otherwise is the fastest way to lose the user's trust.

So the ranking is a **hybrid**: HNSW recall on the vector, then a deterministic re-rank over
structured signals from the stored `profile` payload — pure, tested, weights in one constant
(`src/lib/similar/lookalike-score.ts` (new)):

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

`EmbeddedProfile` lacks both (verified at HEAD — `src/lib/semantic/embedding-doc.ts`).
**`kind`**: `builder_embeddings` mixes people and repositories.
`github.ts`/`npm.ts`/`gitlab.ts`/`codeberg.ts`/`huggingface.ts` all emit `kind: 'repo' as const`,
`src/lib/search.ts` does not filter on `kind`, and `src/routes/api/search/builders.ts:92`
write-throughs the *unfiltered* result array — so repo rows are in the index. (The discovery worker
does filter: `src/lib/discovery/worker.ts:126` keeps `kind === 'person'` only, as does
`src/lib/sprints/semantic-write-through.ts`.) A repository in a look-alike list is broken output.
**`lastActiveAt`**: `metadata.lastSeen` exists on `RawBuilder` (it is what `src/lib/score.ts:39`
reads) but `toEmbeddedProfile` drops it.

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
copy-pasted. `collapseLookAlikes(seed, scored)` (`src/lib/similar/identity-collapse.ts` (new), pure +
tested) applies in order:

1. drop the seed's own `(source, sourceId)`;
2. drop `kind === 'repo'` (keep `undefined`);
3. drop candidates whose `identityKey` equals the seed's;
4. drop equal normalized display names **when both have ≥ 2 tokens** (collapses "Jane Q.
   Developer" across sources without collapsing everyone called "Alex");
5. group survivors by `identityKey`, keep the highest-scoring representative, union topics, list
   the rest in `collapsedFrom` so the UI can say "also on DEV.to, Hashnode".

**Relationship to `src/lib/dedup.ts` — decided, not hedged**: `deduplicateBuilders(builders:
RawBuilder[])` cannot be called directly — candidates are `EmbeddedProfile`-shaped (no
`id`/`kind`/`metadata`), so adapting them would be lossy. `identityKey(username: string): string`
(lowercase, strip non-`[a-z0-9]`) is **added as a new export in `src/lib/dedup.ts`** and imported
by `identity-collapse.ts`, so the collapse rule has one home.

`deduplicateBuilders` itself keeps its current, laxer key (`username.toLowerCase()` — `dedup.ts:6`)
**unchanged**. Swapping it to `identityKey` would silently merge `foo-bar` and `foobar` in the live
federated search path (`src/lib/search.ts:106`, the only caller), which is a user-visible
result-set change this plan neither needs nor wants to own. The two keys therefore differ on
purpose, and that difference is the point: collapse is allowed to over-merge because showing the
seed back to the user is the worse failure; search is not. A test in `tests/unit/lib/dedup.test.ts`
pins both — `identityKey('Edd-Remonts') === 'eddremonts'` **and** `deduplicateBuilders` still
keeping `Edd-Remonts` and `eddremonts` as two entries.

**Text-mode seed has no identity**: for `kind: 'text'` there is no `(source, sourceId)` and no
username, so collapse steps 1, 3 and 4 are unconditional no-ops and only the repo filter (2) and
the candidate-side grouping (5) apply. `collapseLookAlikes` takes the seed as
`{ source, sourceId, username, displayName } | null` and must be tested with `null`.

## Result quality on a thin index — RESOLVED

Constants (`src/lib/similar/lookalike.ts` (new)): `LOOKALIKE_CANDIDATE_LIMIT = 60`,
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

Every path below is `(new)` — none exists at HEAD:

```
src/lib/similar/
  lookalike-score.ts     # (new) pure: signals, LOOKALIKE_WEIGHTS, scoreLookAlike, explainLookAlike
  identity-collapse.ts   # (new) pure: collapseLookAlikes, normalizeDisplayName
  seed-doc.ts            # (new) pure: buildSeedDocFromText (buildEmbeddingDoc's line grammar)
  lookalike.ts           # (new) orchestrator: seed resolution -> HNSW -> collapse -> rank
src/routes/api/search/similar.ts                        # (new) POST, tenant principal, Pro gate, rate limits
src/routes/_dashboard/similar.tsx                       # (new)
src/modules/similar/components/SimilarSourcingPage.tsx  # (new)
src/modules/builder-profile/components/SimilarBuildersCard.tsx  # (new)
```

Two additions to the existing `src/shared/lib/repositories/public-builder-embeddings.ts`:
`findBuilderEmbeddingSeed(source, sourceId)` → `{ embedding, profile, embeddedAt } | null`, and
`countEmbeddedBuilders()` (5-minute Redis cache).

### Writes and grants

`builder_embeddings` is a **global, non-tenant** table: it has no `organization_id`, no RLS
(`drizzle/0013_polite_night_thrasher.sql` enables none, and no later migration does), and is
reached through `publicDb` only — never `withTenantContext`. The role that serves HTTP requests is
`builderhunt_app`, and `drizzle/0025_public_tables_app_grants.sql:19` is the grant:

```sql
GRANT SELECT, INSERT, UPDATE ON TABLE builder_embeddings TO builderhunt_app;
```

That covers every database operation this plan performs:

| Operation | SQL | Grant held? |
| --- | --- | --- |
| `findBuilderEmbeddingSeed` | `SELECT` on `builder_embeddings` | yes (`SELECT`) |
| `countEmbeddedBuilders` | `SELECT count(*)` on `builder_embeddings` | yes (`SELECT`) |
| `findSimilarBuilderEmbeddings` | `SELECT … ORDER BY <=>` | yes (`SELECT`) — already exercised by `/api/search/semantic` |
| `upsertEmbeddingStubs` (pending-seed stub only) | `INSERT … ON CONFLICT DO UPDATE` | yes (`INSERT`, `UPDATE`) |
| tracked annotation | `SELECT` on `builder_identities` under `withTenantContext` | yes — same call (`getTrackedBuilderIds`) `/api/search/semantic` already makes |

No `DELETE` is performed and none is granted, which is consistent: this feature never removes an
index row. `scripts/db/verify-api-isolation-local.mjs` runs against the non-owner `builderhunt_app`
role, so Phase 6's check exercises the grants above rather than asserting them on paper.

Also note `src/lib/similar/lookalike.ts` (new) must **not** import `~/shared/lib/db/index` — it reaches
the table only through the repository. `scripts/check-tenant-boundaries.mjs` fails any
non-allowlisted file that imports the global db directly (`pnpm security:boundaries`).

### The HNSW ordering fix already landed — ASSERTED, NOT OWNED

Two conditions must both hold for pgvector to use `builder_embeddings_hnsw_idx`
(`drizzle/0013_polite_night_thrasher.sql:19`): the `ORDER BY` operand must be a
parameter/constant, **and** the sort key must be the bare distance operator ascending. The shipped
code used to satisfy only the first (``.orderBy(desc(sql`1 - (${distance})`))``), so
`/api/search/semantic` seq-scanned the whole table. **That was fixed outside phase 2** in commit
`24a280b`. At HEAD the shipped shape is:

```ts
// src/shared/lib/repositories/public-builder-embeddings.ts:101-114 (already in master)
export function similarBuilderEmbeddingsQuery(db: PostgresJsDatabase, queryVector: number[], limit: number) {
  const distance = cosineDistance(builderEmbeddings.embedding, queryVector)
  return db
    .select({ source: …, sourceId: …, profile: …, similarity: sql<number>`1 - (${distance})` })
    .from(builderEmbeddings)
    .where(isNotNull(builderEmbeddings.embedding))
    .orderBy(asc(distance))       // bare operator, ascending — index-eligible
    .limit(limit)
}
```

Ascending cosine distance and descending `1 - distance` are the same total order, so every
caller's ordering is mathematically identical. The query builder is exported separately from
`findSimilarBuilderEmbeddings` precisely so a test can EXPLAIN the SQL the module actually emits;
`tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` does exactly that against a
disposable migrated database with `SET LOCAL enable_seqscan = off`, asserting
`Index Scan using builder_embeddings_hnsw_idx`, `Order By: (embedding <=>`, no `Seq Scan`, no
`Sort Key:` — plus a negative control proving the old derived-descending shape still cannot use the
index. `tests/e2e/semantic-search.spec.ts` covers the route end to end.

**This plan therefore writes no line of that function.** Its obligation is to keep depending on the
shape: `findLookAlikes` calls `findSimilarBuilderEmbeddings(vector, LOOKALIKE_CANDIDATE_LIMIT)` and
the existing EXPLAIN test is the regression guard for both callers. If that test is ever deleted or
the ordering reverted, this plan's p95 target is void.

Two properties to keep in mind, neither of which is an action item:

- **Exact → approximate.** A seq scan returns exact KNN; HNSW returns approximate KNN. Recall
  quality is bounded by `hnsw.ef_search` (default 40) — raising it explores more candidates and
  improves recall, at proportional cost. An earlier draft of this spec claimed `ef_search` must be
  **≥ the requested `LIMIT`** or the query "silently returns fewer rows than asked for". That is
  **false**. pgvector searches with `ef = max(hnsw.ef_search, limit)`, so the requested row count
  always comes back. Verified by `EXPLAIN (ANALYZE)` on a 5k-row HNSW index with `ef_search = 40`
  and the index scan actually chosen: `LIMIT 50 → 50 rows`, `LIMIT 60 → 60 rows`,
  `LIMIT 100 → 100 rows`. `SET LOCAL hnsw.ef_search = 100` is therefore a **recall-quality tuning
  knob, not a correctness requirement** — `LOOKALIKE_CANDIDATE_LIMIT = 60` is safe without it, and
  this plan does not set it. Do not reintroduce it justified by an under-return that does not
  happen. The repository's own doc comment now states the same thing.
- **An indexable `ORDER BY` makes the index available, not mandatory.** The planner still costs it
  against a seq scan; measured locally the crossover sits around ~2k embedded rows (352 rows → seq
  scan at ~7 ms; 2k/5k/20k rows → index scan). Any acceptance check that asserts an index scan must
  either set `enable_seqscan = off` or run against a corpus past that crossover, or it will fail on
  a correct query.
- **Cross-plan touchpoint** (conventions rule 6): `findSimilarBuilderEmbeddings` /
  `similarBuilderEmbeddingsQuery` are co-owned with `semantic-search`. The before/after comparison
  for the shipped ordering change already ran and showed zero delta — but only because at 352 rows
  the planner still chose the exact seq scan. The run that would actually exercise approximate
  recall is still open and belongs to whoever grows the corpus past ~2k rows; it is tracked as an
  unchecked task in this plan's Phase 3 rather than hidden under the checked one.

**Why the seed vector still round-trips through Node** rather than a self-joining SQL statement:
the parameter/constant condition above. `ORDER BY e.embedding <=> seed.embedding` against a joined
CTE is not a constant operand and falls back to a seq scan regardless of the ordering fix. Fetching
the seed's ~12 KB of floats and binding them as a parameter is what makes the second query
index-eligible at all.

```ts
// src/routes/api/search/similar.ts  (new)
// import { SOURCE_NAMES } from '~/lib/sources/types'   // 15 sources, `as const satisfies readonly SourceName[]`
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

`findLookAlikes` takes `{ seed, principal, entitlement }` — `principal` and `entitlement` are
needed even though `indexed`/`tracked` make no AI call, because the `text` branch's
`checkAndConsumeBudget` requires both, and the metering check demands that call sit in the same
function as `embedTexts` (see "Metering the pasted-seed embed"). They are the same
`Pick<TenantPrincipal, 'organizationId' | 'userId'>` / `Pick<EntitlementPolicy, 'tier'>` narrow
shapes `semanticSearch` already takes.

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
  `src/routes/_dashboard/sprints/new.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx` and
  `src/routes/_landing/explore/index.tsx`) gains an optional `similarHref?: string`, rendering a
  "Similar" ghost link only when passed — `/explore` (anonymous) passes nothing, so the public page
  is untouched. **`SearchPage.tsx` defines its own local `PersonResultCard`**
  (`src/modules/search/components/SearchPage.tsx:1345`) that shadows the shared one; the same link
  goes there too. Verified — that is the card search results actually render.
- **`/similar`** hosts both modes: seed header when `?source=&sourceId=`/`?builderId=` is present,
  otherwise the paste box (textarea + optional topics/language) with "Used once to find matches.
  Not stored."
- **Navigation** (updated 2026-07-27): the floating topbar `NAV` array in `DashboardLayout.tsx` no
  longer exists — commit `1e2ac57` moved navigation into shell C's registry,
  `src/modules/dashboard/ui/shell/nav-config.ts`, whose `NavItem` is
  `{ to, label, icon, group?, badge?, exact? }` (no `end`). The entry goes in the **`discover`**
  area: `{ to: '/similar', label: 'Look-alikes', icon: UsersRound, group: 'Discover' }`, **and**
  `'/similar'` must be appended to that area's `routes` array. Both halves are required:
  `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`'s "keeps every destination inside an
  area that owns its prefix" case fails if an item's `to` resolves to a different area, and without
  the prefix `/similar` resolves to the `home` fallback.
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
- Paste mode has a per-organization daily allowance in `src/shared/lib/billing-shared.ts`, beside
  `SOURCING_SPRINT_LIMITS`:

  ```ts
  export const LOOKALIKE_PASTE_LIMITS: Record<OrganizationTier, number> = {
    free: 0, pro: 20, pro_max: 100, team: 100,
  }
  ```

  **Keyed by `OrganizationTier`, indexed by `entitlement.tier` directly — no
  `resolveLegacyPlanTier` on this path.** An earlier draft of this spec called
  `Record<PlanTier, …>` + `resolveLegacyPlanTier` "the convention every other legacy table uses".
  That is no longer true and was already a known defect: `SOURCING_SPRINT_LIMITS` was migrated to
  `Record<OrganizationTier, number>` precisely because the `PlanTier` shape "left the advertised
  allowance and the enforced one free to disagree — they did" (`src/shared/lib/billing-shared.ts`
  lines 44–54), and `resolveLegacyPlanTier`'s own doc comment
  (`src/shared/lib/repositories/entitlements.ts` lines 33–48) now says: "Do NOT reach for this when
  the allowance is also *advertised* somewhere." Enforced by
  `rateLimit('lookalike-paste', principal.organizationId, LOOKALIKE_PASTE_LIMITS[entitlement.tier], 86400)`
  — org-scoped because the entitlement is. Bucket name verified unused (`rateLimit('…')` call sites
  at HEAD: `search`, `search-builders`, `search-semantic`, `sprint-create`, … — neither
  `search-similar` nor `lookalike-paste` is taken).
- All modes: `rateLimit('search-similar', principal.userId, 30, 60)`.
- Nothing is added to `AI_TASKS`, so nothing is added to its allowances table and nothing is
  addressable by `AI_DISABLED_TASKS`. The embedding spend on the `text` path is still metered — see
  "Metering the pasted-seed embed".
- **With `STRIPE_BILLING_ENABLED=false` (today) the gate is not theoretical**:
  `organization_entitlements` is already populated by admin action (`setPlatformUserPlan`), so the
  403 and the allowance are live and testable. No Checkout, webhook, or credit ledger is touched.
- `PLAN_PRICING.pro.features` gains the plain string `'Look-alike sourcing'` so promise and gate
  match (conventions rule 8). Deliberately **numberless**: the capability is what Pro buys, and
  `pro.features` is built with `compactFeatures(...)`, whose derived-bullet helpers exist for
  allowances that state a figure. Stating "20 pastes/day" there would recreate the exact copy/gate
  drift `SOURCING_SPRINT_LIMITS` was migrated to prevent.

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
  index is actually in use, which below ~2k embedded rows requires `enable_seqscan = off` (see "The
  HNSW ordering fix already landed"). The shape is already guarded permanently by
  `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`.
- **Zero** responses whose top result is the seed person — asserted in `collapseLookAlikes` tests
  and counted in production via the `lookalike_query` log event's `selfHitsSuppressed`.
- ≥ 30% of `/similar` result views end in a track (baseline: the current search→track rate).
- < 10% of requests returning `index_warming` after four weeks of organic use.
- Repos in a look-alike list: 0 once `kind` has backfilled (`repoRowsDropped` logged).

## Resolved edge cases

- **Seed not in the index**: upsert a stub via `upsertEmbeddingStubs` from the resolved public
  profile and return `pending`; the existing embed worker fills it on the next cron run. This is
  the only write this feature performs, and only for data that is already public — covered by
  `GRANT … INSERT, UPDATE ON builder_embeddings TO builderhunt_app`
  (`drizzle/0025_public_tables_app_grants.sql:19`), the same grant `/api/search/builders`'
  write-through already relies on.
- **Paste-mode embed budget exhausted**: `429 { error: 'seed_embed_budget' }` with `Retry-After`.
  Distinct from the org allowance 429 so the two ceilings are distinguishable in support.
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
