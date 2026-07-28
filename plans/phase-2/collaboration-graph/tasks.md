# Co-Shipping Collaboration Graph (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/spec.md) (global-public data classification for a cross-tenant identity graph); [`production-infrastructure`](../../phase-1/02-production-infrastructure/spec.md) (cron authentication and monitoring for a new long-running worker). Enhanced by [`look-alike-sourcing`](../look-alike-sourcing/spec.md) and [`team-synergy`](../../phase-1/39-team-synergy/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check** (re-verified against master HEAD, 2026-07-27): Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/env.ts`, `src/shared/lib/billing-shared.ts`, `src/shared/lib/operational-schedules.ts`, `src/lib/enrichment/worker.ts`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `docs/operations/deploy-runbook.md` (worker/cron inventory table at L145–154), `scripts/db/verify-api-isolation-local.mjs`. Two new global-public tables; `builder_identities` gains one additive nullable column and insert-only minimal rows using the existing deterministic-id derivation (never `trackOrganizationBuilder`'s upsert).

**Before starting, two rules that this plan was re-verified against and that override any number
written below.** (1) **Never hardcode a migration index.** Mint every migration with
`pnpm exec drizzle-kit generate --custom` (or `pnpm db:generate` for schema-derived ones) and read
the real next index from `drizzle/meta/_journal.json`; `NNNN` below is a placeholder, not a value.
(2) **No test file lives under `src/`.** `vitest.config.ts` includes only
`tests/unit/**/*.{test,spec}.{ts,tsx}`, mirroring the `src/` layout; e2e specs live in `tests/e2e/`.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — Edge + cursor schema, data classification, grants

- [ ] **Add the collaboration env vars (all conservative by default)**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: Add to the zod schema, immediately after the `DISCOVERY_*` block (`env.ts` L112–114 —
    `DISCOVERY_CELLS_PER_RUN` / `DISCOVERY_DAILY_STUB_CAP`, under the `// Plan: proactive-discovery`
    comment), with a `// Plan: collaboration-graph` comment of its own:
    `COLLABORATION_ENABLED: z.enum(['true','false']).default('false')`,
    `COLLABORATION_ANCHORS_PER_RUN: z.coerce.number().int().positive().default(8)`,
    `COLLABORATION_REPOS_PER_ANCHOR: z.coerce.number().int().positive().default(5)`,
    `COLLABORATION_RATE_LIMIT_RESERVE: z.coerce.number().int().nonnegative().default(500)`,
    `COLLABORATION_COAUTHOR_REPOS_PER_RUN: z.coerce.number().int().nonnegative().default(0)`.
    Mirror the `ENRICHMENT_ENABLED` refinement style inside the existing `.superRefine((data,
    context) => …)` at `env.ts` L263 (the `ENRICHMENT_ENABLED === 'true'` block is at L416): when
    `COLLABORATION_ENABLED === 'true'` and `!data.GITHUB_TOKEN`, `context.addIssue({ code: 'custom',
    path: ['GITHUB_TOKEN'], message: 'GITHUB_TOKEN is required when COLLABORATION_ENABLED=true' })`.
    Names/placeholders only in `.env.example`, never values.
    Verified free at HEAD: `grep -rn "COLLABORATION_" src/ drizzle/ scripts/ docs/` returns nothing,
    so all five names are unclaimed.
  - Verify: `pnpm type-check`, then
    `COLLABORATION_ENABLED=true pnpm exec tsx -e "import('./src/shared/lib/env.ts')"` exits non-zero
    with the refinement message while `GITHUB_TOKEN` is unset, and exits 0 once it is set. (There is
    no `tests/unit/shared/lib/env.security.test.ts` at HEAD — do not add one just for this.)

- [ ] **Add the edge and cursor tables + the `discovered_by` provenance column to schema.ts**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `doublePrecision` to the `drizzle-orm/pg-core` import list at `schema.ts` L2 (`check`,
    `index`, `uniqueIndex`, `jsonb`, `integer`, `timestamp` are already imported there;
    `doublePrecision` is not). Add
    `builderCollaborationEdges` and `collaborationGraphState` exactly per spec.md §1, including
    the `builder_collaboration_edges_canonical_order` CHECK (`a_id < b_id`), the
    `(a_id, b_id, source)` unique index, `(a_id, strength)` and `(b_id, strength)` indexes, the
    source and strength-range CHECKs, and the exported `CollaborationObservation(s)` interfaces.
    No `organization_id` on either table — global public (spec.md §1). Also add the single additive
    nullable column `discoveredBy: text('discovered_by')` to `builderIdentities` (declared at
    `schema.ts` L139–162; put it after `country` on L152, before `firstSeenAt` on L153) with the
    shared-surface comment from spec.md §1 — nullable so every existing row and every
    `trackOrganizationBuilder` write stays `NULL`, and no backfill is required (spec.md
    §Cross-plan touchpoint). Verified at HEAD: `discovered_by` does not exist on any table and
    `first_seen_at` is still `.defaultNow().notNull()`, so the reasoning behind the column holds.
  - Verify: `pnpm type-check`; `grep -n "discovered_by" src/shared/lib/db/schema.ts` returns exactly
    one match.

