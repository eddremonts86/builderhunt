# Saved Search Health (tasks)

> **Status**: `pending`
> **Depends on**: [`smart-alerts`](../../smart-alerts/tasks.md) (`alerts` / `alert_triggers` are the signal source); [`ai-sourcing-sprints`](../../ai-sourcing-sprints/tasks.md) (sprint results count as useful-match evidence). Both already have shipped code — see the reality check.
> **Blocks**: nothing
> **Reality check**: Touches existing `src/shared/lib/db/schema.ts`, `src/routes/api/alerts/index.ts`, `src/shared/lib/repositories/organization-alerts.ts`, `src/routes/api/sprints/index.ts`, `src/lib/sprints/service.ts`, `src/shared/lib/sprints-shared.ts`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `scripts/db/verify-api-isolation-local.mjs`. `/saved-searches` is a new route; `/alerts` (`src/routes/_dashboard/alerts.tsx`) is not modified.

Ordered so the app ships cleanly after every checkbox. Phase 0's FK repair must land before any
code writes `alerts.query_id`.

## Phase 0 — Attribution foundation

- [ ] **Record the data classification and authorization decision**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: No new table. Note that `sourcing_sprints.saved_query_id` and the now-live
    `alerts.query_id` are tenant-private relational references (class: **Tenant private**,
    ownership key `organization_id`), and that saved-search health is readable only by the saved
    search's creator via `can(principal, 'resource:read', { creatorUserId })` — `saved_queries`
    has no `visibility` column, so owner/admin get no extra reach.
  - Verify: both docs mention `saved_query_id` and the creator-only health read; no code change.

- [ ] **Make `schema.ts` model everything the migration will do that Drizzle can express**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Three edits, so the generated snapshot is truthful rather than a silent lie about the
    live database:
    1. `sourcingSprints`: add `savedQueryId: text('saved_query_id')` (nullable, **no**
       single-column `.references()` — the composite FK is the tenant-preserving one) plus
       `index('sourcing_sprints_saved_query_idx').on(table.organizationId, table.savedQueryId)`
       and `foreignKey({ columns: [table.organizationId, table.savedQueryId], foreignColumns: [savedQueries.organizationId, savedQueries.id], name: 'sourcing_sprints_organization_saved_query_fk' }).onDelete('set null')`
       in the extras array (same shape as `alerts_organization_query_fk`).
    2. `alerts`: change `queryId` to
       `text('query_id').references(() => savedQueries.id, { onDelete: 'set null' })` and add
       `.onDelete('set null')` to the `organizationQueryFk` `foreignKey({ … })` builder. Drizzle
       **can** express the action (`UpdateDeleteAction` in
       `node_modules/drizzle-orm/pg-core/foreign-keys.d.ts` includes `'set null'`) — it cannot
       express the column list; see the next task.
    3. `alertTriggers`: add
       `index('alert_triggers_org_alert_matched_idx').on(table.organizationId, table.alertId, table.matchedAt)`.
       Plain ascending on purpose: the health aggregate filters and groups, it never does an
       ordered scan, so no `.desc()` is needed and the index stays a stock construct drizzle-kit
       emits verbatim.
  - Verify: `pnpm type-check`; `pnpm db:generate` reports a diff containing the new column, the
    two index creations and both `alerts` FK recreations (and nothing else).

