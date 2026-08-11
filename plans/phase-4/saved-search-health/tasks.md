# Saved Search Health (tasks)

> **Status**: `pending`
> **Depends on**: [`smart-alerts`](../../implemented/phase-1/34-smart-alerts/tasks.md) (`alerts` / `alert_triggers` are the signal source); [`ai-sourcing-sprints`](../../implemented/phase-1/41-ai-sourcing-sprints/tasks.md) (sprint results count as useful-match evidence). Both already have shipped code — see the reality check.
> **Blocks**: nothing
> **Reality check**: Touches existing `src/shared/lib/db/schema.ts`, `src/routes/api/alerts/index.ts`, `src/routes/api/alerts/$id.ts`, `src/shared/lib/repositories/organization-alerts.ts`, `src/shared/lib/repositories/saved-queries.ts`, `src/routes/api/sprints/index.ts`, `src/lib/sprints/service.ts`, `src/shared/lib/sprints-shared.ts`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`, `scripts/db/verify-api-isolation-local.mjs`. `/saved-searches` is a new route; `/alerts` (`src/routes/_dashboard/alerts.tsx`) is not modified.

Ordered so the app ships cleanly after every checkbox. Phase 0's FK repair must land before any
code writes `alerts.query_id`.

**Migration numbering — read before Phase 0.** Never hardcode a migration index or filename.
`drizzle/meta/_journal.json` grows constantly (115 entries, head `0114_*` at last check, all
committed), so the real next index will differ from anything written here. Both migration tasks
below say to let drizzle-kit allocate the index and to read the actual value back out of
`drizzle/meta/_journal.json`.

## Phase 0 — Attribution foundation

- [ ] **Record the data classification and authorization decision**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: No new table. `sourcing_sprints` and `sprint_results` are currently **absent** from
    `data-classification.md`'s table — add both as `tenant-private` / owner `organization_id`
    (plans: `ai-sourcing-sprints`, `saved-search-health`), and note in the `sourcing_sprints` and
    `alerts` rows that `saved_query_id` and the now-live `query_id` are tenant-private relational
    references carrying no authorization data (`security-policy.md` §8). In
    `authorization-matrix.md`, note under "Product actions" that saved-search health is readable
    only by the saved search's creator via `can(principal, 'resource:read', { creatorUserId })` —
    `saved_queries` has no `visibility` column, so the "Read organization-visible resource" row
    never applies to it and owner/admin get no extra reach.
  - Verify: `grep -n "sourcing_sprints\|sprint_results" docs/architecture/data-classification.md`
    returns both rows; `grep -n "saved_query_id\|saved-search health"
    docs/architecture/data-classification.md docs/architecture/authorization-matrix.md` returns
    hits in both files. `pnpm db:audit-schema` still exits 0 (it classifies tables, not columns —
    adding the two missing rows removes two `unclassified table` findings). No code change.

- [ ] **Make `schema.ts` model everything the migration will do that Drizzle can express**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Three edits, so the generated snapshot is truthful rather than a silent lie about the
    live database. Note the two extras styles already in this file — `sourcingSprints` uses the
    **array** form `(table) => [ … ]`, while `alerts` and `alertTriggers` use the **object** form
    `(table) => ({ … })`. Match each table's existing style:
    1. `sourcingSprints` (array extras): add column
       `savedQueryId: text('saved_query_id')` (nullable, **no** single-column `.references()` —
       the composite FK is the tenant-preserving one), and append to the extras array:

       ```ts
       index('sourcing_sprints_saved_query_idx').on(table.organizationId, table.savedQueryId),
       foreignKey({
         columns: [table.organizationId, table.savedQueryId],
         foreignColumns: [savedQueries.organizationId, savedQueries.id],
         name: 'sourcing_sprints_organization_saved_query_fk',
       }).onDelete('set null'),
       ```

       `savedQueries` is declared earlier in the file, so no forward reference is needed.
    2. `alerts` (object extras): change `queryId` to
       `text('query_id').references(() => savedQueries.id, { onDelete: 'set null' })` and add
       `.onDelete('set null')` to the existing `organizationQueryFk` `foreignKey({ … })` builder.
       Drizzle **can** express the action (`UpdateDeleteAction` in
       `node_modules/drizzle-orm/pg-core/foreign-keys.d.ts:4` includes `'set null'`) — it cannot
       express the column list. Put a comment on `organizationQueryFk` saying the live database
       has `ON DELETE SET NULL (query_id)` and pointing at the `--custom` migration, so a future
       regeneration does not silently "fix" the divergence.
    3. `alertTriggers` (object extras): add
       `orgAlertMatchedIdx: index('alert_triggers_org_alert_matched_idx').on(table.organizationId, table.alertId, table.matchedAt),`.
       Plain ascending on purpose: the health aggregate filters and groups, it never does an
       ordered scan, so no `.desc()` is needed and the index stays a stock construct drizzle-kit
       emits verbatim.
  - Verify: `pnpm type-check`; `pnpm db:generate` writes a migration whose statements are exactly
    the new column, the two `CREATE INDEX`es and the two `alerts` FK drop/add pairs — nothing else.

- [ ] **Generate the schema migration and mint its metadata**
  - Files: `drizzle/<next>_saved_search_attribution.sql` (new — **do not hardcode the number**),
    `drizzle/meta/_journal.json`, `drizzle/meta/<next>_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate`. The whole diff comes from the previous task's `schema.ts` edits, so
    this one is generated, not `--custom`. drizzle-kit allocates the next index itself from
    `drizzle/meta/_journal.json`; read the value it actually used back out of the journal rather
    than assuming one. Rename the generated `.sql` to a descriptive tag
    (`<idx>_saved_search_attribution.sql`) and update the matching `_journal.json` `tag` — this
    repo's convention, e.g. `0083_public_surface_indexing_grants`,
    `0085_candidate_documents_rls_grants`. Do **not** rename the snapshot: the integrity checker
    expects `<padded idx>_snapshot.json`. No new RLS policy or GRANT: `alerts`,
    `alert_triggers` and `sourcing_sprints` already have FORCE RLS
    (`drizzle/0008_tenant_rls.sql`, `drizzle/0024_sourcing_sprints_grants.sql`) and their grants
    are table-level (`drizzle/0008_tenant_rls.sql:110-118`,
    `drizzle/0024_sourcing_sprints_grants.sql:55`), so the new column inherits them. Finally
    regenerate the hash manifest with `node scripts/db/verify-migration-integrity.mjs --write`.
    That script hard-fails unless the `.sql` filename set equals the journal's tags, the
    `NNNN_snapshot.json` set equals the journal's padded indices, and the manifest is current —
    a mismatch in any of the three turns `tests/unit/shared/lib/db/migration-integrity.test.ts`
    red, so run it before committing, not after.
  - Verify: `pnpm db:migrate` on a fresh DB **first**, then `pnpm exec drizzle-kit check`,
    `pnpm test:migration-integrity`, and `pnpm db:generate` again reporting no schema changes.

- [ ] **Add the `--custom` migration for the one thing Drizzle cannot express**
  - Files: `drizzle/<next>_alerts_query_fk_column_scoped_set_null.sql` (new — **do not hardcode
    the number**), `drizzle/meta/_journal.json`, `drizzle/meta/<next>_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: Mint with `pnpm exec drizzle-kit generate --custom`, then read the index it allocated out
    of `drizzle/meta/_journal.json` and rename the `.sql` + its journal `tag` to
    `<idx>_alerts_query_fk_column_scoped_set_null`. Body — exactly this, comment included:

    ```sql
    -- The previous migration set alerts_organization_query_fk to a whole-row ON DELETE SET NULL,
    -- which would also null alerts.organization_id when a saved search is deleted. PostgreSQL >= 15
    -- supports a column list; drizzle-orm 0.45.2's UpdateDeleteAction
    -- (node_modules/drizzle-orm/pg-core/foreign-keys.d.ts:4) has no column-list variant, so this
    -- statement is hand-written and the snapshot deliberately records a MORE destructive action
    -- than the database has. Do not "fix" the snapshot; see the comment on `organizationQueryFk`
    -- in src/shared/lib/db/schema.ts. Every environment runs pgvector/pgvector:pg16.
    ALTER TABLE "alerts" DROP CONSTRAINT "alerts_organization_query_fk";--> statement-breakpoint
    ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_query_fk"
      FOREIGN KEY ("organization_id","query_id")
      REFERENCES "public"."saved_queries"("organization_id","id")
      ON DELETE SET NULL ("query_id");
    ```

    Then `node scripts/db/verify-migration-integrity.mjs --write` again.
  - Verify: `pnpm db:migrate` on a fresh DB, `pnpm exec drizzle-kit check`,
    `pnpm test:migration-integrity`. Then, connected as the **owner**, confirm both actions:

    ```sql
    SELECT conname, confdeltype, confdelsetcols
    FROM pg_constraint
    WHERE conrelid = 'alerts'::regclass AND conname IN
      ('alerts_query_id_saved_queries_id_fk','alerts_organization_query_fk');
    ```

    Both rows must show `confdeltype = 'n'`; `alerts_organization_query_fk` must have a non-empty
    `confdelsetcols` naming only `query_id`'s attnum, and `alerts_query_id_saved_queries_id_fk`
    must have `confdelsetcols IS NULL`. Then, connected as **`builderhunt_app`** inside a tenant
    context, insert a saved query + an alert with `query_id`, delete the saved query, and confirm
    the alert survives with `query_id IS NULL` **and** `organization_id` unchanged.

