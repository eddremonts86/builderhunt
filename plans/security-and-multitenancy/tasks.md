# Tasks: Security, Normalization, and Multi-Tenancy Foundation

> **Status**: `in_progress`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/tasks.md), [`shared-resources`](../shared-resources/tasks.md), [`activity-feed`](../activity-feed/tasks.md), [`ai-expansion`](../ai-expansion/tasks.md), [`semantic-search`](../semantic-search/tasks.md), [`ai-sourcing-sprints`](../ai-sourcing-sprints/tasks.md), [`production-infrastructure`](../production-infrastructure/tasks.md)
> **Reality check**: migrations `0001`–`0009` now provide the additive foundation and RLS has passed
> local A/B, missing-context, cross-insert, pool-reuse, auth-broker, and bootstrap checks.
> `security:boundaries` now reports zero legacy direct-db imports (verified 2026-07-22). Task
> checkboxes below are otherwise not yet reconciled against actual commit history — several other
> tasks have real, tested implementations in code despite showing `[ ]`. No destructive contract
> migration or production credential switch is authorized until backfill, dual-write/shadow
> observation, and readiness checks pass in a real environment.

Tasks are ordered as reviewer-sized, independently testable deliverables. Each implementation commit
must include its tests and must not stage unrelated worktree changes.

- [ ] **Inventory and classify every current and planned table**
  - Files: `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`, `package.json`, `src/shared/lib/db/schema.ts`, `plans/**/*.md`
  - Do: Add `db:audit-schema` to emit a deterministic JSON/Markdown manifest containing table, class (`global-public | account-subject | tenant-private | system-operational`), owner key, public DTO fields, retention, row count query, PK/unique/FK/check/index/RLS state, and plans that introduce/touch it. Populate all 21 current tables and every `pgTable` proposed in plans; fail on an unclassified table, tenant-private table without `organization_id`, authorization field inside JSON, foreign key without a left-prefix index, or tenant child relation without a composite organization FK.
  - Verify: `pnpm db:audit-schema` exits non-zero against today's schema with named findings and exits 0 only after all later schema/policy tasks; its manifest is stable across two runs.

- [ ] **Write the threat model and authorization matrix before implementation**
  - Files: `docs/architecture/threat-model.md`, `docs/architecture/authorization-matrix.md`, `test/security/plan-coverage.test.ts`, `plans/_meta/security-policy.md`
  - Do: Enumerate assets, trust boundaries, principals, entry points, tenant/public/account/operational flows, attacker capabilities, and mitigations. Define resource/action permissions for anonymous, member, admin, owner, platform admin, and worker. Add a test parsing route/repository metadata so every private resource/action and every tenant-mutating plan maps to the matrix and data classification.
  - Verify: `pnpm vitest run test/security/plan-coverage.test.ts` initially fails on unmapped current routes, then passes with zero `unknown`/placeholder entries.