- [ ] **Generate the table migration (schema-derived)**
  - Files: `drizzle/NNNN_<generated_name>.sql` (new, index assigned by drizzle-kit),
    `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/meta/_journal.json`
  - Do: `pnpm db:generate`. Do **not** invent or edit the index — read what drizzle-kit assigned
    from `drizzle/meta/_journal.json` after the run. Confirm the generated SQL contains exactly the
    two `CREATE TABLE`s, their indexes/CHECKs, the
    `ALTER TABLE "builder_identities" ADD COLUMN "discovered_by" text;`, and nothing else — no drop,
    rename, or table rewrite ([`security-policy`](../../_meta/security-policy.md) §"Migration and
    release gate" item 2, L130).
  - Verify: `pnpm exec drizzle-kit check`; `pnpm db:migrate` succeeds on a fresh DB;
    `psql "$DATABASE_URL" -c '\d builder_collaboration_edges'` shows all three CHECKs
    (`_canonical_order`, `_source_check`, `_strength_range`) and all three indexes
    (`_pair_source_unique`, `_a_strength_idx`, `_b_strength_idx`); an `INSERT` with `a_id > b_id` is
    rejected by `builder_collaboration_edges_canonical_order`.

- [ ] **Mint the grants-only migration as a `--custom` migration (snapshot + hashes included)**
  - Files: `drizzle/NNNN_collaboration_graph_grants.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json` (new), `drizzle/migration-hashes.json`
  - Do: `pnpm exec drizzle-kit generate --custom --name=collaboration_graph_grants` — **not** a
    hand-created `.sql`, and **never** with a number you chose yourself. `scripts/db/verify-migration-integrity.mjs`
    L12–15 asserts the `.sql` set and the `NNNN_snapshot.json` set both match `_journal.json`
    exactly, and L27–36 asserts `migration-hashes.json` matches; a hand-added file has no journal
    entry and no snapshot, which is precisely how `0045_user_devices_worker_read_grant` turned that
    test red on 2026-07-24. After writing the SQL body, regenerate the manifest with
    `node scripts/db/verify-migration-integrity.mjs --write`.

    SQL body — modelled on `drizzle/0025_public_tables_app_grants.sql`, with a header comment stating
    the data class (global public, no owning tenant ⇒ no RLS possible, access controlled by GRANT
    only) and the `0025` lesson (`builder_embeddings`/`discovery_state` shipped with zero grants and
    every write silently failed for weeks):

    ```sql
    REVOKE ALL ON TABLE builder_collaboration_edges, collaboration_graph_state FROM PUBLIC;
    -- runCollaborationWorker + listEgoGraph both run on publicDb == builderhunt_app.
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_collaboration_edges TO builderhunt_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE collaboration_graph_state TO builderhunt_app;
    -- Read-only: this role must never author an edge. Asserted negatively in the isolation script.
    GRANT SELECT ON TABLE builder_collaboration_edges, collaboration_graph_state TO builderhunt_worker;
    -- deleteCollaborationEdgesForIdentity runs on platformDb, matching enrichment-restrictions.ts.
    GRANT SELECT, DELETE ON TABLE builder_collaboration_edges TO builderhunt_platform;
    -- builderhunt_capability (drizzle/0078_capability_role.sql) is deliberately given nothing:
    -- it exists only for the accountless scheduling path and must not reach an identity graph.
    ```

    **No grant is needed on `builder_identities`** — `drizzle/0011_builder_claim_policies.sql` L31
    already grants `builderhunt_app` `SELECT, INSERT, UPDATE`, and the table has no RLS (verified:
    no `ENABLE ROW LEVEL SECURITY` for it in any migration). **No `EXECUTE` grant is needed** for
    `is_builder_processing_restricted(text)` — `drizzle/0017_enrichment_rls_policies.sql` L82 already
    grants it to `builderhunt_app` and `builderhunt_worker`, and the platform role never calls it.
  - Verify: `pnpm test:migration-integrity` passes (journal, snapshot and hash manifest all agree);
    then, **in this order** — the migration must be applied before anything asserts a permission —
    `pnpm db:migrate` on a fresh DB, then `pnpm test:rls:local`, then `pnpm test:api-isolation:local`.

- [ ] **Record the data classification**
  - Files: `docs/architecture/data-classification.md`
  - Do: Add two rows to the existing pipe table (columns:
    `Table | Class | Canonical owner | Public fields | Retention / transition`, classes are exactly
    `global-public`, `account-subject`, `tenant-private`, `system-operational`):

    ```
    | builder_collaboration_edges | global-public | identity pair `(a_id, b_id, source)` | reviewed edge DTO only — counterpart identity, strength, source, counts; never `observations.artifacts`, never `raw_weight` | until either endpoint is deleted or restricted; regenerated by crawl |
    | collaboration_graph_state | system-operational | platform | none | permanent, one row |
    ```

    Then append a short note below the table (the doc has a free-text section after it) recording
    `builder_identities.discovered_by` as a **shared surface** with its value registry: `NULL` =
    pre-existing row or `trackOrganizationBuilder` write; `'collaboration_crawl'` = this plan's
    insert-only crawler path; any future crawler claims its own value here first. Also state the
    "no RLS because there is no owning tenant" rationale and name the processing-restriction
    exclusion as the compensating control for a table describing named individuals. The doc's
    closing paragraph already requires this ("Future tables must be added here before their
    migration is accepted").
  - Verify: `grep -n "builder_collaboration_edges\|collaboration_graph_state\|discovered_by" docs/architecture/data-classification.md`
    returns all three; the classes match the grants migration header verbatim.

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
  - Files: `tests/unit/lib/collaboration/strength.test.ts` (new)
  - Do: Cover — one artifact at age 180 d weighs half its fresh value; a 3-participant repo
    outweighs an 800-participant one; `computeRawWeight` is stable across repeated calls with the
    same input (idempotency); a hub node (`nodeTotal` 200) has strength far below a mutual pair
    (`nodeTotal` equal to `rawWeight`); `strength ∈ [0,1]` for adversarial inputs including
    `rawWeight > nodeTotal`; `computeNormalizedStrength` is invariant under swapping A/B;
    `mergeObservations` dedupes and caps at 20; `canonicalPair`/`edgeId` are order-independent.
  - Verify: `pnpm test -- tests/unit/lib/collaboration/strength.test.ts`.

- [ ] **Implement and test the ego layout**
  - Files: `src/lib/collaboration/layout.ts` (new), `tests/unit/lib/collaboration/layout.test.ts` (new)
  - Do: `layoutEgoGraph(neighbors: { id: string; strength: number }[], opts?: { innerRadius?: 110;
    outerRadius?: 190; innerThreshold?: 0.5 })` → `{ id, x, y, r, ring }[]` with ego implicit at
    `(0,0)`: split by `strength >= innerThreshold`, sort each ring by strength desc, angle
    `= i * 2π / ringCount` offset per ring so rings do not align, `r = 8 + 10 * strength`. Pure and
    deterministic — no `Math.random`, no time input. Tests: identical input → identical output;
    node count preserved; no two nodes in a ring share an angle; empty input → empty array;
    single neighbour is placed on the inner ring only if it passes the threshold.
  - Verify: `pnpm test -- tests/unit/lib/collaboration/layout.test.ts`.

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
    → `{ remaining, resetAt }` from `x-ratelimit-remaining` / `x-ratelimit-reset` (the latter is Unix
    epoch **seconds**, so `new Date(Number(header) * 1000)`), plus `retry-after` when present so a
    secondary-rate-limit 403 still yields a usable `resetAt`. Headers match `src/lib/sources/github.ts`
    L33–37 verbatim: `Accept: application/vnd.github.v3+json`, `User-Agent: BuilderHunt/1.0`,
    `Authorization: Bearer <token>`. Every function returns `[]` on a non-OK response — never throws.

    **Identity-id compatibility is load-bearing.** `sourceId` MUST be `String(user.id)` — the GitHub
    numeric user id, exactly as `github.ts` L55 produces it — because the identity primary key is
    `sha256('github' \0 sourceId)` (`organization-builders.ts` L278). Using the `login` instead would
    mint a *second*, colliding-by-nothing identity row for people already tracked, and every edge
    would point at a ghost.

    One page per request, never paginated: exactly `2 + limit` core REST calls per anchor
    (spec §Quota budget's table).
  - Verify: `pnpm type-check`.

- [ ] **Test the crawl adapter against fixtures**
  - Files: `tests/unit/lib/collaboration/github-crawl.test.ts` (new)
  - Do: Inject a stub `fetchImpl` returning recorded JSON (inline in the test, no network). Assert:
    forks excluded; a repo appearing in both events and owned repos is returned once; bot logins
    filtered; `readRateLimit` parses both headers and returns `null` when absent; a 403 response
    yields `[]` rather than an exception.
  - Verify: `pnpm test -- tests/unit/lib/collaboration/github-crawl.test.ts`.

## Phase 4 — Worker, cursor, restriction cascade

- [ ] **Add the collaboration-graph repository**
  - Files: `src/shared/lib/repositories/collaboration-graph.ts` (new)
  - Do: All functions use `publicDb` directly (global table, no `withTenantContext`) — copy the
    header-comment convention of `src/shared/lib/repositories/public-builder-embeddings.ts`.
    Export: `insertDiscoveredBuilderIdentity({ source, sourceId, username, avatarUrl, profileUrl })` —
    deterministic id `createHash('sha256').update(\`${source}\0${sourceId}\`).digest('hex')`, the same
    derivation as `trackOrganizationBuilder` (`organization-builders.ts` L278–280) but
    **`.onConflictDoNothing()`, never `onConflictDoUpdate`**, and sets
    `discoveredBy: 'collaboration_crawl'`. Do NOT reuse `trackOrganizationBuilder`'s SET clause
    (`organization-builders.ts` L294–307): it unconditionally writes
    `followersCount: input.followersCount ?? 0`, `language: … ?? null`, `bio: … ?? null` and
    `lastSeenAt: new Date()`, none of which a contributor-list row can supply, so an update path
    would zero `followers_count`, null `language`/`bio` and falsely refresh `last_seen_at` on every
    already-known identity the crawler touches — columns read by `organization-builders.ts` L41/L45
    (tracked list, dashboard, CSV export) and `public-builders.ts` L12 (public profile). Insert-only
    makes that corruption structurally impossible.

    **Grant check for this write**: it runs on `publicDb` = `builderhunt_app`, which already holds
    `GRANT SELECT, INSERT, UPDATE ON TABLE builder_identities` (`drizzle/0011_builder_claim_policies.sql`
    L31), and `builder_identities` has no RLS — so no new grant and no tenant context is required.

    Then `upsertCollaborationEdge(input)` (canonical pair asserted, merged observations, recomputed
    `rawWeight`, `observationCount`, `lastObservedAt`, `ON CONFLICT (builder_identity_a_id,
    builder_identity_b_id, source)`); `getNodeTotals(identityIds)` (one
    `SELECT id, SUM(raw_weight)` grouped over both endpoint columns);
    `renormalizeEdgesForIdentities(ids, now)`; `renormalizeAllEdges(now)`;
    `deleteCollaborationEdgesForIdentity(identityId)` — the **only** function in this file that uses
    `platformDb` (imported from `../db/client`, matching `enrichment-restrictions.ts` L2), covered by
    the new `GRANT SELECT, DELETE … TO builderhunt_platform`; `isIdentityRestricted(identityId)` via
    ``sql`select is_builder_processing_restricted(${id}) as restricted` `` on `publicDb`, the same
    shape as `isBuilderProcessingRestricted` in `repositories/enrichment.ts` L182–190 but without a
    `TenantTransaction` (the `EXECUTE` grant to `builderhunt_app` is
    `drizzle/0017_enrichment_rls_policies.sql` L82); `loadCollaborationState()` /
    `saveCollaborationState()`.
  - Verify: `pnpm type-check`; `pnpm security:boundaries` still passes (this file must import
    `publicDb`/`platformDb` from `~/shared/lib/db/client`, **never** from `~/shared/lib/db/index` —
    `scripts/check-tenant-boundaries.mjs` fails any `/repositories/` file importing the latter).

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
  - Files: `tests/unit/lib/collaboration/worker.test.ts` (new)
  - Do: With stubbed crawl functions and an in-memory repository double: running twice over the same
    fixture yields identical `rawWeight` and no duplicate edges; an edge is written once for a pair
    regardless of contributor order; a restricted endpoint produces zero edges and increments
    `skippedRestricted`; a snapshot with `remaining: 10` halts before the second anchor and leaves
    the cursor on the first; a crawl error on one anchor does not abort the run.
  - Verify: `pnpm test -- tests/unit/lib/collaboration/worker.test.ts`.

- [ ] **Add the admin run-worker endpoint**
  - Files: `src/routes/api/admin/collaboration-graph/run-worker.ts` (new)
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` verbatim in shape — that file changed since
    this plan was drafted and now wraps the run in `withJobRun`, so copy the current version, not the
    older two-step one:
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, then

    ```ts
    const { payload: result } = await withJobRun({ jobKey: 'collaboration.crawl' }, async () => {
      const outcome = await runCollaborationWorker()
      // A rate-limit halt is a SUCCESSFUL run — only per-anchor crawl errors count as failures,
      // or job_runs history shows red for correct throttling behaviour (spec §Quota budget).
      return { processedCount: outcome.anchors, failedCount: outcome.errors, payload: outcome }
    })
    ```

    then `auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker',
    targetId: 'collaboration-graph', result: 'allowed' })`, return
    `Response.json({ ok: true, ...result })`, `platformAdminErrorResponse(err)` fallback. Return
    `503 { error: 'collaboration_disabled' }` when `env.COLLABORATION_ENABLED !== 'true'` and
    `503 { error: 'github_unconfigured' }` when `GITHUB_TOKEN` is unset — both **before** entering
    `withJobRun`, so a disabled worker leaves no `job_runs` row. Add `errors: number` to the worker's
    return shape for the `failedCount` mapping above.
  - Verify: `pnpm security:route-coverage` passes (the route matches the `platform-admin` guard
    pattern, so it needs no allowlist entry);
    `curl -sS -o /dev/null -w '%{http_code}' -X POST -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/admin/collaboration-graph/run-worker`
    returns `200` with `{ ok: true, anchors: N }` when the flag is on, `503` with
    `{"error":"collaboration_disabled"}` when off, and `401`/`403` with no cron header and no admin
    session.

- [ ] **Register `collaboration.crawl` in the schedule registry**
  - Files: `src/shared/lib/operational-schedules.ts`
  - Do: This step did not exist when the plan was written and is now mandatory for every worker
    (`drizzle/0066_orange_the_enforcers.sql` / `drizzle/0067_operational_schedule_grants.sql`, plan `calendar-scheduling-interview-intelligence`). Append to
    `OPERATIONAL_SCHEDULES`:

    ```ts
    {
      jobKey: 'collaboration.crawl',
      cronExpression: '5,20,35,50 * * * *',
      timezone: 'UTC',
      scope: 'platform',
      label: 'Collaboration graph crawl',
      sourceRoute: '/api/admin/collaboration-graph/run-worker',
    },
    ```

    Cadence rationale (re-derived at HEAD): `discovery.crawl` is `0 4 * * *` Europe/Copenhagen and
    never contends, so the plan's original "stagger 5 minutes off the discovery worker" was stale.
    The offset keeps this job off the `*/15` :00 grid that `alerts.evaluate` occupies; the only real
    `GITHUB_TOKEN` co-consumer is `enrichment.refresh` at `0 3 * * *`, one run a day, absorbed by
    `COLLABORATION_RATE_LIMIT_RESERVE`.
    After deploying, run the reconciliation **once**: `POST /api/admin/operations/sync-schedules`
    (the registry is never synced on boot, by design). Leave the row `enabled = false` until
    `COLLABORATION_ENABLED=true`, because `advanceScheduleAfterRun`
    (`repositories/platform-operations.ts` L133) only updates `WHERE enabled = true` and an enabled
    row that never runs shows as a permanently overdue job.
  - Verify: `pnpm test -- tests/unit/shared/lib/operational-schedules.test.ts` (its
    `assertRegistryIsSafe` case rejects a duplicate `jobKey`, a `sourceRoute` outside `/api/admin/`,
    an unknown timezone, or an unparseable cron); then
    `curl -X GET -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/admin/operations/sync-schedules`
    lists `collaboration.crawl`.

- [ ] **Cascade the processing restriction to edges**
  - Files: `src/lib/enrichment/worker.ts`, `src/routes/api/me/builder/$builderId/restrict-processing.ts`
  - Do: `cascadeBuilderProcessingRestriction` is at `src/lib/enrichment/worker.ts` L206–211 and
    currently returns `{ jobsCancelled, evidencePurged }`. Add
    `const collaborationEdgesPurged = await deleteCollaborationEdgesForIdentity(builderIdentityId)`
    after `purgeEnrichmentEvidenceForIdentity`, widen the declared return type, and include the count
    in both the returned object and the `log.info('enrichment_subject_restriction', …)` line at L209.
    `restrict-processing.ts` L31 already spreads the cascade result into its response, so the route
    needs no change.
    **Cross-plan collision**: [`availability-signals`](../availability-signals/spec.md) extends the
    *same* function (its `tasks.md` L234). Both additions are additive and order-independent, but
    whichever lands second must rebase rather than overwrite the other's key.
  - Verify: `pnpm test -- tests/unit/lib/enrichment/worker.test.ts` (still passes unchanged);
    manual: activate a restriction for an identity with edges, then confirm
    `SELECT count(*) FROM builder_collaboration_edges WHERE builder_identity_a_id = $id OR builder_identity_b_id = $id`
    is 0 and the POST response body carries `collaborationEdgesPurged`.

- [ ] **Document the worker in the runbook**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Add a row to the `## Workers / scrapers` table (L145–154, columns
    `Endpoint | Purpose | Key env`):
    `| POST /api/admin/collaboration-graph/run-worker | co-shipping collaboration graph | COLLABORATION_*, GITHUB_TOKEN |`
    plus a short note under it: cadence is defined in `src/shared/lib/operational-schedules.ts` as
    `collaboration.crawl` (`5,20,35,50 * * * *` UTC), not in a crontab; it shares `GITHUB_TOKEN` with
    the enrichment worker (`0 3 * * *`) and is bounded by `COLLABORATION_RATE_LIMIT_RESERVE`;
    and it stays off until `COLLABORATION_ENABLED=true`, like `DEVPOST_ENABLED`.
    The runbook's blanket statement that workers "connect to the DB as `builderhunt_worker`" is not
    true of this one — its writes run in the app process on `publicDb` (`builderhunt_app`), exactly
    like the discovery worker. Say so explicitly so nobody debugs a permission error against the
    wrong role.
  - Verify: `grep -n "collaboration-graph/run-worker" docs/operations/deploy-runbook.md` returns the
    new row; no code change.

