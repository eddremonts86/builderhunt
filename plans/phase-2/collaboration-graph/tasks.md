# Co-Shipping Collaboration Graph (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (global-public data classification for a cross-tenant identity graph); [`production-infrastructure`](../../production-infrastructure/spec.md) (cron authentication and monitoring for a new long-running worker). Enhanced by [`look-alike-sourcing`](../look-alike-sourcing/spec.md) and [`team-synergy`](../../team-synergy/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/env.ts`, `src/shared/lib/billing-shared.ts`, `src/lib/enrichment/worker.ts`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `docs/operations/deploy-runbook.md` (worker/cron inventory at L127), `scripts/db/verify-api-isolation-local.mjs`. Two new global-public tables; `builder_identities` gains only additive minimal rows via the existing deterministic-id upsert shape.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — Edge + cursor schema, data classification, grants

- [ ] **Add the collaboration env vars (all conservative by default)**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: Add to the zod schema, next to the `DISCOVERY_*` block (L53–54):
    `COLLABORATION_ENABLED: z.enum(['true','false']).default('false')`,
    `COLLABORATION_ANCHORS_PER_RUN: z.coerce.number().int().positive().default(8)`,
    `COLLABORATION_REPOS_PER_ANCHOR: z.coerce.number().int().positive().default(5)`,
    `COLLABORATION_RATE_LIMIT_RESERVE: z.coerce.number().int().nonnegative().default(500)`,
    `COLLABORATION_COAUTHOR_REPOS_PER_RUN: z.coerce.number().int().nonnegative().default(0)`.
    Mirror the `ENRICHMENT_ENABLED` refinement style: when `COLLABORATION_ENABLED === 'true'`,
    require `GITHUB_TOKEN` to be set. Names/placeholders only in `.env.example`, never values.
  - Verify: `pnpm type-check`; booting with `COLLABORATION_ENABLED=true` and no `GITHUB_TOKEN`
    fails closed with the refinement message.

- [ ] **Add the edge and cursor tables + the `discovered_by` provenance column to schema.ts**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `doublePrecision` to the `drizzle-orm/pg-core` import list (L2). Add
    `builderCollaborationEdges` and `collaborationGraphState` exactly per spec.md §1, including
    the `builder_collaboration_edges_canonical_order` CHECK (`a_id < b_id`), the
    `(a_id, b_id, source)` unique index, `(a_id, strength)` and `(b_id, strength)` indexes, the
    source and strength-range CHECKs, and the exported `CollaborationObservation(s)` interfaces.
    No `organization_id` on either table — global public (spec.md §1). Also add the single additive
    nullable column `discoveredBy: text('discovered_by')` to `builderIdentities` (L138) with the
    shared-surface comment from spec.md §1 — nullable so every existing row and every
    `trackOrganizationBuilder` write stays `NULL`, and no backfill is required (spec.md
    §Cross-plan touchpoint).
  - Verify: `pnpm type-check`.

- [ ] **Generate the table migration (schema-derived)**
  - Files: `drizzle/` (new migration from `pnpm db:generate`), `drizzle/meta/*`
  - Do: `pnpm db:generate`. Confirm the generated SQL contains exactly the two `CREATE TABLE`s, the
    `ALTER TABLE builder_identities ADD COLUMN "discovered_by" text;`, and nothing else — no drop,
    rename, or table rewrite (`_meta/security-policy.md` §"Migration and release gate" item 2).
  - Verify: `pnpm exec drizzle-kit check`; `pnpm db:migrate` succeeds on a fresh DB;
    `\d builder_collaboration_edges` shows both CHECKs and all three indexes; `INSERT` of `(a, b)`
    where `a > b` is rejected by the canonical-order CHECK.

