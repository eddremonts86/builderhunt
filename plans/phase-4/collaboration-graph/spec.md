# Co-Shipping Collaboration Graph (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../implemented/01-security-and-multitenancy/spec.md) (global-public data classification for a cross-tenant identity graph); [`production-infrastructure`](../../implemented/02-production-infrastructure/spec.md) (cron authentication and monitoring for a new long-running worker). Enhanced by [`look-alike-sourcing`](../look-alike-sourcing/spec.md) and [`team-synergy`](../../implemented/40-team-synergy/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check** (re-verified against master HEAD, 2026-07-27): `builder_identities` is the global-public identity store with a *deterministic* id (`sha256(source \0 sourceId)`, built in `trackOrganizationBuilder`, `src/shared/lib/repositories/organization-builders.ts` L278). `builder_processing_restrictions` + the `is_builder_processing_restricted(text)` SECURITY DEFINER function already exist (`drizzle/0017_enrichment_rls_policies.sql` L70–82, `EXECUTE` granted to `builderhunt_app` and `builderhunt_worker`; `src/shared/lib/repositories/enrichment-restrictions.ts`). `src/lib/sources/github.ts` fetches **only** `/search/users` (L46) and `/search/repositories` (L79) — no commit, contributor or co-author data is persisted anywhere today. The worker pattern to clone is `src/lib/discovery/worker.ts` + `src/routes/api/admin/alerts/run-worker.ts`, which now also wraps the run in `withJobRun({ jobKey })` and requires an entry in the code-side schedule registry `src/shared/lib/operational-schedules.ts`.

## Problem

Sourcing today is "describe the person you want". The strongest real-world signal is one BuilderHunt
never exposes: *who ships with whom*. A recruiter who has found X ("good frontend") cannot answer
"who does X actually ship with", which is often the better hire and is invisible in every mainstream
sourcing tool. BuilderHunt stores public identities and zero relationships between them.

## Goal

A **global, public-metadata-only** collaboration graph over `builder_identities`, plus an ego view on
a builder's profile:

1. One canonical undirected edge per `(identity pair, source)` with a defined, tested `strength`.
2. A resumable, quota-budgeted, cron-triggered worker deriving edges from public GitHub repository
   metadata — never private repos, never commit contents, never email addresses.
3. A 1-hop ego view in hand-written SVG (no graph library), with a full table equivalent, keyboard
   traversal, and reduced motion.
4. Hard exclusion of any subject with an active processing restriction — from their own graph *and*
   from everyone else's.

## Non-goals

- **No co-mention edges** (HN/Reddit threads). `src/lib/sources/hn.ts` queries the Algolia index for
  *hits* (L64–70) and the Firebase user endpoint (L103); nothing in `src/lib/sources/` fetches a
  comment tree or thread participant list. Deriving "co-mentioned in a thread" needs a fetch path
  that does not exist. Out of scope entirely.