- [ ] **Create least-privilege PostgreSQL roles and runtime env separation**
  - Files: `drizzle/0001_database_roles.sql`, `src/shared/lib/env.ts`, `.env.example`, `.env.production.example`, `docker-compose.yml`, `docs/operations/database-roles.md`, `test/security/database-roles.test.ts`
  - Do: Create `builderhunt_owner` (`NOLOGIN` where deployment permits), `builderhunt_app`, `builderhunt_worker`, and `builderhunt_readonly` without superuser or `BYPASSRLS`; revoke public schema/table/function defaults and grant only documented schema usage/operations. Introduce `DATABASE_MIGRATION_URL`, `DATABASE_URL`, optional `DATABASE_WORKER_URL`, and fail production startup when web `current_user` owns app tables or has superuser/`BYPASSRLS`. Local Compose provisions separate credentials without embedding production secrets.
  - Verify: `pnpm vitest run test/security/database-roles.test.ts` proves app cannot `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, assume owner, or read a default-deny fixture; owner applies a test migration. `pnpm type-check` passes.

- [ ] **Build isolated migration, restore, and legacy-fixture test infrastructure**
  - Files: `test/security/db-harness.ts`, `test/security/fixtures/legacy-schema.sql`, `test/security/migrations.test.ts`, `scripts/db/restore-test.ts`, `package.json`, `.github/workflows/quality.yml`
  - Do: Create disposable Postgres databases with explicit validated names, apply `0000` then pending migrations as owner, seed deterministic legacy users/resources/conflicts/orphans, and reconnect as app/worker roles. Add `test:migrations` and `db:restore-test`; never reset a non-test database. Verify migration files against journal/snapshots and store hashes so edited applied migrations fail.
  - Verify: `pnpm exec drizzle-kit check && pnpm test:migrations` passes empty install, legacy upgrade, second-run idempotency, and expected-failure fixtures; `pnpm db:restore-test` restores a test dump and reruns integrity checks.

- [ ] **Enable Better Auth Organizations with mapped Drizzle schema**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/auth/client.ts`, `src/shared/lib/auth/organization-options.ts`, `src/shared/lib/auth/organization-options.test.ts`, `drizzle/0002_organizations.sql`
  - Do: Add `organizations`, `organizationMembers`, `organizationInvitations`, and nullable `authSessions.activeOrganizationId` matching the installed plugin contract. Configure `organization({ teams: { enabled: false }, dynamicAccessControl: { enabled: false }, creatorRole: 'owner', invitationExpiresIn: 604800, requireEmailVerificationOnInvitation: true, cancelPendingInvitationsOnReInvite: true, membershipLimit })`; map model/field names explicitly and add the client plugin. Add unique `(organization_id,user_id)`, partial unique one-owner-per-org, role/status checks, normalized invitation email index, expiry index, and session active-org index.
  - Verify: `pnpm vitest run src/shared/lib/auth/organization-options.test.ts` asserts exact options/model names; generated SQL diff contains only the declared additive objects; `pnpm type-check` and Better Auth create/list/switch integration smoke pass.

- [x] **Harden organization invitations and lifecycle operations**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`, `src/shared/lib/auth/organization-lifecycle.test.ts`, `src/shared/lib/email.ts` (unchanged — already covered invitation email sending), `src/routes/team/invite/$invitationId.tsx`, `src/routes/api/organizations/switch.ts`, `src/routes/api/organizations/invitations/$invitationId/accept.ts`
  - Do: Wrap plugin operations so organization creation, switching, invite/resend/cancel/accept, member removal, role change, ownership transfer, and deletion use validated server sessions and centralized limits. Normalize email once; accept only when authenticated verified email matches; return generic errors; apply per-user+organization rate limits; require recent auth for owner/destructive changes; clear invalid active organization from affected sessions; emit redacted audits. Never return another tenant's invitation ID/email to members.
  - Verify: integration tests cover two memberships, switching, wrong-org switch, wrong-email/replayed/expired/revoked invite, enumeration response, concurrent final-seat invites, stale session after removal, member escalation, and atomic ownership transfer.

- [ ] **Create canonical tenant principals and transaction-scoped database context**
  - Files: `src/shared/lib/auth/tenant-principal.ts`, `src/shared/lib/auth/tenant-principal.test.ts`, `src/shared/lib/db/tenant-context.ts`, `src/shared/lib/db/tenant-context.test.ts`, `src/shared/lib/db/client.ts`, `src/shared/lib/db/index.ts`
  - Do: Implement `TenantPrincipal { userId, organizationId, role, requestId }`, `requireTenantPrincipal(request)`, and `withTenantContext<T>(principal, operation)`. Resolve `activeOrganizationId` from session, recheck membership, then inside one Drizzle transaction parameterize `select set_config('app.user_id',$1,true)`, organization, and request ID. Export `TenantTransaction`; private callbacks receive only `tx`. Keep a separate `publicDb` surface for explicitly global repositories and reject nested contexts with a different organization.
  - Verify: tests prove null/stale/spoofed context denial, correct settings inside a transaction, settings absent after commit and rollback on reused pooled connections, and concurrent A/B transactions never observe each other's setting.

- [ ] **Centralize product permissions and enforce the repository boundary**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`, `eslint.config.mjs`, `scripts/check-tenant-boundaries.mjs`, `package.json`, `test/security/tenant-boundaries.test.ts`
  - Do: Implement pure `can(principal, action, resource)` from `authorization-matrix.md`, including creator/member/admin/owner distinctions and platform-admin separation. Add `security:boundaries` that rejects global `db` imports under private repositories/routes, direct role-string checks outside permissions, private ORM row serialization, and tenant mutation without `requireTenantPrincipal`/`withTenantContext`. Permit explicit public/admin/worker allowlists with rationale in the classification manifest.
  - Verify: permission matrix tests cover every role/action cell; deliberate forbidden imports and route patterns make `pnpm security:boundaries` fail; the real tree passes after repository migration.

