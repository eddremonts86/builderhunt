# Hiring Pipeline Kanban (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md) (tenant-private `organization_builders` ownership, RLS, tenant principal — all shipped; that plan stays `in_progress` only for the legacy-column contraction, which this one does not touch, so nothing here waits on it); [`team-accounts`](../../phase-1/team-accounts/spec.md) (organization roles and seats — already implemented). Enhanced by [`activity-feed`](../../phase-1/activity-feed/spec.md) (stage-change events; not required).
> **Blocks**: [`ats-integrations`](../ats-integrations/spec.md) (hard — the ATS sync maps its external status back onto this plan's stage model)
> **Reality check**: `organization_builders` (`src/shared/lib/db/schema.ts:179`) is the live tenant-private tracking store, read through `src/shared/lib/repositories/organization-builders.ts` under `withTenantContext`; its `status` check constraint (`'tracked' | 'shortlisted' | 'archived'`) is dead — a repo-wide grep for `'shortlisted'` outside `schema.ts`/`drizzle/` returns nothing. Tenant-scoped notes already exist (`builder_notes` + `listOrganizationBuilderNotes`/`createOrganizationBuilderNote`, served by `src/routes/api/builders/$builderId/notes.ts`) — reuse them, do not build a second notes table. There is **no** `/me/builders` page: `GET /api/me/builders` (`src/routes/api/me/builders/index.ts`) is an unpaginated JSON endpoint whose only consumer is `src/modules/dashboard/components/ExportsPage.tsx` (`/exports`). Dashboard navigation is **no longer** a flat `NAV` array in `DashboardLayout.tsx`: it is the two-level `NAV_AREAS` registry in `src/modules/dashboard/ui/shell/nav-config.ts`, which already owns an area with `id: 'pipeline'` (Sprints + Calendar) — this feature joins that area rather than creating a new one.

## Problem

BuilderHunt can discover and track builders, but the act of *hiring* five people at once
lives outside the app: a CSV from `/exports`, a chat thread, and a pile of undifferentiated
notes. Nothing records where a candidate is in a process, who owns them, when they last
moved, or which cards have gone quiet. `organization_builders.status` was designed for this
and never wired up — **no code reads or writes it today**; only its check constraint
(`'tracked' | 'shortlisted' | 'archived'`) exists.

## Goal

A per-organization Kanban board over the org's tracked builders:

1. Ordered stages with a seeded default set (New → Reviewed → Contacted → In conversation → Hired),
   customizable on paid tiers.
2. A stage per tracked builder, an owner per tracked builder, a `changed_at` timestamp, and an
   append-only history of every transition.
3. Filters by stage and owner; notes that record the stage they were written in.
4. A board that stays fast for an organization tracking 500+ builders.

## Non-goals

- **User-configurable automation rules** — the "Team con automation rules" half of the idea — are
  deferred to a named follow-on plan, `pipeline-automation-rules`. Argued: a rule DSL either runs
  inline in the drag request (unbounded side-effect fan-out inside one tenant transaction, exactly
  what the no-queue constraint makes dangerous) or needs its own rule table, evaluation worker, and
  per-rule idempotency keys — larger than everything else in this plan combined. The highest-value
  rules also depend on surfaces that do not exist (no task entity) or are `blocked`
  (`activity-feed` for "notify the team"). Team's differentiator here is the bounded,
  non-configurable substitute in Phase 6: per-stage SLA thresholds plus a daily stale-card digest.
  The seam the successor plan will use already exists:
  `organization_builder_stage_events.source` accepts `'automation'`.
- No aggregate funnel analytics (per-stage conversion, median time-to-hire). Per-card "N days in
  stage" and per-stage counts are in; cohort math is not.
- No new notes table, no notes-in-JSONB, no per-stage note *threads*.
- No changes to `organization_builders.status`, legacy `builders`, or the visibility model.
- No AI: no task in `src/shared/lib/ai/tasks.ts`, no model calls, no new env vars.
- No realtime/multiplayer board sync. Moves are last-write-wins behind a conflict guard.

## User stories

1. As a **founder hiring 5 people**, I open `/pipeline`, see my tracked builders in columns, and
   drag one from Contacted to In conversation; the card shows "2d in stage".
2. As a **recruiter on a Team plan**, I filter the board to `owner = me` and see only my 14 cards.
3. As a **team admin on Pro**, I rename "Reviewed" to "Screened" and add a "Passed" terminal stage.
4. As a **member**, I add a note from a card sitting in Contacted; it stays readable *with* the
   stage it belonged to, so "we reached out about X" is not context-free.
5. As a **free-tier user**, I get all 5 default columns plus drag/assign/filter; only "Add stage"
   is locked with a Pro pill.
6. As a **Team owner**, I get one email a day listing cards past their stage SLA.

## Resolved design decisions

### `status` vs `pipeline_stage` — RESOLVED: a separate, FK-backed column

`organization_builders.status` stays exactly as it is. `pipeline_stage` is a new column.

Widening the existing `status` check constraint is not merely undesirable, it is **impossible**:
a static `CHECK (... in (...))` cannot validate a stage set that varies per organization. Custom
stages therefore require a relational reference, and a relational reference cannot live in the
same column as a fixed lifecycle enum.

The two axes are also genuinely orthogonal: `archived` (this row is out of my workspace) must be
expressible for a card whose last pipeline position was "In conversation", and that history must
survive archiving. `shortlisted` is semantically the second default stage, so the backfill maps
`status = 'shortlisted'` → `pipeline_stage = 'reviewed'` **without modifying `status`** — a
mapping that currently affects zero rows (nothing writes `'shortlisted'`), included for
correctness rather than necessity. Contracting the dead `status` column is out of scope.

### Custom stages: a table, not JSONB — RESOLVED

`_meta/security-policy.md` rule 8 permits validated versioned config in JSONB but requires
**relational references** to use typed columns and constraints. A stage set is not authorization
data, so JSONB on `organizations`/`organization_entitlements` would not violate the letter of
rule 8 — but `organization_builders.pipeline_stage` *is* a relational reference to a stage, and
with JSONB stages it would be a dangling text key validated only by application code, in exactly
the table where a wrong value silently hides a candidate from a column. A tenant-private table
gives it a composite tenant-preserving FK (rule 6) that the database enforces.

The table is small by construction (≤ 12 rows per organization, hard-capped), so this honors the
idea's "sin nueva tabla grande".

### Stage history: an append-only table, not just `changed_at` — RESOLVED

`pipeline_stage_changed_at` alone answers "how long here?" and nothing else: it cannot produce
time-in-each-stage, "who moved this and when", or the ATS reconciliation trail that
`ats-integrations` needs. `activity-feed` is `blocked` (it depends on `shared-resources`, also
blocked) and cannot be relied on for any of it.

So: `organization_builder_stage_events` is append-only and authoritative, and
`pipeline_stage_changed_at` is a **denormalized cache** of the latest event so the board query
needs no per-card lateral join. Growth is bounded by human behavior (~5–20 events per card;
≈ 7.5k rows for a 500-builder org) — no pruning, it is hiring-decision evidence.

### `pipeline_owner_user_id` is an assignment, never authority — RESOLVED

- Nullable. `NULL` = unassigned. Never consulted by `can()`; RLS remains `organization_id`-only.
  Any member may move or reassign any card (see Permissions), so an owner value can never widen
  or narrow access to a row.
- Validated on write against `organization_members` for the server-resolved organization — a
  client-supplied user ID is a selector, never a grant.
- FK `onDelete: 'restrict'` like `creator_user_id`, **not** `set null`: an `ON DELETE SET NULL`
  cascade fired from `auth_users` would have to touch rows in organizations the deleting context
  is not scoped to, which is precisely the RLS-silent-no-op class of bug that
  `drizzle/0026_deleted_user_sentinel.sql` and `app-reality.md` constraint 7 document.
- Hard account deletion therefore handles it explicitly inside
  `hardDeleteAccountSubject`'s existing per-membership `withTenantContext` loop
  (`src/shared/lib/repositories/account-privacy.ts:273`): `pipeline_owner_user_id` is set to
  `NULL` (an assignment is current state — the card becomes unassigned, which is the honest
  product outcome) while `organization_builder_stage_events.actor_user_id` is reassigned to
  `DELETED_USER_SENTINEL_ID` (an event is audit — it must keep a non-null actor).
- Member removal (`removeMemberRecord` in `src/shared/lib/auth/organization-lifecycle.ts:788`)
  likewise nulls that member's assignments in that one organization.

### Per-stage notes reuse `builder_notes` — RESOLVED

`builder_notes` is **not** legacy per-user: it carries `organization_id` (`NOT NULL` since
`drizzle/0081_wakeful_butterfly.sql`, the canonical tenant cutover), a composite
`(organization_id, builder_id) → builders(organization_id, id)` FK, forced RLS
(`drizzle/0008_tenant_rls.sql`), and its only live path is the tenant-scoped
`listOrganizationBuilderNotes`/`createOrganizationBuilderNote` pair behind
`/api/builders/$builderId/notes`.

One detail the stage-key default depends on, verified rather than assumed: `builder_notes.builder_id`
references the **legacy `builders`** table, but `trackOrganizationBuilder` dual-writes both tables
with the *same* primary key, so a note's `builder_id` is byte-identical to the
`organization_builders.id` of the same card. That is what `resolveOrganizationBuilderId`'s doc
comment states ("the id `builders`/`builderNotes` rows are actually keyed on") and what
`createOrganizationBuilderNote` already relies on when it validates the id through
`findOrganizationBuilder`. So the card's current stage is a plain
`findOrganizationBuilder(tx, orgId, builderId)` away — no extra join, no id translation.

Per-stage notes are therefore **one nullable typed column** on that table — `pipeline_stage_key`
with a composite FK to the stage table — plus an optional `stageKey` field on the existing POST
body that defaults to the card's current stage when the request comes from the board. No new table,
no new route, no JSONB. `builderhunt_app` already holds table-level
`SELECT, INSERT, UPDATE, DELETE` on `builder_notes` (`drizzle/0008_tenant_rls.sql:110-116`) and a
table-level grant covers columns added later, so the new column needs no new grant.

### Scale: stage-paginated, not board-paginated — RESOLVED

An organization tracking 500 builders must not download 500 cards. The board is one query that
returns **per-stage totals plus the first 25 cards of every stage**, via a single window-function
pass; each column then loads more on a `(pipeline_stage_changed_at, id)` cursor.

```sql
-- GET /api/pipeline/board — one round trip, counts and first page together
WITH ranked AS (
  SELECT ob.id, coalesce(ob.pipeline_stage, $firstStage) AS stage,
         ob.pipeline_stage_changed_at, ob.pipeline_owner_user_id, ob.private_metadata,
         bi.id AS identity_id, bi.username, bi.display_name, bi.avatar_url, bi.source, bi.profile_url,
         row_number() OVER (PARTITION BY coalesce(ob.pipeline_stage, $firstStage)
                            ORDER BY ob.pipeline_stage_changed_at DESC NULLS LAST, ob.id DESC) AS rn,
         count(*)     OVER (PARTITION BY coalesce(ob.pipeline_stage, $firstStage)) AS stage_total
  FROM organization_builders ob
  JOIN builder_identities bi ON bi.id = ob.builder_identity_id
  WHERE ob.organization_id = $org
    AND ($owner::text IS NULL OR ob.pipeline_owner_user_id = $owner)
)
SELECT * FROM ranked WHERE rn <= 25;
```

Cost: one index scan of `organization_builders_org_stage_changed_idx`
(`organization_id, pipeline_stage, pipeline_stage_changed_at DESC`) plus a PK join to
`builder_identities`, bounded output of ≤ 12 × 25 = 300 rows. Estimated < 25 ms at 500 tracked
builders; the acceptance check in `tasks.md` measures it against 500 seeded rows rather than
trusting this number. No virtualization library — 300 cards is ordinary DOM. `/api/me/builders`
stays unpaginated (a pre-existing wart, out of scope) and is deliberately **not** reused.

### Tier gating with `STRIPE_BILLING_ENABLED = false` — RESOLVED

Nobody can self-upgrade today, so the free-tier board must be genuinely useful or the feature is
dead on arrival: **every tier gets all 5 default stages, drag, assign, filters, per-stage notes,
and history.** The paid axis is customization and the digest.

```ts
// src/shared/lib/billing-shared.ts — beside SOURCING_SPRINT_LIMITS.
//
// Keyed by OrganizationTier, NOT PlanTier. This is not a style choice: the comment
// above SOURCING_SPRINT_LIMITS (billing-shared.ts:44-53) records that keying an
// *advertised* allowance by PlanTier forced every enforcement site through
// resolveLegacyPlanTier and let the pricing page and the routes drift apart by 7
// sprints before anyone noticed. The stage cap is advertised — the free-tier board
// renders a "Pro" pill linking to /pricing — so it gets its own explicit pro_max row
// and is indexed by `entitlement.tier` directly.
export const PIPELINE_STAGE_LIMITS: Record<OrganizationTier, number> = {
  free: 5,
  pro: 8,
  pro_max: 12,
  team: 12,
}

// src/shared/lib/pipeline/entitlement.ts
// `EntitlementPolicy` / `resolveEntitlementPolicy` come from
// src/shared/lib/repositories/entitlements.ts (the policy interface is declared at :25,
// the pure resolver at :53).
export function pipelineCapabilities(entitlement: EntitlementPolicy) {
  return {
    maxStages: PIPELINE_STAGE_LIMITS[entitlement.tier],
    // Reads/moves are never gated; only structural changes are.
    canCustomizeStages: entitlement.tier !== 'free' && entitlement.paidActionsAllowed,
    // Deliberately the RAW tier, not resolveLegacyPlanTier: SLA + digest are multi-seat
    // coordination features and Pro Max has seat_limit 1, so there is nobody to coordinate
    // with. A solo founder arguably still wants the digest — if Pro Max ever gets seats,
    // this one predicate becomes resolveLegacyPlanTier(...) === 'team'.
    canSetStageSla: entitlement.tier === 'team' && entitlement.paidActionsAllowed,
    staleDigest: entitlement.tier === 'team',
  }
}
```

Note the consequence of the `OrganizationTier` keying: `pro_max` gets 12 stages (the Team number),
which is what a top-tier plan should get and what the `/pricing` copy will state, whereas the
previous `Record<PlanTier, …>` shape had no `pro_max` row at all and only produced 12 by laundering
Pro Max through `resolveLegacyPlanTier`.

A past-due org keeps reading its custom stages (`paidActionsAllowed` false only blocks writes),
and a downgrade never deletes stages — it blocks adding new ones. Grants come from
`setPlatformUserPlan` today, exactly like `SOURCING_SPRINT_LIMITS`.

## Architecture

### Schema (Drizzle, `src/shared/lib/db/schema.ts`)

`primaryKey` is not in that file's `drizzle-orm/pg-core` import list today and no composite
`primaryKey({ columns: … })` exists anywhere in it yet — `organization_pipeline_stages` is the
schema's first, so the import needs extending and there is no in-repo precedent to copy from.

```ts
// Data class: tenant-private (organization_id). Composite PK IS the tenant-preserving key.
export const organizationPipelineStages = pgTable('organization_pipeline_stages', {
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),                       // immutable slug: [a-z0-9_]{1,32}
  label: text('label').notNull(),                   // editable display name
  position: integer('position').notNull(),
  isTerminal: boolean('is_terminal').notNull().default(false), // Hired/Passed — never "stale"
  staleAfterDays: integer('stale_after_days'),      // Team-only SLA; null = no SLA
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.key] }),
  // Index, NOT unique: a reorder renumbers several rows in one statement and a
  // non-deferrable unique index would fail on the transient collision. Contiguity is an
  // application invariant (reorderStages), ties broken by key for determinism.
  index('organization_pipeline_stages_org_position_idx').on(table.organizationId, table.position),
  check('organization_pipeline_stages_key_check', sql`${table.key} ~ '^[a-z0-9_]{1,32}$'`),
  check('organization_pipeline_stages_stale_check', sql`${table.staleAfterDays} is null or ${table.staleAfterDays} between 1 and 365`),
])

// Data class: tenant-private, append-only. Source of truth for stage history.
export const organizationBuilderStageEvents = pgTable('organization_builder_stage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  organizationBuilderId: text('organization_builder_id').notNull(),
  actorUserId: text('actor_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  fromStage: text('from_stage'),                    // null = first entry into the pipeline
  toStage: text('to_stage').notNull(),
  // Deliberately NO FK on from_stage/to_stage: an audit row must survive a later stage
  // deletion (same rationale as organization_deletion_requests' unreferenced organization_id).
  source: text('source').notNull().default('ui'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.organizationId, table.organizationBuilderId],
    foreignColumns: [organizationBuilders.organizationId, organizationBuilders.id],
    name: 'organization_builder_stage_events_organization_builder_fk',
  }).onDelete('cascade'), // untracking a builder removes its events; no manual delete needed
  index('organization_builder_stage_events_builder_idx').on(table.organizationId, table.organizationBuilderId, table.occurredAt),
  index('organization_builder_stage_events_org_occurred_idx').on(table.organizationId, table.occurredAt),
  check('organization_builder_stage_events_source_check',
    sql`${table.source} in ('ui', 'automation', 'ats', 'import', 'backfill')`),
])
```

Additive columns on existing tables:

```ts
// organization_builders (+3) — pipelineStage stays nullable permanently: NULL means "the org's
// position-0 stage". This is not an expand-phase placeholder awaiting contraction (the way
// organization_id once was, before drizzle/0081 made it NOT NULL on the last seven tables). It is
// the design: trackOrganizationBuilder is on the hot search path and is deliberately left
// untouched, so every newly tracked card arrives with NULL, and resolveStageForCard maps NULL to
// position 0. A NOT NULL default would force either a track-path change or a per-org default
// lookup on insert; neither buys anything the coalesce in the board query does not.
pipelineStage: text('pipeline_stage'),
pipelineStageChangedAt: timestamp('pipeline_stage_changed_at', { withTimezone: true }),
pipelineOwnerUserId: text('pipeline_owner_user_id').references(() => authUsers.id, { onDelete: 'restrict' }),
// + foreignKey([organizationId, pipelineStage] -> organizationPipelineStages[organizationId, key]).onDelete('restrict')
// + index('organization_builders_org_stage_changed_idx').on(organizationId, pipelineStage, pipelineStageChangedAt)
// + index('organization_builders_org_owner_idx').on(organizationId, pipelineOwnerUserId)

// builder_notes (+1)
pipelineStageKey: text('pipeline_stage_key'),
// + foreignKey([organizationId, pipelineStageKey] -> organizationPipelineStages[organizationId, key]).onDelete('set null')
```

Stage deletion is `restrict` on cards (the API demands an explicit `reassignTo`) and `set null`
on notes (a note survives its stage disappearing).

### Permissions (`src/shared/lib/authorization/permissions.ts`)

Two new `PermissionAction` values — never inline role comparisons (a boundary test forbids them):

- `'pipeline:move'` → `true` for every role. Justified: `organization_builders` is already
  documented as an organization-owned resource "visible/manageable by the whole org, not just
  their creator" (`drizzle/0026`), and `listOrganizationBuilders` already ignores `visibility`
  entirely. Routing a stage move through `'resource:update'` would make a colleague's card
  unmovable (default `visibility = 'private'`), which breaks the feature for exactly the teams
  it exists for.
- `'pipeline:configure'` → `owner | admin`. Stage CRUD, reorder, SLA.

Untrack/delete keeps using today's stricter `'resource:delete'` path, unchanged.

### Repositories and pure lib

Pure logic in `src/shared/lib/pipeline/` (**all new**): `stages.ts` (`DEFAULT_PIPELINE_STAGES`,
`normalizeStageKey`, `validateStageSet`, `reorderStages`, `resolveStageForCard` — NULL →
position-0), `staleness.ts` (`daysInStage`, `isStale`), `entitlement.ts`
(`pipelineCapabilities`). Their specs live in `tests/unit/shared/lib/pipeline/` (**new**) — this
repo has no co-located tests under `src/`; `vitest.config.ts` includes only `tests/unit/**`.

Tenant data access in `src/shared/lib/repositories/pipeline.ts` (**new**) and
`src/shared/lib/repositories/pipeline-worker.ts` (**new**, worker reads via
`withWorkerOrganization`, cloned from `repositories/alerts-worker.ts:10-27`) — every function takes
`TenantTransaction` first and the modules never import the global `db`, which
`pnpm security:boundaries` enforces. The digest itself is `src/lib/pipeline/worker.ts` (**new**),
beside the existing `src/lib/alerts/worker.ts`. Full function list in `tasks.md` Phase 3.

`ensureDefaultPipelineStages` is idempotent (`onConflictDoNothing`) and called lazily at the top
of `loadBoard` and the stage-mutation routes, so organizations created after the migration seed
themselves without touching `better-auth.ts`'s bootstrap hook.

### API surface

| Route (file under `src/routes/api/pipeline/`, all new) | Method | Auth / gate |
| --- | --- | --- |
| `/api/pipeline/board` (`board.ts`) | GET | tenant principal; `?stage=`, `?owner=`, `?cursor=` |
| `/api/pipeline/builders/$builderId` (`builders/$builderId.ts`) | PATCH | `can('pipeline:move')`; body `{ stage?, ownerUserId?, expectedStage? }` |
| `/api/pipeline/builders/$builderId/events` (`builders/$builderId/events.ts`) | GET | tenant principal |
| `/api/pipeline/stages` (`stages/index.ts`) | GET, POST | GET tenant principal; POST `can('pipeline:configure')` + `maxStages` |
| `/api/pipeline/stages/$stageKey` (`stages/$stageKey.ts`) | PATCH, DELETE | `can('pipeline:configure')`; DELETE needs `reassignTo` |
| `/api/pipeline/stages/reorder` (`stages/reorder.ts`) | POST | `can('pipeline:configure')` |
| `/api/pipeline/stale` (`stale.ts`) | GET | tenant principal + `staleDigest` |
| `/api/admin/pipeline/run-worker` (`admin/pipeline/run-worker.ts`) | POST | `tryCronPrincipal ?? requirePlatformAdminPrincipal` |

The `stages.ts` + `stages/` file pair is deliberately written as `stages/index.ts` + `stages/*.ts`,
matching `src/routes/api/alerts/index.ts` + `alerts/$id.ts`. A sibling `$builderId.ts` next to a
`$builderId/` directory is also an existing pattern (`src/routes/api/builders/`), so the two
`builders/` entries above are conventional.

Every one of these routes uses `requireTenantPrincipal`/`withTenantContext` or
`requirePlatformAdminPrincipal`, which is what `pnpm security:route-coverage`
(`scripts/check-route-coverage.mjs`) requires of anything under `src/routes/api/**` that is not on
its public allowlist. None of them may compare `principal.role` against a role literal —
`pnpm security:boundaries` (`scripts/check-tenant-boundaries.mjs`) fails the build on that, which is
why `pipeline:move`/`pipeline:configure` exist at all.

`expectedStage` is the concurrency guard: if the row's current stage differs, respond
`409 { error: 'stage_conflict', currentStage }` and the UI re-fetches instead of silently
overwriting a colleague's move. `PATCH` writes the row, the `changed_at` cache, and the event in
**one** `withTenantContext` transaction.

### Background work (no queue)

`POST /api/admin/pipeline/run-worker` clones `src/routes/api/admin/alerts/run-worker.ts`. That
route has three moving parts today, all of which the clone must carry — the alerts route was
extended after this plan was first written and a two-part clone would now be wrong:

1. `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`.
2. `withJobRun({ jobKey: 'pipeline.stale-digest' }, …)`, which opens and closes exactly one
   `job_runs` row per scheduled run and maps the worker's counters onto
   `{ processedCount, failedCount, payload }`. `builderhunt_worker` holds
   `SELECT, INSERT, UPDATE` on `job_runs` and `SELECT, UPDATE` on `operational_schedules`
   (`drizzle/0067_operational_schedule_grants.sql:22-23`), so no new grant is needed —
   but the job key **must** be registered in `OPERATIONAL_SCHEDULES`
   (`src/shared/lib/operational-schedules.ts`) or the run gets a null `schedule_id` and never
   appears on the operations calendar. `pipeline.stale-digest` is unclaimed; the registry's
   `assertRegistryIsSafe` requires the `sourceRoute` to start with `/api/admin/`, which it does.
3. `auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker', targetId: 'pipeline', result: 'allowed' })`
   — note the principal is the **first positional argument**, and `targetType`/`result` are
   required alongside `action`/`targetId`.

Per organization, in its own worker transaction: skip unless
`pipelineCapabilities(...).staleDigest`; collect cards whose stage has `stale_after_days` and whose
`pipeline_stage_changed_at` is older than that; email each card's **assigned owner** via a new
`sendPipelineStaleDigestEmail` in `src/shared/lib/email.ts`, modelled on `sendAlertDigestEmail`
(`src/shared/lib/email.ts:249`). That model has three branches in this order and the clone must
keep all three: the `isE2EOutboxActive()` short-circuit into `dispatchEmail` (the E2E outbox seam —
`dispatchEmail` **throws** outside `E2E_MODE=true`, so it can never be the only branch), the
`!env.RESEND_API_KEY` dev-mode console preview, then the real Resend `fetch`.

Unassigned stale cards are counted but emailed to nobody — an owner fallback would require
`organization_members`, which `builderhunt_worker` has no grant on at all. Resolving an owner's
address uses the `GRANT SELECT (id, email) ON auth_users` the worker already has
(`drizzle/0010_worker_alert_policies.sql:29`), the same read `alerts-worker.ts`'s
`findWorkerUserEmail` performs. Idempotent: a run is skipped for an org whose newest digest event is
younger than 20 h, so a double cron hit does not double-email. Cron cadence: daily. No new env
vars — it degrades to a no-op when `RESEND_API_KEY` is unset.

Reading the cards themselves needs no new grant either: `drizzle/0018_enrichment_worker_target_access.sql:6-12`
already gives `builderhunt_worker` an org-scoped SELECT policy **and** a table-level
`GRANT SELECT ON organization_builders`, and a table-level grant covers the three columns this plan
adds. Only the two new pipeline tables need worker SELECT policies and grants of their own.

The worker resolves the tier through a narrow `getWorkerEntitlementPolicy` (three columns of
`organization_entitlements` fed to the pure `resolveEntitlementPolicy`,
`src/shared/lib/repositories/entitlements.ts:53`), **not** `getOrganizationEntitlement`
(`entitlements.ts:78-100`).

The reason is `organization_entitlements`, and only that. Every `GRANT … TO builderhunt_worker` in
`drizzle/*.sql` was re-enumerated at HEAD, multi-line statements included, and
`organization_entitlements` appears in none of them: `drizzle/0008_tenant_rls.sql:45,108` gives it
an app-only policy and an app-only grant, `0010` (the full worker grant set) omits it, and nothing
since has added it. So `getOrganizationEntitlement` fails with `42501` on its *first* query when run
as `builderhunt_worker`.

An earlier draft of this plan also claimed `billing_subscriptions` has no worker grant. **That is
false** — `drizzle/0028_billing_rls_grants.sql:294-298` grants `builderhunt_worker`
`SELECT, INSERT, UPDATE` on it (inside a multi-line table list, which is how the original audit
missed it), backed by org-scoped worker policies at `:166-174`. Its second query is fine.

The narrow helper therefore stays, but as a least-privilege choice rather than a necessity: with the
column-scoped `organization_entitlements` grant in place, `getOrganizationEntitlement` *would* work
as the worker. It is still the wrong call here — `pipelineCapabilities(...).staleDigest` reads only
`tier`, so pulling a subscription row to compute a `paymentBlocked` flag that never reaches a
predicate is a second table read and a second failure mode for nothing. `paymentBlocked` is passed
as a hard-coded `false`. The one column-scoped worker grant this does need ships in the same
RLS/grants migration as the two new tables.

## UX integration

- Navigation goes into `src/modules/dashboard/ui/shell/nav-config.ts`, **not** into
  `DashboardLayout.tsx`. The flat `NAV`/`MOBILE_NAV_ITEMS` arrays this plan was written against are
  gone; Shell C derives the rail, the level-2 panel, the breadcrumb and the mobile drawer from the
  single `NAV_AREAS` array, and `DashboardLayout.tsx` only composes the regions.
  There is already an area with `id: 'pipeline'`, `label: 'Pipeline'`, owning
  `routes: ['/sprints', '/calendar']`. The board joins that area — it does not get a new one:
  - append `'/pipeline'` to that area's `routes` (prefix ownership is what lights the rail;
    without it `resolveActiveArea('/pipeline')` silently falls back to Home);
  - append `{ to: '/pipeline', label: 'Board', icon: KanbanSquare, group: 'Pipeline', exact: true }`
    to its `items`. `KanbanSquare` is exported by the installed `lucide-react`.
  An item may only be listed under an area that owns its prefix — `nav-config.test.ts` asserts this,
  because an item under the wrong area swaps the rail out from under the user on click. Label
  "Board" rather than "Pipeline" so `breadcrumbFor` renders `Pipeline › Board` instead of
  collapsing to a single crumb.
  New route `src/routes/_dashboard/pipeline/index.tsx` (**new**), mirroring
  `src/routes/_dashboard/sprints/index.tsx`.