- [ ] **Generate the migration, hand-fix the one thing Drizzle cannot express, and mint its metadata**
  - Files: `drizzle/0046_saved_search_attribution.sql` (new — number/tag are illustrative; use the
    real next journal index), `drizzle/meta/_journal.json`, `drizzle/meta/0046_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate` (the whole diff comes from the previous task's `schema.ts` edits —
    this is *not* a `--custom` migration; only a grants/DDL-only migration with no schema
    counterpart is minted with `pnpm exec drizzle-kit generate --custom`). Rename the generated
    file to a descriptive tag and update the matching `_journal.json` entry, per this repo's
    existing rename convention. Then make exactly one hand-edit to the generated SQL — replacing
    drizzle-kit's whole-row `ON DELETE set null` on the composite FK with the column-scoped form:

    ```sql
    -- Deleting a saved search must not 500 once alerts.query_id is populated: both FKs are
    -- ON DELETE no action today (drizzle/0000_tranquil_hemingway.sql:261, drizzle/0003_tenant_expand.sql:17).
    ALTER TABLE "alerts" DROP CONSTRAINT "alerts_organization_query_fk";
    ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_query_fk"
      FOREIGN KEY ("organization_id","query_id")
      REFERENCES "public"."saved_queries"("organization_id","id")
      ON DELETE SET NULL ("query_id");  -- column list: a plain SET NULL would also null organization_id
    ```

    **Documented, deliberate divergence**: drizzle-orm 0.45.2's `UpdateDeleteAction` is a bare
    string union (`'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'`) with no
    column-list variant, so the snapshot will record this FK as an unqualified `set null` while the
    database has `set null (query_id)`. The snapshot therefore models a *more destructive* action
    than reality — write that reason into a comment directly above the hand-edited statement so
    the next person regenerating sees it. Everything else in the migration is generated, so this is
    the only divergence. No new RLS policy or GRANT: `alert_triggers`/`sourcing_sprints` already
    have FORCE RLS (`drizzle/0008_tenant_rls.sql`, `drizzle/0024_sourcing_sprints_grants.sql`) and
    grants are table-level, so the new column inherits them.
    Finally regenerate the hash manifest: `node scripts/db/verify-migration-integrity.mjs --write`
    (`scripts/db/verify-migration-integrity.mjs` hard-fails unless the `.sql` set, the journal tags
    and the `NNNN_snapshot.json` set match exactly and the manifest is current —
    `0045_user_devices_worker_read_grant` shipped without its snapshot and turned
    `migration-integrity.test.ts` red).
  - Verify: `pnpm db:migrate` on a fresh DB **first**, then `pnpm exec drizzle-kit check`,
    `pnpm test:migration-integrity`, and `pnpm db:generate` again reporting "No schema changes".
    `\d alerts` shows `alerts_query_id_saved_queries_id_fk` as `ON DELETE SET NULL` and
    `alerts_organization_query_fk` as `ON DELETE SET NULL (query_id)`; insert a saved query + an
    alert with `query_id`, delete the saved query, and confirm the alert survives with
    `query_id IS NULL` **and** `organization_id` unchanged.

- [ ] **Accept and persist `queryId` on alert creation**
  - Files: `src/shared/lib/repositories/organization-alerts.ts`, `src/routes/api/alerts/index.ts`
  - Do: Add `queryId?: string | null` to `CreateOrganizationAlertInput` and pass it through
    `createOrganizationAlert`. Add `queryId: z.string().min(1).optional()` to `CreateBody`. Before
    insert, inside the same `withTenantContext` transaction, verify the saved query belongs to the
    active organization **and** to `principal.userId` (reuse `listLegacySavedQueries` or a new
    `findSavedQuery(tx, organizationId, userId, id)` in
    `src/shared/lib/repositories/saved-queries.ts`); on failure return
    `404 { error: 'Saved search not found' }` — never a distinguishable "exists but not yours".
  - Verify: `pnpm test organization-alerts`; authed `curl -X POST /api/alerts` with a valid
    `queryId` returns the alert with `queryId` set; with another organization's id returns 404.

- [ ] **Add `PATCH /api/alerts` to attach/detach a saved search**
  - Files: `src/routes/api/alerts/index.ts`, `src/shared/lib/repositories/organization-alerts.ts`
  - Do: Body `z.object({ id: z.string().min(1), queryId: z.string().min(1).nullable() }).strict()`.
    New repository function `setOrganizationAlertQuery(tx, organizationId, alertId, queryId)` →
    `UPDATE alerts SET query_id = $queryId WHERE organization_id = $org AND id = $alertId`,
    returning a boolean. Same ownership pre-check as the create path; 404 when either id misses.
  - Verify: `pnpm test organization-alerts`; attach then detach round-trips; attaching another
    organization's alert or saved query returns 404.

- [ ] **Accept `savedQueryId` on sprint creation**
  - Files: `src/shared/lib/sprints-shared.ts`, `src/lib/sprints/service.ts`, `src/routes/api/sprints/index.ts`
  - Do: Add `savedQueryId: z.string().min(1).optional()` to `createSprintSchema` (it is `.strict()`),
    thread it into `createSprint`'s `insert(...).values({ … savedQueryId: input.savedQueryId ?? null })`,
    add `savedQueryId: string | null` to `SprintRecord` + `toRecord`. In the route, validate the
    saved query is the caller's own (same helper as the alert path) before create; 404 otherwise.
  - Verify: `pnpm type-check`; `curl -X POST /api/sprints` with `savedQueryId` returns a sprint
    whose `savedQueryId` matches; unknown/foreign id returns 404.

## Phase 1 — Pure health library