- [ ] **Split global builder identity from tenant tracking and public claims**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/public-builders.ts`, `src/shared/lib/repositories/organization-builders.ts`, `src/shared/lib/repositories/builder-claims.ts`, `src/shared/lib/public-builder-dto.ts`, `src/shared/lib/public-builder-dto.test.ts`, `drizzle/0003_builder_normalization.sql`
  - Do: Add `builderIdentities` unique `(source,sourceId)`, versioned `builderSourceSnapshots`, `organizationBuilders` unique `(organizationId,builderIdentityId)`, `builderClaims`, and `publishedBuilderProfiles`. Move tracking/private metadata to the organization association; keep provider provenance/global public fields on identity; bind claims to source evidence and subject user; hash one-time verification secrets; add publication opt-in. Public DTO must explicitly allow only documented identity/verified publication fields.
  - Verify: tests dedupe one external identity tracked by A/B while keeping notes/status private; unclaimed/unpublished/private metadata never appears publicly; source-bound claim and revocation work; cross-tenant tracking reference fails at DB level.

- [ ] **Normalize organization entitlements and migrate billing ownership**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/billing.ts`, `src/shared/lib/billing-shared.ts`, `src/shared/lib/repositories/entitlements.ts`, `src/shared/lib/repositories/entitlements.test.ts`, `drizzle/0004_organization_entitlements.sql`
  - Do: Add `organizationEntitlements` keyed `organizationId` with checked tier/status and period fields, plus `organizationPlanChanges` containing organization and actor FK. Resolve limits/budgets from active organization. Stop designing `plans.organizationId` beside a user PK. During compatibility, dual-write current personal org entitlements from `plans`; Team entitlement belongs directly to the team org. Lock entitlement/membership scope when allocating the final seat.
  - Verify: tests prove switching org changes effective plan without changing user identity, personal plans backfill exactly, team members share entitlement, inactive plan preserves data but denies paid action, and concurrent 10th/11th seat yields one success/one limit response.

