# Hiring Pipeline Kanban (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (tenant-private `organization_builders` ownership, RLS, tenant principal); [`team-accounts`](../../team-accounts/spec.md) (organization roles and seats — already implemented). Enhanced by [`activity-feed`](../../activity-feed/spec.md) (stage-change events; not required).
> **Blocks**: [`ats-integrations`](../ats-integrations/spec.md) (hard — the ATS sync maps its external status back onto this plan's stage model)
> **Reality check**: Extends `src/shared/lib/db/schema.ts` (`organizationBuilders`, `builderNotes`), `src/shared/lib/repositories/organization-builders.ts`, `src/shared/lib/authorization/permissions.ts`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/routes/api/me/builders/index.ts`, `src/routes/api/export/builders.ts`. Clones the worker pattern of `src/routes/api/admin/alerts/run-worker.ts` and the RLS/grants shape of `drizzle/0044_abuse_usage_integrity_rls_grants.sql`. `organization_builders.status` and legacy `builders` are not modified.

## Phases (dependency order — shippable after each)

### Phase 1 — Schema, RLS, backfill

Add `organization_pipeline_stages` and `organization_builder_stage_events`; add the three
`organization_builders` columns and `builder_notes.pipeline_stage_key` with their composite
tenant FKs and indexes. Generate the DDL migration with `pnpm db:generate`, then hand-write two
follow-on migrations drizzle-kit cannot emit — both minted via `drizzle-kit generate --custom` so
the journal entry and `drizzle/meta/NNNN_snapshot.json` exist (`pnpm test:migration-integrity`
fails otherwise; grants-only migrations are not exempt): RLS + per-role grants mirroring `0044`,
and an idempotent batched data migration that seeds the 5 default stages for every existing
organization and backfills `pipeline_stage` / `pipeline_stage_changed_at` (mapping
`status = 'shortlisted'` → `reviewed` without touching `status`). The grants migration also adds
the one grant Phase 6 needs and no existing migration provides: a column-scoped
`builderhunt_worker` SELECT on `organization_entitlements` (`0008` scopes it to `builderhunt_app`;
`0010`, the full worker grant set, omits it). Register both tables in
`docs/architecture/data-classification.md`. App behavior unchanged — three dead columns and two
empty-but-seeded tables.

### Phase 2 — Pure stage/staleness lib + permissions

`src/shared/lib/pipeline/stages.ts` (defaults, key normalization, set validation, reorder,
NULL→position-0 resolution), `staleness.ts` (`daysInStage`, `isStale`), and
`entitlement.ts` (`pipelineCapabilities`), each with a sibling `*.test.ts`. Add
`PIPELINE_STAGE_LIMITS` to `billing-shared.ts` and the `'pipeline:move'` / `'pipeline:configure'`
actions to `permissions.ts` with `can()` coverage. Still no user-visible change; everything here
is pure and unit-tested before a single query touches it.

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

Nav entry, `/pipeline` route, `PipelineBoard` / `StageColumn` / `PipelineCard` /
`CardDetailDrawer` / `StageSettingsDialog`. HTML5 drag-and-drop plus the keyboard "Move to…"
select and `aria-live` announcements. Stage/owner filters wired to URL state. Free-tier locks on
"Add stage" and the SLA field. Add stage columns to `/api/me/builders` and the CSV export.

### Phase 6 — Team SLA digest worker

`stale_after_days` editing (Team-gated), `GET /api/pipeline/stale`, `pipeline-worker.ts` +
`getWorkerEntitlementPolicy` + `runPipelineDigestWorker`, `sendPipelineStaleDigestEmail`, and
`POST /api/admin/pipeline/run-worker` cloned from the alerts worker. The worker resolves tier from
three columns of `organization_entitlements` through the pure `resolveEntitlementPolicy`, never
`getOrganizationEntitlement` (which also reads `billing_subscriptions` — worker-policied in `0028`
but granted to `builderhunt_worker` nowhere). Acceptance runs the worker as the real
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
| Digest reads an entitlement table the worker role cannot see → `emailsSent: 0` forever, and a naive verify passes vacuously | High (confirmed gap: `0008` is app-only, `0010` omits it, `billing_subscriptions` has no worker grant at all) | High | Column-scoped worker grant + policy in the Phase 1 migration; worker reads only 3 columns via the pure `resolveEntitlementPolicy`; Phase 6 acceptance seeds an eligible org and **requires `emailsSent >= 1` as the real `builderhunt_worker` role** |
| Owner null-out written on the wrong connection (`authDb` has no grant on `organization_builders`) → silent no-op, then `restrict` makes accounts undeletable | Medium | High | Null-out moved to the `removeMember` orchestrator under `withTenantContext` (app role); member-removal case added to `checkPipeline()`; `checkLegalRunWorker` re-run with an account that owns cards and authored events |
| Hand-written migration ships without a journal entry/snapshot → `pnpm test:migration-integrity` red | Medium (`0045` did exactly this) | Low | Every hand-written migration minted with `drizzle-kit generate --custom`; snapshot, journal, and `migration-hashes.json` listed in each task's `Files:` line |
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
- **Phase 5** rolls back by reverting the nav entry and the two DTO field additions.
- **Phase 6** rolls back by removing the cron entry — the worker endpoint is idempotent and a
  no-op with no cron hitting it, and it already self-skips when `RESEND_API_KEY` is unset or no
  organization has `staleDigest`.
- Forward-recovery, not down-migrations: per `_meta/security-policy.md` rule 9, production
  migrations are immutable and forward-only.