- `src/modules/pipeline/components/` (**all new**): `PipelineBoard.tsx` (columns, filters, stage
  settings entry), `StageColumn.tsx` (header with label + count + SLA dot, "Load more"),
  `PipelineCard.tsx` (avatar, name, source, owner chip, "Nd in stage", stale badge),
  `CardDetailDrawer.tsx` (stage history from `/events` + the existing notes endpoints),
  `StageSettingsDialog.tsx`.
  Built from existing `src/components/ui` primitives — verified present: `button.tsx`, `input.tsx`,
  `select.tsx`, `dialog.tsx`, `label.tsx`.
- **Accessibility is not an afterthought**: HTML5 drag-and-drop (no new dependency) is the mouse
  affordance, and every card also has a keyboard/screen-reader "Move to…" `Select` that hits the
  same PATCH. Column changes announce via an `aria-live` region.
- Free tier: "Add stage" and the SLA field render locked with a Pro/Team pill linking to
  `/pricing`; everything else is fully enabled.
- `/exports`: `GET /api/me/builders` and `GET /api/export/builders` gain `pipelineStage`,
  `pipelineStageChangedAt`, and `pipelineOwnerUserId` — the CSV is where this feature's "why"
  started. Both routes build their rows from `listOrganizationBuilders`, whose column list is the
  shared `privateBuilderFields` object (`repositories/organization-builders.ts:31-47`); the three
  columns are added there once and both consumers pick them up. `/api/export/builders` additionally
  passes its rows through `filterSuppressed` — leave that in place.

