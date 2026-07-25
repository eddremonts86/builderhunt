# Security, Normalization, and Multi-Tenancy Foundation

> **Status**: `in_progress`
> **Depends on**: nothing
> **Blocks**: [`team-accounts`](../team-accounts/spec.md), [`shared-resources`](../shared-resources/spec.md), [`activity-feed`](../activity-feed/spec.md), [`ai-expansion`](../ai-expansion/spec.md), [`semantic-search`](../semantic-search/spec.md), [`ai-sourcing-sprints`](../ai-sourcing-sprints/spec.md), [`production-infrastructure`](../production-infrastructure/spec.md)
> **Reality check**: the additive organization, tenant-key, entitlement, normalized-builder,
> auth-broker, backfill-state, bootstrap, RLS, worker/claim policies, and platform-role layers are
> implemented through migration `0012` and verified against local PostgreSQL. The tenant-boundary
> ratchet (`pnpm security:boundaries`) now tracks **0** legacy global-db imports (down from the
> earlier 37) and dual-write/shadow-read/backfill/readiness modules exist with tests. Still **not**
> done: `TENANT_READ_MODE`/`TENANT_WRITE_MODE` default to `legacy` in `.env.example` (canonical mode
> is not enabled anywhere), most tenant tables still have a **nullable** `organization_id` (contract
> phase/`NOT NULL` not applied), no contract migration has dropped legacy columns, and
> `assessTenantReadiness` requires production-only evidence (24h zero-mismatch shadow window,
> restore rehearsal, exact-role RLS/API/worker isolation runs) that has not been produced. Status
> remains `in_progress` until canonical cutover and contract land.

## Problem

BuilderHunt authorizes private data by repeating `userId` filters in route and library queries. That
model cannot safely support organizations, shared resources, persisted AI artifacts, or tenant
workers: a missing predicate becomes an IDOR/cross-tenant disclosure, and PostgreSQL provides no
independent boundary.

The current schema also conflates different data classes:

- `builders` is simultaneously a per-user tracking row, external public identity, claimed profile,
  enrichment container, and target for tenant notes/alerts;
- `plans` belongs to a user even though Team is sold as an organization entitlement;
- `alerts.queryId` and `alert_triggers.userId` do not prove same-tenant integrity;
- `onboarding_progress.firstBuilderIds` stores relational IDs inside JSON;
- claim/invitation-style tokens are stored or planned as bearer credentials without a universal
  hashing, recipient-binding, and single-use contract;
- enum-like statuses and roles are comments rather than database checks;
- most foreign keys lack supporting indexes and several deletion behaviors are implicit.

This plan does not claim that every JSON field violates normalization. It distinguishes structured,
queryable relationships from versioned snapshots: relational facts move into constrained tables;
validated provider/AI payloads may remain JSONB with schema version and provenance.

## Goal

Create a secure multi-tenant foundation in which:

1. a user can belong to multiple Better Auth organizations and select one active organization;
2. all tenant-private rows carry a mandatory, server-resolved `organization_id`;
3. application permissions and PostgreSQL RLS independently enforce isolation;
4. global public identities, personal legal/auth records, tenant data, and operational data are
   physically and behaviorally separated;
5. cross-table constraints make cross-tenant references impossible;
6. existing rows migrate without loss through expand-backfill-contract;
7. every remaining BuilderHunt plan inherits a concrete security and migration gate.

The approved architecture record is
[`docs/superpowers/specs/2026-07-20-security-multitenancy-design.md`](../../docs/superpowers/specs/2026-07-20-security-multitenancy-design.md).

## Non-goals

- No schema-per-tenant or database-per-tenant topology.
- No enterprise SSO, SCIM, custom roles, or nested Better Auth teams in the first release.
- No payment processor; manual plan approval remains, but entitlement ownership moves to the
  organization.
- No feature UI beyond an organization switcher/context shell required to exercise isolation.
- No immediate deletion of legacy columns during the first tenant-aware deploy.
- No encryption system that promises application-layer field encryption without key rotation,
  search, backup, and recovery requirements.

