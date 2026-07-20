# BuilderHunt Security and Multi-Tenancy Design

**Approved:** 2026-07-20

## Purpose

BuilderHunt must treat tenant isolation as a platform invariant before team accounts, shared
resources, persisted AI artifacts, or background discovery expand the current data model. The
current application is single-user scoped: most private rows carry `user_id`, every authorization
decision is implemented in application queries, PostgreSQL row-level security is absent, and the
application can connect with a database owner role. That is insufficient for a multi-tenant SaaS.

This design introduces multi-organization identity, normalizes global and tenant-owned data,
enforces isolation in both the application and PostgreSQL, and makes security evidence a required
completion gate for every implementation plan.

## Selected approach

Use Better Auth's organization plugin for organization membership, invitations, roles, and active
organization state. Keep product authorization in BuilderHunt services and add PostgreSQL RLS as an
independent guard against missing tenant filters.

Two rejected alternatives are:

1. Application filters only. This is simple but permits a single missing predicate to disclose or
   mutate another tenant's data.
2. Custom organization and invitation tables plus RLS. This can be secure, but it duplicates
   identity lifecycle code already supplied by the installed Better Auth version and creates a
   larger custom authentication surface.

## Tenant model

A user may belong to multiple organizations. Each authenticated session has zero or one active
organization. Every request that accesses tenant data must resolve the session, verify that the
user is a current member of the active organization, and create a transaction-scoped database
context. Client-provided organization IDs never establish authority.

Every existing user receives a personal organization during migration. Personal and team
workspaces therefore use the same ownership model. An organization's plan and entitlements belong
to the organization, not to its owner. Switching organizations switches both data scope and
entitlements.

Static roles are `owner`, `admin`, and `member`. Product actions use an explicit permission map;
role names are not scattered through route handlers. Exactly one owner is enforced per
organization. Ownership transfer, membership removal, invitation acceptance, plan changes, and
destructive privacy actions are atomic transactions with audit events.

## Data classification and normalization

All tables must be classified before migration:

- **Global public:** externally sourced identities, published profiles, public roadmap/changelog,
  incidents, and non-sensitive source metadata. These rows do not carry tenant ownership.
- **Account subject:** authentication records, user consent, account deletion, and account-level
  export history. These rows use `user_id` because the legal subject is a person.
- **Tenant private:** tracked builders, searches, lists, notes, alerts, alert delivery, sourcing
  sprints, work-sample analyses, AI artifacts, organization activity, and plan entitlements. These
  rows require `organization_id`.
- **System operational:** worker leases, migration records, aggregate metrics, and redacted audit
  records. Access is limited to dedicated operational roles.

The current `builders` table is split into a global `builder_identities` table keyed by
`(source, source_id)` and an `organization_builders` association containing tenant-private tracking
state. Verified public ownership lives in `builder_claims`; tenant notes and enrichment never enter
the public identity row.

Tenant relations use composite foreign keys containing `organization_id`. For example, an alert
cannot reference a saved query unless both rows have the same organization. Duplicated owner fields
that can be derived from a parent are removed unless they serve an independently documented audit
or recipient purpose.

JSONB remains valid only for versioned provider snapshots, validated AI artifacts, and data that is
not used for authorization or relational integrity. Queryable relationships such as onboarding
builder selections, builder topics, saved-query sources, and saved-query keywords use child or
join tables when they require constraints, joins, or independent indexing.

## Database enforcement

Production uses separate PostgreSQL roles:

- `builderhunt_owner`: owns schemas and executes migrations; the web application cannot assume it.
- `builderhunt_app`: runtime web role; no `SUPERUSER`, `BYPASSRLS`, object ownership, `CREATE`,
  `TRUNCATE`, or broad schema privileges.
- `builderhunt_worker`: optional runtime role for approved background operations, restricted to the
  tables and commands each worker requires.
- `builderhunt_readonly`: optional support/analytics role with redacted views only.