## Success metrics

- ≥ 40% of organizations with > 10 tracked builders move at least one card within 14 days.
- Board p95 < 150 ms server-side at 500 tracked builders (measured, not assumed).
- Median stage-transition count per hired card ≥ 3 (the funnel is actually being used, not just
  set once).
- Zero cross-tenant board/stage/event reads in `pnpm test:api-isolation:local`.

## Resolved edge cases

- **Cards never explicitly moved**: `pipeline_stage IS NULL` renders in the position-0 column and
  has no stage event; its "days in stage" falls back to `organization_builders.created_at`.
- **Newly tracked builder**: `trackOrganizationBuilder` is left untouched (it is on the hot search
  path and dual-writes legacy `builders`); new rows simply start at NULL = first stage. No
  migration of the track path, no first event until the first real move.
- **Deleting a stage that holds cards**: `409 { error: 'stage_not_empty', count }` without
  `reassignTo`; with it, cards move in one transaction and each gets a `source: 'ui'` event.
- **Last stage / all-terminal set**: `validateStageSet` refuses a set with zero non-terminal
  stages or fewer than two stages.
- **Downgrade below the current stage count**: existing stages remain readable and usable; only
  `POST /api/pipeline/stages` returns `403 { error: 'plan', limit }`.
- **Two members drag the same card**: `expectedStage` → 409, UI refetches. Last-write-wins is
  never silent.