- [ ] **Mint the grants-only migration as a `--custom` migration (snapshot + hashes included)**
  - Files: `drizzle/00XX_collaboration_graph_grants.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/00XX_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: `pnpm exec drizzle-kit generate --custom --name=collaboration_graph_grants` — **not** a
    hand-created `.sql`. `scripts/db/verify-migration-integrity.mjs` L12–15 asserts the `.sql` set and
    the `NNNN_snapshot.json` set both match `_journal.json` exactly, and L27–30 asserts
    `migration-hashes.json` matches; a hand-added file has no journal entry and no snapshot, which is
    precisely how `0045_user_devices_worker_read_grant` turned that test red. After writing the SQL,
    regenerate the manifest with `node scripts/db/verify-migration-integrity.mjs --write`.
    SQL body — modelled on `drizzle/0025_public_tables_app_grants.sql`, with a header comment stating
    the data class (global public, no owning tenant ⇒ no RLS possible, access controlled by GRANT
    only) and the `0025` lesson (`builder_embeddings`/`discovery_state` shipped with zero grants and
    every write silently failed for weeks):
    `REVOKE ALL ON TABLE builder_collaboration_edges, collaboration_graph_state FROM PUBLIC;`
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_collaboration_edges TO builderhunt_app;`
    `GRANT SELECT, INSERT, UPDATE ON TABLE collaboration_graph_state TO builderhunt_app;`
    `GRANT SELECT ON TABLE builder_collaboration_edges, collaboration_graph_state TO builderhunt_worker;`
    `GRANT SELECT, DELETE ON TABLE builder_collaboration_edges TO builderhunt_platform;`
  - Verify: `pnpm test:migration-integrity` passes (journal, snapshot and hash manifest all agree);
    then — in this order, `db:migrate` first so the grants exist before anything asserts them, the
    ordering `plans/abuse-and-usage-integrity/tasks.md` L45 establishes — `pnpm db:migrate` on a fresh
    DB, then `pnpm test:rls:local`, then `pnpm test:api-isolation:local`.

- [ ] **Record the data classification**
  - Files: `docs/architecture/data-classification.md`
  - Do: Add `builder_collaboration_edges` and `collaboration_graph_state` as **global public** /
    **system operational** respectively, citing the grants migration, the "no RLS because there is
    no owning tenant" rationale, and the processing-restriction exclusion as the compensating
    control for a table describing named individuals. Also note `builder_identities.discovered_by`
    as a shared surface with the values in use (`NULL` = tenant-tracked or pre-existing,
    `'collaboration_crawl'` = this plan) so the next writer does not reuse a value.
  - Verify: Both tables present; classes match the grants migration header; `discovered_by` value
    registry present.

## Phase 2 — Pure strength and layout libraries

- [ ] **Implement the strength module**
  - Files: `src/lib/collaboration/strength.ts` (new)
  - Do: Export `COLLABORATION_HALF_LIFE_DAYS = 180`, `COLLABORATION_MAX_OBSERVATIONS = 20`,
    `SOURCE_WEIGHT = { github_commit: 1.0, github_repo: 0.5 }`,
    `sizeDamping(n) = 1 / Math.log2(2 + n)`,
    `artifactWeight(artifact, source, now)` = `SOURCE_WEIGHT[source] * sizeDamping(participantCount)
    * 0.5 ** (ageDays / COLLABORATION_HALF_LIFE_DAYS)` (same `0.5 ** (age/halfLife)` mechanic as
    `decayedWeight` in `src/shared/lib/abuse/risk.ts` L51 — reuse the curve, do not invent a
    second one), `computeRawWeight(observations, source, now)` (sum over the stored artifact list —
    recomputed, never accumulated), `computeNormalizedStrength(rawWeight, nodeTotalA, nodeTotalB)`
    = `clamp01(rawWeight / Math.sqrt(nodeTotalA * nodeTotalB))` (0 when either total is 0),
    `mergeObservations(existing, incoming)` (dedupe by `artifactRef`, newest `lastActivityAt` wins,
    sort desc, cap at 20), `canonicalPair(idX, idY)` → `[a, b]` with `a < b`, and
    `edgeId(source, a, b)` = `sha256(source \0 a \0 b)` hex.
  - Verify: `pnpm type-check`.

- [ ] **Test the strength module**
  - Files: `src/lib/collaboration/strength.test.ts` (new)
  - Do: Cover — one artifact at age 180 d weighs half its fresh value; a 3-participant repo
    outweighs an 800-participant one; `computeRawWeight` is stable across repeated calls with the
    same input (idempotency); a hub node (`nodeTotal` 200) has strength far below a mutual pair
    (`nodeTotal` equal to `rawWeight`); `strength ∈ [0,1]` for adversarial inputs including
    `rawWeight > nodeTotal`; `computeNormalizedStrength` is invariant under swapping A/B;
    `mergeObservations` dedupes and caps at 20; `canonicalPair`/`edgeId` are order-independent.
  - Verify: `pnpm test strength`.

