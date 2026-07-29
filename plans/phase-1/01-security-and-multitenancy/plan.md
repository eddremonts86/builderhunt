# Delivery Plan: Security, Normalization, and Multi-Tenancy Foundation

> **Status**: `in_progress`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../27-team-accounts/plan.md), [`shared-resources`](../28-shared-resources/plan.md), [`activity-feed`](../29-activity-feed/plan.md), [`ai-expansion`](../21-ai-expansion/plan.md), [`semantic-search`](../22-semantic-search/plan.md), [`ai-sourcing-sprints`](../41-ai-sourcing-sprints/plan.md), [`production-infrastructure`](../02-production-infrastructure/plan.md)
> **Reality check**: roles, Better Auth organizations, tenant context, normalized expand schema,
> personal-organization bootstrap, RLS, worker/claim policies, platform role, and local exact-role
> verification are implemented, including dual-write/shadow-read/backfill/readiness code with tests.
> The tenant-boundary ratchet is now at **0** baselined legacy global-db imports (verified via
> `pnpm security:boundaries`), down from 37. Canonical flags remain blocked: `.env.example` still
> defaults `TENANT_READ_MODE`/`TENANT_WRITE_MODE` to `legacy`, most tenant tables keep a nullable
> `organization_id` (no contract migration yet), and `assessTenantReadiness` still requires
> production evidence (24h zero-mismatch shadow window, restore rehearsal, exact-role RLS/API/worker
> isolation runs) that has not been produced.

## Delivery principle

Treat this as a compatibility program, not a single schema patch. Every phase ends in a deployable
state, has explicit evidence, and leaves legacy reads available until the new representation has
reconciled. RLS enforcement and destructive contract migrations occur only after the tenant-aware
application path is proven with production-like data.

## Phase 0 — Inventory, threat model, and ownership map

Create machine-readable table classification and authorization matrices from current plus planned
schemas. Record row counts, sizes, foreign keys, missing indexes, duplicates, orphans, enum-like
values, JSON-held relationships, route/repository access paths, and public DTO fields. Map every
roadmap plan to global public, account subject, tenant private, or operational storage.

Write failing architecture tests before schema work: private repositories importing global `db`,
tenant routes without `requireTenantPrincipal`, public handlers returning unrestricted ORM rows,
and planned tenant tables without `organization_id` must be detectable. Freeze the current database
and API behavior in characterization tests so migration regressions are visible.

Exit evidence: reviewed data classification, authorization matrix, threat model, schema audit, and
failing tenant A/B test skeleton.

## Phase 1 — Separate database identities and establish the test harness

Create owner, application, worker, and read-only role migrations with explicit revokes/grants.
Provision distinct migration/runtime URLs through env validation and deployment configuration; never
commit credentials. Local/test Postgres must exercise the same privilege boundary instead of using
`postgres` for application tests.

Add integration helpers that create isolated databases, apply migrations, connect as each role,
seed tenants/users/members, and inspect current role/RLS state. Add backup/restore and schema-drift
checks before private data changes.

Exit evidence: application role cannot create/drop/truncate tables, read private candidate tables
without policy, or assume owner; migration role can apply the migration chain.

## Phase 2 — Adopt Better Auth organizations

Enable Better Auth's installed organization plugin using mapped Drizzle tables. Add organizations,
memberships, invitations, and `auth_sessions.active_organization_id`; configure static roles,
verified-recipient invitation acceptance, expiry, membership limits, and email delivery. Do not
enable nested teams or dynamic roles.

Create personal organizations for new registrations in an idempotent post-registration hook. Build
`requireTenantPrincipal`, organization switching, stale membership/session clearing, centralized
permissions, and organization lifecycle audit events. Keep existing user-scoped product routes
unchanged during this phase.

Exit evidence: one user belongs to two organizations, switches active context safely, cannot select
an unrelated organization, and cannot accept another email's invitation.

## Phase 3 — Expand the normalized model

Add organization-owned entitlements and tenant columns to current private tables as nullable.
Introduce global builder identities, provider snapshots, verified claims/public profiles, and
organization builder tracking. Add join tables for queryable keyword/source/topic/onboarding
relationships and candidate keys for composite tenant foreign keys.

Do not add populated-table constraints or blocking indexes in the same transactional migration.
Create large indexes concurrently in migration steps explicitly configured outside a transaction.
Add constraints as `NOT VALID` when it avoids long blocking validation.

Exit evidence: generated SQL contains no legacy drops or unexpected rewrites; new empty structures
accept valid seed data and reject enum/uniqueness violations.