- **Owner removed from the org / account hard-deleted**: assignment nulled, history preserved with
  `system-deleted-user` as actor (see the RESOLVED section above).
- **Stage filter + owner filter together**: both are indexed predicates on the same composite
  scan; combining them narrows, never fans out.
- **`ats-integrations` handoff**: see the published contract below.

## Published stage-model contract

`ats-integrations` is build-order item 8 and is hard-blocked on this plan (item 3) because it maps
each external ATS status onto this stage model. The stage model is therefore a **published
contract**, not an internal detail. These six clauses are what a downstream plan may rely on; a
change to any of them is a breaking change that must be coordinated with every consumer.

1. **A stage is identified by `(organization_id, key)`.** `key` is an immutable
   `^[a-z0-9_]{1,32}$` slug and is the composite primary key of `organization_pipeline_stages`.
   `label` is display-only and may be renamed at any time; nothing may key off it. `position` is
   presentation order and is renumbered by `reorderStages`; nothing may key off it either.
2. **The default set is exactly five keys, in this order**: `new`, `reviewed`, `contacted`,
   `in_conversation`, `hired` (`hired` is the only `is_terminal` default). They exist for every
   organization — seeded by the Phase 1 data migration for organizations that predate it, and
   lazily by `ensureDefaultPipelineStages` for every organization created after. A consumer that
   only ever maps onto these five keys never has to handle a missing stage.