## Phase 5 — Read API + entitlement gate

- [ ] **Add the tier limits and pricing copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: **Corrected from the original draft.** `SOURCING_SPRINT_LIMITS` is no longer
    `Record<PlanTier, number>` — it is `Record<OrganizationTier, number>` (`billing-shared.ts` L54),
    and its own comment (L43–53) plus `repositories/entitlements.ts` L44–47 record that the
    `PlanTier` shape *was the bug*: it forced enforcement through `resolveLegacyPlanTier` and let
    `/pricing` advertise 3 sprints for Pro Max while the code allowed 10. An allowance that is also
    advertised must be keyed by `OrganizationTier` and indexed by `entitlement.tier` directly.
    Add next to `SOURCING_SPRINT_LIMITS`:

    ```ts
    // Plan: collaboration-graph. Neighbours visible on a builder's ego graph. Keyed by
    // OrganizationTier (not PlanTier) so /pricing copy and route enforcement read the same row —
    // see the SOURCING_SPRINT_LIMITS comment above for the drift this prevents.
    export const COLLABORATION_GRAPH_LIMITS: Record<OrganizationTier, number> = {
      free: 0, pro: 12, pro_max: 24, team: 24,
    }

    /** Plan-card bullet, e.g. `Collaboration graph (12 links)`. `null` for a zero allowance. */
    export function collaborationGraphFeature(tier: OrganizationTier): string | null {
      const limit = COLLABORATION_GRAPH_LIMITS[tier]
      return limit > 0 ? `Collaboration graph (${limit} links)` : null
    }
    ```

    Then add `collaborationGraphFeature('pro')` inside the existing `compactFeatures(…)` call in
    `PLAN_PRICING.pro.features` and `collaborationGraphFeature('team')` in `team.features` — a
    derived string, never a hand-written one. Do **not** add a Free bullet: `compactFeatures` drops
    the `null` a zero allowance produces, and `PLAN_PRICING.free.features` is a plain array anyway.
  - Verify: `pnpm type-check` (the `Record<OrganizationTier, …>` type makes a missing `pro_max` key a
    compile error); `pnpm test -- tests/unit/shared/lib/billing.test.ts`; `/pricing` renders
    "Collaboration graph (12 links)" on Pro and "(24 links)" on Team, and nothing on Free.

