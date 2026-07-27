# Hiring Pipeline Kanban (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md) (tenant-private `organization_builders` ownership, RLS, tenant principal — all shipped; that plan stays `in_progress` only for the legacy-column contraction, which this one does not touch, so nothing here waits on it); [`team-accounts`](../../phase-1/team-accounts/spec.md) (organization roles and seats — already implemented). Enhanced by [`activity-feed`](../../phase-1/activity-feed/spec.md) (stage-change events; not required).
> **Blocks**: [`ats-integrations`](../ats-integrations/spec.md) (hard — the ATS sync maps its external status back onto this plan's stage model)
> **Reality check**: Extends `src/shared/lib/db/schema.ts` (`organizationBuilders`, `builderNotes`), `src/shared/lib/repositories/organization-builders.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/billing-shared.ts`, `src/modules/dashboard/ui/shell/nav-config.ts` (**not** `DashboardLayout.tsx` — the flat `NAV` array is gone, navigation is the two-level `NAV_AREAS` registry and an area with `id: 'pipeline'` already exists), `src/shared/lib/operational-schedules.ts`, `src/routes/api/me/builders/index.ts`, `src/routes/api/export/builders.ts`. Clones the worker pattern of `src/routes/api/admin/alerts/run-worker.ts` (`tryCronPrincipal ?? requirePlatformAdminPrincipal` + `withJobRun` + `auditPlatformAdminAction`) and the RLS/grants shape of `drizzle/0044_abuse_usage_integrity_rls_grants.sql`. `organization_builders.status` and legacy `builders` are not modified.

## Phases (dependency order — shippable after each)

### Phase 1 — Schema, RLS, backfill

Add `organization_pipeline_stages` and `organization_builder_stage_events`; add the three
`organization_builders` columns and `builder_notes.pipeline_stage_key` with their composite
tenant FKs and indexes. Generate the DDL migration with
`pnpm exec drizzle-kit generate --name pipeline_kanban`, then hand-write two follow-on migrations
drizzle-kit cannot emit — both minted via `drizzle-kit generate --custom` so the journal entry and
`drizzle/meta/NNNN_snapshot.json` exist (`pnpm test:migration-integrity` fails otherwise;
grants-only migrations are not exempt): RLS + per-role grants mirroring `0044`, and an idempotent
batched data migration that seeds the 5 default stages for every existing organization and
backfills `pipeline_stage` / `pipeline_stage_changed_at` (mapping `status = 'shortlisted'` →
`reviewed` without touching `status`).

**No migration number is written down anywhere in this plan.** The head of `drizzle/` moves
constantly (86 journal entries as of 2026-07-27, and two of the newest files are uncommitted
working-tree WIP). Every migration task reads the real next index from `drizzle/meta/_journal.json`
at the moment it runs; a hardcoded `00NN` in a task is a defect.

The grants migration also adds the one grant Phase 6 needs and no existing migration provides: a
column-scoped `builderhunt_worker` SELECT on `organization_entitlements` (`0008` scopes it to
`builderhunt_app`; `0010`, the full worker grant set, omits it; nothing since has added it —
verified by enumerating every `GRANT … TO builderhunt_worker` in `drizzle/*.sql`). It does **not**
need to grant the worker anything on `organization_builders`: `drizzle/0018_enrichment_worker_target_access.sql:6-12`
already ships the org-scoped policy and the table-level SELECT, which covers the new columns.
Register both tables in `docs/architecture/data-classification.md`. App behavior unchanged — three
dead columns and two empty-but-seeded tables.

### Phase 2 — Pure stage/staleness lib + permissions

`src/shared/lib/pipeline/stages.ts` (defaults, key normalization, set validation, reorder,
NULL→position-0 resolution), `staleness.ts` (`daysInStage`, `isStale`), and
`entitlement.ts` (`pipelineCapabilities`), each with a matching spec under
`tests/unit/shared/lib/pipeline/` (this repo has **zero** co-located tests under `src/`;
`vitest.config.ts` includes only `tests/unit/**`). Add `PIPELINE_STAGE_LIMITS` — keyed by
`OrganizationTier`, not `PlanTier`, per the drift lesson recorded above `SOURCING_SPRINT_LIMITS` —
to `billing-shared.ts`, and the `'pipeline:move'` / `'pipeline:configure'` actions to
`permissions.ts` with `can()` coverage. Both action names are still unclaimed at HEAD. `can()` is
an exhaustive `switch` with no `default` arm, so adding to `PermissionAction` without adding a case
is a type error, not a silent allow. Still no user-visible change; everything here is pure and
unit-tested before a single query touches it.

### Phase 3 — Tenant repository

`src/shared/lib/repositories/pipeline.ts`: `ensureDefaultPipelineStages`, stage CRUD/reorder,
`loadBoard` (the single window-function query from spec.md), `loadStagePage`, `moveBuilderStage`
(row + `changed_at` cache + event, one transaction), `assignBuilderOwner` (validated against
`organization_members`), `clearPipelineOwner`, `listStageEvents`. Extend
`deleteOrganizationBuilder`'s doc comment to record that events cascade. Wire owner lifecycle:
member removal calls `clearPipelineOwner` from the `removeMember` orchestrator under
`withTenantContext` (the `builderhunt_app` role, which holds UPDATE on `organization_builders`) —
**not** from `removeMemberRecord`, which runs as `builderhunt_auth` and has no grant on that table;
and `hardDeleteAccountSubject` nulls assignments while sentinelling event actors. Repository unit
test proves owner validation rejects a non-member.

### Phase 4 — API routes

`GET /api/pipeline/board`, `PATCH /api/pipeline/builders/$builderId` (with the `expectedStage`
409 guard), `GET /api/pipeline/builders/$builderId/events`, `GET|POST /api/pipeline/stages`,
`PATCH|DELETE /api/pipeline/stages/$stageKey`, `POST /api/pipeline/stages/reorder`. Add the
optional `stageKey` field to the existing notes POST. Extend
`scripts/db/verify-api-isolation-local.mjs` with a `checkPipeline()` covering tenant A vs tenant
B on board/stage/event/move, a spoofed `ownerUserId` from another organization, and a member
attempting `pipeline:configure`. Ships as a headless, curl-usable API.

### Phase 5 — Board UI

`/pipeline` route, the `nav-config.ts` area/item entries (plus the `nav-config.test.ts` cases that
registry demands), `PipelineBoard` / `StageColumn` / `PipelineCard` / `CardDetailDrawer` /
`StageSettingsDialog`. HTML5 drag-and-drop plus the keyboard "Move to…" select and `aria-live`
announcements. Stage/owner filters wired to URL state. Free-tier locks on "Add stage" and the SLA
field. Add stage columns to the shared `privateBuilderFields` select so `/api/me/builders` and the
CSV export both pick them up.

### Phase 6 — Team SLA digest worker

`stale_after_days` editing (Team-gated), `GET /api/pipeline/stale`, `pipeline-worker.ts` +
`getWorkerEntitlementPolicy` + `runPipelineDigestWorker`, `sendPipelineStaleDigestEmail`, the
`pipeline.stale-digest` entry in the `OPERATIONAL_SCHEDULES` registry, and
`POST /api/admin/pipeline/run-worker` cloned from the alerts worker — including the `withJobRun`
wrapper the alerts route gained after this plan was written. The worker resolves tier from three
columns of `organization_entitlements` through the pure `resolveEntitlementPolicy`, never
`getOrganizationEntitlement` — that table is the one the worker genuinely cannot read (no grant in
any migration), and the subscription row the full helper additionally fetches is dead weight for a
predicate that only reads `tier`. Acceptance runs the worker as the real
`builderhunt_worker` role against a seeded eligible org and requires `emailsSent >= 1`; a zero is a
failed grant, not a pass. Daily cron note documented alongside the existing crontab entries.
Configurable automation rules remain out of scope, recorded as the follow-on plan
`pipeline-automation-rules`.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Composite FK on a nullable `pipeline_stage` blocks the backfill if stage rows are not seeded first | Medium | High | Data migration seeds stages for every org **before** the `UPDATE`; single migration file, ordered statements, idempotent re-run |
| Non-unique `position` drifts into duplicates via concurrent reorders | Medium | Low | `reorderStages` rewrites the whole set in one statement inside the tenant transaction; `validateStageSet` asserts contiguity; ties broken by `key` so rendering stays deterministic |
| Grants forgotten on the two new tables → route works as DB owner, 42501 as `builderhunt_app` | High (this repo's documented failure mode, constraint 7) | High | Dedicated RLS+grants migration and a mandatory `checkPipeline()` addition to `pnpm test:api-isolation:local` before Phase 4 closes |
| Digest reads an entitlement table the worker role cannot see → `emailsSent: 0` forever, and a naive verify passes vacuously | High (re-confirmed at HEAD 2026-07-27 by re-enumerating every `GRANT … TO builderhunt_worker`, multi-line statements included: `organization_entitlements` is app-only in `0008` and appears in no worker grant anywhere) | High | Column-scoped worker grant + policy in the Phase 1 migration; worker reads only 3 columns via the pure `resolveEntitlementPolicy`; Phase 6 acceptance seeds an eligible org and **requires `emailsSent >= 1` as the real `builderhunt_worker` role** |
| The plan's stated reason for avoiding `getOrganizationEntitlement` was partly wrong: it claimed `billing_subscriptions` has no worker grant | **Materialized** — `drizzle/0028_billing_rls_grants.sql:294-298` does grant the worker `SELECT, INSERT, UPDATE` on it, inside a multi-line table list the original single-line grep missed | Low | Corrected in spec.md. The narrow `getWorkerEntitlementPolicy` is kept, but now as an explicit least-privilege choice (`staleDigest` reads only `tier`, so the subscription read and the `paymentBlocked` computation are dead weight) rather than as a workaround for a grant that turns out to exist. The `organization_entitlements` gap it actually works around is real and re-verified |
| The dashboard shell was rewritten under this plan: the flat `NAV`/`MOBILE_NAV_ITEMS` arrays it targeted no longer exist, and an area already occupies `id: 'pipeline'` | **Materialized** — found at HEAD, not predicted | Medium | Redesigned rather than patched: the board joins the existing `pipeline` area in `nav-config.ts` (append `'/pipeline'` to `routes`, append a `label: 'Board'` item) instead of creating a second area. Prefix ownership is mandatory — without it `resolveActiveArea('/pipeline')` falls back to Home and the rail lights the wrong icon, which `nav-config.test.ts` is written to catch. Item label is "Board", not "Pipeline", so `breadcrumbFor` renders two crumbs instead of collapsing to one |
| `PIPELINE_STAGE_LIMITS` keyed by `PlanTier` re-creates the exact advertised-vs-enforced drift `SOURCING_SPRINT_LIMITS` was fixed for | **Materialized** — the original spec wrote `Record<PlanTier, number>`, which `billing-shared.ts:44-53` documents as the bug shape | Medium | Keyed by `OrganizationTier` with an explicit `pro_max: 12` row and indexed by `entitlement.tier` directly. The cap is advertised (the free board renders a Pro pill linking to `/pricing`), which is precisely the condition under which `entitlements.ts`'s own doc comment forbids routing through `resolveLegacyPlanTier` |
| The alerts run-worker route gained `withJobRun` (one `job_runs` row per run) after this plan was written; a literal "clone the two-part route" instruction now produces a worker with no operational-calendar presence | Medium | Low | Phase 6 clones all three parts and registers `pipeline.stale-digest` in `OPERATIONAL_SCHEDULES`. No new grant: `0067` already gives the worker `job_runs` INSERT/UPDATE and `operational_schedules` SELECT/UPDATE |
| Owner null-out written on the wrong connection (`authDb` has no grant on `organization_builders`) → silent no-op, then `restrict` makes accounts undeletable | Medium | High | Null-out moved to the `removeMember` orchestrator under `withTenantContext` (app role); member-removal case added to `checkPipeline()`; `checkLegalRunWorker` re-run with an account that owns cards and authored events |
| Hand-written migration ships without a journal entry/snapshot → `pnpm test:migration-integrity` red | Medium (`0045` did exactly this; it now has its snapshot and the check is green at 86/86/86) | Low | Every hand-written migration minted with `drizzle-kit generate --custom`; snapshot, journal, and `migration-hashes.json` listed in each task's `Files:` line. `scripts/db/verify-migration-integrity.mjs:12-15` compares the journal's tags against `drizzle/*.sql` **and** its indices against `drizzle/meta/NNNN_snapshot.json`; a missing snapshot fails before any hash is computed |
| A hardcoded migration number in a task collides with whatever actually landed first | High (three fase-2 plans once claimed `0046`; `drizzle/` has since moved 40 migrations past it) | Medium | No number appears in any task. Every migration task's first instruction is to read `drizzle/meta/_journal.json` and let `drizzle-kit` assign the index |
| `pipeline:move` for every role is read as a security regression in review | Medium | Medium | Argued in spec.md against real current behavior (`listOrganizationBuilders` ignores `visibility`; `0026` documents org-owned semantics); stage CRUD stays elevated-only; flagged for the security review that `_meta/security-policy.md` requires on authorization changes |
| Board query degrades on a very large org (10k+ tracked) | Low | Medium | Window query is a single indexed scan with bounded output; acceptance check measures 500 seeded rows and records the plan; column cursor paging already in place if it regresses |
| Stale digest double-emails on a double cron hit | Medium | Low | Per-org 20 h skip guard keyed on the newest digest event; no email at all when `RESEND_API_KEY` is unset |
| Scope creep into automation rules during Phase 6 | High | High | Named non-goal in spec.md with the technical reason (no queue, no notification surface, no task entity) and a named successor plan; Phase 6 ships exactly one non-configurable behavior |
| `ats-integrations` writes `pipeline_stage` directly and skips the event row | Medium | Medium | Contract stated in spec.md's edge cases: the only sanctioned write path is `moveBuilderStage(..., { source: 'ats' })`; `source` check constraint already enumerates `'ats'` |

## Rollback

- **Phase 1** is additive and invisible: two new tables plus four nullable columns. Roll back by a
  forward migration dropping them in FK-safe order (`organization_builder_stage_events`, then the
  `organization_builders` / `builder_notes` columns and their FKs, then
  `organization_pipeline_stages`). No existing column is altered, so nothing needs restoring —
  `organization_builders.status` and legacy `builders` were never touched.
- **Phases 2–4** are dead code without the UI. Remove the nav entry / route to hide the feature
  while leaving the API in place; existing tracking, notes, exports, and `/api/me/builders`
  consumers keep working because every addition is an optional field.
- **Phase 5** rolls back by reverting the two `nav-config.ts` entries (the `'/pipeline'` route
  prefix and the `Board` item) and the three `privateBuilderFields` additions. Removing only the
  nav item while leaving `'/pipeline'` in the area's `routes` is also safe — the page becomes
  unlisted but still resolves to the right rail area.
- **Phase 6** rolls back by removing the cron entry — the worker endpoint is idempotent and a
  no-op with no cron hitting it, and it already self-skips when `RESEND_API_KEY` is unset or no
  organization has `staleDigest`.
- Forward-recovery, not down-migrations: per `_meta/security-policy.md` rule 9, production
  migrations are immutable and forward-only.