- [ ] **Accept and persist `queryId` on alert creation**
  - Files: `src/shared/lib/repositories/organization-alerts.ts`, `src/routes/api/alerts/index.ts`
  - Do: Add `queryId?: string | null` to `CreateOrganizationAlertInput`; `createOrganizationAlert`
    already spreads `...input` into the insert, so no other repository change is needed. Add
    `queryId: z.string().min(1).optional()` to `CreateBody`. Before insert, inside the same
    `withTenantContext` transaction, verify the saved query belongs to the active organization
    **and** to `principal.userId` using the existing
    `findSavedQueryById(tx, organizationId, id)` in
    `src/shared/lib/repositories/saved-queries.ts` (it returns the full row, so
    `row?.userId === principal.userId` is the whole check — do not add a new finder). On failure
    return `404 { error: 'Saved search not found' }` — never a distinguishable "exists but not
    yours". Grant check: this is an `INSERT INTO alerts`, covered by
    `drizzle/0008_tenant_rls.sql:110-118` plus the `alerts_app_insert` policy from that file's
    `DO $$` loop.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/organization-alerts.test.ts`
    (a source-inspection boundary test — it must still pass);
    `pnpm type-check`; authed `curl -X POST /api/alerts` with a valid `queryId` returns the alert
    with `queryId` set; with another organization's saved-query id returns 404.

- [ ] **Extend the existing `PATCH /api/alerts/$id` to attach/detach a saved search**
  - Files: `src/routes/api/alerts/$id.ts`, `src/shared/lib/repositories/organization-alerts.ts`,
    `tests/unit/shared/lib/repositories/organization-alerts.test.ts`
  - Do: **No new route** — `src/routes/api/alerts/$id.ts` already exists and already calls
    `updateOrganizationAlert`. Add `queryId: z.string().min(1).nullable().optional()` to its
    `UpdateBody`, and `queryId?: string | null` to `UpdateOrganizationAlertInput`;
    `updateOrganizationAlert` already does `.set(input)`, so it needs no change. When `queryId` is
    a string, run the same `findSavedQueryById` + `row?.userId === principal.userId` pre-check as
    the create path and 404 on failure; `null` detaches unconditionally. Add
    `'src/routes/api/alerts/$id.ts'` to the `tenantSurfaces` array at the top of
    `organization-alerts.test.ts` — it is currently absent, so this route is not yet covered by
    the boundary assertions. Grant check: `UPDATE alerts SET query_id = …` is covered by the
    table-level grant at `drizzle/0008_tenant_rls.sql:110-118` and the `alerts_app_update` policy
    from the same file's `DO $$` loop; no column-level grant exists or is needed.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/organization-alerts.test.ts`;
    `curl -X PATCH /api/alerts/<own alert id>` with `{"queryId":"<own saved query>"}` then
    `{"queryId":null}` round-trips; another organization's alert id → 404 (existing behaviour);
    another organization's saved-query id → 404.