- [ ] **Implement and test the ego layout**
  - Files: `src/lib/collaboration/layout.ts` (new), `src/lib/collaboration/layout.test.ts` (new)
  - Do: `layoutEgoGraph(neighbors: { id: string; strength: number }[], opts?: { innerRadius?: 110;
    outerRadius?: 190; innerThreshold?: 0.5 })` → `{ id, x, y, r, ring }[]` with ego implicit at
    `(0,0)`: split by `strength >= innerThreshold`, sort each ring by strength desc, angle
    `= i * 2π / ringCount` offset per ring so rings do not align, `r = 8 + 10 * strength`. Pure and
    deterministic — no `Math.random`, no time input. Tests: identical input → identical output;
    node count preserved; no two nodes in a ring share an angle; empty input → empty array;
    single neighbour is placed on the inner ring only if it passes the threshold.
  - Verify: `pnpm test layout`.

## Phase 3 — GitHub public-metadata crawl adapter

- [ ] **Implement the crawl adapter with injectable fetch**
  - Files: `src/lib/collaboration/github-crawl.ts` (new)
  - Do: `listAnchorRepos(username, { token, fetchImpl, limit })` — `GET /users/{u}/events/public?per_page=100`
    plus `GET /users/{u}/repos?sort=pushed&per_page=30&type=owner`, union the repo full names, drop
    forks and private, sort by most recent activity, take `limit`. `listRepoContributors(fullName,
    { token, fetchImpl })` — `GET /repos/{o}/{r}/contributors?per_page=100&anon=false`, returning
    `{ login, sourceId: String(id), avatarUrl, profileUrl, type }`. `isLikelyBotLogin(login, type)` —
    true for `type === 'Bot'`, a `[bot]` suffix, or the deny-list `['dependabot','renovate',
    'github-actions','greenkeeper','snyk-bot','imgbot','allcontributors']`. `readRateLimit(response)`
    → `{ remaining, resetAt }` from `x-ratelimit-remaining` / `x-ratelimit-reset`. Headers match
    `src/lib/sources/github.ts` (`Accept: application/vnd.github.v3+json`, `User-Agent: BuilderHunt/1.0`,
    `Authorization: Bearer <token>`). Every function returns `[]` on a non-OK response — never throws.
  - Verify: `pnpm type-check`.

- [ ] **Test the crawl adapter against fixtures**
  - Files: `src/lib/collaboration/github-crawl.test.ts` (new)
  - Do: Inject a stub `fetchImpl` returning recorded JSON (inline in the test, no network). Assert:
    forks excluded; a repo appearing in both events and owned repos is returned once; bot logins
    filtered; `readRateLimit` parses both headers and returns `null` when absent; a 403 response
    yields `[]` rather than an exception.
  - Verify: `pnpm test github-crawl`.

## Phase 4 — Worker, cursor, restriction cascade

- [ ] **Add the collaboration-graph repository**
  - Files: `src/shared/lib/repositories/collaboration-graph.ts` (new)
  - Do: All functions use `publicDb` directly (global table, no `withTenantContext`) — copy the
    header-comment convention of `src/shared/lib/repositories/public-builder-embeddings.ts`.
    Export: `insertDiscoveredBuilderIdentity({ source, sourceId, username, avatarUrl, profileUrl })` —
    deterministic id `sha256(source \0 sourceId)` (same derivation as `trackOrganizationBuilder`,
    `organization-builders.ts` L212) but **`.onConflictDoNothing()`, never `onConflictDoUpdate`**, and
    sets `discoveredBy: 'collaboration_crawl'`. Do NOT reuse `trackOrganizationBuilder`'s SET clause
    (L228–241): it unconditionally writes `followersCount: input.followersCount ?? 0` and
    `language: … ?? null`, which a contributor-list row cannot supply, so an update path would zero
    `followersCount` and null `language` on every already-known identity the crawler touches —
    columns read by `organization-builders.ts` L41 (tracked list, dashboard, CSV export) and
    `public-builders.ts` L12 (public profile). Insert-only makes that corruption structurally
    impossible; it also means the crawler never touches `last_seen_at`, which is intended.
    Then `upsertCollaborationEdge(input)` (canonical
    pair asserted, merged observations, recomputed `rawWeight`, `observationCount`,
    `lastObservedAt`, `ON CONFLICT (a,b,source)`); `getNodeTotals(identityIds)` (one
    `SELECT id, SUM(raw_weight)` grouped over both endpoint columns);
    `renormalizeEdgesForIdentities(ids, now)`; `renormalizeAllEdges(now)`;
    `deleteCollaborationEdgesForIdentity(identityId)` (uses `platformDb`, matching
    `enrichment-restrictions.ts`); `isIdentityRestricted(identityId)` via
    `sql\`select is_builder_processing_restricted(${id}) as restricted\`` exactly as
    `repositories/enrichment.ts` L187 does; `loadCollaborationState()` / `saveCollaborationState()`.
  - Verify: `pnpm type-check`.