3. **A card's stage is nullable and NULL is not "no stage"** — it means "the organization's
   `position = 0` stage". Every reader must resolve it with `resolveStageForCard`, never treat NULL
   as absent. New cards from `trackOrganizationBuilder` always start NULL.
4. **The only sanctioned write path is `moveBuilderStage(tx, orgId, builderId, { toStage, actorUserId, expectedStage?, source })`.**
   A consumer must never `UPDATE organization_builders SET pipeline_stage`: the function writes the
   column, the `pipeline_stage_changed_at` cache and the `organization_builder_stage_events` audit
   row in one transaction, and a direct update silently desynchronizes all three.
5. **`source` is a closed set**, enforced by a check constraint:
   `'ui' | 'automation' | 'ats' | 'import' | 'backfill'`. ATS write-back uses `'ats'`; the
   deferred `pipeline-automation-rules` plan uses `'automation'`. Adding a sixth value is a
   migration, not a code change.
6. **Stage history is append-only and survives stage deletion.** `from_stage`/`to_stage` are
   deliberately un-FK'd text so an audit row outlives the stage it names; consumers reading history
   must tolerate a `to_stage` that no longer exists in `organization_pipeline_stages`. Events
   cascade only when the card itself is untracked.

Unresolvable external statuses are the consumer's problem, not this plan's: `ats-integrations` maps
an unknown external status to *no* move and surfaces it, rather than inventing a stage. Creating
stages is `pipeline:configure` + `canCustomizeStages` + `maxStages`, and a background sync holds
none of those.
