# Co-Shipping Collaboration Graph (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (global-public data classification for a cross-tenant identity graph); [`production-infrastructure`](../../production-infrastructure/spec.md) (cron authentication and monitoring for a new long-running worker). Enhanced by [`look-alike-sourcing`](../look-alike-sourcing/spec.md) and [`team-synergy`](../../team-synergy/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: `builder_identities` is the global-public identity store with a *deterministic* id (`sha256(source \0 sourceId)`, `src/shared/lib/repositories/organization-builders.ts` L212). `builder_processing_restrictions` + the `is_builder_processing_restricted(text)` SECURITY DEFINER function already exist (`drizzle/0017_enrichment_rls_policies.sql`, `src/shared/lib/repositories/enrichment-restrictions.ts`). `src/lib/sources/github.ts` fetches **only** `/search/users` and `/search/repositories` — no commit, contributor or co-author data exists anywhere today. The worker pattern to clone is `src/lib/discovery/worker.ts` + `src/routes/api/admin/alerts/run-worker.ts`.

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
  *hits*; nothing in `src/lib/sources/` fetches a comment tree or thread participant list. Deriving
  "co-mentioned in a thread" needs a fetch path that does not exist. Out of scope entirely.
- **No co-publication edges** (launches). `producthunt-integration` and `devpost-integration` are
  `pending` with zero code (`_meta/app-reality.md`) — there is no launch data to join on.
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
| `github_repo`   | REST `GET /users/{u}/events/public`, `GET /users/{u}/repos?sort=pushed`, then `GET /repos/{o}/{r}/contributors?per_page=100` | Both appear in one public repo's contributor list. Weaker, high coverage. | ~2 + `REPOS_PER_ANCHOR` core requests per anchor |
| `github_commit` | GraphQL `history(first:100){ nodes { authors(first:5){ nodes { user { login databaseId } } } } }`                            | True co-authorship — GraphQL resolves trailer emails to `User` nodes.     | 1 GraphQL query per repo, points by node count   |

REST `GET /repos/../commits` is deliberately **not** used for co-authorship: it returns the raw commit
message, so resolving `Co-authored-by: Name <email>` to an account would mean persisting an email or
calling `/search/users?q=<email>` (30 req/min bucket, unreliable, and a privacy expansion). GraphQL's
`Commit.authors` does that resolution at GitHub and returns `login` + `databaseId`, so no email ever
enters our process.

**Quota budget.** `GITHUB_TOKEN` gives 5,000 core REST requests/hour and 5,000 GraphQL points/hour.
Today's federated search barely touches the *core* bucket — `searchGitHub` only hits `/search/*`, a
separate 30 req/min bucket. With `COLLABORATION_ANCHORS_PER_RUN=8` and
`COLLABORATION_REPOS_PER_ANCHOR=5`: ~7 core requests per anchor × 8 = **~56 per run**, at 4 runs/hour
= **~224/hour, 4.5% of the core budget**. Phase 7 adds up to `COLLABORATION_COAUTHOR_REPOS_PER_RUN`
GraphQL queries per run — **default `0`, i.e. off until deliberately enabled**, with `5` the intended
steady-state value — each requesting `rateLimit { cost remaining resetAt }` so cost is measured, not
assumed. Hard stop: abort before the next anchor when `x-ratelimit-remaining` falls below
`COLLABORATION_RATE_LIMIT_RESERVE` (500), leaving headroom for interactive search. `GITHUB_TOKEN`
unset ⇒ the worker 503s and does nothing (unauthenticated GitHub is 60 req/hour). The token must be
fine-grained, **public repositories, read-only**, no other scope.

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
upsert's SET clause (`organization-builders.ts` L228–241) unconditionally writes
`followersCount: input.followersCount ?? 0` and `language: … ?? null`. A contributor-list row supplies
neither, so reusing it would zero `builder_identities.followersCount` and null `language` on **every
already-known identity the crawler touches** — columns read by `organization-builders.ts` L41 (tracked
list / dashboard / CSV export) and `public-builders.ts` L12 (public profile). Insert-only makes it
structurally impossible for the crawler to degrade a row the track path enriched. It also means the
crawler never refreshes `last_seen_at`; if that is wanted later it must be a separate narrow
`UPDATE … SET last_seen_at = now()` naming no other column.

### Cross-plan touchpoint: `builder_identities` (conventions rule 6)

This plan becomes a **second writer** of `builder_identities` — specifically of `first_seen_at`, which
`plans/fase-2/talent-market-intelligence/spec.md` L84 and `_meta/app-reality.md` both state as fact is
"written only by `trackOrganizationBuilder`", i.e. only when a paying tenant tracked someone. That
premise underpins the market-reports plan's population framing, so silently breaking it is not an
option. `first_seen_at` is `.defaultNow().notNull()`, so "not setting it" is not available; a crawler
insert *will* stamp it.

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
activity. Consequences per `_meta/security-policy.md`: **no RLS** (no owning tenant to filter on),
access controlled entirely by `GRANT`, DTO allowlist on read, provenance per edge. Precedent and its
lesson: `drizzle/0025_public_tables_app_grants.sql` — `builder_embeddings`/`discovery_state` shipped
with *no* grant for `builderhunt_app` and every write silently failed for weeks. Grants here are a
first-class task.

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