- [ ] **Add tenant keys and organization-preserving integrity to current private resources**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0005_tenant_expand.sql`, `src/shared/lib/repositories/saved-queries.ts`, `src/shared/lib/repositories/alerts.ts`, `src/shared/lib/repositories/builder-notes.ts`, `src/shared/lib/repositories/onboarding.ts`
  - Do: Add nullable `organization_id` plus `(organization_id,id)` candidate keys to saved queries, alerts, triggers, notes, onboarding, export payload resources, and other classified tenant tables. Add composite FKs for alert→query, trigger→alert, note→organization-builder, and onboarding selections. Replace `firstBuilderIds` with `onboardingSelectedBuilders`; add normalized query keyword/source and builder topic association tables when indexed/relational. Remove duplicated tenant owner columns only in contract phase.
  - Verify: schema tests reject A child→B parent, invalid enum/status, duplicate association, and missing supporting index; generated migration is additive with concurrent-index instructions and no populated-table drop/rewrite.

- [ ] **Implement resumable personal-organization and resource backfills**
  - Files: `scripts/db/backfills/state.ts`, `scripts/db/backfills/organizations.ts`, `scripts/db/backfills/builders.ts`, `scripts/db/backfills/resources.ts`, `scripts/db/backfills/reconcile.ts`, `src/shared/lib/db/schema.ts`, `test/security/backfills.test.ts`
  - Do: Add `migrationBackfillRuns`/`migrationBackfillConflicts`; derive deterministic personal organization IDs from user IDs; create memberships/entitlements; migrate builders and every tenant resource in stable cursor batches with checkpoint, counts, checksums, retry ceiling, lock/statement timeout, dry-run, and resume. Quarantine ambiguous claims/orphans without raw sensitive payloads. Never use one unbounded update transaction.
  - Verify: legacy fixture backfill reconciles source=migrated+skipped/conflict/orphan; interruption/resume completes; second full run writes zero new canonical rows; conflict fixtures remain quarantined and do not become public.

- [ ] **Dual-write and shadow-compare every current private surface**
  - Files: `src/shared/lib/migration/tenant-flags.ts`, `src/shared/lib/migration/dual-write.ts`, `src/shared/lib/migration/shadow-read.ts`, `src/shared/lib/migration/migration-metrics.ts`, `src/shared/lib/migration/*.test.ts`, `src/routes/api/**/*.ts`
  - Do: Add server-only per-surface flags `TENANT_WRITE_MODE=legacy|dual|canonical` and `TENANT_READ_MODE=legacy|shadow|canonical`; reject canonical mode before readiness manifest passes. Dual writes share idempotency keys and transaction outcome; shadow reads compare canonical allowlisted DTO hashes/IDs and record redacted counts only. Migrate plans, tracking/notes, queries, alerts, onboarding, legal exports, and claims in dependency order.
  - Verify: create/update/delete concurrency tests keep legacy/canonical state equal; injected canonical write failure rolls back both; shadow mismatch reports IDs/counts without row values; changing a request body organization never changes stored scope.

- [ ] **Add RLS policies and direct-SQL isolation tests for every tenant table**
  - Files: `drizzle/0006_tenant_rls.sql`, `test/security/rls-manifest.ts`, `test/security/rls.test.ts`, `scripts/db/audit-schema.ts`, `docs/architecture/data-classification.md`
  - Do: For each tenant table enable and force RLS; create explicit `SELECT/INSERT/UPDATE/DELETE` policies for `builderhunt_app` using transaction-local organization and permission requirements, with `USING` plus `WITH CHECK`. Grant worker-only commands separately; deny absent settings; revoke `PUBLIC`, truncate, and base-table read-only access. Manifest maps each table/command to a named test and expected index.
  - Verify: `pnpm test:rls` connects as exact app/worker roles and proves missing/A/B/stale contexts, cross-tenant insert/update, delete roles, worker scope, and rollback/pool reuse. Owner-role execution is not accepted as test evidence.

- [ ] **Migrate APIs, workers, admin tools, exports, and deletion to tenant repositories**
  - Files: `src/routes/api/**/*.ts`, `src/shared/lib/legal.ts`, `src/lib/alerts/worker.ts`, `src/routes/api/admin/**/*.ts`, `scripts/db/seed-admin.ts`, `test/security/api-isolation.test.ts`, `test/security/worker-isolation.test.ts`, `test/security/privacy-isolation.test.ts`
  - Do: Replace direct private-table queries with tenant repositories/context; keep public routes on explicit public DTO repositories. Workers enumerate server-side organization IDs and open one context/transaction per batch. Platform admin mutations require server-verified admin plus target organization audit context. Separate account-subject export/deletion from organization export/deletion; require owner/admin/recent auth for tenant export and ownership transfer before deleting an owner account.
  - Verify: two-tenant API matrix covers every private route with own/other/random IDs and roles; worker failure in A neither exposes nor rolls back B; account export contains only subject plus explicitly authorized org summaries; organization export/delete cannot target B.

- [ ] **Harden HTTP, secrets, logs, dependencies, and AI tenant boundaries**
  - Files: `src/shared/lib/env.ts`, `src/shared/lib/rate-limit.ts`, `src/shared/lib/security/headers.ts`, `src/shared/lib/security/audit.ts`, `src/shared/lib/ai/platform.ts`, `src/shared/lib/ai/cache.ts`, `server.prod.mjs`, `.github/dependabot.yml`, `test/security/http-security.test.ts`, `test/security/log-redaction.test.ts`
  - Do: Fail production on default/weak secrets or owner DB role; set CSP/frame/content/referrer/HSTS headers; require origin/CSRF protection for cookie-authenticated mutations; validate redirect/URL/provider inputs and SSRF boundaries; key distributed rate limits by appropriate IP+user+organization/action; redact DB URLs, cookies, emails, tokens, invite/reset IDs, prompts/responses, and export payloads. Tenant-scope AI cache/budget/artifacts; keep global embeddings public-source-only. Add lockfile vulnerability/license review with documented severity policy.
  - Verify: security tests cover forged origin, missing token, XSS payload, private-network URL, open redirect, rate bypass, weak secret, owner connection, and log canaries; AI A/B cache/budget test never collides; dependency scan meets the documented release threshold.

- [ ] **Cut over canonical reads and validate tenant constraints**
  - Files: `drizzle/0007_tenant_constraints.sql`, `src/shared/lib/migration/tenant-readiness.ts`, `src/shared/lib/migration/tenant-readiness.test.ts`, `docs/operations/tenant-cutover.md`
  - Do: Require zero shadow mismatch for the observation window, complete backfill/reconciliation, RLS/role/restore evidence, and no legacy-only consumer before canonical read mode. Validate `NOT VALID` constraints, confirm zero null tenant IDs, apply `NOT NULL` and composite FKs with controlled locks, stop legacy writes surface-by-surface, and record query plans/latency for policy predicates.
  - Verify: readiness test rejects every missing artifact; migration succeeds against sanitized production-sized data within recorded lock/statement budgets; canonical API and worker suites pass while legacy read/write paths are disabled.

- [ ] **Contract legacy schema only after the compatibility window**
  - Files: `drizzle/0008_tenant_contract.sql`, `src/shared/lib/db/schema.ts`, `src/shared/lib/db/index.ts`, `src/shared/lib/migration/*`, `docs/operations/database-migrations.md`
  - Do: In a separate release remove legacy per-user builder/tracking columns, user-keyed plan paths, redundant JSON relationship fields, dual-write/shadow code, and obsolete repositories only after fresh backup/restore, zero legacy access telemetry, and explicit maintainer approval. Use a new forward recovery migration for any failure; never edit applied migrations or restore owner credentials to runtime.
  - Verify: fresh install and `0000`→latest upgrade produce identical schema fingerprints; code/search telemetry finds no legacy references; all security/static/build/runtime gates pass with only `builderhunt_app` in the web runtime.

- [ ] **Make security policy a mandatory gate across the roadmap and CI**
  - Files: `plans/README.md`, `plans/_meta/conventions.md`, `plans/_meta/app-reality.md`, `plans/team-accounts/{spec,plan,tasks}.md`, `plans/shared-resources/{spec,plan,tasks}.md`, `.github/workflows/quality.yml`, `CODEOWNERS`
  - Do: Put this foundation before schema/persistence/teams/AI waves; replace one-org custom team design with Better Auth multi-org active context; make shared resources consume canonical tenant repositories/RLS. Require security ownership review for auth/RLS/roles/tenant/export/deletion changes. CI runs migration, schema audit, DB-role, RLS, tenant A/B, boundary, dependency, static, build, and smoke gates before deploy.
  - Verify: plan validator reports all plan trios consistent and links valid; a fixture plan/table missing classification/RLS/security dependency fails CI; deploy job cannot run after any security gate failure.

## Execution handoff

Implementation must use an isolated worktree and execute tasks top-to-bottom. Each task starts with
its failing test/manifest expectation, proves the failure, implements the smallest scoped change,
runs the task-specific command plus affected regression suite, and commits only its named files.
Database role creation, production migration, RLS enforcement, credential switch, conflict
disposition, and contract/drop steps require explicit environment owner approval at execution time.