Private tables use both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Policies apply
`USING` and `WITH CHECK` conditions against transaction-local settings:
`app.user_id`, `app.organization_id`, `app.request_id`, and an explicitly authorized operational
context where necessary. Default is deny when context is absent or invalid. Standard privileges
are revoked from `PUBLIC`.

`withTenantContext()` is the only application entry point for private database work. It opens a
Drizzle transaction, verifies membership, sets context with `set_config(..., true)`, and passes the
transaction handle to a callback. Tenant repositories accept that handle and never import the
global `db` object. `SET LOCAL`/transaction-local settings prevent context leaking through pooled
connections.

Global public reads use a separate narrow repository surface. Administrative and worker operations
use dedicated entry points and policies; they never simulate a tenant by trusting request input.

## Authentication and invitation security

Enable Better Auth Organizations with multiple memberships and `activeOrganizationId` on sessions.
Organization creation and membership limits derive from server-side plan data. Invitations require
a verified session email matching the normalized invited email, expire, are single-use, and can be
revoked. Invite identifiers are never accepted as sufficient authority to choose a different email
or role. Responses do not reveal whether unrelated email addresses have accounts.

Session organization changes verify membership before persistence. Removing a member invalidates
that organization's active session context. Sensitive changes require recent authentication and
produce an audit event. Authorization failures use consistent `404` or `403` behavior to avoid
resource enumeration.

## Migration and deployment

Production migrations are immutable and forward-only. `drizzle-kit push` is development-only.
Schema and data migrations are separate. The rollout uses expand-backfill-contract:

1. Create organization/auth structures, database roles, normalized tables, nullable tenant columns,
   composite candidate keys, and supporting indexes.
2. Create one personal organization per existing user and establish memberships and organization
   plans.
3. Backfill in resumable, idempotent batches with reconciliation counts and orphan reports.
4. Deploy dual writes and compare legacy/new representations.
5. Enable RLS in shadow tests while production reads remain compatible.
6. Switch reads and writes to tenant repositories.
7. Validate zero null tenant keys, zero cross-tenant references, and stable performance.
8. Apply `NOT NULL`, foreign keys, checks, and `FORCE ROW LEVEL SECURITY`; switch runtime to the
   non-owner application role.
9. Remove legacy columns and tables only in a later release after the compatibility window.

Indexes on existing large tables are created concurrently outside transaction-wrapped migrations.
Lock and statement timeouts fail safely. A sanitized production-sized rehearsal, backup restore,
and forward recovery exercise are required before enforcement.

## Security gates for all plans

No plan that reads, persists, shares, exports, deletes, or sends private data can be marked
`implemented` until it provides:

- table-level data classification and retention;
- server-resolved tenant context and least-privilege authorization;
- composite tenant integrity and an RLS policy where applicable;
- owner/member/non-member/admin and tenant A/tenant B negative tests;
- IDOR, missing-context, spoofed-tenant, stale-membership, and concurrent-role-change tests;
- validated input and output DTO allowlists;
- CSRF, XSS, SSRF, rate-limit, secret, logging, and dependency review as applicable;
- export/deletion behavior covering both personal and organization data;
- forward migration, compatibility, observability, and recovery evidence;
- `lint`, `type-check`, unit, integration, migration, RLS, and runtime smoke gates in CI.

AI plans additionally isolate cache keys, budgets, persisted artifacts, and audit metadata by
organization. Prompts and model responses never enter unrestricted logs. Background workers resolve
their organization scope from persisted server data rather than request parameters.

## Success criteria

- A seeded tenant A can never read, mutate, reference, export, or infer tenant B private rows through
  application APIs or direct `builderhunt_app` SQL.
- A request without valid tenant context observes default-deny behavior on every private table.
- A user can switch between multiple organizations without cross-tab or pooled-connection leakage.
- Every private foreign-key path preserves organization identity.
- Current users and private rows are migrated without loss, duplication, or entitlement changes.
- Backup restore plus all forward migrations produces a database that passes schema-drift, RLS, and
  isolation tests.