- **No co-publication edges** (launches). Re-checked at HEAD, and the original reason ("both
  integrations are pending with zero code") is **no longer true** — but the conclusion survives on
  better grounds:
  - `src/lib/sources/producthunt.ts` L82 *does* request `makers { id name username … }` per post,
    so co-maker pairs are technically reachable. But it runs only inside an interactive federated
    search, persists nothing, is a no-op without `PRODUCTHUNT_TOKEN` (L41, unset everywhere), and
    would produce `producthunt`-namespaced nodes that can never join a `github` node given the
    no-cross-source-merging non-goal below.
  - `src/lib/devpost/scraper.ts` L78 *does* scrape `#app-team li.software-team-member`, but
    `src/lib/devpost/worker.ts` L82–83 flattens the roster into a flat `Set` of usernames and
    discards the co-membership relation; `devpost_profiles` (schema.ts L796) is keyed by Devpost
    username and carries no FK to `builder_identities`.

  Either edge source would need its own persistence and its own identity join. Out of scope here;
  recorded so a later plan does not re-derive the same finding.
- **No 2-hop or whole-network view.** Traversal is: click a node → their profile → their own ego
  graph. 2-hop is N× the cost and renders as an unreadable hairball.
- **No graph library** (d3-force, cytoscape, vis, sigma) and no physics simulation.
- **No cross-source identity merging** — a `github` node and an `npm` node for the same human stay
  separate; `src/lib/dedup.ts` is a search-time heuristic, too weak to merge people in a stored graph.
- **No employment or affiliation inference.** An edge means "co-appeared in public repository
  metadata", and the UI must say exactly that.
- No queue system, and **zero AI calls** — this plan adds no task to `src/shared/lib/ai/tasks.ts`.

## User stories

1. As a **Pro user** on `/builder/:id` I see "Ships with" — collaborators ranked by strength, each
   clickable to their profile, with source and last-seen per link.
2. As a **Pro user** I filter by minimum strength, time window (12 / 24 / all months) and source, and
   the view re-renders from the already-fetched payload.
3. As a **screen-reader or keyboard user** I get the same ranked data as a table of real links; the
   SVG is decorative and `aria-hidden`.
4. As a **free user** I see "14 frequent collaborators" and a Pro pill — the count, never the names.
5. As a **claimed subject** I can list the edges held about me, and restricting processing removes me
   from the graph everywhere within one request.

## Where the data comes from — RESOLVED (and it is not free)

`github.ts` calls `/search/users` and `/search/repositories` only. Neither returns commits,
contributors, or `Co-authored-by:` trailers. **This plan requires a new GitHub fetch path.** Two
sources, in this order:

| Edge source     | Fetch                                                                                                                       | Semantics                                                                | Cost                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `github_repo`   | REST `GET /users/{u}/events/public`, `GET /users/{u}/repos?sort=pushed`, then `GET /repos/{o}/{r}/contributors?per_page=100` | Both appear in one public repo's contributor list. Weaker, high coverage. | exactly `2 + COLLABORATION_REPOS_PER_ANCHOR` core REST requests per anchor (= 7 at the default) |
| `github_commit` | GraphQL `history(first:100){ nodes { authors(first:5){ nodes { user { login databaseId } } } } }`                            | True co-authorship — GraphQL resolves trailer emails to `User` nodes.     | 1 GraphQL query per repo, points by node count   |

REST `GET /repos/../commits` is deliberately **not** used for co-authorship: it returns the raw commit
message, so resolving `Co-authored-by: Name <email>` to an account would mean persisting an email or
calling `/search/users?q=<email>` (30 req/min bucket, unreliable, and a privacy expansion). GraphQL's
`Commit.authors` does that resolution at GitHub and returns `login` + `databaseId`, so no email ever
enters our process.

**Quota budget — the number to approve before writing any code.** `GITHUB_TOKEN` gives 5,000 core
REST requests/hour and 5,000 GraphQL points/hour. Today's federated search barely touches the *core*
bucket — `searchGitHub` (`src/lib/sources/github.ts`) only hits `/search/*`, which is a **separate**
30 req/min search bucket. The one existing core-bucket consumer is the enrichment worker
(`enrichment.refresh`, daily 03:00 Europe/Copenhagen), which is why the reserve below exists.

Exact per-anchor request count (all core REST, one page each — **no pagination**, deliberately: page
2 of a contributor list is by definition the long tail of a repo we are already damping):

| # | Request                                                | Count |
| - | ------------------------------------------------------ | ----- |
| 1 | `GET /users/{u}/events/public?per_page=100`             | 1 |
| 2 | `GET /users/{u}/repos?sort=pushed&per_page=30&type=owner` | 1 |
| 3 | `GET /repos/{o}/{r}/contributors?per_page=100&anon=false` | `COLLABORATION_REPOS_PER_ANCHOR` (5) |
|   | **per anchor**                                          | **7** |

With `COLLABORATION_ANCHORS_PER_RUN=8`: 7 × 8 = **56 core requests per run**. At the registered
cadence of `5,20,35,50 * * * *` (4 runs/hour) that is **224 core requests/hour = 4.48% of 5,000**,
and the success metric below asserts it stays under 10%.

Phase 7 adds up to `COLLABORATION_COAUTHOR_REPOS_PER_RUN` GraphQL queries per run — **default `0`,
i.e. off until deliberately enabled**, with `5` the intended steady-state value — each requesting
`rateLimit { cost remaining resetAt }` in the same document so cost is measured, not assumed.

**What happens at the limit**, in three distinct cases, because they behave differently:

1. *Core budget approaching exhaustion.* Before starting each anchor, if the most recent response's
   `x-ratelimit-remaining` is below `COLLABORATION_RATE_LIMIT_RESERVE` (500), the run stops cleanly:
   persist `haltedReason='rate_limit'` and `rateLimitResetAt` (from `x-ratelimit-reset`, a Unix
   epoch-seconds value), leave the cursor on the last *fully completed* anchor, log
   `collaboration_worker_rate_limited`, return `200 { ok: true, halted: 'rate_limit', … }`. A
   throttled run is a successful run, not a failure — `withJobRun` must therefore see
   `failedCount: 0`, or the job-runs history will show a red run for correct behaviour.
2. *A 403/429 arrives anyway* (secondary/abuse rate limit — GitHub returns these without a useful
   `x-ratelimit-remaining`). Every adapter function returns `[]` on a non-OK response and never
   throws; the anchor is counted as an error, the run continues to the next anchor, and the cursor
   does not advance past a failed anchor. If `retry-after` is present it is recorded in
   `rateLimitResetAt` and the run halts as in case 1.
3. *`GITHUB_TOKEN` unset.* The route returns `503 { error: 'github_unconfigured' }` and the worker
   does nothing — unauthenticated GitHub is 60 req/hour, which is not a budget, it is an outage.

The token must be fine-grained, **public repositories, read-only**, no other scope. It is the same
token the enrichment worker already uses; this plan does not introduce a second GitHub credential.

## Anchor rule — RESOLVED (bounded crawl, bounded privacy)

Requiring both endpoints to pre-exist in `builder_identities` makes the feature useless (the value is
discovering people you do *not* have). Crawling freely makes BuilderHunt a general GitHub scraper.

**Decision: every crawl is anchored.** The worker walks `builder_identities WHERE source='github'` in
`(created_at, id)` order. Per anchor it may create a *minimal* identity row for a discovered
co-contributor from fields the same public response already contains (`login`, `id`, `avatar_url`,
`html_url`), reusing the existing deterministic id. No extra request per discovered person; no bio, no
email, no location. Every edge therefore has at least one endpoint BuilderHunt already knew, and the
graph can never grow beyond one hop per run.

**This write is INSERT-ONLY (`onConflictDoNothing`), not `trackOrganizationBuilder`'s upsert.** That
upsert's SET clause (`organization-builders.ts` L294–307) unconditionally writes
`followersCount: input.followersCount ?? 0`, `language: … ?? null`, `bio: … ?? null` and
`lastSeenAt: new Date()`. A contributor-list row supplies none of them, so reusing it would zero
`builder_identities.followers_count`, null `language`/`bio` and falsely refresh `last_seen_at` on
**every already-known identity the crawler touches** — columns read by `organization-builders.ts`
L41/L45 (tracked list / dashboard / CSV export) and `public-builders.ts` L12 (public profile, via
`findPublishedBuilderProfile`). Insert-only makes it
structurally impossible for the crawler to degrade a row the track path enriched. It also means the
crawler never refreshes `last_seen_at`; if that is wanted later it must be a separate narrow
`UPDATE … SET last_seen_at = now()` naming no other column.

### Cross-plan touchpoint: `builder_identities` (conventions rule 6)

This plan becomes a **second writer** of `builder_identities` — specifically of `first_seen_at`
(`schema.ts` L153, `.defaultNow().notNull()`), which was documented as "written only by
`trackOrganizationBuilder`", i.e. only when a paying tenant tracked someone. That premise underpins
the market-reports plan's population framing. Because `first_seen_at` is `notNull()` with a default,
"not setting it" is not available; a crawler insert *will* stamp it.

**Status at HEAD: already accepted downstream.** [`talent-market-intelligence`](../talent-market-intelligence/spec.md)
L84 and L128–133 already record the two-writer reality and the `discovered_by IS NULL` filter, and
[`plans/phase-2/README.md`](../README.md) registers `discovered_by` as a shared surface. Nothing here
is a surprise to another plan; what remains is to actually add the column.

**Resolution: an explicit provenance marker.** Phase 1 adds a nullable
`discoveredBy: text('discovered_by')` to `builder_identities`, left `NULL` by every existing writer
and set to `'collaboration_crawl'` by this plan's insert-only path. `first_seen_at` on a
`discovered_by = 'collaboration_crawl'` row means "when our crawler first saw them", not "when a
tenant first tracked them"; `talent-market-intelligence` restores its premise verbatim with
`WHERE discovered_by IS NULL`. Chosen over deriving the distinction from
`EXISTS (SELECT 1 FROM organization_builders WHERE builder_identity_id = …)`, which is only a proxy:
it reads as "currently tracked", so an identity a tenant tracked and later untracked would be
misclassified as crawler-discovered. The column is additive, nullable, backfill-free, and
self-documenting for the next writer.

I own the value `'collaboration_crawl'` only; the column is a shared surface, so any future crawler
adds its own value rather than reusing mine.

## Architecture

### 1. Schema — data class: **global public** (no `organization_id`)

Same class as `builder_identities` / `builder_embeddings`: externally sourced public data, one row per
fact about the world, identical for every tenant. Adding `organization_id` would be actively wrong —
N copies of one global truth, N× the GitHub quota, and one tenant could infer another's crawl
activity. Consequences per [`security-policy`](../../_meta/security-policy.md): **no RLS** (no owning
tenant to filter on), access controlled entirely by `GRANT`, DTO allowlist on read, provenance per
edge. Precedent and its lesson: `drizzle/0025_public_tables_app_grants.sql` —
`builder_embeddings`/`discovery_state` shipped with *no* grant for `builderhunt_app` and every write
silently failed for weeks. Grants here are a first-class task.

**Which role writes what** (every write below is checked against a real `GRANT` in the Phase-1
grants migration; the seven roles at HEAD are `builderhunt_owner`, `_app`, `_worker`, `_platform`,
`_capability`, `_auth`, `_readonly`):

| Write                                                     | Client        | Role                    | Grant it needs |
| ---------------------------------------------------------- | ------------- | ----------------------- | -------------- |
| edge upsert, state upsert                                  | `publicDb`    | `builderhunt_app`       | new: `SELECT, INSERT, UPDATE, DELETE` on `builder_collaboration_edges`; `SELECT, INSERT, UPDATE` on `collaboration_graph_state` |
| discovered-identity insert                                 | `publicDb`    | `builderhunt_app`       | **already exists** — `GRANT SELECT, INSERT, UPDATE ON TABLE builder_identities TO builderhunt_app` (`drizzle/0011_builder_claim_policies.sql` L31). No new grant, and no RLS on `builder_identities`. |
| `is_builder_processing_restricted(text)` call              | `publicDb`    | `builderhunt_app`       | **already exists** — `drizzle/0017_enrichment_rls_policies.sql` L82 |
| restriction-cascade edge delete                            | `platformDb`  | `builderhunt_platform`  | new: `SELECT, DELETE` on `builder_collaboration_edges` |
| `job_runs` row opened/closed by `withJobRun`               | `workerDb`    | `builderhunt_worker`    | **already exists** — `drizzle/0067_operational_schedule_grants.sql` L24 |
| ego read                                                   | `publicDb`    | `builderhunt_app`       | covered by the `SELECT` above |

`builderhunt_capability` gets **nothing** here: it exists only for the accountless scheduling
capability path (`drizzle/0078_capability_role.sql`) and must not reach an identity graph.
`builderhunt_worker` gets `SELECT` only — the isolation script asserts its `INSERT` is refused.

```ts
// src/shared/lib/db/schema.ts — add `doublePrecision` to the pg-core import list.
export const builderCollaborationEdges = pgTable(
  'builder_collaboration_edges',
  {
    id: text('id').primaryKey(), // sha256(source \0 aId \0 bId) — deterministic, upsert needs no read
    builderIdentityAId: text('builder_identity_a_id').notNull()
      .references(() => builderIdentities.id, { onDelete: 'cascade' }),
    builderIdentityBId: text('builder_identity_b_id').notNull()
      .references(() => builderIdentities.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // 'github_repo' | 'github_commit'
    // Capped, versioned provenance snapshot (security-policy rule 8: artifacts only, never
    // authorization data). Max 20 most-recent shared artifacts.
    observations: jsonb('observations').$type<CollaborationObservations>().notNull(),
    rawWeight: doublePrecision('raw_weight').notNull().default(0), // pair-local, decayed, damped
    strength: doublePrecision('strength').notNull().default(0), // degree-normalized 0..1 (2nd pass)
    observationCount: integer('observation_count').notNull().default(0),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).defaultNow().notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The ordering bug in the original sketch: (A,B) and (B,A) must not coexist.
    check('builder_collaboration_edges_canonical_order',
      sql`${table.builderIdentityAId} < ${table.builderIdentityBId}`),
    uniqueIndex('builder_collaboration_edges_pair_source_unique')
      .on(table.builderIdentityAId, table.builderIdentityBId, table.source),
    // Canonical ordering means an ego query is `a_id = $ego OR b_id = $ego` — both sides need an
    // index or every profile view is a sequential scan.
    index('builder_collaboration_edges_a_strength_idx').on(table.builderIdentityAId, table.strength),
    index('builder_collaboration_edges_b_strength_idx').on(table.builderIdentityBId, table.strength),
    check('builder_collaboration_edges_source_check',
      sql`${table.source} in ('github_repo', 'github_commit')`),
    check('builder_collaboration_edges_strength_range',
      sql`${table.strength} >= 0 and ${table.strength} <= 1`),
  ],
)

/** Public artifact ref only ('owner/repo') — never a commit message, never a tokenized URL. */
export interface CollaborationObservation { artifactRef: string; participantCount: number; lastActivityAt: string }
export interface CollaborationObservations { version: 1; artifacts: CollaborationObservation[] }
```

One additive, nullable column on an existing table (§Cross-plan touchpoint) — the only change this
plan makes to `builder_identities`:

```ts
// src/shared/lib/db/schema.ts, inside builderIdentities:
/** NULL for every pre-existing row and every `trackOrganizationBuilder` write. Shared surface —
 *  this plan owns exactly the value 'collaboration_crawl'. */
discoveredBy: text('discovered_by'),
```

Cursor state lives in **its own singleton table**, mirroring `discovery_state` rather than squatting a
second row in it (`discovery_state.lastCellKey`/`stats` are matrix-specific):

```ts
export const collaborationGraphState = pgTable('collaboration_graph_state', {
  id: text('id').primaryKey(), // constant 'default'
  /** Last FULLY completed anchor identity, in `(created_at, id)` order. Never mid-anchor. */
  lastAnchorIdentityId: text('last_anchor_identity_id'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  haltedReason: text('halted_reason'), // null | 'rate_limit' | 'error'
  rateLimitResetAt: timestamp('rate_limit_reset_at', { withTimezone: true }),
  stats: jsonb('stats').$type<{ runs: number; anchors: number; edges: number; skippedRestricted: number; errors: number }>()
    .notNull().default({ runs: 0, anchors: 0, edges: 0, skippedRestricted: 0, errors: 0 }),
})
```

### 2. `strength` — the exact formula (pure, tested)

`src/lib/collaboration/strength.ts` (new). Two stages, because a pair-local number cannot know about hubs.

**Stage 1 — `rawWeight` (pair-local, idempotent).** Reuses the decay mechanic already in
`src/shared/lib/abuse/risk.ts` (`0.5 ** (age / halfLife)`, L51) rather than inventing a second curve,
with `COLLABORATION_HALF_LIFE_DAYS = 180` as a code constant like `RISK_DECAY_HALF_LIFE_HOURS`:

```
SOURCE_WEIGHT  = { github_commit: 1.0, github_repo: 0.5 }
sizeDamping(n) = 1 / Math.log2(2 + n)     // 800-contributor repo ≈ 0.10 vs 3-person repo ≈ 0.43
artifactWeight(a) = SOURCE_WEIGHT[source] * sizeDamping(a.participantCount)
                    * 0.5 ** (ageDays(a.lastActivityAt, now) / 180)
rawWeight = Σ artifactWeight(a)   over the stored (capped) artifact list
```

This is **recomputed from the stored artifact list, never accumulated**, so re-running the worker over
the same repos yields the identical number — that is what makes the worker idempotent without an
event-log table.

**Stage 2 — `strength` (degree-normalized, 0..1).** Salton/cosine normalization against each
endpoint's total weight — exactly the anti-hub requirement:

```
nodeTotal(X) = Σ rawWeight over every edge touching X    // one SQL aggregate, no extra table
strength     = clamp01( rawWeight / Math.sqrt(nodeTotal(A) * nodeTotal(B)) )
```

A maintainer who merges everyone's PRs has a huge `nodeTotal`, so each of their edges normalizes
*down* toward zero; a two-person pair who only ship with each other normalizes toward 1. Both
functions are pure and unit-tested (monotonicity, hub suppression, half-life, clamping, empty input,
invariance under swapping A/B).

Staleness is honest: the worker renormalizes edges touching identities it touched this run;
neighbours-of-neighbours keep a slightly stale `strength` until the cursor wraps, when a full
renormalization pass runs. `computedAt` records when each edge was last normalized.

### 3. Worker — `POST /api/admin/collaboration-graph/run-worker`

Auth exactly like `src/routes/api/admin/alerts/run-worker.ts`:
`tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, then
`auditPlatformAdminAction`. No body.

**Scheduling is no longer a crontab line in a doc.** Since the
`calendar-scheduling-interview-intelligence` work landed (`drizzle/0066_orange_the_enforcers.sql` / `drizzle/0067_operational_schedule_grants.sql`), every scheduled job
is (a) an entry in the code-side registry `src/shared/lib/operational-schedules.ts` and (b) wrapped
in `withJobRun({ jobKey }, …)` from `src/shared/lib/repositories/platform-operations.ts`, which opens
and closes a `job_runs` row and advances `next_run_at`. `assertRegistryIsSafe` (unit-tested in
`tests/unit/shared/lib/operational-schedules.test.ts`) rejects duplicate job keys, a `sourceRoute`
outside `/api/admin/`, an unknown timezone, or an unparseable cron. Registry entry:

```ts
{ jobKey: 'collaboration.crawl',
  cronExpression: '5,20,35,50 * * * *',   // every 15 min, offset 5 from the :00 grid
  timezone: 'UTC',
  scope: 'platform',
  label: 'Collaboration graph crawl',
  sourceRoute: '/api/admin/collaboration-graph/run-worker' }
```

The offset is not about the discovery worker — `discovery.crawl` is `0 4 * * *`
(Europe/Copenhagen), daily, and never contends. The two jobs that matter are `alerts.evaluate`
(`*/15 * * * *`, the :00/:15/:30/:45 grid) and `enrichment.refresh` (`0 3 * * *`), which is the other
`GITHUB_TOKEN` consumer. Offsetting to minute 5 keeps this worker off the busiest minute of the hour;
the 03:00 overlap once a day is absorbed by `COLLABORATION_RATE_LIMIT_RESERVE`.

`runCollaborationWorker()` in `src/lib/collaboration/worker.ts` (new) uses `publicDb` (app role), like
`src/lib/discovery/worker.ts`:

1. Skip with `503` when `COLLABORATION_ENABLED !== 'true'` or `GITHUB_TOKEN` is unset.
2. Load/insert the singleton state; select the next `COLLABORATION_ANCHORS_PER_RUN` github identities
   after `lastAnchorIdentityId`.
3. Skip an anchor when `is_builder_processing_restricted(anchorId)` (counted, not an error).
4. Public events + owned repos → ≤ `COLLABORATION_REPOS_PER_ANCHOR` distinct public non-fork repos by
   recency → contributors per repo.
5. Pair `(anchor, contributor)` and `(contributor, contributor)` only for repos with
   `participantCount ≤ COLLABORATION_MAX_PARTICIPANTS` — a **module constant of 50**, not an env var
   (it is a correctness threshold the strength tests are written against, not an ops dial). Above it a
   repo says nothing and the pair count explodes quadratically.
6. Drop pairs where either endpoint is restricted; insert-only any missing identity (§Anchor rule);
   upsert edges with the
   pair canonically ordered in JS *before* the insert, so the CHECK never fires; merge the artifact
   list (dedupe by `artifactRef`, keep 20 most recent); recompute `rawWeight`.
7. Advance the cursor **only after an anchor completes fully**; wrap to `null` at the end of the list
   and run the full renormalization pass.
8. **Quota exhaustion mid-run**: before each anchor, if the last response's
   `x-ratelimit-remaining < COLLABORATION_RATE_LIMIT_RESERVE`, stop, persist
   `haltedReason='rate_limit'` + `rateLimitResetAt` from `x-ratelimit-reset`, log
   `collaboration_worker_rate_limited`, return `200 { ok: true, halted: 'rate_limit', … }` — a
   throttled run is a successful run. The next invocation resumes at the same anchor; anchors are
   idempotent, so a partially-crawled anchor loses nothing.
9. Returns `{ anchors, repos, pairs, edgesUpserted, identitiesCreated, skippedRestricted, halted, cursor }`.

### 4. Read path — `GET /api/builders/$builderId/collaboration`

1. `requireTenantPrincipal` (401); `rateLimit('collaboration-graph', principal.userId, 60, 60)`.
1b. **Enumeration cap** (see §Enumeration below): `429 { error: 'enumeration_cap' }` past
   `COLLABORATION_DAILY_SUBJECTS_PER_USER` distinct subjects in a rolling UTC day.
2. Entitlement gate (§Tier gating). Free ⇒ `200 { locked: true, neighborCount }` — the count only.
3. `listEgoGraph()` in `src/shared/lib/repositories/collaboration-graph.ts` (new, `publicDb`, no
   `withTenantContext` — global table, same convention as `public-builder-embeddings.ts`): one query,
   `WHERE (a_id = $ego OR b_id = $ego) AND strength >= $min AND last_observed_at >= $since`, joined to
   `builder_identities` for the counterpart, `ORDER BY strength DESC`, `LIMIT cap + 1`.
4. **Restriction filter at read time too**: `AND NOT is_builder_processing_restricted(a_id) AND NOT
   is_builder_processing_restricted(b_id)`. Deletion on restriction is the durable fix; this covers
   the window before the next crawl and any bug in the write-side check.
5. DTO allowlist: `{ id, source, username, displayName, avatarUrl, profileUrl, strength, edgeSource,
   observationCount, lastObservedAt, sharedArtifactCount }`. Never `observations.artifacts` verbatim
   (it would expose the crawl's exact repo picks), never `rawWeight`.
6. **Not tracked-gated.** Unlike `/api/builders/$builderId/enrichment` (which needs an
   `organization_builders` row because it *writes* tenant-private artifacts), this reads global public
   data, and the entire point is discovering people the org has not tracked.

### Enumeration — the threat case this endpoint actually has

`builderIdentityId` is `sha256(source \0 sourceId)`: **deterministic and derivable offline** from a
GitHub numeric user id, so it is not a capability. Without a control, one Pro seat can walk the entire
global relationship graph at 60 req/min — bulk extraction of the exact dataset this spec calls its
largest risk. [`security-policy`](../../_meta/security-policy.md) L108 lists "ID enumeration and
response-timing/existence leakage" as a required threat case, and a tracked-gate is deliberately
unavailable here (§4.6).

**Control: a per-seat daily distinct-subject cap**, `COLLABORATION_DAILY_SUBJECTS_PER_USER = 200`
(module constant). Counted with a Redis set keyed `collab:subjects:{userId}:{YYYY-MM-DD}` —
`SADD` then `SCARD`, 48 h TTL — so re-viewing the same subject is free and only *breadth* is charged.
Same mechanic and same in-memory fallback caveat as the discovery worker's daily counter
(`peekStubCount`/`incrementStubCount`, `src/lib/discovery/worker.ts` L74–93, keyed
`discovery:stubs:{YYYY-MM-DD}`) and `src/shared/lib/rate-limit.ts`. `getRedis()` returns an `ioredis`
client, so `sadd`/`scard`/`expire` are available directly. Over cap ⇒
`429 { error: 'enumeration_cap' }` and `log.warn('collaboration_enumeration_cap', { userId, organizationId })`,
surfaced on the admin metrics page. No `abuse_signals` row: none of that table's `type` CHECK values
fits (`drizzle/0043_abuse_usage_integrity_tables.sql` L10, last widened by
`drizzle/0046_abuse_signals_credit_spend_velocity.sql`), and widening a security table's constraint
from a product plan is out of scope here.

200 distinct profiles/day is far above genuine sourcing behaviour (a recruiter opens tens of profiles
a day) and far below useful bulk extraction of a graph with 100k+ edges. The cap is per **seat**, not
per organization, and seats are hard-capped at 10 by `organization_entitlements_seat_limit_check`
(`drizzle/0004_organization_entitlements.sql` L16, `between 1 and 10`), so the organization-level
ceiling is 2,000 distinct subjects/day and is bounded too.

### 5. Render — precomputed radial ego layout, hand-written SVG

`layoutEgoGraph(neighbors, opts)` in `src/lib/collaboration/layout.ts` (new) is a **pure function**, so the
layout is unit-tested and byte-identical between renders — no jitter, no simulation, no animation loop:

- Ego implicit at `(0,0)`. Neighbours split into two rings by strength (`≥ 0.5` → r=110, else r=190),
  sorted by strength desc, angle `= ringOffset + i * 2π / ringCount`.
- Node radius `8 + 10 * strength`; edge `stroke-width = 1 + 4 * strength`,
  `opacity = 0.25 + 0.5 * strength`. Strength is **never encoded by colour alone** (WCAG 1.4.1):
  width + node size + a printed number in the label and the table.
- Node cap comes from the tier (§Tier gating): 12 neighbours on Pro, 24 on Team. Beyond the cap the
  header reads "Showing the 24 strongest of 137 connections" and the table lists all of them,
  paginated 50/page. Nothing is ever silently truncated.
- SVG is `viewBox`-scaled, `max-width: 100%`, `aria-hidden="true"`.

**Accessibility** ([`audit-accessibility`](../../implemented/48-audit-accessibility/spec.md) is a release
gate, run as `pnpm test:a11y` → `tests/regression/test-accessibility.mjs`): the accessible equivalent is not an
afterthought. The component always renders a real `<table>` (counterpart link, source, strength,
shared artifacts, last seen) with a visible "Graph / Table" toggle; graph mode keeps the table
visually hidden but in the DOM and reachable. Every node in the graph is also a focusable `<a>` in
strength order, so a sighted keyboard user traverses the visual view in the same ranking. Under
`prefers-reduced-motion: reduce` no transition is applied at all; otherwise the only motion is a
150 ms hover/focus opacity change. A caption states the exact meaning: "Links are co-appearance in
public repository metadata, not confirmed working relationships."

## UX integration

- `src/modules/builder-profile/components/BuilderProfilePage.tsx`: a new `CollaborationGraphCard`
  below `<PersonaCard …/>` (L352, in the right-hand column), fetched on mount with plain `fetch` +
  `React.useState` (that module's existing style — it does not use React Query; see `PersonaCard.tsx`
  L21–26's `FetchState` discriminated union and L45's `useState<FetchState>`).
- Filters (min-strength, window, source) filter the fetched payload client-side; widening the window
  beyond the fetched range refetches.
- Free tier: locked card with the neighbour count and a `Pro` pill linking to `/pricing`. **The
  original claim that this idiom lives at `BuilderProfilePage.tsx` L300/L305 is stale — that file
  contains no locked/upsell section at HEAD.** The real precedent in this same module is
  `TeamFitCard.tsx`: a `{ kind: 'plan' }` arm of its result union rendering a `Lock` icon inside
  `border-bh-accent/30 bg-bh-accent-soft` with a `data-testid` (L118–128). Copy that shape and give
  it `data-testid="collaboration-graph-upgrade"`. Hidden entirely on
  `503 { error: 'collaboration_disabled' }`.
- **Not** rendered on the public route `src/routes/builders/$builderId.tsx` — publishing a
  relationship graph on an unauthenticated page is a privacy escalation this plan does not take.

## Tier gating

**Corrected at HEAD.** The plan originally said `Record<PlanTier, number>` "same convention as
`SOURCING_SPRINT_LIMITS`". `SOURCING_SPRINT_LIMITS` is no longer keyed that way: it is
`Record<OrganizationTier, number>` (`billing-shared.ts` L54), and its own comment (L43–53) records
that the `Record<PlanTier, …>` shape *was the bug* — it forced enforcement through
`resolveLegacyPlanTier` and let `/pricing` advertise 3 sprints for Pro Max while the code allowed 10.
`entitlements.ts` L44–47 now states the rule outright: "Do NOT reach for `resolveLegacyPlanTier` when
the allowance is also *advertised* somewhere." This plan advertises its allowance on `/pricing`, so
it must follow the corrected shape or it reintroduces the exact defect that was just fixed.

- New in `src/shared/lib/billing-shared.ts`, next to `SOURCING_SPRINT_LIMITS`:

  ```ts
  export const COLLABORATION_GRAPH_LIMITS: Record<OrganizationTier, number> = {
    free: 0, pro: 12, pro_max: 24, team: 24,
  }

  /** Plan-card bullet, e.g. `Collaboration graph (12 links)`. `null` for a zero allowance. */
  export function collaborationGraphFeature(tier: OrganizationTier): string | null {
    const limit = COLLABORATION_GRAPH_LIMITS[tier]
    return limit > 0 ? `Collaboration graph (${limit} links)` : null
  }
  ```

- `PLAN_PRICING.pro.features` and `.team.features` get `collaborationGraphFeature('pro')` /
  `collaborationGraphFeature('team')` inside their existing `compactFeatures(…)` calls — a derived
  string, never a hand-written one, so copy and enforcement cannot disagree.
- The route reads `getOrganizationEntitlement(tx, principal.organizationId)` and requires
  `policy.paidActionsAllowed`, then indexes `COLLABORATION_GRAPH_LIMITS[policy.tier]` **directly** —
  no `resolveLegacyPlanTier`. Free, `paymentBlocked`, or a zero allowance ⇒
  `{ locked: true, neighborCount }`.
- **`STRIPE_BILLING_ENABLED` is `false` by default (`env.ts` L141) and stays false.** Nothing here
  needs Stripe: `organization_entitlements` is granted manually today by a platform admin via
  `setPlatformUserPlan`, which is exactly how `ai-sourcing-sprints`' tier gate already works. Note
  that only a real Stripe subscription can ever set `pro_max`, so the `pro_max: 24` row is
  unreachable until Stripe lands — it is there so the row exists before the tier does, not because
  it is live.

## Privacy — the largest risk, resolved explicitly

Inference about relationships between named real people, so
[`security-policy`](../../_meta/security-policy.md) and
[`legal-and-compliance`](../../implemented/04-legal-and-compliance/spec.md) both apply.

1. **Public repository metadata only.** Contributor lists and commit authorship on public repos. No
   private repos (the token has no scope), no commit messages, no diffs, no email addresses at any
   point — `github_commit` uses GraphQL precisely so trailer emails resolve at GitHub.
2. **Restriction exclusion is a cascade, in four places.** (a) A restricted identity is never chosen
   as an anchor. (b) No edge is written where *either* endpoint is restricted, checked via
   `is_builder_processing_restricted` before the upsert. (c) `cascadeBuilderProcessingRestriction()`
   in `src/lib/enrichment/worker.ts` (L206, called by `POST /api/me/builder/$builderId/restrict-processing`)
   gains a `deleteCollaborationEdgesForIdentity()` step, so activating a restriction deletes every
   edge touching that identity **including the ones inside other people's ego graphs** — that is the
   cascade problem, and it is tractable precisely because the graph is global: there is exactly one
   copy to delete. (d) The read query re-checks both endpoints. Withdrawal is symmetric: edges are not
   resurrected, they simply regenerate on a later crawl.
3. **Subject transparency.** New `GET /api/me/builder/$builderId/collaboration` (verified-claimant
   only, same `isVerifiedBuilderClaimant` gate as `restrict-processing.ts`) lists the edges held about
   the subject, so the graph is inspectable by the person it describes.
4. **Output minimization**: `observations.artifacts` never reaches a client, only its count.
5. **What an edge means is stated in the UI**, not left to the reader (§5).
6. `builder_identities` deletion cascades to edges by FK, so a subject-deletion path needs no extra
   work.

## Success metrics

- ≥ 60% of `builder_identities WHERE source='github'` have ≥ 1 edge after 4 weeks at the registered
  `5,20,35,50 * * * *` cadence (≈ 2,688 anchors/week at 8 anchors/run).
- Ego-graph read p95 < 120 ms at 100k edges (both strength indexes exercised, no seq scan).
- Core GitHub REST consumption by this worker < 10% of the hourly budget, measured from the
  `x-ratelimit-*` headers logged on every run.
- **Zero** edges involving a restricted identity, asserted by `pnpm test:api-isolation:local`.
- ≥ 20% of Pro users who open a profile with a non-empty graph click through to a neighbour — the
  whole "derived discovery" hypothesis, measurable from existing route logs.

## Resolved edge cases

- **Graph enumeration by a paying seat** — identity ids are offline-derivable, so the id is not a
  capability. Bounded by `COLLABORATION_DAILY_SUBJECTS_PER_USER = 200` distinct subjects per seat per
  UTC day (Redis set, breadth-charged only) on top of the existing 60 req/min limit; over cap ⇒ `429
  { error: 'enumeration_cap' }`, logged and surfaced on admin metrics. Asserted in
  `pnpm test:api-isolation:local`. See §Enumeration.
- **Crawler-created identities skewing another plan's population frame** — `discovered_by =
  'collaboration_crawl'` marks them; [`talent-market-intelligence`](../talent-market-intelligence/spec.md)
  filters `discovered_by IS NULL` (already written into that plan at L84/L128–133).
  See §Cross-plan touchpoint.
- **Crawler degrading a known identity's profile fields** — impossible by construction: the discovered
  identity write is `onConflictDoNothing`, never an update. See §Anchor rule.
- **Both `(A,B)` and `(B,A)` observed** — canonical ordering in JS before the insert (`a < b` on the
  sha256 hex ids); the CHECK is the backstop, so a regression is a loud DB error, not silent dupes.
- **Same pair, two sources** — two rows. The read path returns the strongest per counterpart and
  reports the source set; it does not sum them (double-counting the same repo observed both ways).
- **Bot accounts** (`dependabot`, `renovate`, `github-actions[bot]`) — dropped by a tested
  `isLikelyBotLogin()` (a `[bot]` suffix, GitHub `type: 'Bot'`, small deny-list). Without this, every
  graph is a star around Dependabot.
- **Huge repos** — skipped above 50 participants, and damped by `sizeDamping` if a repo grows past
  that after being observed.
- **Anchor deleted upstream** — the identity row stays (public snapshot, same policy as
  `builder_embeddings`); its edges decay below the UI's default `minStrength`, so a dead relationship
  fades rather than vanishing abruptly.
- **Empty graph** — "No collaboration data yet", with a line explaining the crawl is progressive.
  Never a spinner that never resolves.
- **A rate-limited run must not look like a broken job** — `withJobRun` marks a run `failed` when the
  callback returns `failedCount > 0` (`platform-operations.ts` L202). A `halted: 'rate_limit'` run
  therefore reports `failedCount: 0` and surfaces the halt through `collaboration_graph_state`, not
  through `job_runs.state`. Only per-anchor crawl errors count toward `failedCount`.
- **`COLLABORATION_ENABLED=false`** (the default everywhere, including production at first) — the
  worker no-ops and the read route 503s, so the schema ships long before the crawl is switched on.
  The 503 returns *before* `withJobRun` is entered, so a disabled worker writes no `job_runs` row.
  Its `operational_schedules` row is therefore created with `enabled = false` and only flipped on in
  the same change that sets `COLLABORATION_ENABLED=true`, because `advanceScheduleAfterRun`
  (`platform-operations.ts` L133) only updates rows `WHERE enabled = true` — an enabled row that
  never runs would leave `next_run_at` permanently in the past and show as a perpetually-overdue job
  on the operations calendar.
- **Registry drift** — the code registry is reconciled into `operational_schedules` only by
  `POST /api/admin/operations/sync-schedules`, never on boot. Adding the registry entry is therefore
  two steps: the code change, then one sync call. Skipping the sync means the job runs (cron calls
  the route directly) but has no schedule row, so `withJobRun` records `scheduleId: null` and the
  calendar shows nothing.
