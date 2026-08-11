# Hiring Pipeline Kanban (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../implemented/phase-1/01-security-and-multitenancy/spec.md) (tenant-private `organization_builders` ownership, RLS, tenant principal — all shipped; that plan stays `in_progress` only for the legacy-column contraction, which this one does not touch, so nothing here waits on it); [`team-accounts`](../../implemented/phase-1/27-team-accounts/spec.md) (organization roles and seats — already implemented). Enhanced by [`activity-feed`](../../implemented/phase-1/29-activity-feed/spec.md) (stage-change events; not required).
> **Blocks**: [`ats-integrations`](../ats-integrations/spec.md) (hard — the ATS sync maps its external status back onto this plan's stage model)
> **Reality check**: `organization_builders` already exists (`src/shared/lib/db/schema.ts:240`) with a dead `status` check constraint nothing reads; tenant notes already exist (`builder_notes` + `src/routes/api/builders/$builderId/notes.ts`); there is no `/me/builders` page, only `GET /api/me/builders` consumed by `src/modules/dashboard/components/ExportsPage.tsx`; dashboard navigation is `src/modules/dashboard/ui/shell/nav-config.ts`'s `NAV_AREAS`, not a flat array in `DashboardLayout.tsx`.

Ordered so the app ships cleanly after every checkbox.

**Migration numbering — read this before Phase 1.** No task below names a migration number, on
purpose. `drizzle/meta/_journal.json` is the only source of truth for the next index, and it moves:
it held 46 entries when this plan was written and 86 on 2026-07-27, two of them uncommitted
working-tree files. Every migration task starts by letting `drizzle-kit` assign the index, then
records whatever it produced. Every hand-written migration is minted with
`pnpm exec drizzle-kit generate --custom --name <name>` so the journal entry **and**
`drizzle/meta/NNNN_snapshot.json` both exist; `scripts/db/verify-migration-integrity.mjs:12-15`
compares the journal against both file sets before hashing anything, so a grants-only migration
without a snapshot turns `pnpm test:migration-integrity` red. Generated (non-custom) migrations use
`pnpm exec drizzle-kit generate --name <name>` so the tag is meaningful from the start and no
post-hoc rename of the file + journal tag is needed.

**Test layout.** There are zero co-located test files under `src/`. `vitest.config.ts` includes only
`tests/unit/**/*.{test,spec}.{ts,tsx}`, mirroring the `src/` tree; Playwright specs live in
`tests/e2e/`. `pnpm test -- <path>` filters, but the path must be under `tests/`.

## Phase 1 — Schema, RLS, backfill

- [ ] **Add the two pipeline tables to the schema**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `organizationPipelineStages` and `organizationBuilderStageEvents` exactly per
    spec.md §Architecture — composite `primaryKey({ columns: [organizationId, key] })`, the
    non-unique `(organization_id, position)` index, the `key ~ '^[a-z0-9_]{1,32}$'` and
    `stale_after_days between 1 and 365` checks, the events table's composite
    `(organization_id, organization_builder_id) → organization_builders(organization_id, id)` FK
    with `onDelete('cascade')`, and the `source in ('ui','automation','ats','import','backfill')`
    check. No FK on `from_stage`/`to_stage`.
    Two import-level details, both verified against HEAD: `primaryKey` is **not** currently
    imported in `schema.ts` (line 2's `drizzle-orm/pg-core` list has `pgTable, text, timestamp,
    boolean, integer, jsonb, unique, uniqueIndex, uuid, index, check, foreignKey, vector, time,
    date`) and there is no composite `primaryKey({ columns: … })` anywhere in the file yet — this
    is the schema's first, so add `primaryKey` to that import and expect no local precedent to
    copy. The regex `check(...)` form has precedent: `schema.ts:2385` uses
    ``sql`${table.sha256} ~ '^[a-f0-9]{64}$'` ``.
  - Verify: `pnpm type-check` (a missing `primaryKey` import fails here, not at runtime).

- [ ] **Add the four additive columns and their composite FKs**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: On `organizationBuilders` add nullable `pipelineStage`, `pipelineStageChangedAt`,
    `pipelineOwnerUserId` (`references(authUsers.id, { onDelete: 'restrict' })`), plus
    `foreignKey([organizationId, pipelineStage] → organizationPipelineStages[organizationId, key])`
    `.onDelete('restrict')`, `index('organization_builders_org_stage_changed_idx')` on
    `(organizationId, pipelineStage, pipelineStageChangedAt)` and
    `index('organization_builders_org_owner_idx')` on `(organizationId, pipelineOwnerUserId)`. On
    `builderNotes` add nullable `pipelineStageKey` with the same composite FK, `.onDelete('set null')`.
    Do **not** touch `status`, its check constraint, or legacy `builders`.
  - Verify: `pnpm type-check`; `pnpm exec drizzle-kit check` passes.

- [ ] **Generate the DDL migration**
  - Files: `drizzle/<next>_pipeline_kanban.sql` (new, generated), `drizzle/meta/<next>_snapshot.json` (new, generated), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: Read the current head first — `node -p "require('./drizzle/meta/_journal.json').entries.at(-1).tag"`
    — and note that `drizzle/` may contain uncommitted migration files that are nonetheless in the
    journal; never assume the head. Then run
    `pnpm exec drizzle-kit generate --name pipeline_kanban`, which assigns the next index itself and
    writes the SQL, the snapshot, and the journal entry together (no rename needed — that is why
    `--name` is used instead of bare `pnpm db:generate`). Regenerate the hash manifest with
    `node scripts/db/verify-migration-integrity.mjs --write`. Read the emitted SQL and confirm it
    contains no DROP, no rename, and no table rewrite — only `CREATE TABLE`,
    `ALTER TABLE ... ADD COLUMN`, FKs, and indexes.
  - Verify: `pnpm db:migrate` on a fresh DB succeeds; `\d organization_builders` shows the three
    new nullable columns and both new indexes; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` both pass (the last prints `{"valid":true,"migrations":N}` with
    `N` equal to the journal length).

- [ ] **Hand-write the RLS + grants migration**
  - Files: `drizzle/<next>_pipeline_rls_grants.sql` (new), `drizzle/meta/<next>_snapshot.json` (new), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: Mint the file with `pnpm exec drizzle-kit generate --custom --name pipeline_rls_grants` so
    the journal entry **and** the snapshot exist — `scripts/db/verify-migration-integrity.mjs:12-15`
    fails unless the SQL set, the journal, and `drizzle/meta/NNNN_snapshot.json` agree exactly, and
    grants-only migrations are not exempt (`0045` shipped without a snapshot and turned that test
    red). Then mirror `drizzle/0044_abuse_usage_integrity_rls_grants.sql`. Both new tables are
    **tenant-private**: `ENABLE`/`FORCE ROW LEVEL SECURITY`, then per-verb policies
    `USING/WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''))`
    for `builderhunt_app` (SELECT/INSERT/UPDATE on both; DELETE on
    `organization_pipeline_stages` only — the events table is append-only, so no app DELETE
    policy and no DELETE grant). `builderhunt_worker`: SELECT on both (digest reads) with the same
    org-scoped policy. `builderhunt_platform`, `builderhunt_auth`, `builderhunt_capability`,
    `builderhunt_readonly`: nothing — say so in the head comment so the omission reads as a
    decision rather than an oversight (`builderhunt_capability` was created by
    `drizzle/0078_capability_role.sql` and did not exist when this plan was written).
    **Also add the one grant the digest worker is otherwise missing** (see the Phase 6 tier-read
    task): a `builderhunt_worker` org-scoped SELECT policy on `organization_entitlements` plus
    `GRANT SELECT (organization_id, tier, status, seat_limit) ON TABLE organization_entitlements TO builderhunt_worker;`
    — column-scoped, matching `0010_worker_alert_policies.sql:25`'s `GRANT SELECT (id)` style.
    `drizzle/0008_tenant_rls.sql:45,108` grants that table to `builderhunt_app` only, and
    `0010` (the full worker grant set) omits it entirely; nothing between `0011` and the current
    head adds it — re-verify with
    `grep -rn "TO builderhunt_worker" drizzle/*.sql | grep -i "organization_entitlements"`
    returning nothing before writing the grant.
    Do **not** add a worker grant on `organization_builders`: `drizzle/0018_enrichment_worker_target_access.sql:6-12`
    already ships `organization_builders_worker_select` plus a table-level
    `GRANT SELECT ON TABLE organization_builders TO builderhunt_worker`, and table-level grants
    cover columns added later. Likewise no new grant on `builder_notes` — `0008` already grants the
    app role all four verbs on it at the table level.
    Then `REVOKE ALL ... FROM PUBLIC` and explicit `GRANT`s; no `TRUNCATE`, no `REFERENCES`.
    Head-comment the data class and role split, as `0044` does.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local` and `pnpm test:migration-integrity` pass;
    `psql -U builderhunt_app -c "select * from organization_pipeline_stages"` with no
    `app.organization_id` set returns 0 rows (not an error, not data); the same query as
    `builderhunt_worker` with `app.organization_id` set to one org returns only that org's stages;
    `psql -U builderhunt_worker -c "select tier from organization_entitlements"` succeeds instead
    of `42501`; `psql -U builderhunt_app -c "delete from organization_builder_stage_events"`
    fails with `42501` (append-only is enforced by the absent grant, not by convention).

- [ ] **Hand-write the idempotent stage seed + backfill migration**
  - Files: `drizzle/<next>_pipeline_default_stage_backfill.sql` (new), `drizzle/meta/<next>_snapshot.json` (new), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: Mint with `pnpm exec drizzle-kit generate --custom --name pipeline_default_stage_backfill`
    (same snapshot/journal requirement as above). Two ordered, re-runnable steps in one file.
    (1) For every row in `organizations`, insert
    the five defaults `('new','New',0)`, `('reviewed','Reviewed',1)`, `('contacted','Contacted',2)`,
    `('in_conversation','In conversation',3)`, `('hired','Hired',4,is_terminal=true)` with
    `ON CONFLICT (organization_id, key) DO NOTHING`. (2) A `DO` block looping in 5000-row batches:
    `UPDATE organization_builders SET pipeline_stage = CASE WHEN status = 'shortlisted' THEN 'reviewed' ELSE 'new' END, pipeline_stage_changed_at = coalesce(pipeline_stage_changed_at, created_at) WHERE pipeline_stage IS NULL` (batched by `ctid`/`id`), raising a `NOTICE` with the migrated/remaining counts per batch. Never writes `status`.
    Stage seeding **must** precede the update or the composite FK rejects every row.
  - Verify: `pnpm db:migrate` twice in a row — second run reports 0 migrated, 0 conflicts;
    `select count(*) from organization_builders where pipeline_stage is null` = 0;
    `select count(*) from organization_builders where status = 'shortlisted' and pipeline_stage <> 'reviewed'` = 0;
    `pnpm test:migration-integrity` passes.

- [ ] **Register both tables in the architecture docs**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Add `organization_pipeline_stages` and `organization_builder_stage_events` rows to the
    table in `data-classification.md` (same five columns as the existing
    `organization_builders` row at line 22) — class `tenant-private`, owner `organization_id`,
    public fields `none`, retention "organization lifetime (events append-only, no pruning)".
    While in that file, correct the `builder_notes` row (line 29), which still reads
    "currently `user_id`; target `organization_id`": `drizzle/0081_wakeful_butterfly.sql` made
    `builder_notes.organization_id` `NOT NULL`, so the owner is now unambiguously
    `organization_id`. In `authorization-matrix.md`, add two rows to the "Product actions" table
    (which is keyed by prose action name across the six principal columns, not by
    `PermissionAction` literal): "Move a pipeline card / reassign its owner" —
    deny/allow/allow/allow/deny by default/deny; and "Configure pipeline stages" —
    deny/deny/allow/allow/deny by default/deny. Name the two `PermissionAction` literals in the
    cell text so the doc and `permissions.ts` are greppable against each other.
  - Verify: `grep -n "organization_pipeline_stages\|organization_builder_stage_events" docs/architecture/data-classification.md`
    returns two rows; `grep -n "pipeline:" docs/architecture/authorization-matrix.md` returns the
    two new actions. No code change.

## Phase 2 — Pure stage/staleness lib + permissions

- [ ] **Build the pure stage module**
  - Files: `src/shared/lib/pipeline/stages.ts` (new)
  - Do: Export `DEFAULT_PIPELINE_STAGES` (the five above, same keys/labels/positions as the
    migration — single source of truth for `ensureDefaultPipelineStages`), `PIPELINE_MAX_STAGES = 12`,
    `PIPELINE_COLUMN_PAGE_SIZE = 25`, `normalizeStageKey(label)` (lowercase, `_`-joined, stripped
    to `[a-z0-9_]`, ≤ 32 chars, non-empty), `validateStageSet(stages, maxStages)` (≥ 2 stages,
    ≤ maxStages, ≥ 1 non-terminal, unique keys, contiguous positions from 0),
    `reorderStages(stages, orderedKeys)`, and `resolveStageForCard(pipelineStage, stages)`
    (NULL → the `position: 0` stage). Pure — no imports from `db` or `env`.
  - Verify: `pnpm type-check`.

- [ ] **Test the stage module**
  - Files: `tests/unit/shared/lib/pipeline/stages.test.ts` (new)
  - Do: `normalizeStageKey('In Conversation!')` → `in_conversation`; empty/emoji-only label throws;
    `validateStageSet` rejects 1 stage, 13 stages, duplicate keys, all-terminal sets, and gaps in
    `position`; `reorderStages` with an unknown or missing key throws rather than dropping a stage;
    `resolveStageForCard(null, ...)` returns the position-0 stage.
  - Verify: `pnpm test -- tests/unit/shared/lib/pipeline/stages.test.ts`.

- [ ] **Build and test the staleness module**
  - Files: `src/shared/lib/pipeline/staleness.ts` (new), `tests/unit/shared/lib/pipeline/staleness.test.ts` (new)
  - Do: `daysInStage({ changedAt, createdAt, now })` (falls back to `createdAt` when
    `changedAt` is null, floor of whole days, never negative) and
    `isStale({ stage, changedAt, createdAt, now })` (false when `stage.isTerminal` or
    `stage.staleAfterDays == null`, else `daysInStage >= staleAfterDays`). Tests cover the
    terminal-stage exemption, the null-SLA exemption, the null-`changedAt` fallback, and an
    exact-boundary day.
  - Verify: `pnpm test -- tests/unit/shared/lib/pipeline/staleness.test.ts`.

- [ ] **Add the tier limits and capability resolver**
  - Files: `src/shared/lib/billing-shared.ts`, `src/shared/lib/pipeline/entitlement.ts` (new), `tests/unit/shared/lib/pipeline/entitlement.test.ts` (new)
  - Do: Add
    `export const PIPELINE_STAGE_LIMITS: Record<OrganizationTier, number> = { free: 5, pro: 8, pro_max: 12, team: 12 }`
    beside `SOURCING_SPRINT_LIMITS`. **`OrganizationTier`, not `PlanTier`** — the doc comment above
    `SOURCING_SPRINT_LIMITS` (`billing-shared.ts:44-53`) records that keying an advertised
    allowance by `PlanTier` forced enforcement through `resolveLegacyPlanTier` and let `/pricing`
    and the routes drift apart by 7 sprints. This cap is advertised (the free board renders a Pro
    pill linking to `/pricing`), so it is indexed by `entitlement.tier` directly and carries its own
    `pro_max` row. Copy that reasoning into the new doc comment. Then add
    `pipelineCapabilities(entitlement: EntitlementPolicy)` exactly per spec.md §Tier gating —
    importing `EntitlementPolicy` from `~/shared/lib/repositories/entitlements` — including the
    comment explaining why `canSetStageSla`/`staleDigest` compare the raw tier to `'team'` rather
    than going through `resolveLegacyPlanTier`. Tests: free → `canCustomizeStages: false`,
    `maxStages: 5`; pro → 8/true/false; `pro_max` → `maxStages: 12`, `canCustomizeStages: true`,
    `canSetStageSla: false`, `staleDigest: false`; team → 12/true/true;
    `paidActionsAllowed: false` → both write capabilities false while `maxStages` is unchanged.
  - Verify: `pnpm test -- tests/unit/shared/lib/pipeline/entitlement.test.ts`; `pnpm type-check`
    (the `Record<OrganizationTier, …>` shape makes a missing `pro_max` row a compile error).

- [ ] **Add the two permission actions**
  - Files: `src/shared/lib/authorization/permissions.ts`, `tests/unit/shared/lib/authorization/permissions.test.ts`
  - Do: Confirm both names are still unclaimed first
    (`grep -n "pipeline:" src/shared/lib/authorization/permissions.ts` returns nothing at HEAD).
    Add `'pipeline:move'` (returns `true` for every role — comment the justification from
    spec.md §Permissions) and `'pipeline:configure'` to the `PermissionAction` union and to the
    `can()` switch. `pipeline:configure` joins the existing `elevated` arm alongside
    `'organization:update'`/`'organization:invite'`/`'resource:export'`; `pipeline:move` joins the
    unconditional `return true` arm alongside `'organization:read'`/`'resource:create'`. The switch
    is exhaustive with no `default`, so a missing case is a type error rather than a silent allow.
    Extend `tests/unit/shared/lib/authorization/permissions.test.ts` with all three roles × both
    actions (6 assertions).
  - Verify: `pnpm test -- tests/unit/shared/lib/authorization/permissions.test.ts`;
    `pnpm security:boundaries` still passes (it fails the build on any new file comparing
    `.role` against a role literal — these two actions exist so the pipeline routes never need to).

## Phase 3 — Tenant repository

- [ ] **Build the pipeline repository**
  - Files: `src/shared/lib/repositories/pipeline.ts` (new)
  - Do: Every function takes `TenantTransaction` first and filters on `organizationId`; never
    import the global `db`. `ensureDefaultPipelineStages(tx, orgId)` inserts
    `DEFAULT_PIPELINE_STAGES` with `onConflictDoNothing`. `listStages`, `createStage`,
    `updateStage` (label/isTerminal/staleAfterDays only — `key` is immutable),
    `deleteStage(tx, orgId, key, reassignTo)` (counts cards first; reassigns and writes one event
    per moved card, then deletes the stage row), `reorderStages` (one `UPDATE ... FROM (VALUES ...)`
    statement over the whole set). `loadBoard(tx, orgId, { stage?, ownerUserId? })` = the window
    query from spec.md §Scale. `loadStagePage(tx, orgId, stage, cursor)` on
    `(pipeline_stage_changed_at, id)`. `moveBuilderStage(tx, orgId, builderId, { toStage, actorUserId, expectedStage?, source })`
    returns `{ ok: false, currentStage }` on an `expectedStage` mismatch, otherwise updates
    `pipeline_stage` + `pipeline_stage_changed_at` and inserts one event. `assignBuilderOwner`
    validates `ownerUserId` against `organization_members` for this org and returns null on a
    non-member. `listStageEvents(tx, orgId, builderId, limit)`.
  - Verify: `pnpm type-check`.

- [ ] **Test the repository's pure decision points**
  - Files: `tests/unit/shared/lib/repositories/pipeline.test.ts` (new)
  - Do: Follow the existing `organization-builders.test.ts` style (fake transaction object).
    Assert: every query builder receives an `organizationId` predicate; `assignBuilderOwner`
    returns null for a user with no `organization_members` row in this org; `moveBuilderStage`
    with a mismatched `expectedStage` performs no UPDATE and no INSERT; a successful move inserts
    exactly one event with the supplied `source`; `deleteStage` without `reassignTo` and a
    non-zero count performs no DELETE.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/pipeline.test.ts`.

- [ ] **Handle owner lifecycle: member removal and account deletion**
  - Files: `src/shared/lib/repositories/pipeline.ts`, `src/shared/lib/auth/organization-lifecycle.ts`, `src/shared/lib/repositories/account-privacy.ts`
  - Do: **Connection matters — do not put this on `authDb`.** `removeMemberRecord`
    (`organization-lifecycle.ts:788-792`) is an `authDb.delete(organizationMembers)` running as
    `builderhunt_auth`, and `drizzle/0007_auth_broker.sql:11-20` grants that role only
    `auth_users`/`auth_sessions`/`auth_accounts`/`auth_verifications`/`organizations`/
    `organization_members`/`organization_invitations` — never `organization_builders`. An UPDATE
    there would be a `42501`, or worse a silent no-op. Instead:
    add `clearPipelineOwner(tx, organizationId, userId)` to `repositories/pipeline.ts`, declare a
    new `clearPipelineOwnerRecord(organizationId, userId, actor: TenantPrincipal)` member on the
    `LifecycleDependencies` interface (`organization-lifecycle.ts:113-143`, beside
    `removeMemberRecord` at `:131`), and call it from the `removeMember` orchestrator
    (`organization-lifecycle.ts:412-440`) **before** `deps.removeMemberRecord` at `:432`. The
    default implementation wraps `clearPipelineOwner` in `withTenantContext` using the *actor's*
    principal — the remover is owner/admin of that organization (or is removing themselves), so
    the context is legitimate and RLS-scoped. That runs as `builderhunt_app`, which already holds
    UPDATE on `organization_builders` (`drizzle/0008_tenant_rls.sql:110-116`), so no new grant is
    needed. Follow the existing dynamic-import shape this file already uses to reach
    `withTenantContext` without a static import (`organization-lifecycle.ts:1058`, `:1103`).
    Skipping this recreates the permanently-undeletable-account bug that
    `drizzle/0026_deleted_user_sentinel.sql:1-14` exists to fix, because
    `pipeline_owner_user_id` is `onDelete: 'restrict'`.
    In `hardDeleteAccountSubject`'s existing per-membership `withTenantContext` loop
    (`account-privacy.ts:288-322`, also `builderhunt_app`), add — beside the two existing
    `creatorUserId` → `DELETED_USER_SENTINEL_ID` reassignments at `:310-313` —
    `tx.update(organizationBuilders).set({ pipelineOwnerUserId: null }).where(eq(organizationBuilders.pipelineOwnerUserId, userId))`
    and `tx.update(organizationBuilderStageEvents).set({ actorUserId: DELETED_USER_SENTINEL_ID }).where(eq(organizationBuilderStageEvents.actorUserId, userId))`,
    with a comment stating why one is nulled (an assignment is current state — the card honestly
    becomes unassigned) and the other sentinelled (an event is audit and must keep a non-null
    actor). Both are inside the tenant context, so RLS scopes them per organization; the loop only
    visits organizations the user is still a member of, which is sound precisely because
    `removeMember` already cleared assignments in the ones they left.
  - Verify: `pnpm test -- tests/unit/shared/lib/auth/organization-lifecycle.test.ts` with a new
    case asserting `clearPipelineOwnerRecord` is called before `removeMemberRecord`;
    `pnpm test -- tests/unit/shared/lib/repositories/account-privacy.test.ts`; the new
    `checkPipeline()` member-removal case below proves it against the real non-owner roles; and
    `pnpm test:api-isolation:local`'s `checkLegalRunWorker` still passes with a seeded account that
    both owns pipeline cards and authored stage events — i.e. that account is now genuinely
    hard-deletable rather than blocked by the `restrict` FK.

## Phase 4 — API routes

- [ ] **Add GET /api/pipeline/board**
  - Files: `src/routes/api/pipeline/board.ts` (new)
  - Do: `requireTenantPrincipal` → `withTenantContext`. Zod query
    `{ stage?: string, owner?: string, cursor?: string }`. Call `ensureDefaultPipelineStages`,
    then `listStages` + `loadBoard`. Resolve `capabilities` with
    `pipelineCapabilities(await getOrganizationEntitlement(tx, orgId))` — on the request path the
    app role *does* hold the needed grants (`drizzle/0008_tenant_rls.sql:45,108` for
    `organization_entitlements`, `0028` for `billing_subscriptions`, both of which that helper
    reads), so the full helper is correct here; only the Phase 6 worker needs the narrow variant.
    Respond an explicit DTO
    allowlist:
    `{ stages: [{ key, label, position, isTerminal, staleAfterDays, total }], cards: [{ id, identityId, username, displayName, avatarUrl, source, profileUrl, stage, stageChangedAt, daysInStage, stale, ownerUserId }], capabilities }` —
    never spread an ORM row, never leak `privateMetadata` wholesale.
  - Verify: `curl -b session '/api/pipeline/board'` on a fresh org returns 5 stages with
    `total: 0`; unauthenticated → 401; a second org's session never sees the first org's cards.

- [ ] **Add PATCH /api/pipeline/builders/$builderId**
  - Files: `src/routes/api/pipeline/builders/$builderId.ts` (new)
  - Do: `requireTenantPrincipal`; `if (!can(principal, 'pipeline:move')) return 403`. Zod body
    `{ stage?: string, ownerUserId?: string | null, expectedStage?: string | null }`, at least one
    of `stage`/`ownerUserId` present. Resolve the id with
    `resolveOrganizationBuilderId` (both id spaces — see that function's doc comment). Inside one
    `withTenantContext`: `moveBuilderStage` (→ `409 { error: 'stage_conflict', currentStage }` on
    mismatch, `400 { error: 'unknown_stage' }` when the key is not in the org's set) and/or
    `assignBuilderOwner` (→ `400 { error: 'not_a_member' }`). Return the updated card DTO.
  - Verify: Move a card and re-GET the board — it is in the new column with `daysInStage: 0`;
    replaying the same PATCH with the stale `expectedStage` returns 409; an `ownerUserId` copied
    from another organization returns 400.

- [ ] **Add the stage CRUD, reorder, and events routes**
  - Files: `src/routes/api/pipeline/stages/index.ts` (new), `src/routes/api/pipeline/stages/$stageKey.ts` (new), `src/routes/api/pipeline/stages/reorder.ts` (new), `src/routes/api/pipeline/builders/$builderId/events.ts` (new)
    (`stages/index.ts` rather than a `stages.ts` sibling of the directory — matches
    `src/routes/api/alerts/index.ts` + `alerts/$id.ts`. The `builders/$builderId.ts` +
    `builders/$builderId/` pair in the previous task is the other existing shape, from
    `src/routes/api/builders/`.)
  - Do: GET stages = any member. POST/PATCH/DELETE/reorder require
    `can(principal, 'pipeline:configure')` **and** `pipelineCapabilities(...).canCustomizeStages`,
    else `403 { error: 'plan', limit }`; POST also enforces `maxStages` and derives `key` via
    `normalizeStageKey` (409 on collision). DELETE requires `reassignTo` when the stage holds
    cards → `409 { error: 'stage_not_empty', count }`. `staleAfterDays` is rejected with
    `403 { error: 'plan' }` unless `canSetStageSla`. reorder body `{ orderedKeys: string[] }`
    validated by `validateStageSet` before any write. Events route returns
    `[{ occurredAt, fromStage, toStage, actorUserId, source }]`, newest first, `limit` ≤ 100.
  - Verify: Free-tier POST → 403 `plan`; pro member (non-admin) POST → 403; pro admin adds a 6th
    stage; a 9th on pro → 403 with `limit: 8`; DELETE a populated stage without `reassignTo` → 409.

- [ ] **Attach stage context to the existing notes endpoint**
  - Files: `src/routes/api/builders/$builderId/notes.ts`, `src/shared/lib/repositories/organization-builders.ts`
  - Do: Extend `NoteBody` (`notes.ts:12`, currently `z.object({ content: … })`) with
    `stageKey: z.string().max(32).nullish()`. In `createOrganizationBuilderNote`
    (`organization-builders.ts:411`), persist `pipelineStageKey`: the supplied `stageKey` when it
    exists in the org's stage set, otherwise the card's current `pipeline_stage`, otherwise null.
    That function already calls `findOrganizationBuilder(tx, input.organizationId, input.builderId)`
    to validate the id, so the card's current stage comes back on the row it already fetched — no
    extra query and no id translation, because a note's `builder_id` is the same value as
    `organization_builders.id` (see spec.md §Per-stage notes for why). Add `pipelineStageKey` to
    the `listOrganizationBuilderNotes` select (`organization-builders.ts:395-409`) and to both
    returned DTOs. No new table, no new route, and no new grant — `builderhunt_app` holds
    table-level SELECT/INSERT/UPDATE/DELETE on `builder_notes` from
    `drizzle/0008_tenant_rls.sql:110-116`, which covers the new column.
  - Verify: POST a note with no `stageKey` on a card sitting in `contacted` → GET returns
    `pipelineStageKey: 'contacted'`; POST with a bogus key falls back to the card's stage, never
    stores the bogus value; `pnpm test -- tests/unit/shared/lib/repositories/organization-builders.test.ts`
    still passes.

- [ ] **Extend the API tenant-isolation script**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkPipeline()` (the file's existing checks start at `:228`; `checkBuilderTracking`
    is at `:288`) and register it in `main()`'s call list, beside `await checkBuilderTracking()`
    at `:1227`. Cover:
    tenant B's session cannot see tenant A's cards on `/api/pipeline/board`; tenant B PATCHing
    tenant A's `builderId` gets 404 (not 403, no existence leak); a spoofed `organizationId` in the
    body/query changes nothing; `ownerUserId` from another org → 400; a `member`-role principal is
    refused `POST /api/pipeline/stages` but allowed `PATCH .../builders/:id`; a direct
    `builderhunt_app` SQL read of `organization_pipeline_stages` with no `app.organization_id`
    returns 0 rows; `organization_builder_stage_events` has no DELETE grant for `builderhunt_app`.
    **Member removal**: assign a card to member B, remove B from the organization through the real
    route, and assert the card's `pipeline_owner_user_id` is now NULL and the card itself still
    exists — this is the check that catches the wrong-connection failure from the Phase 3 lifecycle
    task, since a `builderhunt_auth` UPDATE would leave the owner set.
    **Worker role**: with `DATABASE_WORKER_URL` connected as `builderhunt_worker`, read
    `organization_entitlements.tier` and `organization_pipeline_stages` for one org and assert both
    succeed and are org-scoped (this is the grant added in Phase 1; without it the Phase 6 digest
    silently reports zero).
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, no existing check regresses.

## Phase 5 — Board UI

- [ ] **Add the route and register it in the nav registry**
  - Files: `src/routes/_dashboard/pipeline/index.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`, `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`
  - Do: Route mirrors `src/routes/_dashboard/sprints/index.tsx` (auth `beforeLoad`, renders the
    module component). **Navigation is not in `DashboardLayout.tsx`** — the flat `NAV` /
    `MOBILE_NAV_ITEMS` arrays this plan originally targeted no longer exist; Shell C derives the
    rail, the level-2 panel, the breadcrumb and the mobile drawer from `NAV_AREAS` in
    `nav-config.ts`, and `DashboardLayout.tsx` only composes the regions. An area with
    `id: 'pipeline'`, `label: 'Pipeline'` and `routes: ['/sprints', '/calendar']` already exists;
    join it rather than adding a second Pipeline area:
    (1) append `'/pipeline'` to that area's `routes` — prefix ownership is what lights the rail, and
    without it `resolveActiveArea('/pipeline')` falls through to `areas[0]` (Home);
    (2) append `{ to: '/pipeline', label: 'Board', icon: KanbanSquare, group: 'Pipeline', exact: true }`
    to its `items`, importing `KanbanSquare` from `lucide-react` alongside the existing icon
    imports. Label it "Board", not "Pipeline": `breadcrumbFor` collapses to a single crumb when the
    item label equals the area label.
    An item may only live under an area that owns its prefix — the registry's own test documents
    why (clicking it would otherwise swap the rail out from under the user).
    Extend `nav-config.test.ts` with `['/pipeline', 'pipeline']` in the `resolveActiveArea` table
    and a `breadcrumbFor('/pipeline', false)` case expecting `['Pipeline', 'Board']`.
  - Verify: `pnpm test -- tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`;
    `pnpm type-check` passes with the regenerated route tree; `pnpm dev` — `/pipeline` renders, the
    Pipeline rail icon is lit and "Board" is highlighted in the level-2 panel.

- [ ] **Build the board, columns, and cards**
  - Files: `src/modules/pipeline/components/PipelineBoard.tsx` (new), `src/modules/pipeline/components/StageColumn.tsx` (new), `src/modules/pipeline/components/PipelineCard.tsx` (new)
  - Do: Board fetches `/api/pipeline/board`, renders one `StageColumn` per stage
    (`overflow-x-auto` row, existing `card`/`bh-*` classes — no new design tokens). Column header
    shows label, `total`, and an SLA dot. Card shows avatar, name, `@username · source`, owner
    chip, `{daysInStage}d in stage`, and a stale badge. Empty column = a short prompt, not a
    spinner. "Load more" appends via the cursor. Stage and owner filters bound to URL search
    params so a filtered board is linkable.
  - Verify: Board renders 5 columns for a fresh org; with 500 seeded cards each column shows 25
    plus a working "Load more"; filtering by owner narrows every column.

- [ ] **Make moving a card accessible, not drag-only**
  - Files: `src/modules/pipeline/components/PipelineCard.tsx`, `src/modules/pipeline/components/PipelineBoard.tsx`
  - Do: Native HTML5 `draggable` + `onDragOver`/`onDrop` on columns (no new dependency), and a
    per-card "Move to…" `Select` from `src/components/ui/select.tsx` hitting the same PATCH with
    the card's current stage as `expectedStage`. Optimistically move, roll back and refetch on
    409/4xx with an inline message. Announce each move in a single `aria-live="polite"` region
    ("Moved Ada Lovelace to Contacted").
  - Verify: Keyboard-only: tab to a card, open the select, move it — the card relocates and the
    live region announces it. Two browser tabs moving the same card: the second shows the conflict
    message and refetches.

- [ ] **Add the card detail drawer with history and stage-aware notes**
  - Files: `src/modules/pipeline/components/CardDetailDrawer.tsx` (new)
  - Do: Built on `src/components/ui/dialog.tsx`. Shows the stage timeline from
    `/api/pipeline/builders/$id/events`, existing notes from
    `GET /api/builders/$builderId/notes` grouped by `pipelineStageKey`, a composer that POSTs with
    the card's current `stageKey`, an owner `Select` limited to current members, and a link to
    `/builder/$builderId`.
  - Verify: Adding a note from a card in "Contacted" shows it under Contacted after a refetch;
    moving the card then adding another note groups the second under the new stage.

- [ ] **Add the stage settings dialog with tier locks**
  - Files: `src/modules/pipeline/components/StageSettingsDialog.tsx` (new)
  - Do: List stages with drag/arrow reordering, inline label rename, terminal toggle, and an
    `staleAfterDays` input. Free tier: "Add stage" and the SLA input render disabled with a
    "Pro"/"Team" pill linking to `/pricing`, driven by the `capabilities` object the board
    endpoint returns — never by a client-side tier guess. Members (non-admin) see the dialog
    read-only. Surfaces the `stage_not_empty` 409 as a reassignment picker.
  - Verify: Free org sees locked controls and no 403 toasts; pro admin renames a stage and the
    board header updates; deleting a populated stage prompts for a destination.

- [ ] **Surface stage data in `/exports` and the CSV**
  - Files: `src/shared/lib/repositories/organization-builders.ts`, `src/routes/api/me/builders/index.ts`, `src/routes/api/export/builders.ts`, `src/modules/dashboard/components/ExportsPage.tsx`
  - Do: Both routes build their rows from `listOrganizationBuilders`, which selects the shared
    `privateBuilderFields` object (`organization-builders.ts:31-47`) — add
    `pipelineStage`, `pipelineStageChangedAt` and `pipelineOwnerUserId` there **once** and both
    consumers see them (as do `listRecentOrganizationBuilders` and
    `listOrganizationBuildersForTeamAggregate`, which is harmless — they map to their own DTOs).
    Then add the three fields to the `/api/me/builders` response mapper
    (`me/builders/index.ts:17-27`) and three matching columns (`pipeline_stage`,
    `pipeline_stage_changed_at`, `pipeline_owner`) to the CSV `header`/`rows` arrays in
    `export/builders.ts:55-64`. Leave that route's `filterSuppressed`, seat metering and daily-cap
    logic untouched. Show the stage as a badge in `ExportsPage`'s tracked-builder list (it already
    fetches `/api/me/builders` at `:26`). Do not paginate `/api/me/builders` here — that is a
    pre-existing issue and an explicit non-goal.
  - Verify: `pnpm type-check`; download the CSV from `/exports` — every row carries a stage
    (cards never moved show the position-0 stage key, not an empty cell); a card moved on the board
    shows the new stage in the next export.

## Phase 6 — Team SLA digest worker

- [ ] **Add the stale-cards query and endpoint**
  - Files: `src/shared/lib/repositories/pipeline.ts`, `src/routes/api/pipeline/stale.ts` (new)
  - Do: `listStaleCards(tx, orgId, now)` joins cards to their stage and applies
    `isStale` server-side (index scan on `organization_builders_org_stage_changed_idx`). Route
    requires a tenant principal and `pipelineCapabilities(...).staleDigest`, else
    `403 { error: 'plan' }`. Returns `{ cards: [{ id, username, stage, daysInStage, ownerUserId }] }`.
  - Verify: Team org with a 3-day SLA and a card untouched for 5 days lists it; the same card in a
    terminal stage does not; free/pro org → 403.

- [ ] **Add the digest email template**
  - Files: `src/shared/lib/email.ts`
  - Do: `sendPipelineStaleDigestEmail(to, items: PipelineStaleDigestItem[])` modelled on
    `sendAlertDigestEmail` (`email.ts:249`, not the line this plan originally cited). Copy all
    **three** branches in order, because the E2E outbox seam was added after this plan was written:
    (1) `if (isE2EOutboxActive()) return dispatchEmail({ … })` — `dispatchEmail` **throws** unless
    `E2E_MODE=true` (`email.ts:44-47`), so it can never be the only branch;
    (2) `if (!env.RESEND_API_KEY)` → console dev-mode preview, `return { ok: true }`;
    (3) the real `https://api.resend.com/emails` `fetch`.
    Add a `PipelineStaleDigestItem` interface and a `pipelineStaleDigestEmailHtml` helper beside
    the existing `AlertDigestItem` / `alertDigestEmailHtml` pair. Plain-text + HTML, links to
    `/pipeline`. Never include notes, bios, or any private metadata in the email body — name,
    stage, and days only.
  - Verify: With `RESEND_API_KEY` unset and `E2E_MODE` unset, calling it logs a dev-mode preview
    and returns a `SendResult` without throwing; with `E2E_MODE=true` it lands in the outbox
    readable via `/api/e2e/outbox`.

- [ ] **Add the worker-safe entitlement tier read**
  - Files: `src/shared/lib/repositories/pipeline-worker.ts` (new), `tests/unit/shared/lib/repositories/pipeline-worker.test.ts` (new)
  - Do: The digest must **not** call `getOrganizationEntitlement`
    (`repositories/entitlements.ts:78-100`). That helper issues two queries: one against
    `organization_entitlements`, which `builderhunt_worker` genuinely cannot read
    (`drizzle/0008_tenant_rls.sql:45,108` scopes it to `builderhunt_app`, `0010` omits it, and no
    later migration adds it — re-verified at HEAD), and one against `billing_subscriptions`, which
    the worker *can* read (`drizzle/0028_billing_rls_grants.sql:294-298` grants it
    `SELECT, INSERT, UPDATE`, with org-scoped worker policies at `:166-174`; an earlier draft of
    this plan wrongly claimed otherwise). So the first query is a hard `42501` and the second is
    simply unnecessary.
    Instead add `getWorkerEntitlementPolicy(tx, organizationId)`: select only
    `tier, status, seat_limit` from `organization_entitlements` (the column-scoped grant added in
    Phase 1 covers exactly these plus `organization_id`) and return
    `resolveEntitlementPolicy(row ?? null, false)` — the already-exported pure function at
    `entitlements.ts:53`. Comment that `paymentBlocked` is hard-coded `false` deliberately:
    `pipelineCapabilities(...).staleDigest` reads only `tier`, so a notification is never gated on
    payment state, and skipping `billing_subscriptions` is a least-privilege choice rather than a
    workaround for a missing grant.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/pipeline-worker.test.ts` — a `team`
    row yields `staleDigest: true`, a `pro_max` row yields `staleDigest: false` and
    `maxStages: 12`, a missing row yields the free default; and as `builderhunt_worker` against a
    real DB the select returns a row instead of `42501` (covered by the Phase 4 isolation check).

- [ ] **Add the digest worker and its admin endpoint**
  - Files: `src/lib/pipeline/worker.ts` (new), `src/shared/lib/repositories/pipeline-worker.ts`, `src/shared/lib/operational-schedules.ts`, `src/routes/api/admin/pipeline/run-worker.ts` (new)
  - Do: `pipeline-worker.ts` clones `repositories/alerts-worker.ts`'s `listWorkerOrganizationIds`
    (`:10`) + `withWorkerOrganization` (`:14`) shape; `src/lib/pipeline/worker.ts` sits beside the
    existing `src/lib/alerts/worker.ts`. `runPipelineDigestWorker()` iterates organizations, each in
    its own worker transaction (one org's failure never aborts another — collect into
    `errors[]`), resolves the tier via `getWorkerEntitlementPolicy` and skips unless `staleDigest`,
    skips an org whose newest digest event is < 20 h old (the idempotency guard against a double
    cron hit), groups stale cards **by assigned owner only** — unassigned stale cards are counted
    in `cardsFlagged` but emailed to nobody, which keeps the worker off `organization_members`
    (which it has no grant on at all) and limits its `auth_users` access to the
    `GRANT SELECT (id, email)` from `drizzle/0010_worker_alert_policies.sql:29`, the same read
    `alerts-worker.ts`'s `findWorkerUserEmail` (`:110`) performs — and emails. Reading the cards
    themselves needs no new grant: `drizzle/0018_enrichment_worker_target_access.sql:6-12` already
    gives the worker an org-scoped policy plus table-level SELECT on `organization_builders`.
    Returns `{ organizationsScanned, cardsFlagged, emailsSent, errors }`.
    Register the job in `OPERATIONAL_SCHEDULES` (`src/shared/lib/operational-schedules.ts:38-122`):
    `{ jobKey: 'pipeline.stale-digest', cronExpression: '0 7 * * *', timezone: 'Europe/Copenhagen',
    scope: 'organization', label: 'Pipeline stale-card digest',
    sourceRoute: '/api/admin/pipeline/run-worker' }`. `pipeline.stale-digest` is unclaimed at HEAD;
    Europe/Copenhagen because it is a daily digest a human notices at a local hour, per the comment
    above that array. `assertRegistryIsSafe` requires the `sourceRoute` to start with `/api/admin/`
    and the cron to parse — `tests/unit/shared/lib/operational-schedules.test.ts` runs it.
    The route clones `src/routes/api/admin/alerts/run-worker.ts` structurally. That route now has
    **three** parts, all required:
    `const principal = tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`;
    `const { payload: result } = await withJobRun({ jobKey: 'pipeline.stale-digest' }, async () => { const outcome = await runPipelineDigestWorker(); return { processedCount: outcome.cardsFlagged, failedCount: outcome.errors.length, payload: outcome } })`;
    and `await auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker', targetId: 'pipeline', result: 'allowed' })`
    — principal first, `targetType` and `result` both required. Close with the same
    `platformAdminErrorResponse(err)` catch. `withJobRun` runs on `workerDb` and needs no new
    grant (`drizzle/0067_operational_schedule_grants.sql:22-23`).
  - Verify: **Run the worker against `DATABASE_WORKER_URL` connected as the real
    `builderhunt_worker` role, not the DB owner** (`app-reality.md` constraint 7). Seed an eligible
    fixture first: a `team`-tier org, a stage with `stale_after_days = 3`, and a card assigned to a
    member and untouched for 5 days. First `curl -X POST` as platform admin must return
    `cardsFlagged >= 1` **and** `emailsSent >= 1` with `errors: []` — a run reporting
    `emailsSent: 0` on this fixture is a failure, not a pass, and means a grant is missing. Then
    assert idempotency: an immediate second call returns `emailsSent: 0` *while the first call
    still shows 1*. Also confirm a free-tier org in the same run is skipped without an error, and a
    non-admin session gets 401/403. Finally,
    `select job_key, state, processed_count from job_runs order by created_at desc limit 2`
    shows two `pipeline.stale-digest` rows in state `succeeded` — a run that produced no `job_runs`
    row means `withJobRun` was dropped from the clone. `pnpm test -- tests/unit/shared/lib/operational-schedules.test.ts`
    proves the registry entry is well-formed.

- [ ] **Document the cron entry and close out**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Add `` | `POST /api/admin/pipeline/run-worker` | hiring-pipeline stale-card digests | `RESEND_API_KEY` | ``
    to the worker endpoint table (rows currently at `:146-154`, between the alerts and billing
    rows), and a matching daily line to the crontab example block below it (`:183` area), e.g.
    `0 7 * * * curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://builderhunt.dev/api/admin/pipeline/run-worker`
    — same hour as the `pipeline.stale-digest` registry entry. State that configurable automation
    rules are a separate future plan (`pipeline-automation-rules`), not a missing cron.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm test:migration-integrity && pnpm security:boundaries && pnpm security:route-coverage && pnpm test:rls:local && pnpm test:api-isolation:local`
    all green; manual pass: free org gets a working default board with locked customization, pro org
    customizes stages, team org receives a digest.