## Resolved architecture

### Better Auth organization boundary

Enable the installed Better Auth 1.6.9 organization plugin with static `owner`, `admin`, and
`member` roles, multiple memberships, `activeOrganizationId` session state, verified-email invite
acceptance, seven-day expiry, resend cancellation, and a server-derived membership limit. Use schema
model names `organizations`, `organization_members`, and `organization_invitations`; add
`active_organization_id` to `auth_sessions`.

BuilderHunt still owns product authorization. Better Auth answers membership and organization
lifecycle; `permissions.ts` answers whether a principal may view, create, update, share, export, or
delete a product resource.

An invitation is accepted only by an authenticated, email-verified user whose normalized email
matches the invitation email. Its ID is single-use and expires. API responses never return pending
invitation identifiers or emails to ordinary members. Organization switching verifies membership
server-side and clears stale active organization state after membership removal.

### Canonical data classes

| Existing/planned surface                                                    | Class              | Canonical ownership/model                                                              |
| --------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `auth_users`, accounts, sessions, verifications                             | Account subject    | Better Auth user/session                                                               |
| `user_consents`, `deletion_requests`, account export request metadata       | Account subject    | `user_id`; explicit uniqueness/retention                                               |
| external builders and source provenance                                     | Global public      | `builder_identities` unique `(source, source_id)` plus provider snapshot table         |
| verified claimed profile and publication settings                           | Global public      | `builder_claims`/`published_builder_profiles`, subject-bound and auditable             |
| tracked builders                                                            | Tenant private     | `organization_builders` unique `(organization_id, builder_identity_id)`                |
| saved searches, query keywords/sources, lists/items, notes, alerts/triggers | Tenant private     | mandatory `organization_id`; composite tenant FKs                                      |
| onboarding workspace selections                                             | Tenant private     | child tables, not relational IDs in JSON                                               |
| plans, limits, seats, AI budgets                                            | Tenant private     | `organization_entitlements` keyed `organization_id`                                    |
| sprints, analyses, private enrichment, timeline/workspace artifacts         | Tenant private     | mandatory `organization_id`; creator user retained only for audit/permission           |
| semantic public source index                                                | Global public      | public-source evidence only; no tenant notes, searches, emails, or private enrichments |
| activity/audit events                                                       | System operational | organization correlation plus redacted actor/target; append-only runtime grants        |
| incidents, changelog, roadmap items                                         | Global public      | public DTOs; admin mutation policy                                                     |
| worker leases, source cursors, migration/backfill checkpoints               | System operational | dedicated worker/owner role                                                            |

### Normalized target model

Core organization and entitlement relationships:

```text
auth_users ──< organization_members >── organizations ──1 organization_entitlements
auth_sessions ── active_organization_id ────────────────┘
organizations ──< organization_invitations
```

External identity and tenant tracking:

```text
builder_identities (source, source_id unique)
  ├──< builder_source_snapshots
  ├──0..1 builder_claims ── auth_users
  └──< organization_builders >── organizations
         ├──< builder_notes
         ├──< builder_list_items
         └──< tenant-private analyses/artifacts
```

Tenant relation rules:

- every tenant table has a primary key plus `UNIQUE (organization_id, id)`;
- child tables reference `(organization_id, parent_id)` to the corresponding candidate key;
- `organization_id` is never nullable after contract phase;
- `created_by_user_id`/`actor_user_id` references `auth_users` but does not define scope;
- role/status/source/visibility values use PostgreSQL check constraints generated in migration SQL;
- all foreign-key columns and policy predicates have left-prefix indexes;
- timestamps use `timestamp with time zone`, are non-null unless absence has domain meaning, and
  mutable rows have server-maintained `updated_at` behavior;
- normalized email comparison uses a single canonicalization function and unique lower-case index
  where email uniqueness is required.