## Phase 4 — Backfill personal organizations and data

Create deterministic personal organization IDs from existing user IDs, membership rows, and
organization entitlements matching current `plans`. Backfill each tenant table in stable primary-key
batches. Split `builders` into a deduplicated global identity and per-organization tracking row;
record conflicting claim/public fields for manual disposition rather than choosing silently.

Backfill association tables from validated JSON arrays. Quarantine orphan references with reason,
source table/ID, and non-sensitive checksum; never discard them silently. Persist batch checkpoints
and reconciliation counters so every step is idempotent and resumable.

Exit evidence: source/migrated/skipped/conflict/orphan counts reconcile, rerunning every backfill
changes zero completed rows, and sampled public/tenant DTOs match the legacy behavior.

## Phase 5 — Tenant context, repositories, and dual writes

Implement transaction-scoped context and focused repositories. Migrate product services in
dependency order: plans/limits, tracked builders/notes, saved queries, alerts/triggers, onboarding,
exports/deletion, claims/public profiles, then planned AI/team surfaces. Every private repository
accepts a transaction handle and organization ID comes from `TenantPrincipal`.

Deploy dual writes guarded by a server flag and idempotency keys. Shadow reads compare legacy/new
IDs and canonical DTO hashes, emit redacted mismatch metrics, and never substitute tenant data across
contexts. Per-surface flags permit rollback to legacy reads without undoing schema.

Exit evidence: legacy and normalized representations remain equal through concurrent create/update/
delete tests; deliberate organization spoofing has no effect.

## Phase 6 — RLS policy implementation and enforcement rehearsal

Add `ENABLE/FORCE ROW LEVEL SECURITY`, command-specific policies, and explicit runtime grants for
each tenant table. Test policies directly as `builderhunt_app`, including missing context, wrong
tenant, insert/update `WITH CHECK`, stale membership, and transaction-pool reuse. Restrict operational
tables with the worker role and expose read-only aggregates through reviewed views.

Run policies in an isolated production-like rehearsal first. In production, deploy policy objects
while the runtime still supports legacy rollback, then switch `DATABASE_URL` to the app role and
observe deny/error/mismatch metrics. Never use the owner role as an emergency runtime workaround;
roll forward or switch the feature read flag.

Exit evidence: direct SQL and API matrices show no cross-tenant visibility/mutation; runtime role
and table ownership queries match the approved manifest.

## Phase 7 — Cut over reads and validate constraints

Switch each surface to tenant repositories after its shadow mismatch rate is zero for the defined
observation window. Validate `NOT VALID` constraints, confirm no null tenant IDs, apply `NOT NULL`,
and activate composite foreign keys. Stop legacy writes only after every consumer, worker, export,
admin tool, and cleanup script is inventoried and migrated.

Run performance plans for policy predicates and common tenant queries; add indexes based on observed
plans rather than speculative duplication. Test concurrent invitation/seat allocation, ownership
transfer, member removal, exports, deletion, worker batches, and organization switches.

Exit evidence: normalized path is authoritative, all constraints validate, query budgets hold, and
legacy read flags can be disabled without changing responses.

## Phase 8 — Contract and make the policy a roadmap gate

After at least one release compatibility window and a fresh restore test, remove obsolete columns,
duplicate tables, dual-write code, and legacy repository paths through new forward migrations.
Update every plan's persistence section to classify data and reference `_meta/security-policy.md`.
Make CI fail when a new tenant table lacks ownership, RLS, indexes, direct-SQL tests, or composite
tenant integrity.

Exit evidence: clean schema audit, no legacy access paths, all roadmap plans reconciled, and release
gate required before deployment.

## File/module boundaries