- [ ] **Implement the worker**
  - Files: `src/lib/collaboration/worker.ts` (new)
  - Do: `runCollaborationWorker()` per spec.md §3, structured like `src/lib/discovery/worker.ts`
    (load singleton state, bounded loop, per-item try/catch that logs and continues, `log.info`
    with a single structured report at the end). Return
    `{ anchors, repos, pairs, edgesUpserted, identitiesCreated, skippedRestricted, halted, cursor }`.
    Rules: skip a restricted anchor (count it); skip repos with `participantCount >
    COLLABORATION_MAX_PARTICIPANTS = 50` (module constant); build `(anchor, contributor)` and
    `(contributor, contributor)` pairs from the surviving repos; drop any pair whose either endpoint
    is restricted; create missing endpoints with `insertDiscoveredBuilderIdentity` (insert-only —
    it must never update an existing identity row); canonicalize with `canonicalPair` **before** the insert; advance
    `lastAnchorIdentityId` only after an anchor completes fully; wrap to `null` and call
    `renormalizeAllEdges` at the end of the identity list; before each anchor, if the last
    `RateLimitSnapshot.remaining < env.COLLABORATION_RATE_LIMIT_RESERVE`, stop with
    `haltedReason='rate_limit'` + `rateLimitResetAt` and `log.warn('collaboration_worker_rate_limited', …)`.
  - Verify: `pnpm type-check`; unit test in the next task.

- [ ] **Test worker idempotency, canonical ordering, and the halt path**
  - Files: `src/lib/collaboration/worker.test.ts` (new)
  - Do: With stubbed crawl functions and an in-memory repository double: running twice over the same
    fixture yields identical `rawWeight` and no duplicate edges; an edge is written once for a pair
    regardless of contributor order; a restricted endpoint produces zero edges and increments
    `skippedRestricted`; a snapshot with `remaining: 10` halts before the second anchor and leaves
    the cursor on the first; a crawl error on one anchor does not abort the run.
  - Verify: `pnpm test collaboration/worker`.