Queryable keyword, source, topic, selection, and membership relationships use association tables.
JSONB is permitted for immutable provider snapshots and versioned artifacts with `{ schemaVersion,
provenance, payload }`; no JSON path decides authorization, billing, ownership, or referential
integrity.

### Tenant request and repository contract

```ts
export interface TenantPrincipal {
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "member";
  requestId: string;
}

export async function requireTenantPrincipal(
  request: Request,
): Promise<TenantPrincipal>;

export async function withTenantContext<T>(
  principal: TenantPrincipal,
  operation: (tx: TenantTransaction) => Promise<T>,
): Promise<T>;
```

`requireTenantPrincipal` derives the active organization from the Better Auth session and verifies a
current membership. `withTenantContext` starts a Drizzle transaction, calls
`set_config('app.user_id', ..., true)`, `set_config('app.organization_id', ..., true)`, and
`set_config('app.request_id', ..., true)`, then passes only the transaction handle. Private
repositories accept `TenantTransaction`; importing `db` is a lint/architecture failure.

Routes use validated request schemas and explicit response DTOs. Repository update/delete predicates
still include organization identity for clarity and query planning even though RLS also enforces it.
Public repositories expose only allowlisted global data. Administrator and worker entry points have
separate principals, database grants, and tests.

### PostgreSQL roles and RLS

Create non-login ownership roles and distinct login credentials outside committed files:

| Role                   | Purpose                  | Prohibited properties/access                                                                  |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `builderhunt_owner`    | migrations/schema owner  | no web/worker connection                                                                      |
| `builderhunt_app`      | web runtime              | no superuser, `BYPASSRLS`, object ownership, schema create, truncate, or unrestricted execute |
| `builderhunt_worker`   | scheduled worker runtime | no broad table access; explicit operations only                                               |
| `builderhunt_readonly` | support/aggregate views  | no base-table private data or mutations                                                       |

