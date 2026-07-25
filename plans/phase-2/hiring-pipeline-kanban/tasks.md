# Hiring Pipeline Kanban (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (tenant-private `organization_builders` ownership, RLS, tenant principal); [`team-accounts`](../../team-accounts/spec.md) (organization roles and seats — already implemented). Enhanced by [`activity-feed`](../../activity-feed/spec.md) (stage-change events; not required).
> **Blocks**: [`ats-integrations`](../ats-integrations/spec.md) (hard — the ATS sync maps its external status back onto this plan's stage model)
> **Reality check**: `organization_builders` already exists (`src/shared/lib/db/schema.ts:178`) with a dead `status` check constraint nothing reads; tenant notes already exist (`builder_notes` + `src/routes/api/builders/$builderId/notes.ts`); there is no `/me/builders` page, only `GET /api/me/builders` consumed by `src/modules/dashboard/components/ExportsPage.tsx`.

Ordered so the app ships cleanly after every checkbox.

Migration numbers assume `0045` is the current head. **`match-evidence-panel` also claims `0046`**
(recorded in `plans/fase-2/README.md`) — whichever plan lands second renumbers its files, journal
tags, and snapshots. Every hand-written migration is minted with
`drizzle-kit generate --custom` so the journal entry and `drizzle/meta/NNNN_snapshot.json` always
exist; `pnpm test:migration-integrity` fails otherwise, and grants-only migrations are not exempt.

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
  - Verify: `pnpm type-check`.

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
  - Files: `drizzle/0046_pipeline_kanban.sql` (new, generated), `drizzle/meta/0046_snapshot.json` (new), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`, then rename the auto-tag to `0046_pipeline_kanban` and update the
    journal entry to match (this repo's existing rename convention — see
    `plans/abuse-and-usage-integrity/tasks.md:43-58`). Regenerate the hash manifest with
    `node scripts/db/verify-migration-integrity.mjs --write`. Read the emitted SQL and confirm it
    contains no DROP, no rename, and no table rewrite — only `CREATE TABLE`,
    `ALTER TABLE ... ADD COLUMN`, FKs, and indexes.
  - Verify: `pnpm db:migrate` on a fresh DB succeeds; `\d organization_builders` shows the three
    new nullable columns and both new indexes; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` both pass.

- [ ] **Hand-write the RLS + grants migration**
  - Files: `drizzle/0047_pipeline_rls_grants.sql` (new), `drizzle/meta/0047_snapshot.json` (new), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
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
    org-scoped policy. `builderhunt_platform`: none.
    **Also add the one grant the digest worker is otherwise missing** (see the Phase 6 tier-read
    task): a `builderhunt_worker` org-scoped SELECT policy on `organization_entitlements` plus
    `GRANT SELECT (organization_id, tier, status, seat_limit) ON TABLE organization_entitlements TO builderhunt_worker;`
    — column-scoped, matching `0010_worker_alert_policies.sql:25`'s `GRANT SELECT (id)` style.
    `drizzle/0008_tenant_rls.sql:45,108` grants that table to `builderhunt_app` only, and
    `0010` (the full worker grant set) omits it entirely. Then `REVOKE ALL ... FROM PUBLIC` and
    explicit `GRANT`s; no `TRUNCATE`, no `REFERENCES`. Head-comment the data class and role split,
    as `0044` does.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local` and `pnpm test:migration-integrity` pass;
    `psql -U builderhunt_app -c "select * from organization_pipeline_stages"` with no
    `app.organization_id` set returns 0 rows (not an error, not data); the same query as
    `builderhunt_worker` with `app.organization_id` set to one org returns only that org's stages;
    `psql -U builderhunt_worker -c "select tier from organization_entitlements"` succeeds instead
    of `42501`.

- [ ] **Hand-write the idempotent stage seed + backfill migration**
  - Files: `drizzle/0048_pipeline_default_stage_backfill.sql` (new), `drizzle/meta/0048_snapshot.json` (new), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
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
  - Do: Add `organization_pipeline_stages` and `organization_builder_stage_events` rows —
    class `tenant-private`, owner `organization_id`, public fields `none`, retention
    "organization lifetime (events append-only, no pruning)". Add the `pipeline:move` /
    `pipeline:configure` actions to the authorization matrix with their role sets.
  - Verify: Both tables appear; no code change.

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
  - Files: `src/shared/lib/pipeline/stages.test.ts` (new)
  - Do: `normalizeStageKey('In Conversation!')` → `in_conversation`; empty/emoji-only label throws;
    `validateStageSet` rejects 1 stage, 13 stages, duplicate keys, all-terminal sets, and gaps in
    `position`; `reorderStages` with an unknown or missing key throws rather than dropping a stage;
    `resolveStageForCard(null, ...)` returns the position-0 stage.
  - Verify: `pnpm test stages`.

- [ ] **Build and test the staleness module**
  - Files: `src/shared/lib/pipeline/staleness.ts` (new), `src/shared/lib/pipeline/staleness.test.ts` (new)
  - Do: `daysInStage({ changedAt, createdAt, now })` (falls back to `createdAt` when
    `changedAt` is null, floor of whole days, never negative) and
    `isStale({ stage, changedAt, createdAt, now })` (false when `stage.isTerminal` or
    `stage.staleAfterDays == null`, else `daysInStage >= staleAfterDays`). Tests cover the
    terminal-stage exemption, the null-SLA exemption, the null-`changedAt` fallback, and an
    exact-boundary day.
  - Verify: `pnpm test staleness`.

- [ ] **Add the tier limits and capability resolver**
  - Files: `src/shared/lib/billing-shared.ts`, `src/shared/lib/pipeline/entitlement.ts` (new), `src/shared/lib/pipeline/entitlement.test.ts` (new)
  - Do: Add `PIPELINE_STAGE_LIMITS: Record<PlanTier, number> = { free: 5, pro: 8, team: 12 }`
    beside `SOURCING_SPRINT_LIMITS`, with the same doc comment convention. Add
    `pipelineCapabilities(entitlement: EntitlementPolicy)` exactly per spec.md §Tier gating,
    including the comment explaining why `canSetStageSla`/`staleDigest` use the raw tier instead
    of `resolveLegacyPlanTier`. Tests: free → `canCustomizeStages: false`, `maxStages: 5`;
    pro → 8/true/false; `pro_max` → `maxStages: 12`, `canSetStageSla: false`; team → 12/true/true;
    `paidActionsAllowed: false` → both write capabilities false while `maxStages` is unchanged.
  - Verify: `pnpm test entitlement`.

- [ ] **Add the two permission actions**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`
  - Do: Add `'pipeline:move'` (returns `true` for every role — comment the justification from
    spec.md §Permissions) and `'pipeline:configure'` (`elevated`, i.e. owner/admin) to
    `PermissionAction` and the `can()` switch. Extend the test with all three roles × both
    actions.
  - Verify: `pnpm test permissions`; the inline-role-comparison boundary test still passes.

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
  - Files: `src/shared/lib/repositories/pipeline.test.ts` (new)
  - Do: Follow the existing `organization-builders.test.ts` style (fake transaction object).
    Assert: every query builder receives an `organizationId` predicate; `assignBuilderOwner`
    returns null for a user with no `organization_members` row in this org; `moveBuilderStage`
    with a mismatched `expectedStage` performs no UPDATE and no INSERT; a successful move inserts
    exactly one event with the supplied `source`; `deleteStage` without `reassignTo` and a
    non-zero count performs no DELETE.
  - Verify: `pnpm test repositories/pipeline`.

- [ ] **Handle owner lifecycle: member removal and account deletion**
  - Files: `src/shared/lib/repositories/pipeline.ts`, `src/shared/lib/auth/organization-lifecycle.ts`, `src/shared/lib/repositories/account-privacy.ts`
  - Do: **Connection matters — do not put this on `authDb`.** `removeMemberRecord`
    (`organization-lifecycle.ts:788-792`) runs as `builderhunt_auth`, and
    `drizzle/0007_auth_broker.sql:12-20` grants that role only the auth/organization tables, never
    `organization_builders` — an UPDATE there would be a `42501`, or worse a silent no-op. Instead:
    add `clearPipelineOwner(tx, organizationId, userId)` to `repositories/pipeline.ts`, expose it
    as a new `clearPipelineOwnerRecord` dependency, and call it from the `removeMember`
    orchestrator (`organization-lifecycle.ts:412-432`) via `withTenantContext` with the *actor's*
    principal — the remover is owner/admin of that organization, so the context is legitimate and
    RLS-scoped — **before** `deps.removeMemberRecord`. That runs as `builderhunt_app`, which
    already holds UPDATE on `organization_builders` (`drizzle/0008_tenant_rls.sql:110`), so no new
    grant is needed. Skipping this recreates the permanently-undeletable-account bug that
    `drizzle/0026_deleted_user_sentinel.sql:6-10` exists to fix, because
    `pipeline_owner_user_id` is `onDelete: 'restrict'`.
    In `hardDeleteAccountSubject`'s existing per-membership `withTenantContext` loop
    (`account-privacy.ts:~300`, also `builderhunt_app`), add
    `tx.update(organizationBuilders).set({ pipelineOwnerUserId: null }).where(eq(pipelineOwnerUserId, userId))`
    and `tx.update(organizationBuilderStageEvents).set({ actorUserId: DELETED_USER_SENTINEL_ID }).where(eq(actorUserId, userId))`,
    with a comment stating why one is nulled (current assignment) and the other sentinelled
    (audit). Both are inside the tenant context, so RLS scopes them per organization.
  - Verify: `pnpm test organization-lifecycle` (assert `clearPipelineOwnerRecord` is called before
    `removeMemberRecord`); the new `checkPipeline()` member-removal case below proves it against
    the real non-owner roles; `pnpm test:api-isolation:local`'s `checkLegalRunWorker` still passes
    with a seeded account that both owns pipeline cards and authored stage events — i.e. that
    account is now genuinely hard-deletable rather than blocked by the `restrict` FK.

## Phase 4 — API routes

- [ ] **Add GET /api/pipeline/board**
  - Files: `src/routes/api/pipeline/board.ts` (new)
  - Do: `requireTenantPrincipal` → `withTenantContext`. Zod query
    `{ stage?: string, owner?: string, cursor?: string }`. Call `ensureDefaultPipelineStages`,
    then `listStages` + `loadBoard`. Resolve `capabilities` with
    `pipelineCapabilities(await getOrganizationEntitlement(tx, orgId))` — on the request path the
    app role *does* hold the needed grants (`drizzle/0008_tenant_rls.sql:108`), so the full helper
    is correct here; only the Phase 6 worker needs the narrow variant. Respond an explicit DTO
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
  - Files: `src/routes/api/pipeline/stages.ts` (new), `src/routes/api/pipeline/stages/$stageKey.ts` (new), `src/routes/api/pipeline/stages/reorder.ts` (new), `src/routes/api/pipeline/builders/$builderId/events.ts` (new)
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
  - Do: Extend `NoteBody` with `stageKey: z.string().max(32).nullish()`. In
    `createOrganizationBuilderNote`, persist `pipelineStageKey`: the supplied `stageKey` when it
    exists in the org's stage set, otherwise the card's current `pipeline_stage`, otherwise null.
    Add `pipelineStageKey` to the `listOrganizationBuilderNotes` select and both DTOs. No new
    table, no new route.
  - Verify: POST a note with no `stageKey` on a card sitting in `contacted` → GET returns
    `pipelineStageKey: 'contacted'`; POST with a bogus key falls back to the card's stage, never
    stores the bogus value.

- [ ] **Extend the API tenant-isolation script**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Add `checkPipeline()` and register it in `main()` beside `checkBuilderTracking`. Cover:
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

- [ ] **Add the route and nav entry**
  - Files: `src/routes/_dashboard/pipeline/index.tsx` (new), `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: Route mirrors `src/routes/_dashboard/sprints/index.tsx` (auth `beforeLoad`, renders the
    module component). Add `{ to: '/pipeline', icon: KanbanSquare, label: 'Pipeline', end: false }`
    to the `NAV` const (line 22-28), between Search and Sprints. `MOBILE_NAV_ITEMS` (line 31)
    derives from `NAV`, so no second edit is needed.
  - Verify: `pnpm dev` — `/pipeline` renders and the nav item highlights; `pnpm type-check`
    passes with the regenerated route tree.

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
  - Files: `src/routes/api/me/builders/index.ts`, `src/routes/api/export/builders.ts`, `src/modules/dashboard/components/ExportsPage.tsx`
  - Do: Add `pipelineStage`, `pipelineStageChangedAt`, and `pipelineOwnerUserId` to the
    `/api/me/builders` DTO and three matching columns (`pipeline_stage`,
    `pipeline_stage_changed_at`, `pipeline_owner`) to the CSV. Show the stage as a badge in
    `ExportsPage`'s tracked-builder list. Do not paginate `/api/me/builders` here — that is a
    pre-existing issue and an explicit non-goal.
  - Verify: Download the CSV — every row carries a stage; a card moved on the board shows the new
    stage in the next export.

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
    `sendAlertDigestEmail` (line 182) — same `dispatchEmail` wrapper, same dev-mode logging when
    `RESEND_API_KEY` is unset, plain-text + HTML, links to `/pipeline`. Never include notes,
    bios, or any private metadata in the email body — name, stage, and days only.
  - Verify: With `RESEND_API_KEY` unset, calling it logs a dev-mode preview and returns a
    `SendResult` without throwing.

- [ ] **Add the worker-safe entitlement tier read**
  - Files: `src/shared/lib/repositories/pipeline-worker.ts` (new)
  - Do: The digest must **not** call `getOrganizationEntitlement`
    (`repositories/entitlements.ts:71-91`): it reads `organization_entitlements` *and*
    `billing_subscriptions`, and neither is readable by `builderhunt_worker` —
    `drizzle/0008_tenant_rls.sql:45,108` scopes the former to `builderhunt_app`, and
    `billing_subscriptions` has worker RLS policies in `0028` but **no worker `GRANT` in any
    migration**. Instead add `getWorkerEntitlementPolicy(tx, organizationId)`: select only
    `tier, status, seat_limit` from `organization_entitlements` (the column-scoped grant added in
    Phase 1) and return `resolveEntitlementPolicy(row ?? null, false)` — the already-exported pure
    function from `entitlements.ts:44`. `paymentBlocked` is hard-coded false because
    `pipelineCapabilities(...).staleDigest` only reads `tier`, so a notification is never gated on
    payment state and `billing_subscriptions` is never touched.
  - Verify: `pnpm test pipeline-worker` — a `team` row yields `staleDigest: true`, a missing row
    yields the free default; and as `builderhunt_worker` against a real DB the select returns a row
    instead of `42501` (covered by the Phase 4 isolation check).

- [ ] **Add the digest worker and its admin endpoint**
  - Files: `src/lib/pipeline/worker.ts` (new), `src/shared/lib/repositories/pipeline-worker.ts`, `src/routes/api/admin/pipeline/run-worker.ts` (new)
  - Do: `pipeline-worker.ts` clones `repositories/alerts-worker.ts`'s `listWorkerOrganizationIds`
    + `withWorkerOrganization` shape. `runPipelineDigestWorker()` iterates organizations, each in
    its own worker transaction (one org's failure never aborts another — collect into
    `errors[]`), resolves the tier via `getWorkerEntitlementPolicy` and skips unless `staleDigest`,
    skips an org whose newest digest event is < 20 h old (the idempotency guard against a double
    cron hit), groups stale cards **by assigned owner only** — unassigned stale cards are counted
    in `cardsFlagged` but emailed to nobody, which keeps the worker off
    `organization_members`/`auth_users` beyond the `SELECT (id, email)` grant `0010` already
    provides — and emails. Returns
    `{ organizationsScanned, cardsFlagged, emailsSent, errors }`. The route clones
    `src/routes/api/admin/alerts/run-worker.ts` verbatim in structure —
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`,
    `auditPlatformAdminAction({ action: 'admin.worker.run', targetId: 'pipeline' })`.
  - Verify: **Run the worker against `DATABASE_WORKER_URL` connected as the real
    `builderhunt_worker` role, not the DB owner** (`app-reality.md` constraint 7). Seed an eligible
    fixture first: a `team`-tier org, a stage with `stale_after_days = 3`, and a card assigned to a
    member and untouched for 5 days. First `curl -X POST` as platform admin must return
    `cardsFlagged >= 1` **and** `emailsSent >= 1` with `errors: []` — a run reporting
    `emailsSent: 0` on this fixture is a failure, not a pass, and means a grant is missing. Then
    assert idempotency: an immediate second call returns `emailsSent: 0` *while the first call
    still shows 1*. Also confirm a free-tier org in the same run is skipped without an error, and a
    non-admin session gets 401/403.

- [ ] **Document the cron entry and close out**
  - Files: `docs/operations/deploy-runbook.md`
  - Do: Add `| POST /api/admin/pipeline/run-worker | hiring-pipeline stale-card digests | RESEND_API_KEY |`
    to the worker table (line ~127-133), daily cadence. State that configurable automation rules
    are a separate future plan (`pipeline-automation-rules`), not a missing cron.
  - Verify: `pnpm test && pnpm type-check && pnpm lint && pnpm test:api-isolation:local` all
    green; manual pass: free org gets a working default board with locked customization, pro org
    customizes stages, team org receives a digest.