- [ ] **Implement the ego-graph read query**
  - Files: `src/shared/lib/repositories/collaboration-graph.ts` (new — created in Phase 4)
  - Do: `listEgoGraph({ identityId, minStrength, since, sources, limit })` — one query,
    `WHERE (a_id = $ego OR b_id = $ego) AND strength >= $minStrength AND last_observed_at >= $since`
    (+ optional `source IN`), `AND NOT is_builder_processing_restricted(a_id) AND NOT
    is_builder_processing_restricted(b_id)`, joined to `builder_identities` on the *counterpart*
    column, `ORDER BY strength DESC, last_observed_at DESC`, `LIMIT $limit + 1` (the extra row
    detects "more exist"). Also `countEgoNeighbors(identityId)` for the locked free-tier response.
    Map to the DTO allowlist of spec.md §4.5 — never `observations.artifacts`, never `rawWeight`.
    Runs on `publicDb` (`builderhunt_app`), which the Phase-1 grants migration gives `SELECT` on the
    edge table and which already holds `EXECUTE` on `is_builder_processing_restricted(text)`
    (`drizzle/0017_enrichment_rls_policies.sql` L82) — both checked, no new grant.
  - Verify: `pnpm type-check`; with a seeded 100k-edge table,
    `psql "$DATABASE_URL" -c 'EXPLAIN (ANALYZE) <the ego query>'` shows index scans on both
    `builder_collaboration_edges_a_strength_idx` and `..._b_strength_idx` and **no** `Seq Scan on
    builder_collaboration_edges`.