Every tenant table receives `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and command-
appropriate policies for `builderhunt_app`. An absent/empty setting matches no row. Policies include
both `USING` and `WITH CHECK`; mutation policies add centralized permission predicates when members
have different capabilities. `PUBLIC` has no schema/table/function privileges. Runtime roles cannot
`TRUNCATE` because RLS does not govern it.

RLS protects against an application query that omits its tenant predicate. It does not replace
input validation, application authorization, DTO minimization, or least-privilege roles, and it is
not presented as protection after total application-server compromise.

### Billing and limits

Replace the user-primary-keyed `plans` model with organization-owned entitlements. Each personal
organization receives the user's current plan during backfill; team organizations hold Team. The
active organization determines limits and AI budgets. Plan history records organization, actor,
previous/new tier, reason, and timestamp.

Seat enforcement counts accepted members plus usable pending invitations inside the same
transaction/lock used to create an invitation. Concurrent invitations cannot exceed the plan limit.
Downgrade disables paid actions without deleting tenant data. Ownership transfer never transfers a
personal plan row because plans no longer belong to users.

### Privacy, audit, and operational controls

- Account export covers the subject's auth/consent/claim data and enumerates organization data the
  user may export under current role.
- Organization export is owner/admin-only, tenant-scoped, asynchronous, encrypted at rest by the
  platform storage layer, short-lived, and audited.
- Account deletion removes or anonymizes subject-owned data, revokes sessions, and requires transfer
  of sole organization ownership. Tenant resources persist under the organization unless an
  organization deletion is separately authorized.
- Organization deletion uses recent authentication, a confirmation challenge, grace period,
  cancellation, and a forward-only purge workflow.
- Audit events are append-only to runtime roles, redact request bodies/tokens/prompts, and record
  organization, actor, action, target type/ID, result, request ID, and timestamp.
- Backups are encrypted, access-controlled, retained by policy, and restore-tested. Logs never print
  database URLs, cookies, invitation IDs, reset tokens, access tokens, raw prompts/responses, or
  exported payloads.

## Threat model and required tests

The minimum threat set is:

1. horizontal IDOR between tenant A and B;
2. vertical privilege escalation from member to admin/owner;
3. spoofed organization in any client-controlled field;
4. missing or leaked pooled-connection context;
5. stale session after membership/role removal;
6. cross-tenant foreign-key insertion or update;
7. invitation theft, replay, wrong-recipient acceptance, or seat-limit race;
8. public DTO leaking tenant/private/provider/auth fields;
9. worker iterating tenants without isolation;
10. account/organization export or deletion crossing authority boundaries;
11. CSRF, injection, XSS, SSRF, redirect, brute-force, and secret/log leakage on affected surfaces;
12. migration drift, partial backfill, lock exhaustion, failed contract, and untested restore.

CI seeds two organizations with two members each and runs API tests plus direct SQL as
`builderhunt_app`. Direct SQL without context returns zero private rows and cannot insert. Context A
cannot read, update, delete, reference, or infer B. A transaction rollback and a subsequent pooled
transaction prove settings do not persist.

## Migration strategy

Use immutable, forward-only migrations and separate schema/data operations:

1. **Inventory:** record table class, owner key, foreign keys, row counts, nulls, duplicates,
   orphans, sizes, and hottest queries.
2. **Expand identity:** enable Better Auth organizations, add session active organization, create
   organization entitlements, roles, grants, audit/backfill tables, and nullable tenant columns.
3. **Expand normalized data:** create global builder identity and tenant association tables plus
   tenant-preserving candidate/composite keys.
4. **Backfill:** create deterministic personal organizations and migrate resources in resumable
   batches with checkpoints and reconciliation reports.
5. **Dual write:** application writes legacy and new models idempotently; shadow reads compare
   results and report mismatches without exposing data.
6. **Tenant read cutover:** route all private operations through tenant repositories and active
   organization context.
7. **RLS enforcement:** switch production runtime credentials to `builderhunt_app`; enable/force
   policies after direct-SQL tests pass.
8. **Contract:** apply not-null/check/composite FKs and stop legacy writes. Drop legacy structures in
   a later release only after the compatibility window and a fresh backup.

Indexes on populated tables use `CREATE INDEX CONCURRENTLY`; validation uses `NOT VALID` constraints
followed by `VALIDATE CONSTRAINT` when appropriate. Backfills use bounded batches, stable cursor
ordering, `FOR UPDATE SKIP LOCKED` only where parallel workers are justified, statement/lock
timeouts, retry ceilings, and an explicit abort path.

## Acceptance criteria

- Better Auth organization creation, invitation, verified-recipient acceptance, multi-membership,
  switching, removal, and ownership lifecycle pass integration tests.
- All current tenant-private tables and every planned private table in the roadmap have a documented
  organization ownership path; no authorization or relation depends on JSON.
- Tenant A/B isolation succeeds through APIs and direct SQL using the exact production runtime role.
- Missing context is default-deny; owner/superuser credentials are absent from the web/worker runtime.
- Cross-tenant composite references are rejected by PostgreSQL before application logic.
- Existing user/resource/plan counts reconcile exactly after backfill, with explicit conflict and
  orphan disposition.
- A sanitized production-sized rehearsal satisfies recorded lock/time budgets; backup restore plus
  migrations passes RLS and integrity suites.
- `_meta/security-policy.md` is referenced by conventions and the roadmap completion gate; all
  conflicting team/shared-resource plans are reconciled.
- CI blocks merges/deploys on migration collision/drift, security tests, lint, type-check, unit,
  build, and critical runtime smoke failures.

## Success measures

- Zero cross-tenant rows observable or mutable in the tenant A/B matrix.
- 100% of tenant tables have RLS, force-RLS, organization indexes, and direct-SQL policy tests.
- 100% of tenant relations use organization-preserving foreign keys.
- 100% of route handlers touching private data enter through the tenant context/repository boundary.
- Zero production application connections use the schema owner, superuser, or `BYPASSRLS` role.
- Every production migration has rehearsal, reconciliation, observability, and forward-recovery
  evidence.