`src/lib/collaboration/strength.ts`. Two stages, because a pair-local number cannot know about hubs.

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
`auditPlatformAdminAction`. No body. Cadence: every 15 minutes, staggered 5 minutes off the discovery
worker so both never contend for the token in the same minute
(`plans/production-infrastructure/spec.md` §"Consolidated cron inventory").
`runCollaborationWorker()` in `src/lib/collaboration/worker.ts` uses `publicDb` (app role), like
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
largest risk. `_meta/security-policy.md` lists ID enumeration as a required threat case, and a
tracked-gate is deliberately unavailable here (§4.6).

**Control: a per-seat daily distinct-subject cap**, `COLLABORATION_DAILY_SUBJECTS_PER_USER = 200`
(module constant). Counted with a Redis set keyed `collab:subjects:{userId}:{YYYY-MM-DD}` —
`SADD` then `SCARD`, 48 h TTL — so re-viewing the same subject is free and only *breadth* is charged.
Same mechanic and same in-memory fallback caveat as the discovery worker's daily counter
(`src/lib/discovery/worker.ts` L66–94) and `src/shared/lib/rate-limit.ts`. Over cap ⇒
`429 { error: 'enumeration_cap' }` and `log.warn('collaboration_enumeration_cap', { userId, organizationId })`,
surfaced on the admin metrics page. No `abuse_signals` row: none of that table's `type` CHECK values
fits, and widening a security table's constraint from a product plan is out of scope here.

200 distinct profiles/day is far above genuine sourcing behaviour (a recruiter opens tens of profiles
a day) and far below useful bulk extraction of a graph with 100k+ edges. The cap is per **seat**, not
per organization, and seats are capped at 10 by `organization_entitlements.seat_limit`, so the
organization-level ceiling is bounded too.

### 5. Render — precomputed radial ego layout, hand-written SVG

`layoutEgoGraph(neighbors, opts)` in `src/lib/collaboration/layout.ts` is a **pure function**, so the
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

**Accessibility** (`audit-accessibility` is a release gate): the accessible equivalent is not an
afterthought. The component always renders a real `<table>` (counterpart link, source, strength,
shared artifacts, last seen) with a visible "Graph / Table" toggle; graph mode keeps the table
visually hidden but in the DOM and reachable. Every node in the graph is also a focusable `<a>` in
strength order, so a sighted keyboard user traverses the visual view in the same ranking. Under
`prefers-reduced-motion: reduce` no transition is applied at all; otherwise the only motion is a
150 ms hover/focus opacity change. A caption states the exact meaning: "Links are co-appearance in
public repository metadata, not confirmed working relationships."

## UX integration

- `src/modules/builder-profile/components/BuilderProfilePage.tsx`: a new `CollaborationGraphCard`
  below `PersonaCard`, fetched on mount with plain `fetch` + `useState` (that file's existing style —
  it does not use React Query).
- Filters (min-strength, window, source) filter the fetched payload client-side; widening the window
  beyond the fetched range refetches.
- Free tier: locked card with the neighbour count and a `Pro` pill linking to `/pricing` (same idiom
  as the locked sections at `BuilderProfilePage.tsx` L300/L305). Hidden entirely on
  `503 { error: 'collaboration_disabled' }`.
- **Not** rendered on the public route `src/routes/builders/$builderId.tsx` — publishing a
  relationship graph on an unauthenticated page is a privacy escalation this plan does not take.

## Tier gating

- New `COLLABORATION_GRAPH_LIMITS: Record<PlanTier, number>` in `src/shared/lib/billing-shared.ts`
  (neighbours visible): `{ free: 0, pro: 12, team: 24 }` — same convention as `SOURCING_SPRINT_LIMITS`.
- The route reads `getOrganizationEntitlement(tx, principal.organizationId)` and requires
  `policy.paidActionsAllowed`; `resolveLegacyPlanTier(policy.tier)` maps `pro_max` → `team`. Free or
  `paymentBlocked` ⇒ `{ locked: true, neighborCount }`.
- Add `'Collaboration graph (12 links)'` to `PLAN_PRICING.pro.features`, `'…(24 links)'` to `team`.
- **`STRIPE_BILLING_ENABLED` is false everywhere and stays false.** Nothing here needs Stripe:
  `organization_entitlements` is granted manually today by a platform admin via `setPlatformUserPlan`,
  which is exactly how `ai-sourcing-sprints`' tier gate already works. When Stripe lands, this gate is
  unchanged.

## Privacy — the largest risk, resolved explicitly

Inference about relationships between named real people, so `_meta/security-policy.md` and
[`legal-and-compliance`](../../legal-and-compliance/spec.md) both apply.

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

- ≥ 60% of `builder_identities WHERE source='github'` have ≥ 1 edge after 4 weeks of 15-minute runs.
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
  'collaboration_crawl'` marks them; `talent-market-intelligence` filters `discovered_by IS NULL`.
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
- **`COLLABORATION_ENABLED=false`** (the default everywhere, including production at first) — the
  worker no-ops and the read route 503s, so the schema ships long before the crawl is switched on.