- [ ] **Write the pure health module**
  - Files: `src/shared/lib/saved-search-health.ts` (new)
  - Do: Export `HEALTH_THRESHOLDS` (`WINDOW_DAYS: 30`, `MIN_AGE_DAYS: 14`, `DEAD_AGE_DAYS: 60`,
    `NOISE_FLOOR: 20`, `LOW_ACK_RATE: 0.2`, `USEFUL_TARGET: 3`, `RECENCY_HALF_LIFE_DAYS: 60`),
    `HEALTH_REASONS` (the 9 reason codes from spec.md §2), `REASON_GUIDANCE:
    Record<SavedSearchHealthReason, string>` (static one-line copy per reason — the non-AI
    fallback), `evaluateSavedSearchHealth(input: SavedSearchHealthInput): SavedSearchHealth`
    implementing the 9-rule table top-to-bottom with first-match-wins, `healthScore(input)`
    (the 40/30/30 formula, `null` for `unmonitored`/`too-new`), and
    `sortByHealth<T extends { health; metrics; name; id }>(rows): T[]` (score asc nulls last →
    `daysSinceLastTrigger` asc nulls last → `name` → `id`). No imports from `db/`, no I/O, no
    `Date.now()` — `ageDays`/`daysSince*` arrive as numbers from the caller.
  - Verify: `pnpm type-check`; the module's import list contains only `zod` (if used) and nothing
    from `~/shared/lib/db`.

- [ ] **Test every verdict rule and boundary**
  - Files: `src/shared/lib/saved-search-health.test.ts` (new)
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
        `ageDays: 59` never yields `kill`.
    11. Monotonicity: increasing `usefulMatches` never lowers `score`; increasing
        `daysSinceLastUsefulMatch` never raises it.
    12. Determinism: the same input evaluated twice deep-equals; no `Date`/`Math.random` usage
        (assert by calling with a frozen input object).
    13. `sortByHealth`: kill/tune before healthy, `null` scores last, ties broken by name then id;
        sorting an already-sorted list is a no-op.
    14. `REASON_GUIDANCE` has a non-empty entry for every member of `HEALTH_REASONS`.
  - Verify: `pnpm test saved-search-health`.

## Phase 2 — Aggregation repository

- [ ] **Write the health aggregate repository**
  - Files: `src/shared/lib/repositories/saved-search-health.ts` (new)
  - Do: `loadSavedSearchHealthRows(transaction: TenantTransaction, organizationId: string,
    userId: string, now: Date)` — one `transaction.execute(sql\`…\`)` with the CTE chain from
    spec.md §1/§3: `scoped` (`saved_queries` filtered by **both** `organization_id` and `user_id`),
    `linked_alerts` (`count`, `count(*) FILTER (WHERE enabled)`, `min(created_at)` for the
    `ageDays` clamp), `surfaced` = triggers of linked alerts
    (`payload->>'source'`, `payload->>'sourceId'`, `matched_at`, `read_at IS NOT NULL`) `UNION ALL`
    `sprint_results` of sprints with a matching `saved_query_id`, both **unwindowed** and both
    with `organization_id = $org` on every table; `converted` = `surfaced` joined to
    `builder_identities` on `(source, source_id)` and `organization_builders` on
    `(organization_id, builder_identity_id)` with `status IN ('tracked','shortlisted')` and
    `ob.created_at >= surfaced_at - INTERVAL '1 day'`; final `SELECT` per saved query with
    `FILTER (WHERE … >= $windowStart)` for windowed counters and unfiltered `max()` for
    `last_trigger_at` / `last_useful_match_at`. Rows with a NULL `source`/`source_id` pair are
    excluded from `surfaced` (`WHERE payload->>'sourceId' IS NOT NULL`), never coerced. Never
    import the global `db`; return plain numbers/Dates only.
  - Verify: `pnpm type-check`; against a seeded local DB the counters match hand-counted fixtures
    (one search with 3 triggers, 1 acknowledged, 1 converted).

- [ ] **Add the Redis cache wrapper and staleness stamp**
  - Files: `src/shared/lib/repositories/saved-search-health.ts`
  - Do: `getSavedSearchHealthSnapshot(...)` wraps the aggregate: key
    `ssh:v1:${organizationId}:${userId}`, `getRedis()` from `~/shared/lib/redis` (clone the
    get/`set(..., 'EX', 600)` shape used in `src/lib/search.ts`), payload
    `{ computedAt: ISO string, rows }`, and a `refresh: boolean` argument that skips the read and
    overwrites. Missing Redis → compute every time (no in-process map: the value is per-user and
    must not outlive a request in a shared process).
  - Verify: two consecutive calls hit Redis once (`redis-cli monitor` or a `vi.spyOn`);
    `refresh: true` recomputes and updates `computedAt`.