- [ ] **Add the admin run-worker endpoint**
  - Files: `src/routes/api/admin/collaboration-graph/run-worker.ts` (new)
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` verbatim in shape:
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, run
    `runCollaborationWorker()`, `auditPlatformAdminAction(principal, { action: 'admin.worker.run',
    targetType: 'worker', targetId: 'collaboration-graph', result: 'allowed' })`, return
    `Response.json({ ok: true, ...result })`, `platformAdminErrorResponse(err)` fallback. Return
    `503 { error: 'collaboration_disabled' }` when `env.COLLABORATION_ENABLED !== 'true'` and
    `503 { error: 'github_unconfigured' }` when `GITHUB_TOKEN` is unset. Include the cron doc-comment
    (every 15 min, same crontab as the discovery worker).
  - Verify: `curl -X POST -H "X-Cron-Secret: $CRON_SECRET" .../api/admin/collaboration-graph/run-worker`
    returns `{ ok: true, anchors: N }` with the flag on and `503 collaboration_disabled` with it off;
    an unauthenticated call returns 401/403.

- [ ] **Cascade the processing restriction to edges**
  - Files: `src/lib/enrichment/worker.ts`, `src/routes/api/me/builder/$builderId/restrict-processing.ts`
  - Do: In `cascadeBuilderProcessingRestriction` (L206) add
    `const collaborationEdgesPurged = await deleteCollaborationEdgesForIdentity(builderIdentityId)`
    and include it in the returned object and the `enrichment_subject_restriction` log line. The
    route already spreads the cascade result into its response, so no route change beyond the type.
  - Verify: `pnpm test` (existing enrichment worker tests still pass); manual: activate a restriction
    for an identity with edges, then confirm `SELECT count(*) FROM builder_collaboration_edges WHERE
    builder_identity_a_id = $id OR builder_identity_b_id = $id` is 0.

- [ ] **Register the cron in the operations inventory**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Add a row to the worker table at L127:
    `| POST /api/admin/collaboration-graph/run-worker | co-shipping collaboration graph | COLLABORATION_*, GITHUB_TOKEN |`
    plus a one-line note that it shares the 15-minute slot with the discovery worker and must be
    staggered (offset 5 minutes) so both never contend for the GitHub token in the same minute.
  - Verify: Row present; no code change.

## Phase 5 — Read API + entitlement gate

- [ ] **Add the tier limits and pricing copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: Add `COLLABORATION_GRAPH_LIMITS: Record<PlanTier, number> = { free: 0, pro: 12, team: 24 }`
    with the same comment convention as `SOURCING_SPRINT_LIMITS` (organization-entitlement-gated,
    not the legacy per-user `plans` table). Append `'Collaboration graph (12 links)'` to
    `PLAN_PRICING.pro.features` and `'Collaboration graph (24 links)'` to `team.features`.
  - Verify: `pnpm type-check`; `/pricing` renders the new bullets.

- [ ] **Implement the ego-graph read query**
  - Files: `src/shared/lib/repositories/collaboration-graph.ts` (created in Phase 4)
  - Do: `listEgoGraph({ identityId, minStrength, since, sources, limit })` — one query,
    `WHERE (a_id = $ego OR b_id = $ego) AND strength >= $minStrength AND last_observed_at >= $since`
    (+ optional `source IN`), `AND NOT is_builder_processing_restricted(a_id) AND NOT
    is_builder_processing_restricted(b_id)`, joined to `builder_identities` on the *counterpart*
    column, `ORDER BY strength DESC, last_observed_at DESC`, `LIMIT $limit + 1` (the extra row
    detects "more exist"). Also `countEgoNeighbors(identityId)` for the locked free-tier response.
    Map to the DTO allowlist of spec.md §4.5 — never `observations.artifacts`, never `rawWeight`.
  - Verify: `pnpm type-check`; with seeded data, `EXPLAIN (ANALYZE)` on the ego query shows index
    scans on both `builder_collaboration_edges_a_strength_idx` and `..._b_strength_idx`, no seq scan.

- [ ] **Add GET /api/builders/$builderId/collaboration**
  - Files: `src/routes/api/builders/$builderId/collaboration.ts` (new)
  - Do: `requireTenantPrincipal` (401 via `TenantAuthorizationError`);
    `503 { error: 'collaboration_disabled' }` when the flag is off;
    `rateLimit('collaboration-graph', principal.userId, 60, 60)`; then the **enumeration cap**
    (spec.md §Enumeration) — `chargeSubjectView(userId, builderIdentityId)` in
    `src/lib/collaboration/enumeration.ts` (new): Redis `SADD collab:subjects:{userId}:{YYYY-MM-DD}`
    + `SCARD`, `EXPIRE` 48 h, in-memory `Map` fallback when Redis is unset (copy the shape of
    `peekStubCount`/`incrementStubCount` in `src/lib/discovery/worker.ts` L66–94); over
    `COLLABORATION_DAILY_SUBJECTS_PER_USER = 200` (module constant) return
    `429 { error: 'enumeration_cap' }` and `log.warn('collaboration_enumeration_cap', { userId, organizationId })`.
    Re-viewing an already-charged subject must not consume budget. Then zod-parse the query
    (`minStrength` 0–1 default 0.05, `window` `'12m' | '24m' | 'all'` default `'24m'`, `source`
    optional enum); `withTenantContext(principal, tx => getOrganizationEntitlement(tx,
    principal.organizationId))`, then `resolveLegacyPlanTier(policy.tier)` →
    `COLLABORATION_GRAPH_LIMITS[tier]`; when the cap is 0 or `!policy.paidActionsAllowed` return
    `200 { locked: true, neighborCount }`; otherwise return
    `{ locked: false, ego: {…}, neighbors: [...], totalCount, cap, truncated }`. Deliberately does
    **not** require an `organization_builders` row (spec.md §4.6).
  - Verify: Pro-tier authed curl returns neighbours sorted by strength; free-tier returns
    `{ locked: true, neighborCount }` with no usernames anywhere in the body; unauthenticated 401;
    flag off 503; the 201st distinct subject in one day returns `429 enumeration_cap` while the 1st
    subject re-requested a 5th time still returns 200.

- [ ] **Test the enumeration cap as pure logic**
  - Files: `src/lib/collaboration/enumeration.test.ts` (new)
  - Do: Against the in-memory fallback: 200 distinct subjects allowed, the 201st denied; the same
    subject requested 300 times consumes 1 of the budget; the key rolls over on a UTC date change;
    two different `userId`s have independent budgets (the cap is per seat, not per organization).
  - Verify: `pnpm test collaboration/enumeration`.

- [ ] **Extend the route isolation script**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add checks executed as the real non-owner roles: (1) the worker's edge upsert succeeds as
    `builderhunt_app` (the `0025` failure mode — a missing grant must fail the suite, not be
    swallowed); (2) `GET /api/builders/:id/collaboration` returns zero neighbours once a
    restriction is active for the counterpart, and zero once active for the ego; (3) a free-tier
    organization's response contains `locked: true` and no `username` key; (4) an unauthenticated
    request is denied; (5) `builderhunt_worker` cannot INSERT into `builder_collaboration_edges`;
    (6) **ID enumeration** (`_meta/security-policy.md` L107) — a Pro seat walking distinct,
    offline-derivable `sha256(source \0 sourceId)` ids is cut off with `429 enumeration_cap` at
    `COLLABORATION_DAILY_SUBJECTS_PER_USER`, and a nonexistent-but-well-formed id returns an empty
    graph with the same shape and no existence signal (no 404 vs 200 distinction);
    (7) `insertDiscoveredBuilderIdentity` on an existing identity leaves `followers_count`,
    `language`, `bio` and `last_seen_at` byte-identical (regression guard for the corruption path
    described in spec.md §Anchor rule).
  - Verify: `pnpm test:api-isolation:local` — all checks pass, and temporarily dropping the
    `builderhunt_app` grant makes check (1) fail. Run after `pnpm db:migrate`, never before.

## Phase 6 — Ego-graph UI

- [ ] **Build the collaboration graph card**
  - Files: `src/modules/builder-profile/components/CollaborationGraphCard.tsx` (new)
  - Do: Props `{ builderId: string }`. Fetch `/api/builders/${builderId}/collaboration` on mount
    with plain `fetch` + `React.useState` (match `PersonaCard.tsx`'s `FetchState` union style — this
    module does not use React Query). States: `loading`, `locked` (count + `Pro` pill linking to
    `/pricing`, same idiom as the locked sections at `BuilderProfilePage.tsx` L300/L305), `empty`
    ("No collaboration data yet — the crawl fills in progressively"), `hidden` (on 503), `ready`.
    Ready renders: a hand-written `<svg viewBox>` from `layoutEgoGraph` (`aria-hidden="true"`,
    `max-width: 100%`), an always-present `<table>` of counterpart link / source / strength /
    shared artifacts / last seen, a "Graph / Table" toggle (graph mode keeps the table visually
    hidden but in the DOM and reachable), the filter controls (min-strength range, window select,
    source select) applied client-side, and the cap notice
    "Showing the N strongest of M connections" when `truncated`. Every node is an `<a>` to
    `/builder/{id}` in strength order so keyboard traversal matches the visual ranking. Strength is
    encoded by stroke width + node radius + a printed number, never colour alone. Include the
    literal caption "Links are co-appearance in public repository metadata, not confirmed working
    relationships."
  - Verify: `pnpm type-check`; card renders all five states against stubbed responses.

- [ ] **Mount the card on the builder profile**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Import and render `<CollaborationGraphCard builderId={builderId} />` immediately below
    `<PersonaCard …/>`. No change to `src/routes/builders/$builderId.tsx` — the public profile
    never shows the graph (spec.md §UX integration).
  - Verify: `/builder/:id` shows the card for a Pro org and the locked variant for a free org;
    the public `/builders/:id` page is unchanged.

- [ ] **Accessibility and reduced-motion pass**
  - Files: `src/modules/builder-profile/components/CollaborationGraphCard.tsx` (created earlier in this phase), `src/shared/styles/globals.css`
  - Do: Confirm the SVG contributes nothing to the accessibility tree; the table has a `<caption>`
    and `scope="col"` headers; the toggle is a real `<button>` with `aria-pressed`; filter controls
    have visible labels; the "N of M" notice is in an `aria-live="polite"` region so filtering
    announces; all interactive targets meet the 24×24 CSS-pixel minimum (no `p-1`); and every
    transition in this component sits behind
    `@media (prefers-reduced-motion: no-preference)` (add the guard in `globals.css` if a shared
    utility is used).
  - Verify: Keyboard-only traversal reaches every neighbour in strength order and returns focus
    correctly after toggling; the automated a11y check from `plans/audit-accessibility` reports zero
    violations on `/builder/:id`; with `prefers-reduced-motion: reduce` no transition occurs.

## Phase 7 — Co-authorship source, subject transparency, observability

- [ ] **Add the GraphQL co-authorship adapter**
  - Files: `src/lib/collaboration/github-coauthors.ts` (new), `src/lib/collaboration/github-coauthors.test.ts` (new)
  - Do: `listRepoCoAuthorPairs(fullName, { token, fetchImpl })` — one `POST https://api.github.com/graphql`
    with `repository(owner,name){ defaultBranchRef { target { ... on Commit { history(first: 100) {
    nodes { committedDate authors(first: 5) { nodes { user { login databaseId } } } } } } } } }`
    plus `rateLimit { cost remaining resetAt }` in the same query. Emit a pair per commit with ≥ 2
    resolved `user` nodes; drop unresolved authors (no `user` ⇒ the trailer email is not linked to an
    account, and we never store the email); return
    `{ pairs, lastActivityAt, rateLimit }`. Tests use a stubbed `fetchImpl` with a recorded response
    and assert: unresolved authors dropped, bot users dropped, `rateLimit` surfaced, non-200 → empty.
  - Verify: `pnpm test github-coauthors`.