- [ ] **Add GET /api/builders/$builderId/collaboration**
  - Files: `src/routes/api/builders/$builderId/collaboration.ts` (new)
  - Do: `requireTenantPrincipal` (401 via `TenantAuthorizationError`);
    `503 { error: 'collaboration_disabled' }` when the flag is off;
    `rateLimit('collaboration-graph', principal.userId, 60, 60)`; then the **enumeration cap**
    (spec.md §Enumeration) — `chargeSubjectView(userId, builderIdentityId)` in
    `src/lib/collaboration/enumeration.ts` (new): Redis `SADD collab:subjects:{userId}:{YYYY-MM-DD}`
    + `SCARD`, `EXPIRE` 48 h, in-memory `Map` fallback when Redis is unset — copy the shape of
    `peekStubCount`/`incrementStubCount` in `src/lib/discovery/worker.ts` L74–93, including the
    `const redis = await getRedis(); if (redis) { … } return memoryMap…` structure and the
    "per-instance, best-effort, resets on restart" comment. `getRedis()` returns an `ioredis` client,
    so `sadd`/`scard`/`expire` are directly available. Over
    `COLLABORATION_DAILY_SUBJECTS_PER_USER = 200` (module constant) return
    `429 { error: 'enumeration_cap' }` and `log.warn('collaboration_enumeration_cap', { userId, organizationId })`.
    Re-viewing an already-charged subject must not consume budget. Then zod-parse the query
    (`minStrength` 0–1 default 0.05, `window` `'12m' | '24m' | 'all'` default `'24m'`, `source`
    optional enum); `withTenantContext(principal, tx => getOrganizationEntitlement(tx,
    principal.organizationId))`, then index `COLLABORATION_GRAPH_LIMITS[policy.tier]` **directly** —
    **do not** call `resolveLegacyPlanTier`; `repositories/entitlements.ts` L44–47 prohibits it for
    an allowance that is also advertised, and the limits map has a real `pro_max` row. When the cap
    is 0 or `!policy.paidActionsAllowed` return `200 { locked: true, neighborCount }`; otherwise
    return `{ locked: false, ego: {…}, neighbors: [...], totalCount, cap, truncated }`. Deliberately
    does **not** require an `organization_builders` row (spec.md §4.6).
  - Verify: `pnpm security:route-coverage` (the route matches the `tenant` guard pattern, so it needs
    no allowlist entry); Pro-tier authed curl returns neighbours sorted by strength; free-tier returns
    `{ locked: true, neighborCount }` with no `username` key anywhere in the body; unauthenticated
    401; flag off 503; the 201st distinct subject in one day returns `429 enumeration_cap` while the
    1st subject re-requested a 5th time still returns 200.