| Path                                                   | Responsibility                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/shared/lib/db/schema.ts`                          | Drizzle table/constraint declarations; no request authorization            |
| `src/shared/lib/db/client.ts`                          | owner-free runtime clients and shared connection lifecycle                 |
| `src/shared/lib/db/tenant-context.ts`                  | transaction-local PostgreSQL settings and `TenantTransaction`              |
| `src/shared/lib/auth/better-auth.ts`                   | Better Auth plus organization plugin lifecycle configuration               |
| `src/shared/lib/auth/tenant-principal.ts`              | session, active organization, membership, and request principal resolution |
| `src/shared/lib/authorization/permissions.ts`          | pure role/resource/action permission predicates                            |
| `src/shared/lib/repositories/public-builders.ts`       | allowlisted global public identity/profile access                          |
| `src/shared/lib/repositories/organization-builders.ts` | tenant tracking and private builder associations                           |
| `src/shared/lib/repositories/*`                        | tenant-domain queries accepting `TenantTransaction`                        |
| `src/shared/lib/security/audit.ts`                     | redacted append-only audit events                                          |
| `scripts/db/backfills/*`                               | resumable/idempotent data migrations and reconciliation                    |
| `scripts/db/audit-schema.ts`                           | classification, ownership, FK/index/RLS/drift manifest                     |
| `test/security/*`                                      | database role, RLS, tenant A/B, IDOR, migration, and pool-leak tests       |
| `docs/architecture/data-classification.md`             | table/field class, retention, owner key, public DTO                        |
| `docs/architecture/authorization-matrix.md`            | resource/action roles and owner/admin/system exceptions                    |
| `docs/operations/database-migrations.md`               | immutable migration, rehearsal, rollout, recovery, and restore runbook     |

## CI gate matrix

| Gate                  | Command                                                   | Pass condition                                                                     |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Migration metadata    | `pnpm exec drizzle-kit check`                             | no migration collision; journal/snapshots/files agree                              |
| Schema policy         | `pnpm db:audit-schema`                                    | every table classified; every private table has tenant key/index/RLS/test manifest |
| Migration rehearsal   | `pnpm test:migrations`                                    | empty + legacy fixture + sanitized-scale upgrade and rerun succeed                 |
| Database privileges   | `pnpm test:db-roles`                                      | app/worker/read-only grants match manifest; no owner/BYPASSRLS runtime             |
| RLS                   | `pnpm test:rls`                                           | missing context and tenant A/B direct-SQL matrix default-deny                      |
| API authorization     | `pnpm test:security`                                      | IDOR, roles, invitations, CSRF, public DTO, export/delete matrices pass            |
| Pool isolation        | `pnpm test:tenant-context`                                | committed/rolled-back transactions leave no context for next pooled request        |
| Static/build/runtime  | `pnpm lint && pnpm type-check && pnpm test && pnpm build` | exit 0 plus critical preview routes                                                |
| Restore/forward proof | operations-run artifact                                   | encrypted backup restores; all migrations, integrity, RLS, and smoke checks pass   |

## Risks and controls

| Risk                                                    | Control                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| RLS causes production outage                            | tenant repository/shadow rollout first; app-role rehearsal; per-surface read flags; forward recovery, never owner runtime |
| Backfill assigns data to wrong tenant                   | deterministic personal org mapping, batched reconciliation, conflict quarantine, legacy/new DTO hashes                    |
| Better Auth schema diverges from declared Drizzle model | pin installed version, generate/inspect plugin schema, adapter contract test, migration diff gate                         |
| Active organization becomes stale                       | membership validation on tenant entry, session clearing on removal, default deny when null/stale                          |
| Concurrent invites exceed seats                         | transaction/locking around entitlement + usable invite count; concurrency test                                            |
| RLS context leaks through connection pool               | `set_config(..., true)` only inside transaction; rollback/commit pool reuse tests                                         |
| Composite FKs or indexes lock large tables              | expand first, concurrent indexes, `NOT VALID` then validate, lock/statement timeouts, production-size rehearsal           |
| Global identity leaks private enrichment                | separate public/tenant tables and repositories; public DTO allowlist/golden tests                                         |
| Admin/worker becomes a universal bypass                 | separate roles and principals, narrow grants/policies, authenticated jobs, immutable/redacted audit                       |
| Dirty migration history/drift                           | immutable files, journal/snapshot audit, hash inventory, restore-from-zero and upgrade-from-legacy CI                     |

## Rollout and rollback

Rollback is application compatibility, not reverse production DDL. Before contract, disable the
affected new read flag and continue dual writes while fixing forward. After RLS enforcement, retain
the non-owner runtime role and roll forward policy/application corrections; never restore owner
credentials to the web service. Data backfills are idempotent and safe to resume. Destructive cleanup
waits one full compatibility release and requires a fresh verified backup.

Any irreversible organization purge, legacy table drop, or conflict disposition requires explicit
maintainer approval with row counts and restore point. Production schema migrations are never edited
after application.

## Completion evidence

Attach the classification and authorization docs, schema/RLS manifest, migration SQL review,
sanitized-scale timing/locks, reconciliation report, tenant A/B API and direct-SQL results, role
grant dump, pool reuse tests, invitation/seat concurrency results, backup restore artifact, forward
recovery rehearsal, CI run, rollout dashboard, and post-deploy smoke. Mark implemented only when
every artifact corresponds to the production release and no legacy owner connection remains.
