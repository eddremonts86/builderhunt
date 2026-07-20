# Security and Multi-Tenancy Policy

This policy is binding for every BuilderHunt plan, route, repository, background worker, and
migration. The implementation program lives in
[`security-and-multitenancy`](../security-and-multitenancy/spec.md).

## Default rules

1. **Default deny.** Missing authentication, tenant context, membership, permission, or RLS policy
   denies access. A client-supplied organization ID is a selector only; it never grants authority.
2. **Multiple organizations.** A user may belong to several organizations. The active organization
   is session state validated against current membership on every tenant entry point.
3. **Two enforcement layers.** Application services authorize actions and PostgreSQL RLS isolates
   rows. Neither layer substitutes for the other.
4. **Least-privilege database roles.** Migrations run as the schema owner. Web and worker runtimes
   use non-owner, non-superuser, non-`BYPASSRLS` roles with explicit grants.
5. **Transaction-scoped context.** Private queries run through `withTenantContext()` and receive a
   transaction handle after `set_config(..., true)` establishes user, organization, and request
   context. Repositories that touch private tables do not import the global `db` object.
6. **Tenant-preserving integrity.** Every private table has `organization_id`; tenant-to-tenant
   relations use composite foreign keys containing it. Creator or recipient user IDs do not replace
   tenant ownership.
7. **Public/private separation.** Global externally sourced identities and explicitly published
   profiles are physically distinct from tenant tracking, notes, lists, enrichment, and analytics.
8. **No authorization data in JSON.** Membership, roles, ownership, visibility, entitlements, and
   relational references use typed columns and constraints. JSONB is limited to validated,
   versioned snapshots or artifacts.
9. **Safe migrations.** Production migrations are immutable, forward-only, and reviewed SQL.
   Schema and data changes are separate. Existing-table changes use expand-backfill-contract,
   resumable batches, reconciliation, and delayed destructive cleanup.
10. **Output minimization.** Public and tenant APIs return explicit DTO allowlists. ORM rows,
    provider payloads, secrets, tokens, internal metadata, and cross-tenant existence signals are
    never returned wholesale.

## Data classes

| Class              | Ownership key       | Examples                                                                  | Required controls                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Global public      | none                | source identities, published profiles, changelog, roadmap, incidents      | DTO allowlist, provenance, publication/claim policy                               |
| Account subject    | `user_id`           | auth, consent, account deletion, account export history                   | subject authorization, retention, encryption/redaction                            |
| Tenant private     | `organization_id`   | tracking, searches, notes, alerts, lists, sprints, analyses, AI artifacts | application permission, composite tenant FKs, RLS `USING` and `WITH CHECK`        |
| System operational | system/job identity | migration state, worker leases, aggregate metrics, redacted audit events  | dedicated role, narrow grants, authenticated worker, immutable/redacted telemetry |

Every new table must declare one class in its plan and in
`docs/architecture/data-classification.md`. Mixed-class tables require an explicit redesign or a
documented reason and separate DTO/repository surfaces.

## Authorization contract

The canonical application types are:

```ts
export type OrganizationRole = "owner" | "admin" | "member";

export interface TenantPrincipal {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  requestId: string;
}

export type TenantTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
```

`requireTenantPrincipal(request)` resolves the Better Auth session and active organization, verifies
membership, and returns `TenantPrincipal`. `withTenantContext(principal, callback)` starts a
transaction, establishes local PostgreSQL settings, and passes `TenantTransaction` to the callback.
Permission predicates are centralized in `src/shared/lib/authorization/permissions.ts` and receive
the principal plus resource attributes; route components never infer permission from client state.

## PostgreSQL policy contract

Every tenant-private table follows this shape, adapted only when the permission model is stricter:

```sql
ALTER TABLE tenant_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_table FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_table
  TO builderhunt_app
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
  );
```

Policies are explicit for `SELECT`, `INSERT`, `UPDATE`, and `DELETE` when role or ownership rules
differ. `PUBLIC` receives no table/schema privileges. Runtime roles receive no `TRUNCATE` or
`REFERENCES` authority. Table owners never serve web traffic.

## Required threat cases

Every affected endpoint and repository must prove the relevant cases:

- unauthenticated request;
- authenticated user with no active organization;
- spoofed organization in URL, body, header, or query string;
- tenant A user against tenant B ID;
- stale session after membership removal;
- member attempting owner/admin action;
- concurrent role or ownership change;
- missing RLS context and direct SQL as `builderhunt_app`;
- cross-tenant foreign-key reference;
- ID enumeration and response-timing/existence leakage;
- CSRF on cookie-authenticated mutations;
- injection, unsafe HTML, SSRF, redirect, upload, and webhook cases where applicable;
- rate-limit bypass across IP, user, organization, or worker identities;
- secrets, tokens, prompts, model responses, emails, and personal data in logs.

## AI and background work

- Cache keys, budgets, artifacts, semantic search history, and saved outputs include the server-
  resolved organization ID.
- Global public embeddings contain only approved public-source data and never tenant notes,
  searches, private enrichments, or contact data.
- Workers acquire scope from persisted server-side records and execute each tenant batch in its own
  database transaction/context. An organization failure cannot expose or roll back another tenant.
- Provider prompts and responses follow `_meta/ai-policy.md`; logs store task ID, provider, latency,
  token/cost counters, result status, and redacted organization/request correlation only.

## Migration and release gate

A plan that changes persistence cannot be marked `implemented` until all are true:

1. Migration files and Drizzle journal/snapshots agree; `pnpm exec drizzle-kit check` passes.
2. Schema diff contains no unexplained drop, rename, table rewrite, or non-concurrent large index.
3. Backfill is resumable/idempotent and reports source, migrated, skipped, conflicting, and orphan
   counts.
4. Sanitized production-sized migration rehearsal and lock-time evidence exist.
5. Backup restore followed by all migrations passes integrity and RLS tests.
6. Tenant A/B API tests and direct-SQL RLS tests run in CI using the non-owner runtime role.
7. `pnpm lint`, `pnpm type-check`, unit, integration, build, and runtime smoke gates pass.
8. Rollout, compatibility window, forward-recovery migration, monitoring, and owner are recorded.
9. The plan updates `docs/architecture/data-classification.md` and
   `docs/architecture/authorization-matrix.md`.

## Review ownership

Changes to authentication, memberships, tenant context, RLS, database roles, billing ownership,
exports/deletion, invitation acceptance, or public/private classification require a dedicated
security review. No plan may weaken this policy locally; an exception requires an architecture
decision record, explicit expiry date, compensating controls, and maintainer approval.