- [ ] **Test the enumeration cap as pure logic**
  - Files: `tests/unit/lib/collaboration/enumeration.test.ts` (new)
  - Do: Against the in-memory fallback: 200 distinct subjects allowed, the 201st denied; the same
    subject requested 300 times consumes 1 of the budget; the key rolls over on a UTC date change;
    two different `userId`s have independent budgets (the cap is per seat, not per organization).
  - Verify: `pnpm test -- tests/unit/lib/collaboration/enumeration.test.ts`.

- [ ] **Extend the route isolation script**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add one `async function checkCollaborationGraph()` modelled on `checkPublicNonTenantTableGrants()`
    (L399–424, which dynamically `import()`s the repository and asserts through `record(name, pass,
    detail)`), and call it from `main()` (L1223) after `checkPublicNonTenantTableGrants()`. Checks,
    all executed as the real non-owner roles:
    (1) the worker's edge upsert succeeds through `upsertCollaborationEdge` on `publicDb` —
    the `0025` failure mode, where a missing grant is swallowed by a `try/catch`, must fail the
    suite; (2) `GET /api/builders/:id/collaboration` returns zero neighbours once a restriction is
    active for the counterpart, and zero once active for the ego; (3) a free-tier organization's
    response contains `locked: true` and no `username` key; (4) an unauthenticated request is denied;
    (5) `builderhunt_worker` cannot INSERT into `builder_collaboration_edges` (expect `42501`);
    (6) **ID enumeration** ([`security-policy`](../../_meta/security-policy.md) L108) — a Pro seat
    walking distinct, offline-derivable `sha256(source \0 sourceId)` ids is cut off with
    `429 enumeration_cap` at `COLLABORATION_DAILY_SUBJECTS_PER_USER`, and a
    nonexistent-but-well-formed id returns an empty graph with the same shape and no existence
    signal (no 404 vs 200 distinction);
    (7) `insertDiscoveredBuilderIdentity` on an existing identity leaves `followers_count`,
    `language`, `bio` and `last_seen_at` byte-identical (regression guard for the corruption path in
    spec.md §Anchor rule — snapshot the row before and after and deep-compare).
    Note the script's own ordering comment at L1240–1247: nothing here writes cross-user references,
    so this check has no ordering constraint.
  - Verify: `pnpm db:migrate` first, then `pnpm test:api-isolation:local` — all checks pass, and
    temporarily revoking the `builderhunt_app` grant on `builder_collaboration_edges` makes check (1)
    fail rather than silently pass.