- [ ] **Accept `savedQueryId` on sprint creation**
  - Files: `src/shared/lib/sprints-shared.ts`, `src/lib/sprints/service.ts`, `src/routes/api/sprints/index.ts`
  - Do: Add `savedQueryId: z.string().min(1).optional()` to `createSprintSchema` (it is
    `.strict()`, so an unknown key currently 400s). Thread it into `createSprint`'s
    `insert(sourcingSprints).values({ … savedQueryId: input.savedQueryId ?? null })`, and add
    `savedQueryId: string | null` to `SprintRecord` and to `toRecord`. In the route's `POST`
    handler, inside the existing `withTenantContext` callback and before `createSprint`, validate
    the saved query is the caller's own with `findSavedQueryById` + the `userId` comparison; return
    404 otherwise (distinct from the existing 402 quota path). Grant check: `INSERT INTO
    sourcing_sprints` is covered by `drizzle/0024_sourcing_sprints_grants.sql:55`, table-level, so
    the new column inherits it.
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/lib/sprints/service.test.ts`;
    `curl -X POST /api/sprints` with `savedQueryId` returns a 201 sprint whose `savedQueryId`
    matches; unknown or foreign id returns 404.

## Phase 1 — Pure health library

- [ ] **Write the pure health module**
  - Files: `src/shared/lib/saved-search-health.ts` (new)
  - Do: Export `HEALTH_THRESHOLDS` (`WINDOW_DAYS: 30`, `MIN_AGE_DAYS: 14`, `DEAD_AGE_DAYS: 60`,
    `NOISE_FLOOR: 20`, `LOW_ACK_RATE: 0.2`, `USEFUL_TARGET: 3`, `RECENCY_HALF_LIFE_DAYS: 60`),
    `HEALTH_REASONS` (the 9 reason codes from spec.md §2, as a `readonly [...] as const` tuple so
    the AI task can `z.enum(HEALTH_REASONS)`), `REASON_GUIDANCE:
    Record<SavedSearchHealthReason, string>` (static one-line copy per reason — the non-AI
    fallback), `evaluateSavedSearchHealth(input: SavedSearchHealthInput): SavedSearchHealth`
    implementing the 9-rule table top-to-bottom with first-match-wins, `healthScore(input)`
    (the 40/30/30 formula, `null` for `unmonitored`/`too-new`), and
    `sortByHealth<T extends { health: SavedSearchHealth; metrics: { lastTriggerAt: string | null };
    name: string; id: string }>(rows: readonly T[]): T[]` (score asc nulls last →
    `daysSinceLastTrigger` asc nulls last → `name` → `id`). No imports from `db/`, no I/O, no
    `Date.now()` — `ageDays`/`daysSince*` arrive as numbers from the caller.
  - Verify: `pnpm type-check`; `grep -n "from '~/shared/lib/db" src/shared/lib/saved-search-health.ts`
    returns nothing; `pnpm security:boundaries` passes.

- [ ] **Test every verdict rule and boundary**
  - Files: `tests/unit/shared/lib/saved-search-health.test.ts` (new)
  - Do: One case per rule plus boundaries and invariants:
    1. `linkedAlertCount: 0` → `unmonitored` / `no_linked_alert`, `score === null`.
    2. `ageDays: 5`, 1 alert, 3 triggers → `too-new`, `score === null`.
    3. `ageDays: 90`, 1 alert, `triggersFired: 0`, `daysSinceLastUsefulMatch: null` → `kill` /
       `no_signal_ever`.
    4. `ageDays: 30`, `triggersFired: 0` → `tune-query` / `no_matches_in_window` (not `kill`:
       under `DEAD_AGE_DAYS`).
    5. `ageDays: 90`, `triggersFired: 40`, `usefulMatches: 0`, never useful → `kill` /
       `fires_but_never_useful`.
    6. same as 5 but `daysSinceLastUsefulMatch: 100` → `tune-query` / `noisy_no_conversion`
       (it worked once, so never `kill`).
    7. `ageDays: 20`, `triggersFired: 5`, `usefulMatches: 0`, never useful → `tune-query` /
       `no_conversion`.
    8. `ageDays: 90`, `triggersFired: 50`, `triggersAcknowledged: 5`, `usefulMatches: 2` →
       `tune-query` / `ignored_volume`.
    9. `ageDays: 90`, `triggersFired: 10`, `triggersAcknowledged: 6`, `usefulMatches: 3`,
       `daysSinceLastUsefulMatch: 2` → `healthy` / `converting`, `score >= 85`.
    10. Boundaries: `ageDays: 14` is not `too-new`; `triggersFired: 20` hits `NOISE_FLOOR`;
        `acknowledgeRate === 0.2` exactly is **not** `ignored_volume`;
        `ageDays: 59` never yields `kill`; `ageDays: 0` (the coalesced-null case) is `too-new`.
    11. Monotonicity: increasing `usefulMatches` never lowers `score`; increasing
        `daysSinceLastUsefulMatch` never raises it.
    12. Determinism: the same input evaluated twice deep-equals; calling with an
        `Object.freeze`d input neither throws nor mutates it.
    13. `sortByHealth`: kill/tune before healthy, `null` scores last, ties broken by name then id;
        sorting an already-sorted list is a no-op.
    14. `REASON_GUIDANCE` has a non-empty entry for every member of `HEALTH_REASONS`.
  - Verify: `pnpm test -- tests/unit/shared/lib/saved-search-health.test.ts`.

## Phase 2 — Aggregation repository

- [ ] **Write the health aggregate repository**
  - Files: `src/shared/lib/repositories/saved-search-health.ts` (new)
  - Do: `loadSavedSearchHealthRows(transaction: TenantTransaction, organizationId: string,
    userId: string, now: Date)` — one `transaction.execute(sql\`…\`)` with the CTE chain from
    spec.md §1/§3. Import `TenantTransaction` as a type from `~/shared/lib/db/client`; never
    import `~/shared/lib/db/index`.
    - `scoped`: `saved_queries` filtered by **both** `organization_id = $org` and
      `user_id = $userId`, selecting `id, name, keywords, sources, language, country,
      coalesce(created_at, now()) as created_at`.
    - `linked_alerts`: `count(*)`, `count(*) FILTER (WHERE enabled IS TRUE)` (`enabled` is
      nullable, so a bare `FILTER (WHERE enabled)` would be right but is written explicitly), and
      `min(coalesce(created_at, now()))` for the `ageDays` clamp, grouped by `query_id`, filtered
      on `organization_id = $org`.
    - `surfaced`: triggers of linked alerts (`payload->>'source'`, `payload->>'sourceId'`,
      `matched_at`, `read_at IS NOT NULL`) `UNION ALL` `sprint_results` of sprints with a matching
      `saved_query_id` — both **unwindowed**, both with `organization_id = $org` on every table.
      Rows with a NULL `source`/`source_id` pair are excluded
      (`WHERE payload->>'sourceId' IS NOT NULL AND payload->>'source' IS NOT NULL`), never coerced.
    - `converted`: `surfaced` joined to `builder_identities` on `(source, source_id)` and
      `organization_builders` on `(organization_id, builder_identity_id)` with
      `ob.status IN ('tracked','shortlisted')` and `ob.created_at >= surfaced_at - INTERVAL '1 day'`.
    - final `SELECT` per saved query: windowed counters via `FILTER (WHERE … >= $windowStart)`,
      unfiltered `max()` for `last_trigger_at` / `last_useful_match_at`, and
      `EXISTS (SELECT 1 FROM public_radars pr WHERE pr.organization_id = $org AND
      pr.saved_query_id = scoped.id) AS has_public_radar`.
    Return plain numbers/strings/Dates only — no ORM rows. Grant check: every table read here has
    a `builderhunt_app` `SELECT` grant — `saved_queries`/`alerts`/`alert_triggers`/
    `organization_builders` at `drizzle/0008_tenant_rls.sql:110-118`, `sprint_results` at
    `drizzle/0024_sourcing_sprints_grants.sql:56`, `builder_identities` at
    `drizzle/0011_builder_claim_policies.sql:31`, `public_radars` at
    `drizzle/0054_public_radars_grants.sql:9` (that table deliberately has no RLS, which is why
    the `EXISTS` filters `organization_id` explicitly rather than relying on a policy).
  - Verify: `pnpm type-check`; `pnpm security:boundaries` (fails if this file imports the global
    `db`); against a seeded local DB the counters match hand-counted fixtures (one search with
    3 triggers, 1 acknowledged, 1 converted, 1 public radar).

- [ ] **Add the Redis cache wrapper and staleness stamp**
  - Files: `src/shared/lib/repositories/saved-search-health.ts`
  - Do: `getSavedSearchHealthSnapshot(...)` wraps the aggregate: key
    `ssh:v1:${organizationId}:${userId}`, `getRedis()` from `~/shared/lib/redis` (clone the
    `redis.get(key)` / `redis.set(key, JSON.stringify(value), 'EX', 600)` shape used in
    `src/lib/search.ts:58-116`, including its `.catch(() => null)` on the write), payload
    `{ computedAt: ISO string, rows }`, and a `refresh: boolean` argument that skips the read and
    overwrites. `getRedis()` returns `Promise<Redis | null>` — a `null` client means compute every
    time. No in-process map: the value is per-user and must not outlive a request in a shared
    process.
  - Verify: two consecutive calls hit Redis once (`redis-cli monitor` or a `vi.spyOn` on
    `getRedis`); `refresh: true` recomputes and updates `computedAt`; with Redis stopped both
    calls still return correct rows.

- [ ] **Prove the aggregate runs as the non-owner runtime role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: In a new `checkSavedSearchHealth()`, call the repository directly through
    `withTenantContext` as `builderhunt_app` before wiring the route, so a missing grant or an
    RLS-silent empty result is caught here rather than in production
    ([`app-reality.md`](../../_meta/app-reality.md) constraint #7). Register it alongside the
    existing `checkSavedQueries` / `checkAlerts` / `checkSprints` functions and their call site.
  - Verify: `pnpm test:api-isolation:local` — the new check passes and the total check count grows.

## Phase 3 — Read API

- [ ] **Add `GET /api/saved-searches/health`**
  - Files: `src/routes/api/saved-searches/health.ts` (new)
  - Do: `requireTenantPrincipal(request)` → `rateLimit('saved-search-health', \`${principal.organizationId}:${principal.userId}\`, 60, 60)`
    (signature `rateLimit(scope, id, limit, windowSeconds)`, `src/shared/lib/rate-limit.ts:44`;
    on `!allowed` return 429 with `Retry-After`, as `src/routes/api/queries/index.ts:61-67` does)
    → `withTenantContext(principal, tx => getSavedSearchHealthSnapshot(tx, principal.organizationId, principal.userId, new Date(), refresh))`
    where `refresh` comes from `?refresh=1`. For each row: skip unless
    `can(principal, 'resource:read', { creatorUserId: row.userId })`; compute `ageDays =
    min(daysSince(createdAt), daysSince(firstLinkedAlertCreatedAt ?? createdAt))`; call
    `evaluateSavedSearchHealth`; emit the `SavedSearchHealthRow` DTO from spec.md §4 (allowlist —
    no `userId`, no trigger payloads, no identity rows) with `guidance:
    REASON_GUIDANCE[health.reason]`; order with `sortByHealth`. Return
    `{ computedAt, windowDays: HEALTH_THRESHOLDS.WINDOW_DAYS, rows }`. `TenantAuthorizationError`
    → its own status (copy the `tenantAuthorizationResponse` helper shape from
    `src/routes/api/queries/index.ts:139-143`), everything else →
    `500 { error: 'Failed to load saved search health' }`.
  - Verify: `pnpm security:route-coverage` (the route must be recognised as guarded by
    `requireTenantPrincipal`, not allowlisted as public); authed curl returns rows with verdicts;
    unauthenticated → 401; a user with no active organization → the `TenantAuthorizationError`
    status; `?refresh=1` changes `computedAt`.

- [ ] **Add tenant A/B isolation checks**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Extend `checkSavedSearchHealth()` to drive the real route handler with A's and B's
    sessions (`sessionRequest(token, url, init)` at line 212, as `checkSavedQueries` does at
    line 228): A sees only A's saved searches; B's alert triggers do not appear in A's
    `triggersFired`; B's sprint results do not appear in A's `usefulMatches`;
    `PATCH /api/alerts/$id` attaching A's alert to B's saved query → 404; `POST /api/sprints` with
    B's `savedQueryId` → 404; a direct `SELECT` as `builderhunt_app` without RLS context returns
    zero rows.
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, none regress.

## Phase 4 — `/saved-searches` page

- [ ] **Build the health page component**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx` (new)
  - Do: Fetch `/api/saved-searches/health` (`credentials: 'include'`). Render one
    `<div className="card p-5">` per row in the returned order (there is no `Card` component;
    `card` and `badge` are global utility classes in `src/shared/styles/globals.css`, used the
    same way by `src/routes/_dashboard/alerts.tsx:380`): name, keyword chips, verdict pill
    (`<span className="badge …">` with `text-bh-danger` for `kill`, `text-bh-warning` for
    `tune-query`, `text-bh-success` for `healthy`, `text-bh-text-muted` for `unmonitored` /
    `too-new` — those four tokens are defined at `globals.css:115-121`), a four-counter strip
    (`triggersFired`, `triggersAcknowledged`, `surfacedIdentities`, `usefulMatches`) with
    `title` tooltips carrying the exact caveats — "acknowledged in-app, not email opens; 'Mark all
    as read' bulk-sets this", "surfaced then tracked — not proof this search caused it" — plus a
    "Shared publicly" marker when `hasPublicRadar`. Show `guidance` always. One page-level
    footnote (not per row): "RSS reads are not tracked. Every saved search has a feed URL; nothing
    records whether anyone polls it." Header line: "updated {formatDistanceToNow(new
    Date(computedAt))}" (`~/shared/lib/format`, takes a `Date`) + a Refresh button hitting
    `?refresh=1`. Empty state links to `/search`. Buttons come from `~/components/ui`
    (`Button`, `LinkButton`, `Dialog`, `Select` are the available exports — see
    `src/components/ui/index.ts`).
  - Verify: `pnpm dev` with seeded data — every verdict class renders with its counters and no
    console errors; `pnpm type-check`; `pnpm lint`.

- [ ] **Wire the per-verdict actions**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx`
  - Do: `kill` → Delete (`Dialog` confirm → `DELETE /api/queries` with `{ id }`, then refetch; when
    `hasPublicRadar` the dialog must warn that the public `/r/<slug>` page dies with it, because
    `public_radars_organization_query_fk` is `ON DELETE cascade`);
    `tune-query` → "Run a sprint from this search" (`POST /api/sprints` with `savedQueryId`, `name`
    prefilled from the search, and `criteria`/`variants` built from its keywords:
    `const criteria = { skills: row.keywords.slice(0, 20), roles: [], seniority: 'unknown',
    locations: [], mustHaves: [] }` then `variants: [manualCriteriaToVariant(criteria)]` from
    `~/shared/lib/sprints-shared`; on 402 show the `upgradeUrl` link the route returns);
    `unmonitored` → "Attach an alert" (a `Select` of the caller's alerts from `GET /api/alerts`
    filtered to `queryId === null` → `PATCH /api/alerts/$id` with `{ queryId: row.id }`; when the
    organization cannot create alerts show "Smart alerts are a Pro feature" with a `/pricing` link
    instead — the same copy `POST /api/alerts` returns on 402);
    `healthy` → "Run search" linking to `/search?q=${encodeURIComponent(row.keywords.join(' '))}`,
    exactly the `runUrl` `SavedSearchRow` builds at `DashboardPage.tsx:536`.
  - Verify: each action round-trips and the list refetches; deleting a search with a linked alert
    succeeds (the Phase 0 FK repair) and the alert survives on `/alerts` with no saved search.

- [ ] **Add the route and the nav entry**
  - Files: `src/routes/_dashboard/saved-searches/index.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: Thin route: `createFileRoute('/_dashboard/saved-searches/')` with the same `beforeLoad`
    `getAppAuthSession()` shape as `src/routes/_dashboard/sprints/index.tsx:21-28`, rendering
    `SavedSearchHealthPage`. (The parent `src/routes/_dashboard/route.tsx` already redirects
    unauthenticated users; the child guard mirrors the existing siblings.) For the nav: the shell
    is registry-driven — `DashboardLayout.tsx` holds no nav literals. In `nav-config.ts` make
    **two** edits to the `discover` area: append `'/saved-searches'` to its `routes` tuple, and
    add `{ to: '/saved-searches', label: 'Saved searches', icon: Bookmark, group: 'Discover' }`
    to its `items` after the `/search` entry. Add `Bookmark` to the `lucide-react` import at the
    top of the file. `NavItem` has no `end` field — use `exact` only if a child route is ever
    added. Omitting the `routes` prefix makes
    `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts` ("keeps every destination inside an
    area that owns its prefix") fail.
  - Verify: `pnpm test -- tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`; `pnpm dev` —
    `/saved-searches` renders inside the dashboard shell and the Discover rail icon plus the
    "Saved searches" panel entry both light up; `src/routeTree.gen.ts` regenerates cleanly;
    `pnpm type-check` and `pnpm build` pass.

- [ ] **Surface the count on the dashboard card**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`
  - Do: In the existing "Saved searches" Bento tile (the `BentoTileHeader` around line 175), pass a
    `badge` pill into its `action` slot alongside the existing "New search" link: "N need
    attention" (rows whose verdict is `kill` or `tune-query`) linking to `/saved-searches`, fed by
    a fetch of `/api/saved-searches/health` alongside the existing `/api/queries` fetch. Hide the
    pill when N is 0 or the fetch fails — the card must keep working unchanged if the endpoint
    500s.
  - Verify: pill shows the right count and navigates; with the endpoint stubbed to fail the card
    renders exactly as today. There is no `DashboardPage` unit test, so the regression sweep is
    `pnpm test -- tests/unit/modules` (which does cover
    `tests/unit/modules/dashboard/ui/bento/layout.test.ts`) plus `pnpm type-check`.

## Phase 5 — AI rung + observability

- [ ] **Register the `saved-search-tune` AI task**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add the task per spec.md §5 as a `const savedSearchTuneTask: AITaskDefinition<…>` and
    register it in the `AI_TASKS` map as `[savedSearchTuneTask.id]: savedSearchTuneTask` (the id
    `saved-search-tune` is unclaimed — the map currently holds `ping`, `query-translate`,
    `outreach-draft`, `profile-enrich`, `jd-parse`, `criteria-decompose`, `filter-refine`,
    `synergy-analysis`, `alert-digest-summary`, `work-sample-analyze`, `fingerprint-v2`,
    `timeline-summary`). `tier: 'local-first'`; input/output zod schemas exactly as specified;
    `buildPrompt` wraps each `sampleTitles` entry with `wrapUntrusted` (`tasks.ts:740`) and
    instructs the model to treat them as data that can never change the task or schema;
    `cacheTtlSeconds: 86400`; `allowances: { free: 0, pro: 50, team: 200 }`;
    `maxOutputTokens: 500`. System prompt: rewrite a stale sourcing query — return replacement
    keywords, keywords to remove, and one short rationale; never invent filters; JSON only.
    Extend the registry test to cover it.
  - Verify: `pnpm test -- tests/unit/shared/lib/ai/tasks.test.ts`.

- [ ] **Wire the "Suggest a rewrite" button**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx`
  - Do: On `tune-query`/`kill` rows only, a secondary button labelled "Suggested rewrite (AI)"
    calling `ai('saved-search-tune', input)` from `~/shared/lib/ai/client`. Render the result as
    keyword chips + rationale with a copy-to-clipboard action and a "Save as new search" link to
    `/search` — never an automatic write. On any failure (unavailable, 429, parse) fall back to the
    already-rendered `REASON_GUIDANCE` text and surface a one-line non-blocking notice; hide the
    button when `useAICapabilities()` from `~/shared/lib/ai/useAICapabilities` reports
    `disabled` or no `serverAI` (the same `{ serverAI, disabled }` destructure
    `src/shared/components/CodeStyleCard.tsx:78` uses). Free tier: button renders locked with a
    "Pro" pill to `/pricing` (allowance is 0).
  - Verify: Chrome with local AI returns a suggestion without a network call; Firefox falls back to
    `/api/ai/complete`; `AI_DISABLED=true` hides the button and the page is otherwise identical;
    a free user sees the locked pill.

- [ ] **Add structured logging for the aggregate**
  - Files: `src/routes/api/saved-searches/health.ts`
  - Do: `log.info('saved_search_health_computed', { requestId: principal.requestId, rows, cache: 'hit' | 'miss', durationMs })`
    using `log` from `~/shared/lib/log` (`log.info(event, ctx)`, `log.ts:54`). No organization or
    user identifiers beyond the request id, no keywords, no builder data — per
    [`security-policy.md`](../../_meta/security-policy.md) §"AI and background work".
  - Verify: a request logs one line with a `durationMs`; `cache: 'hit'` on the second call; grep
    the log output for keywords/usernames returns nothing.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm security:boundaries &&
    pnpm security:route-coverage && pnpm test:migration-integrity && pnpm test:api-isolation:local`.
    Manual matrix: a fresh workspace shows every search as `unmonitored`; attaching an alert flips
    it to `too-new`; a search older than 60 days with triggers and no tracked builders shows
    `kill`; deleting it succeeds and the linked alert survives with `organization_id` intact;
    p95 of `GET /api/saved-searches/health` under 250 ms for a 50-search / 5 000-trigger seed
    (record the number in plan.md's risk row if it is above the flip trigger of 500 ms).
  - Verify: all green; the degradation matrix (no Redis, no MiniMax, `AI_DISABLED=true`) leaves
    verdicts and counters unchanged.