- [ ] **Wire co-authorship edges into the worker under its own budget**
  - Files: `src/lib/collaboration/worker.ts` (created in Phase 4)
  - Do: After the `github_repo` pass, take up to `env.COLLABORATION_COAUTHOR_REPOS_PER_RUN` of the
    repos already selected this run (no additional repo discovery, therefore no additional REST
    cost) and upsert `source: 'github_commit'` edges from `listRepoCoAuthorPairs`. Halt this pass
    when the GraphQL `rateLimit.remaining` falls below `COLLABORATION_RATE_LIMIT_RESERVE`; log
    `collaboration_worker_graphql_cost` with the summed `cost`. Default of `0` means the pass is
    off until explicitly enabled.
  - Verify: With `COLLABORATION_COAUTHOR_REPOS_PER_RUN=2`, a run reports
    `edgesUpserted` including `github_commit` rows; with `0` no GraphQL request is made.

- [ ] **Add the subject transparency endpoint**
  - Files: `src/routes/api/me/builder/$builderId/collaboration.ts` (new)
  - Do: Same shape as `restrict-processing.ts`: `requireTenantPrincipal`, then
    `withTenantContext(principal, tx => isVerifiedBuilderClaimant(tx, principal.userId,
    params.builderId))` — 403 otherwise. Return the subject's own edges (counterpart username,
    source, strength, `observationCount`, `firstObservedAt`, `lastObservedAt`) plus a one-line
    explanation of the derivation and a pointer to `POST .../restrict-processing`. No pagination
    needed at this size; cap at 500 rows.
  - Verify: A verified claimant gets their edge list; a non-claimant gets 403; a restricted subject
    gets an empty list (their edges were deleted by the cascade).

- [ ] **Surface worker health on the admin metrics page**
  - Files: `src/routes/_dashboard/admin/metrics.tsx`, `src/shared/lib/repositories/collaboration-graph.ts` (created in Phase 4)
  - Do: Add a `getCollaborationGraphStats()` read (total edges, edges by source, distinct identities
    with ≥ 1 edge, `lastRunAt`, `haltedReason`, `rateLimitResetAt`, cumulative `stats`) and render it
    as a row group on the existing admin metrics page, alongside the other worker sections.
  - Verify: The page shows a non-zero edge count and `lastRunAt` after a manual worker run, and
    shows `haltedReason: rate_limit` after forcing the reserve threshold.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint && pnpm test:api-isolation:local`. End-to-end:
    flag off ⇒ card hidden and both routes 503; flag on + cron run ⇒ edges appear, Pro profile shows
    the graph, free profile shows the count only; activate a processing restriction ⇒ the subject
    disappears from their own graph *and* from a neighbour's graph within one request; re-run the
    worker ⇒ no duplicate edges, identical `rawWeight`, cursor advanced.
  - Verify: All green; the restriction cascade and idempotency checks both observed manually in
    addition to the automated suites.