## Phase 6 — Ego-graph UI

- [ ] **Build the collaboration graph card**
  - Files: `src/modules/builder-profile/components/CollaborationGraphCard.tsx` (new)
  - Do: Props `{ builderId: string }`. Fetch `/api/builders/${builderId}/collaboration` on mount
    with plain `fetch` + `React.useState` (match `PersonaCard.tsx` L21–26's `FetchState`
    discriminated union and its `useState<FetchState>({ kind: 'loading' })` at L45 — this module does
    not use React Query). States: `loading`, `locked` (count + `Pro` pill linking to `/pricing` —
    **the original claim that this idiom is at `BuilderProfilePage.tsx` L300/L305 is stale; that file
    has no locked section at HEAD.** Copy `TeamFitCard.tsx` L118–128 instead: a `{ kind: 'plan' }`
    arm rendering a `Lock` icon inside `rounded-lg border border-bh-accent/30 bg-bh-accent-soft p-4`,
    and give it `data-testid="collaboration-graph-upgrade"`), `empty`
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
  - Do: Import and render `<CollaborationGraphCard builderId={builder.id} />` immediately below
    `<PersonaCard builderId={builder.id} canRefresh={Boolean(isMyProfile)} />` at
    `BuilderProfilePage.tsx` L352 (the right-hand column, above `<PublicEvidenceCard …/>`). No change
    to `src/routes/builders/$builderId.tsx` — the public profile never shows the graph
    (spec.md §UX integration).
  - Verify: `pnpm type-check`; `/builder/:id` shows the card for a Pro org and the locked variant for
    a free org; `git diff --stat src/routes/builders/` is empty.

- [ ] **Accessibility and reduced-motion pass**
  - Files: `src/modules/builder-profile/components/CollaborationGraphCard.tsx` (new — created earlier in this phase), `src/shared/styles/globals.css`
  - Do: Confirm the SVG contributes nothing to the accessibility tree; the table has a `<caption>`
    and `scope="col"` headers; the toggle is a real `<button>` with `aria-pressed`; filter controls
    have visible labels; the "N of M" notice is in an `aria-live="polite"` region so filtering
    announces; all interactive targets meet the 24×24 CSS-pixel minimum (no `p-1`); and every
    transition in this component sits behind
    `@media (prefers-reduced-motion: no-preference)` (add the guard in `globals.css` if a shared
    utility is used).
  - Verify: `pnpm test:a11y` (→ `node tests/regression/test-accessibility.mjs`, the gate
    [`audit-accessibility`](../../phase-1/47-audit-accessibility/spec.md) owns) reports zero violations;
    `pnpm test -- tests/unit/shared/lib/accessibility.test.ts` still passes; keyboard-only traversal
    reaches every neighbour in strength order and returns focus correctly after toggling; with
    `prefers-reduced-motion: reduce` no transition occurs.

## Phase 7 — Co-authorship source, subject transparency, observability

