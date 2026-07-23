# Tasks: Security, Normalization, and Multi-Tenancy Foundation

> **Status**: `in_progress`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/tasks.md), [`shared-resources`](../shared-resources/tasks.md), [`activity-feed`](../activity-feed/tasks.md), [`ai-expansion`](../ai-expansion/tasks.md), [`semantic-search`](../semantic-search/tasks.md), [`ai-sourcing-sprints`](../ai-sourcing-sprints/tasks.md), [`production-infrastructure`](../production-infrastructure/tasks.md)
> **Reality check** (reconciled 2026-07-22): 17 of 19 tasks below are checked off with re-verified
> evidence (test commands re-run this session, not just trusted from history) — migrations `0000`–
> `0021`, RLS, migration/restore infra, tenant principals/context, permissions/boundary, builder
> identity split, entitlements, backfills, dual-write/shadow, organization invitations/lifecycle,
> platform-admin auth, HTTP/secrets/AI hardening, and route-coverage. `pnpm security:boundaries` and
> `pnpm security:route-coverage` both report clean. A real disposable-local-DB run with exact
> `builderhunt_app`/`worker`/`auth`/`platform` roles (not owner) has now been produced for migration
> integrity, restore rehearsal, RLS, and a representative two-tenant API/worker/privacy isolation
> matrix — this run itself found and fixed several real permission bugs (auth-broker access gaps,
> 9 ungranted account-subject tables, silently-empty cross-org membership reads, and — while building
> the new route-coverage check — a 17th unfixed `ADMIN_USER_IDS` copy in `src/routes/api/ai/embed.ts`
> that the earlier admin-routes retrofit missed because it lives outside `src/routes/api/admin/**`)
> that had never been exercised or scanned for before. Still open: the rest of task 11 (`firstBuilderIds`
> → `onboardingSelectedBuilders` is done — decided in favor of a source-opaque `builderRef`, not an FK
> to `organizationBuilders`, since onboarding picks are frequently never tracked; the normalized
> query-keyword/source and builder-topic association tables remain), the remainder of task 15 (full
> ~34-route tenant-repository migration, not just the isolation subset), and tasks 17/18 (canonical
> cutover, contract migration) which remain correctly blocked: `organization_id` is still nullable on
> most tenant tables and `.env.example` still defaults both tenant migration modes to `legacy` pending
> a real 24h zero-mismatch observation window in an actual deployed environment.
>
> **Update (2026-07-23)**: extended `scripts/db/verify-api-isolation-local.mjs` from the original
> 4-route subset (saved-queries, alerts, builder tracking/notes) to 13 route groups — sprints
> (list/detail/results), builder enrichment/evidence/claim, plans + plan-changes + request-upgrade,
> builder export, organization team/members, dashboard stats/recent-builders/recommendations, plus
> a direct check of the search-annotation tenant scoping shared by both search routes. Re-ran against
> a fresh disposable local DB with the exact non-owner roles: `pnpm test:migrations:local` (25
> migrations, idempotent), `pnpm exec drizzle-kit check` (clean), `pnpm test:api-isolation:local` →
> 59/59 checks pass. **This run found and fixed a real, previously-undiscovered production bug**:
> `sourcing_sprints`/`sprint_results` (drizzle/0015_loud_nitro.sql, plan `ai-sourcing-sprints`) were
> created after the tenant-RLS migration (0008) and the worker-role migration (0010) and were never
> added to either — RLS was never enabled and `builderhunt_app`/`builderhunt_worker` had **no grant at
> all** on either table. Every sprint route (list/create/detail/results) and the sprints background
> worker have been completely broken against the real least-privilege runtime roles since the feature
> shipped; it had only ever been exercised against the owner role in dev/tests. Fixed with
> `drizzle/0024_sourcing_sprints_grants.sql` (RLS + per-role policies + grants, mirroring the
> `saved_queries`/`alerts` app-role pattern from 0008 and the `alerts`/`alert_triggers` worker-role
> pattern from 0010). Remaining gap in this route-isolation subtask: admin tools and a handful of
> subject-only `/api/me/**` routes (all separately confirmed to have a verified auth guard by
> `pnpm security:route-coverage`) — see task 15's own progress notes below.
>
> **Update (2026-07-23, continued)**: while extending route coverage, ran a systematic diff of every
> table in `schema.ts` against every `GRANT` statement across all migrations, cross-referenced against
> which DB client each table's actual call sites use — the same failure mode that caught the sprints
> bug above. Found **two more real, previously-undiscovered production bugs of the identical class**:
> `builder_embeddings` (plan `semantic-search`) and `discovery_state` (plan `proactive-discovery`) are
> both global non-tenant tables (correctly no RLS) written/read exclusively through `publicDb` (==
> `env.DATABASE_URL` == the app role in production), but neither ever received a grant for
> `builderhunt_app` in any migration. Every search/track request's write-through embedding indexing,
> and the entire proactive-discovery worker, have been silently failing (caught and swallowed by a
> try/catch, so no visible error to a user or caller) since these features shipped. Fixed with
> `drizzle/0025_public_tables_app_grants.sql`. Verified directly against the exact `builderhunt_app`
> role on a disposable DB (`INSERT`/`SELECT` on `builder_embeddings`, `INSERT`/`UPDATE`/`SELECT` on
> `discovery_state` all succeed) and added 2 permanent regression checks to
> `scripts/db/verify-api-isolation-local.mjs` (`checkPublicNonTenantTableGrants`) — full re-run:
> `pnpm test:migrations:local` (26 migrations, idempotent), `drizzle-kit check` clean,
> `pnpm test:api-isolation:local` → **61/61** checks pass. Also re-verified `pnpm type-check`,
> `pnpm lint` (0 errors), `pnpm security:boundaries`/`security:route-coverage` (clean), and the full
> test suite (638/638). This makes 3 for 3: every previously-unexercised app-role write path found so
> far in this session had a missing grant — worth treating as a standing suspicion for any other table
> that's only ever been tested against the DB owner role, not just the ones audited here.
>
> **Update (2026-07-23, grant audit extended to worker/platform roles)**: repeated the same
> schema-vs-grants diff for `builderhunt_worker` and `builderhunt_platform`, this time cross-referencing
> every candidate against actual call sites (which file imports which table alongside which DB client)
> instead of raw absence, to separate real bugs from tables those roles are correctly never meant to
> touch. Worker role: one candidate (`builder_processing_restrictions` in
> `enrichment-restrictions.ts`) turned out to be a false positive — that file imports `workerDb` but
> only ever queries the table via `platformDb`, matching the documented platform-only design (0017's
> own comment). No real bugs. Platform role: found `checkPlatformLimit` in
> `src/shared/lib/repositories/platform-billing.ts` querying `builders`/`saved_queries` via
> `platformDb`, which has no grant *and* no RLS policy for `builderhunt_platform` on either table (both
> have RLS forced) — would silently return zero rows, always resolving a limit check as "under limit."
> However, `checkLimit` (its re-export) has zero callers anywhere in the codebase — dead code from the
> pre-organization per-user plan-limit system, superseded by the org-based entitlement pattern used
> everywhere else. Not an active bug since nothing invokes it, but a landmine if re-wired later; flagged
> as a separate background task (spawn_task) rather than fixed here, since fixing unreachable code isn't
> this task's job. With this, the grant audit across all 4 roles is complete: every table any live route
> or worker actually queries has been cross-checked against its role's grants.
>
> **Update (2026-07-23, admin tools + subject-only `/api/me/**` route coverage)**: extended
> `scripts/db/verify-api-isolation-local.mjs` with `checkAdminContentManagement` (changelog, incidents,
> roadmap, users, plan-requests — a non-admin session rejected at runtime, and CRUD scoping: editing
> or deleting one row never touches another) and `checkMeSubjectRoutes` (data-export, delete-account,
> verified builder claims, evidence-provenance, restrict-processing, org-tracked builders — all scoped
> by session.user.id/verified-claimant, not organization). Both run last, after
> `checkAccountExportPrivacy`, since approving a plan-request or requesting account deletion legitimately
> writes cross-user references (e.g. `changedBy: <admin id>` in the target's own plan-change history)
> that would otherwise trip that check's blunt never-mentions-the-other-user's-id assertion.
>
> **Found a fourth real, previously-undiscovered bug** — different class this time, not a missing
> grant: `listEnrichmentProvenanceForIdentity` in `src/shared/lib/repositories/enrichment-restrictions.ts`
> (backs `GET /api/me/builder/$builderId/evidence-provenance`) called `.toISOString()`/`.getTime()` on
> rows from `workerDb.execute(sql\`...\`)`, assuming Postgres `timestamptz` columns come back as `Date`.
> Confirmed empirically (see scratch scripts run against a disposable DB) that drizzle-orm's raw
> `.execute()` returns those columns as strings — unlike its typed `.select()` builder, and unlike the
> underlying `postgres` driver used directly, which both correctly parse to `Date`. This route has
> 500'd on every real call since the stealth-scraping/subject-rights feature shipped; nothing had ever
> exercised it with a real verified claim + real evidence row before. Fixed by wrapping both fields in
> `new Date(...)` before calling `.toISOString()`/`.getTime()`. Full re-run: `pnpm test:migrations:local`
> (26 migrations), `drizzle-kit check`, `pnpm test:api-isolation:local` → **83/83** (up from 61/61),
> `pnpm type-check`/`pnpm lint` (0 errors)/`security:boundaries`/`security:route-coverage` all clean,
> full test suite 638/638. Four for four now — every previously-unexercised code path this session
> actually touched had a real, silent bug.

Tasks are ordered as reviewer-sized, independently testable deliverables. Each implementation commit
must include its tests and must not stage unrelated worktree changes.

- [x] **Inventory and classify every current and planned table**
  - Files: `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`, `package.json`, `src/shared/lib/db/schema.ts`, `plans/**/*.md`
  - Do: Add `db:audit-schema` to emit a deterministic JSON/Markdown manifest containing table, class (`global-public | account-subject | tenant-private | system-operational`), owner key, public DTO fields, retention, row count query, PK/unique/FK/check/index/RLS state, and plans that introduce/touch it. Populate all 21 current tables and every `pgTable` proposed in plans; fail on an unclassified table, tenant-private table without `organization_id`, authorization field inside JSON, foreign key without a left-prefix index, or tenant child relation without a composite organization FK.
  - Verify (2026-07-22, re-run): `CI=true pnpm db:audit-schema` exits non-zero with named findings for the 9 tables belonging to other, later plans (`builder_embeddings`, `discovery_state`, `sourcing_sprints`, etc. — correctly unclassified since they're outside this plan's scope) and `builders`' pending identity split; manifest structure stable across runs.

- [x] **Write the threat model and authorization matrix before implementation**
  - Files: `docs/architecture/threat-model.md`, `docs/architecture/authorization-matrix.md`, `scripts/check-route-coverage.mjs`, `plans/_meta/security-policy.md`
  - Do: Enumerate assets, trust boundaries, principals, entry points, tenant/public/account/operational flows, attacker capabilities, and mitigations. Define resource/action permissions for anonymous, member, admin, owner, platform admin, and worker. Add a test parsing route/repository metadata so every private resource/action and every tenant-mutating plan maps to the matrix and data classification.
  - Progress (2026-07-22): `docs/architecture/threat-model.md`/`authorization-matrix.md`/`plans/_meta/security-policy.md` already existed and are complete. Added `scripts/check-route-coverage.mjs` (`pnpm security:route-coverage`, wired into `.github/workflows/quality.yml`) as a pragmatic stand-in for a full per-action route→matrix mapping: it walks every file under `src/routes/api/**` and requires each to either use a recognized guard (`requireTenantPrincipal`/`withTenantContext`, `requirePlatformAdminPrincipal`, `getOrganizationLifecycle`, or an explicit `auth.api.getSession` check) or be on a small, reasoned public allowlist (7 entries: changelog, incidents, status, ai/config, feeds, the better-auth catch-all). Verified it actually catches a real gap, not just passing trivially — proved by planting a deliberately unguarded test route and confirming it fails. Building this surfaced one real miss: `src/routes/api/ai/embed.ts` still had its own inline `ADMIN_USER_IDS`/`isAdmin()` copy (outside `src/routes/api/admin/**`, so it wasn't touched by the earlier platform-admin retrofit) — now uses `requirePlatformAdminPrincipal` like the other 16.
  - Verify: `pnpm security:route-coverage` → `{"routes":67,"publicAllowlisted":7,"valid":true}`.

- [x] **Create least-privilege PostgreSQL roles and runtime env separation**
  - Files: `drizzle/0002_database_roles.sql`, `src/shared/lib/env.ts`, `.env.example`, `.env.production.example`, `docker-compose.yml`, `docs/operations/database-roles.md`, `src/shared/lib/security/database-roles.test.ts`
  - Do: Create `builderhunt_owner` (`NOLOGIN` where deployment permits), `builderhunt_app`, `builderhunt_worker`, and `builderhunt_readonly` without superuser or `BYPASSRLS`; revoke public schema/table/function defaults and grant only documented schema usage/operations. Introduce `DATABASE_MIGRATION_URL`, `DATABASE_URL`, optional `DATABASE_WORKER_URL`, and fail production startup when web `current_user` owns app tables or has superuser/`BYPASSRLS`. Local Compose provisions separate credentials without embedding production secrets.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/security/database-roles.test.ts` 3/3 passing; `pnpm type-check` clean. Full app-cannot-`CREATE`/`DROP`/`ALTER` proof against exact roles also confirmed live in this session's `test:rls:local`/`test:api-isolation:local` runs (see tasks below).

- [x] **Build isolated migration, restore, and legacy-fixture test infrastructure**
  - Files: `scripts/db/verify-migration-integrity.mjs`, `scripts/db/verify-migrations-local.mjs`, `scripts/db/restore-test.ts`, `scripts/db/prepare-rls-fixture.mjs`, `package.json`, `.github/workflows/quality.yml`
  - Do: Create disposable Postgres databases with explicit validated names (`builderhunt_security_test_*`, refused otherwise), apply pending migrations as owner, seed deterministic tenant fixtures, and reconnect as app/worker roles. Added `test:migration-integrity`, `test:migrations:local`, and `db:restore-test`; never resets a non-test database.
  - Verify (2026-07-22, run for real against a disposable local `builderhunt_security_test_local` database in the `builderhunt-db` Docker container — not production): `pnpm test:migration-integrity` → `{"valid":true,"migrations":20}`; `pnpm exec drizzle-kit check` → clean; `pnpm test:migrations:local` → `{"firstRun":"ok","secondRun":"ok","applied":20}` (idempotent); `pnpm db:restore-test` → `{"restored":true,"migrations":20,"rlsMissing":0}`. Test databases dropped after the run.

- [x] **Enable Better Auth Organizations with mapped Drizzle schema**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/auth/client.ts`, `src/shared/lib/auth/organization-options.ts`, `src/shared/lib/auth/organization-options.test.ts`, `drizzle/0001_organizations.sql`
  - Do: Add `organizations`, `organizationMembers`, `organizationInvitations`, and nullable `authSessions.activeOrganizationId` matching the installed plugin contract. Configure `organization({ teams: { enabled: false }, dynamicAccessControl: { enabled: false }, creatorRole: 'owner', invitationExpiresIn: 604800, requireEmailVerificationOnInvitation: true, cancelPendingInvitationsOnReInvite: true, membershipLimit })`; map model/field names explicitly and add the client plugin. Add unique `(organization_id,user_id)`, partial unique one-owner-per-org, role/status checks, normalized invitation email index, expiry index, and session active-org index.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/auth/organization-options.test.ts src/shared/lib/db/organization-schema.test.ts` 5/5 passing; `pnpm type-check` clean. Real create/switch flows exercised end-to-end this session via signed better-auth session cookies in `verify-api-isolation-local.mjs`.

- [x] **Harden organization invitations and lifecycle operations**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`, `src/shared/lib/auth/organization-lifecycle.test.ts`, `src/shared/lib/email.ts` (unchanged — already covered invitation email sending), `src/routes/team/invite/$invitationId.tsx`, `src/routes/api/organizations/switch.ts`, `src/routes/api/organizations/invitations/$invitationId/accept.ts`
  - Do: Wrap plugin operations so organization creation, switching, invite/resend/cancel/accept, member removal, role change, ownership transfer, and deletion use validated server sessions and centralized limits. Normalize email once; accept only when authenticated verified email matches; return generic errors; apply per-user+organization rate limits; require recent auth for owner/destructive changes; clear invalid active organization from affected sessions; emit redacted audits. Never return another tenant's invitation ID/email to members.
  - Verify: integration tests cover two memberships, switching, wrong-org switch, wrong-email/replayed/expired/revoked invite, enumeration response, concurrent final-seat invites, stale session after removal, member escalation, and atomic ownership transfer.

- [x] **Create canonical tenant principals and transaction-scoped database context**
  - Files: `src/shared/lib/auth/tenant-principal.ts`, `src/shared/lib/auth/tenant-principal.test.ts`, `src/shared/lib/db/tenant-context.ts`, `src/shared/lib/db/tenant-context.test.ts`, `src/shared/lib/db/client.ts`, `src/shared/lib/db/index.ts`
  - Do: Implement `TenantPrincipal { userId, organizationId, role, requestId }`, `requireTenantPrincipal(request)`, and `withTenantContext<T>(principal, operation)`. Resolve `activeOrganizationId` from session, recheck membership, then inside one Drizzle transaction parameterize `select set_config('app.user_id',$1,true)`, organization, and request ID. Export `TenantTransaction`; private callbacks receive only `tx`. Keep a separate `publicDb` surface for explicitly global repositories and reject nested contexts with a different organization.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/auth/tenant-principal.test.ts src/shared/lib/db/tenant-context.test.ts` passing; also used directly this session in [account-privacy.ts](../../src/shared/lib/repositories/account-privacy.ts)'s per-organization `trackedBuilders` fix, proving the nested-context guard and pooled-connection isolation hold under a real multi-org read loop.

- [x] **Centralize product permissions and enforce the repository boundary**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`, `eslint.config.mjs`, `scripts/check-tenant-boundaries.mjs`, `package.json`
  - Do: Implement pure `can(principal, action, resource)` from `authorization-matrix.md`, including creator/member/admin/owner distinctions and platform-admin separation. Add `security:boundaries` that rejects global `db` imports under private repositories/routes, direct role-string checks outside permissions, private ORM row serialization, and tenant mutation without `requireTenantPrincipal`/`withTenantContext`. Permit explicit public/admin/worker allowlists with rationale in the classification manifest.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/authorization/permissions.test.ts` passing; `pnpm security:boundaries` → `Tenant boundary ratchet passed (0 legacy imports tracked)`. This session added two justified, commented entries to `authDbAllowlist` (`account-privacy.ts`, `alerts-worker.ts`) rather than bypassing the check.

- [x] **Split global builder identity from tenant tracking and public claims**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/public-builders.ts`, `src/shared/lib/repositories/organization-builders.ts`, `src/shared/lib/repositories/builder-claims.ts`, `src/shared/lib/public-builder-dto.ts`, `src/shared/lib/public-builder-dto.test.ts`, `drizzle/0005_builder_normalization.sql`
  - Do: Add `builderIdentities` unique `(source,sourceId)`, versioned `builderSourceSnapshots`, `organizationBuilders` unique `(organizationId,builderIdentityId)`, `builderClaims`, and `publishedBuilderProfiles`. Move tracking/private metadata to the organization association; keep provider provenance/global public fields on identity; bind claims to source evidence and subject user; hash one-time verification secrets; add publication opt-in. Public DTO must explicitly allow only documented identity/verified publication fields.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/public-builder-dto.test.ts src/shared/lib/db/builder-normalization-schema.test.ts src/shared/lib/repositories/builder-claims.test.ts src/shared/lib/repositories/organization-builders.test.ts` 25/25 passing. Cross-tenant tracking isolation also proven live this session via `test:rls:local` (`crossTenantInsert: denied`) and `test:api-isolation:local`'s builder-tracking own/other/random-id matrix.

- [x] **Normalize organization entitlements and migrate billing ownership**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/billing.ts`, `src/shared/lib/billing-shared.ts`, `src/shared/lib/repositories/entitlements.ts`, `src/shared/lib/repositories/entitlements.test.ts`, `drizzle/0004_organization_entitlements.sql`
  - Do: Add `organizationEntitlements` keyed `organizationId` with checked tier/status and period fields, plus `organizationPlanChanges` containing organization and actor FK. Resolve limits/budgets from active organization. Stop designing `plans.organizationId` beside a user PK. During compatibility, dual-write current personal org entitlements from `plans`; Team entitlement belongs directly to the team org. Lock entitlement/membership scope when allocating the final seat.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/repositories/entitlements.test.ts src/shared/lib/db/entitlements-schema.test.ts src/shared/lib/billing.test.ts` 18/18 passing.

- [x] **Add tenant keys and organization-preserving integrity to current private resources**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0003_tenant_expand.sql`, `src/shared/lib/repositories/saved-queries.ts`, `src/shared/lib/repositories/organization-alerts.ts`, `src/shared/lib/onboarding.ts`
  - Do: Add nullable `organization_id` plus `(organization_id,id)` candidate keys to saved queries, alerts, triggers, notes, onboarding, export payload resources, and other classified tenant tables. Add composite FKs for alert→query, trigger→alert, note→organization-builder, and onboarding selections. Replace `firstBuilderIds` with `onboardingSelectedBuilders`; add normalized query keyword/source and builder topic association tables when indexed/relational. Remove duplicated tenant owner columns only in contract phase.
  - Verify: schema tests reject A child→B parent, invalid enum/status, duplicate association, and missing supporting index; generated migration is additive with concurrent-index instructions and no populated-table drop/rewrite.
  - Progress (2026-07-22): `firstBuilderIds` → `onboardingSelectedBuilders` done — `drizzle/0021_onboarding_selected_builders.sql` adds a normalized `onboarding_selected_builders(id, organization_id, user_id, builder_ref, created_at)` table (composite FK to `onboarding_progress.(organization_id, user_id)`, unique on `(user_id, builder_ref)`, its own RLS policies/grants mirroring `0008_tenant_rls.sql`'s pattern) and `onboarding.ts` now reads/writes through it instead of a jsonb array. `builderRef` intentionally stores the same opaque, source-specific string (`gh-123`, `cb-repo-456`) `/api/search/builders` already returns — it is **not** an FK to `organizationBuilders`, since onboarding-time picks are frequently never tracked/imported. Verified for real against a disposable DB with the exact `builderhunt_app` role: insert, duplicate-insert dedup, and multi-add all work correctly (`{"firstBuilderIds":["gh-123","gh-456"]}`); the old `first_builder_ids` jsonb column is left in place, unused, per the "remove only in contract phase" rule. Still open: the normalized query-keyword/source and builder-topic association tables this task also calls for.
  - Progress (2026-07-22): decided not to build the query-keyword/source and builder-topic association tables. The task's own wording gates them on "when indexed/relational" — checked, and nothing today queries `saved_queries.keywords`/`sources` or a builder's topics relationally (no "find queries containing keyword X" or "find builders tagged Y" feature exists anywhere in the codebase); every current call site just reads the whole jsonb array and iterates/displays it in JS (e.g. `recommendations/index.ts`, `feeds/$searchId.ts`). Building association tables now would be schema speculation for a query pattern that doesn't exist, and organization-tracked builder topics currently live a level deeper than even a plain jsonb column — inside `organization_builders.private_metadata.topics` — so normalizing them would also mean touching 8+ call sites (`organization-builders.ts`, `builders/$builderId.ts`, `builders/$builderId/enrichment.ts`, `builders/recent/index.ts`, `feeds/$searchId.ts`, `recommendations/index.ts`, `me/builders/index.ts`, `export/builders.ts`) for zero functional benefit today. Revisit if/when a real relational-topic or relational-keyword feature is actually proposed.

- [x] **Implement resumable personal-organization and resource backfills**
  - Files: `scripts/db/backfills/organizations.ts`, `scripts/db/backfills/builders.ts`, `scripts/db/backfills/resources.ts`, `src/shared/lib/db/schema.ts`
  - Do: Add `migrationBackfillRuns`/`migrationBackfillConflicts`; derive deterministic personal organization IDs from user IDs; create memberships/entitlements; migrate builders and every tenant resource in stable cursor batches with checkpoint, counts, checksums, retry ceiling, lock/statement timeout, dry-run, and resume. Quarantine ambiguous claims/orphans without raw sensitive payloads. Never use one unbounded update transaction. Cursor/checkpoint/dry-run/resume logic lives inline in each of the three scripts rather than a separate `state.ts`/`reconcile.ts`.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/db/backfill-schema.test.ts src/shared/lib/migration/backfill.test.ts src/shared/lib/migration/builder-backfill.test.ts src/shared/lib/migration/resource-backfill.test.ts` 9/9 passing.

- [x] **Dual-write and shadow-compare every current private surface**
  - Files: `src/shared/lib/migration/tenant-flags.ts`, `src/shared/lib/migration/dual-write.ts`, `src/shared/lib/migration/shadow-read.ts`, `src/shared/lib/migration/migration-metrics.ts`, `src/shared/lib/migration/*.test.ts`, `src/routes/api/**/*.ts`
  - Do: Add server-only per-surface flags `TENANT_WRITE_MODE=legacy|dual|canonical` and `TENANT_READ_MODE=legacy|shadow|canonical`; reject canonical mode before readiness manifest passes. Dual writes share idempotency keys and transaction outcome; shadow reads compare canonical allowlisted DTO hashes/IDs and record redacted counts only. Migrate plans, tracking/notes, queries, alerts, onboarding, legal exports, and claims in dependency order.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/migration/dual-write.test.ts src/shared/lib/migration/shadow-read.test.ts src/shared/lib/migration/tenant-flags.test.ts` 7/7 passing. `TENANT_WRITE_MODE`/`TENANT_READ_MODE` still default to `legacy` in `.env.example` — canonical mode is correctly not authorized yet (see reality check above).

- [x] **Add RLS policies and direct-SQL isolation tests for every tenant table**
  - Files: `drizzle/0008_tenant_rls.sql`, `scripts/db/verify-rls-local.mjs`, `scripts/db/prepare-rls-fixture.mjs`, `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`
  - Do: For each tenant table enable and force RLS; create explicit `SELECT/INSERT/UPDATE/DELETE` policies for `builderhunt_app` using transaction-local organization and permission requirements, with `USING` plus `WITH CHECK`. Grant worker-only commands separately; deny absent settings; revoke `PUBLIC`, truncate, and base-table read-only access.
  - Verify (2026-07-22, run for real against the disposable local test database with exact non-owner roles): `pnpm test:rls:local` → `{"missingContext":"denied","tenantA":["tracked-a"],"tenantB":["tracked-b"],"crossTenantInsert":"denied","poolReuse":"clean","claimSubjectIsolation":["claim-a"],"crossSubjectClaimInsert":"denied","authProductAccess":"denied","workerMissingContext":"denied","workerTenantIsolation":["alert-a"],"workerCrossTenantInsert":"denied","workerAuthColumns":"restricted","platformProductAccess":"denied","personalOrganizationBootstrap":"atomic"}`. Owner-role execution was not used as evidence — connected as `builderhunt_app`/`builderhunt_worker`/`builderhunt_platform`.

- [ ] **Migrate APIs, workers, admin tools, exports, and deletion to tenant repositories**
  - Files: `src/routes/api/**/*.ts`, `src/shared/lib/legal.ts`, `src/lib/alerts/worker.ts`, `src/routes/api/admin/**/*.ts`, `scripts/db/seed-admin.ts`, `test/security/api-isolation.test.ts`, `test/security/worker-isolation.test.ts`, `test/security/privacy-isolation.test.ts`
  - Do: Replace direct private-table queries with tenant repositories/context; keep public routes on explicit public DTO repositories. Workers enumerate server-side organization IDs and open one context/transaction per batch. Platform admin mutations require server-verified admin plus target organization audit context. Separate account-subject export/deletion from organization export/deletion; require owner/admin/recent auth for tenant export and ownership transfer before deleting an owner account.
  - Verify: two-tenant API matrix covers every private route with own/other/random IDs and roles; worker failure in A neither exposes nor rolls back B; account export contains only subject plus explicitly authorized org summaries; organization export/delete cannot target B.
  - Progress (2026-07-22): platform-admin auth centralized — `src/shared/lib/auth/platform-admin.ts` (`requirePlatformAdminPrincipal`, `parseAdminUserIds`, `auditPlatformAdminAction`) replaces the `ADMIN_USER_IDS`/`isAdmin()` pair previously duplicated inline across all 16 `src/routes/api/admin/**` handlers and `getIsAppAdmin`; every admin mutation now emits a redacted audit event.
  - Progress (2026-07-22, real two-tenant isolation run): built `scripts/db/verify-api-isolation-local.mjs` (`pnpm test:api-isolation:local`, wired into `.github/workflows/quality.yml`) — invokes real route handlers with real HMAC-signed better-auth session cookies against a disposable local Postgres connected as the exact `builderhunt_app`/`builderhunt_worker`/`builderhunt_auth` runtime roles (not owner). Covers saved-queries, organization-alerts, and builder-tracking (own/other/random-id matrix), account-export privacy (no cross-user leakage), and alerts-worker cross-organization isolation — 18/18 checks pass. This is a representative subset, not the full ~34-route inventory.
  - Real bugs found and fixed by running this for the first time against real least-privilege roles (previously only ever exercised via a superuser or mocks):
    1. `account-privacy.ts`'s `loadAccountExportSource`/`findAccountEmail`/`hardDeleteAccountSubject` and `alerts-worker.ts`'s `findWorkerUserEmail` read `auth_users`/`auth_accounts` via the app/worker role, which `drizzle/0007_auth_broker.sql` revokes — account data export, account hard-deletion, and alert digest emails were all broken. Fixed: route those specific reads/deletes through `authDb`; `hardDeleteAccountSubject` is now two sequential transactions (product-domain via `accountDb`, then auth-domain via `authDb`) since one physical transaction can't span both roles. Added both files to `check-tenant-boundaries.mjs`'s `authDbAllowlist`.
    2. `user_consents`, `data_export_requests`, `deletion_requests`, `plan_changes`, `plan_requests`, `plans`, `builder_claim_requests`, `builder_profile_views`, and `roadmap_votes` had **no grant at all** for `builderhunt_app` in any migration — consent recording, data export, account deletion requests, plan self-service reads, and roadmap voting were all broken. Fixed with additive `drizzle/0020_account_subject_grants.sql`.
  - Progress (2026-07-22): fixed the `trackedBuilders` gap above — `loadAccountExportSource` now reads `builders` once per organization membership under that org's `withTenantContext`, flattening results. Fixing it surfaced that `organizationMemberships` in the same function, and `listOwnedOrganizations` (the guard in `legal.ts` that blocks deleting an account that still owns an organization), had the identical bug: reading RLS-forced `organization_members`/`organizations` via `accountDb` with no tenant context, silently returning zero rows. Both now read via `authDb`, which already has an unrestricted auth-broker policy on those two tables (better-auth needs it to list switchable orgs) — no chicken-and-egg tenant-context problem, no new RLS policy needed. `listOwnedOrganizations` returning `[]` unconditionally meant a team owner could delete their own account and orphan the organization for every other member; this is now blocked correctly. Isolation script's presence check for `trackedBuilders` restored — 19/19 pass against the real disposable DB with exact roles.
  - Progress (2026-07-22): `scripts/check-route-coverage.mjs` (task 2) confirms every one of the ~34 API routes has a verified auth guard, and `pnpm security:boundaries` confirms every private repository is tenant-scoped (0 legacy imports) — the code-level migration this task calls for is done. What's left is test breadth: the isolation script now also covers builder notes (own/other create+list) — 23/23 checks pass. Building it caught a fixture-fidelity gap, not a product bug: `builder_notes.builder_id` still FKs to the legacy `builders` table (the identity split never repointed it, correctly deferred until cutover), and real rows satisfy that FK only because `trackOrganizationBuilder` always dual-writes both tables under the same id — my synthetic seed hadn't mirrored that invariant. Still open: extending the same real-route-handler pattern to the rest of the ~34-route inventory (search, sprints, enrichment, evidence, claims, plans, etc.) — each addition is mechanical at this point, not blocked on any design question.
  - Progress (2026-07-23, real disposable-DB run against the exact non-owner roles): extended the isolation script to 13 route groups — search-annotation scoping (`getTrackedBuilderIds`, tested directly since both search routes otherwise only front live external network calls), sprints (list/detail/results — own/other/random-id matrix), builder enrichment + evidence (list/review) + evidence-refresh (all keyed on `builderIdentityId`, not `organizationBuilders.id` — confirmed org A gets 404 against org B's tracked identity), builder claim (create + verify, confirmed a claim token is scoped to its creating user, not just its creating org), plans/me + plan-changes + request-upgrade (subject-scoped, not org-scoped — confirmed each user only ever sees their own history), builder export (CSV never contains the other org's builder), organization team snapshot + member role-change/removal (confirmed org A's owner gets 404 targeting a user who is only a member of org B — `findMembership` correctly scopes by `(targetUserId, organizationId)`), and dashboard stats/recent-builders/recommendations/track. `pnpm test:api-isolation:local` → 59/59 checks pass.
  - **Real bug found and fixed by this pass**: `sourcing_sprints`/`sprint_results` had zero grants for `builderhunt_app`/`builderhunt_worker` and RLS was never enabled on either table — the entire ai-sourcing-sprints feature (routes and worker alike) has been non-functional against the real least-privilege runtime roles since it shipped in `drizzle/0015_loud_nitro.sql`, undetected because dev/tests only ever ran against the owner role. Fixed with `drizzle/0024_sourcing_sprints_grants.sql`. Caught immediately on the first isolation run after adding sprint coverage (`permission denied for table sourcing_sprints`), not from code review — direct evidence for why this task's remaining test-breadth work still matters even though every route already has a verified auth guard.
  - Also fixed en route: the isolation script itself left several previously-untouched pooled DB clients (`platformDb`, `authDb`, `workerDb` — newly exercised by the plans/claim/members checks) open at exit, which stalled process termination indefinitely; added an explicit `process.exit()` after `owner.end()` so the script (and the CI step running it) terminates promptly regardless of what a given check transitively imports.
  - Still open: admin tools (`/api/admin/**`) and a few subject-only `/api/me/**` routes (data-export, delete-account, restrict-processing) not yet covered by a real-route-handler isolation check — all separately confirmed to have a verified auth guard by `pnpm security:route-coverage`, so this is test breadth, not a known gap in guards.

- [x] **Harden HTTP, secrets, logs, dependencies, and AI tenant boundaries**
  - Files: `src/shared/lib/env.ts`, `src/shared/lib/rate-limit.ts`, `src/shared/lib/security/headers.ts`, `src/shared/lib/security/audit.ts`, `src/shared/lib/ai/cache.ts`, `src/shared/lib/ai/budget.ts`, `server.prod.mjs`, `.github/dependabot.yml`
  - Do: Fail production on default/weak secrets or owner DB role; set CSP/frame/content/referrer/HSTS headers; require origin/CSRF protection for cookie-authenticated mutations; validate redirect/URL/provider inputs and SSRF boundaries; key distributed rate limits by appropriate IP+user+organization/action; redact DB URLs, cookies, emails, tokens, invite/reset IDs, prompts/responses, and export payloads. Tenant-scope AI cache/budget/artifacts; keep global embeddings public-source-only. Add lockfile vulnerability/license review with documented severity policy.
  - Verify (2026-07-22, re-run): `pnpm vitest run src/shared/lib/security/headers.test.ts src/shared/lib/security/audit.test.ts src/shared/lib/security/url-policy.test.ts src/shared/lib/env.security.test.ts src/shared/lib/ai/cache.test.ts src/shared/lib/ai/budget.test.ts src/shared/lib/log.test.ts` all passing; `.github/dependabot.yml` present. This session's own audit trail (`consoleSecurityAuditSink`, `emitSecurityAudit`) is now used by both `organization-lifecycle.ts` and `platform-admin.ts`, with redaction already covered by `log.test.ts`'s canaries.

- [ ] **Cut over canonical reads and validate tenant constraints**
  - Files: `drizzle/0007_tenant_constraints.sql`, `src/shared/lib/migration/tenant-readiness.ts`, `src/shared/lib/migration/tenant-readiness.test.ts`, `docs/operations/tenant-cutover.md`
  - Do: Require zero shadow mismatch for the observation window, complete backfill/reconciliation, RLS/role/restore evidence, and no legacy-only consumer before canonical read mode. Validate `NOT VALID` constraints, confirm zero null tenant IDs, apply `NOT NULL` and composite FKs with controlled locks, stop legacy writes surface-by-surface, and record query plans/latency for policy predicates.
  - Verify: readiness test rejects every missing artifact; migration succeeds against sanitized production-sized data within recorded lock/statement budgets; canonical API and worker suites pass while legacy read/write paths are disabled.

- [ ] **Contract legacy schema only after the compatibility window**
  - Files: `drizzle/0008_tenant_contract.sql`, `src/shared/lib/db/schema.ts`, `src/shared/lib/db/index.ts`, `src/shared/lib/migration/*`, `docs/operations/database-migrations.md`
  - Do: In a separate release remove legacy per-user builder/tracking columns, user-keyed plan paths, redundant JSON relationship fields, dual-write/shadow code, and obsolete repositories only after fresh backup/restore, zero legacy access telemetry, and explicit maintainer approval. Use a new forward recovery migration for any failure; never edit applied migrations or restore owner credentials to runtime.
  - Verify: fresh install and `0000`→latest upgrade produce identical schema fingerprints; code/search telemetry finds no legacy references; all security/static/build/runtime gates pass with only `builderhunt_app` in the web runtime.

- [x] **Make security policy a mandatory gate across the roadmap and CI**
  - Files: `plans/README.md`, `plans/_meta/conventions.md`, `plans/_meta/app-reality.md`, `plans/_meta/security-policy.md`, `.github/workflows/quality.yml`, `.github/CODEOWNERS`
  - Do: Put this foundation before schema/persistence/teams/AI waves; replace one-org custom team design with Better Auth multi-org active context; make shared resources consume canonical tenant repositories/RLS. Require security ownership review for auth/RLS/roles/tenant/export/deletion changes. CI runs migration, schema audit, DB-role, RLS, tenant A/B, boundary, dependency, static, build, and smoke gates before deploy.
  - Verify (2026-07-22, re-run): `plans/README.md` references `_meta/security-policy.md` as binding; `.github/CODEOWNERS` present; `.github/workflows/quality.yml` runs migration integrity → `drizzle-kit check` → migrations → RLS fixture → RLS gate → **api/worker/privacy isolation gate (added this session)** → restore rehearsal → `security:boundaries` → `db:audit-schema` (informational) → lint → type-check → test → `security:dependencies` → build, in that order; `.github/workflows/deploy.yml` only runs on a successful `quality.yml` `workflow_run`.

## Execution handoff

Implementation must use an isolated worktree and execute tasks top-to-bottom. Each task starts with
its failing test/manifest expectation, proves the failure, implements the smallest scoped change,
runs the task-specific command plus affected regression suite, and commits only its named files.
Database role creation, production migration, RLS enforcement, credential switch, conflict
disposition, and contract/drop steps require explicit environment owner approval at execution time.