- [ ] **Prove the aggregate runs as the non-owner runtime role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: In a new `checkSavedSearchHealth()`, call the repository directly through
    `withTenantContext` as `builderhunt_app` before wiring the route, so a missing grant or an
    RLS-silent empty result is caught here rather than in production (app-reality constraint #7).
  - Verify: `pnpm test:api-isolation:local` — the new check passes and the total check count grows.

## Phase 3 — Read API

- [ ] **Add `GET /api/saved-searches/health`**
  - Files: `src/routes/api/saved-searches/health.ts` (new)
  - Do: `requireTenantPrincipal(request)` → `rateLimit('saved-search-health', \`${principal.organizationId}:${principal.userId}\`, 60, 60)`
    → `withTenantContext(principal, tx => getSavedSearchHealthSnapshot(tx, principal.organizationId, principal.userId, new Date(), refresh))`
    where `refresh` comes from `?refresh=1`. For each row: skip unless
    `can(principal, 'resource:read', { creatorUserId: row.userId })`; compute `ageDays =
    min(daysSince(createdAt), daysSince(firstLinkedAlertCreatedAt ?? createdAt))`; call
    `evaluateSavedSearchHealth`; emit the `SavedSearchHealthRow` DTO from spec.md §4 (allowlist —
    no `userId`, no trigger payloads, no identity rows) with `guidance:
    REASON_GUIDANCE[health.reason]`; order with `sortByHealth`. Return
    `{ computedAt, windowDays: HEALTH_THRESHOLDS.WINDOW_DAYS, rows }`. `TenantAuthorizationError`
    → its own status, everything else → `500 { error: 'Failed to load saved search health' }`.
  - Verify: authed curl returns rows with verdicts; unauthenticated → 401; a user with no active
    organization → the `TenantAuthorizationError` status; `?refresh=1` changes `computedAt`.

- [ ] **Add tenant A/B isolation checks**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Extend `checkSavedSearchHealth()` to drive the real route handler with A's and B's
    sessions (`sessionRequest`, as `checkSavedQueries` does): A sees only A's saved searches;
    B's alert triggers do not appear in A's `triggersFired`; B's sprint results do not appear in
    A's `usefulMatches`; `PATCH /api/alerts` attaching A's alert to B's saved query → 404;
    `POST /api/sprints` with B's `savedQueryId` → 404; a direct `SELECT` as `builderhunt_app`
    without RLS context returns zero rows.
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, none regress.

## Phase 4 — `/saved-searches` page

- [ ] **Build the health page component**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx` (new)
  - Do: Fetch `/api/saved-searches/health` (`credentials: 'include'`). Render one `card` per row in
    the returned order: name, keyword chips, verdict pill (`kill` → `badge` danger, `tune-query` →
    warning, `healthy` → success, `unmonitored`/`too-new` → neutral), a four-counter strip
    (`triggersFired`, `triggersAcknowledged`, `surfacedIdentities`, `usefulMatches`) with
    `title` tooltips carrying the exact caveats — "acknowledged in-app, not email opens; 'Mark all
    as read' bulk-sets this", "surfaced then tracked — not proof this search caused it" — plus
    "RSS activity is not tracked" when `hasFeed`. Show `guidance` always. Header line: "updated
    {formatDistanceToNow(computedAt)}" + a Refresh button hitting `?refresh=1`. Empty state links
    to `/search`. Use `~/components/ui` primitives and `formatDistanceToNow` from
    `~/shared/lib/format`, matching `src/routes/_dashboard/alerts.tsx`.
  - Verify: with seeded data every verdict class renders with its counters; no console errors.

- [ ] **Wire the per-verdict actions**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx`
  - Do: `kill` → Delete (confirm dialog → `DELETE /api/queries` with `{ id }`, then refetch);
    `tune-query` → "Run a sprint from this search" (`POST /api/sprints` with `savedQueryId`, name
    prefilled from the search, `criteria`/`variants` built from its keywords via
    `manualCriteriaToVariant` in `~/shared/lib/sprints-shared`; on 402 show the upgrade link);
    `unmonitored` → "Attach an alert" (a `Select` of the caller's alerts from `GET /api/alerts`
    filtered to `queryId === null` → `PATCH /api/alerts`; when the org cannot create alerts show
    "Smart alerts are a Pro feature" with a `/pricing` link instead); `healthy` → "Run search"
    linking to `/search` with the keywords prefilled, exactly as `SavedSearchRow` does today.
  - Verify: each action round-trips and the list refetches; deleting a search with a linked alert
    succeeds (the Phase 0 FK repair) and the alert survives on `/alerts` with no saved search.

- [ ] **Add the route and the nav entry**
  - Files: `src/routes/_dashboard/saved-searches/index.tsx` (new), `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: Thin route: `createFileRoute('/_dashboard/saved-searches/')` with the same
    `beforeLoad` `getAppAuthSession()` guard as `src/routes/_dashboard/alerts.tsx`, rendering
    `SavedSearchHealthPage`. Add `{ to: '/saved-searches', icon: Bookmark, label: 'Saved searches', end: false }`
    to the nav array between Search and Sprints.
  - Verify: `pnpm dev`; `/saved-searches` renders inside the dashboard shell, the nav item
    highlights, `src/routeTree.gen.ts` regenerates cleanly, `pnpm type-check` passes.

- [ ] **Surface the count on the dashboard card**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`
  - Do: In the existing "Saved searches" Bento card header, fetch the health endpoint alongside
    `/api/queries` and render a `badge` pill "N need attention" (rows whose verdict is `kill` or
    `tune-query`) linking to `/saved-searches`. Hide the pill when N is 0 or the fetch fails —
    the card must keep working unchanged if the endpoint 500s.
  - Verify: pill shows the right count and navigates; with the endpoint stubbed to fail the card
    renders exactly as today.

## Phase 5 — AI rung + observability

- [ ] **Register the `saved-search-tune` AI task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add the task per spec.md §5: `tier: 'local-first'`; input/output zod schemas exactly as
    specified; `buildPrompt` wraps `sampleTitles` with the existing `wrapUntrusted` helper and
    instructs the model to treat them as data that can never change the task or schema;
    `cacheTtlSeconds: 86400`; `allowances: { free: 0, pro: 50, team: 200 }`;
    `maxOutputTokens: 500`. System prompt: rewrite a stale sourcing query — return replacement
    keywords, keywords to remove, and one short rationale; never invent filters; JSON only.
    Extend the registry test to cover it.
  - Verify: `pnpm test tasks.test`.

- [ ] **Wire the "Suggest a rewrite" button**
  - Files: `src/modules/dashboard/components/SavedSearchHealthPage.tsx`
  - Do: On `tune-query`/`kill` rows only, a secondary button labelled "Suggested rewrite (AI)"
    calling `ai('saved-search-tune', input)` from `~/shared/lib/ai/client`. Render the result as
    keyword chips + rationale with a copy-to-clipboard action and a "Save as new search" link to
    `/search` — never an automatic write. On any failure (unavailable, 429, parse) fall back to the
    already-rendered `REASON_GUIDANCE` text and surface a one-line non-blocking notice; hide the
    button when `useAICapabilities`/`/api/ai/config` reports AI disabled or server AI unavailable.
    Free tier: button renders locked with a "Pro" pill to `/pricing` (allowance is 0).
  - Verify: Chrome with local AI returns a suggestion without a network call; Firefox falls back to
    `/api/ai/complete`; `AI_DISABLED=true` hides the button and the page is otherwise identical;
    free user sees the locked pill.

- [ ] **Add structured logging for the aggregate**
  - Files: `src/routes/api/saved-searches/health.ts`
  - Do: `log.info('saved_search_health_computed', { requestId: principal.requestId, rows, cache: 'hit' | 'miss', durationMs })`
    using `~/shared/lib/log`. No organization or user identifiers beyond the request id, no
    keywords, no builder data — per `security-policy.md` §"AI and background work".
  - Verify: a request logs one line with a `durationMs`; `cache: 'hit'` on the second call; grep
    the log output for keywords/usernames returns nothing.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm lint && pnpm type-check && pnpm test && pnpm test:api-isolation:local`. Manual
    matrix: a fresh workspace shows every search as `unmonitored`; attaching an alert flips it to
    `too-new`; a search older than 60 days with triggers and no tracked builders shows `kill`;
    deleting it succeeds and the linked alert survives; p95 of `GET /api/saved-searches/health`
    under 250 ms for a 50-search / 5 000-trigger seed (record the number in plan.md's risk row if
    it is above the flip trigger of 500 ms).
  - Verify: all green; the degradation matrix (no Redis, no MiniMax, `AI_DISABLED`) leaves
    verdicts and counters unchanged.