- [ ] **Add the GraphQL co-authorship adapter**
  - Files: `src/lib/collaboration/github-coauthors.ts` (new), `tests/unit/lib/collaboration/github-coauthors.test.ts` (new)
  - Do: `listRepoCoAuthorPairs(fullName, { token, fetchImpl })` — one `POST https://api.github.com/graphql`
    with `repository(owner,name){ defaultBranchRef { target { ... on Commit { history(first: 100) {
    nodes { committedDate authors(first: 5) { nodes { user { login databaseId } } } } } } } } }`
    plus `rateLimit { cost remaining resetAt }` in the same query. Emit a pair per commit with ≥ 2
    resolved `user` nodes; drop unresolved authors (no `user` ⇒ the trailer email is not linked to an
    account, and we never store the email); return
    `{ pairs, lastActivityAt, rateLimit }`. `databaseId` is the numeric GitHub user id — use
    `String(databaseId)` as `sourceId` so the derived identity id matches the REST path's
    (`sha256('github' \0 sourceId)`); a `login`-derived id would mint a duplicate identity.
    Tests use a stubbed `fetchImpl` with a recorded response and assert: unresolved authors dropped,
    bot users dropped, `rateLimit` surfaced, non-200 → empty.
  - Verify: `pnpm test -- tests/unit/lib/collaboration/github-coauthors.test.ts`.

- [ ] **Wire co-authorship edges into the worker under its own budget**
  - Files: `src/lib/collaboration/worker.ts` (new — created in Phase 4)
  - Do: After the `github_repo` pass, take up to `env.COLLABORATION_COAUTHOR_REPOS_PER_RUN` of the
    repos already selected this run (no additional repo discovery, therefore no additional REST
    cost) and upsert `source: 'github_commit'` edges from `listRepoCoAuthorPairs`. Halt this pass
    when the GraphQL `rateLimit.remaining` falls below `COLLABORATION_RATE_LIMIT_RESERVE`; log
    `collaboration_worker_graphql_cost` with the summed `cost`. Default of `0` means the pass is
    off until explicitly enabled.
  - Verify: extend `tests/unit/lib/collaboration/worker.test.ts` (new — created in Phase 4) — with
    `COLLABORATION_COAUTHOR_REPOS_PER_RUN=2` and a stubbed `listRepoCoAuthorPairs`, the run upserts
    `source: 'github_commit'` edges and the stub is called exactly twice; with `0` the stub is never
    called. `pnpm test -- tests/unit/lib/collaboration/worker.test.ts`.

- [ ] **Add the subject transparency endpoint**
  - Files: `src/routes/api/me/builder/$builderId/collaboration.ts` (new)
  - Do: Same shape as `src/routes/api/me/builder/$builderId/restrict-processing.ts` L20–24:
    `requireTenantPrincipal(request)`, then `withTenantContext(principal, (tx) =>
    isVerifiedBuilderClaimant(tx, principal.userId, params.builderId))` from
    `~/shared/lib/repositories/builder-claims` — 403 otherwise; catch `TenantAuthorizationError` and
    map to `error.status`. This is a `GET`, so it sits alongside the existing `POST` file rather than
    inside it. Return the subject's own edges (counterpart username, source, strength,
    `observationCount`, `firstObservedAt`, `lastObservedAt`) plus a one-line explanation of the
    derivation and a pointer to `POST .../restrict-processing`. No pagination needed at this size;
    cap at 500 rows. The enumeration cap does **not** apply — a claimant reading their own edges is
    one subject by construction.
  - Verify: `pnpm security:route-coverage`; a verified claimant gets their edge list; a non-claimant
    gets 403; a restricted subject gets an empty list (their edges were deleted by the cascade).

- [ ] **Surface worker health on the admin metrics page**
  - Files: `src/routes/_dashboard/admin/metrics.tsx`, `src/shared/lib/repositories/collaboration-graph.ts` (new — created in Phase 4)
  - Do: Add a `getCollaborationGraphStats()` read (total edges, edges by source, distinct identities
    with ≥ 1 edge, `lastRunAt`, `haltedReason`, `rateLimitResetAt`, cumulative `stats`, plus the
    running `collaboration_enumeration_cap` count) and render it on
    `src/routes/_dashboard/admin/metrics.tsx` (`AdminMetricsPage` at L66) using the existing
    `MetricCard` helper (L225) and the "Worker has not run yet." empty-state idiom at L177.
  - Verify: `pnpm type-check`; the page shows a non-zero edge count and `lastRunAt` after a manual
    worker run, and shows `haltedReason: rate_limit` after forcing the reserve threshold (set
    `COLLABORATION_RATE_LIMIT_RESERVE` above 5000 and run once).

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm lint && pnpm type-check && pnpm test && pnpm build`, then the security and DB gates:
    `pnpm security:boundaries`, `pnpm security:route-coverage`, `pnpm test:migration-integrity`,
    `pnpm db:migrate`, `pnpm test:rls:local`, `pnpm test:api-isolation:local`, `pnpm db:audit-schema`.
    End-to-end: flag off ⇒ card hidden and both routes 503; flag on + one worker run ⇒ edges appear,
    Pro profile shows the graph, free profile shows the count only; activate a processing restriction
    ⇒ the subject disappears from their own graph *and* from a neighbour's graph within one request;
    re-run the worker ⇒ no duplicate edges, identical `rawWeight`, cursor advanced.
  - Verify: all of the above green, plus `pnpm ci:local` as the single consolidated gate (do not
    invent env values for it — it must run the workflow's env verbatim, including what it leaves
    unset). The restriction cascade and idempotency checks are observed manually in addition to the
    automated suites.
