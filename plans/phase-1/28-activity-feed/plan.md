# Delivery Plan: Tenant Activity Feed

> **Status**: `blocked`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/plan.md), [`team-accounts`](../26-team-accounts/plan.md), [`shared-resources`](../27-shared-resources/plan.md)
> **Blocks**: nothing
> **Reality check**: event persistence and instrumentation do not exist; use canonical tenant
> transactions and activity/audit separation rather than actor-to-org lookup or best-effort direct DB
> writes.

## Phases

1. Define versioned event schemas, redaction, criticality, idempotency, target integrity, and product-
   activity versus security-audit mapping.
2. Add tenant table, indexes, grants, RLS, retention policy, and direct-SQL tests through the
   foundation migration path.
3. Implement transaction-bound emit/list repositories and instrument verified Team/shared-resource
   domain services, not route-level global DB calls.
4. Add tenant API, organization-keyed cache, page/widget, formatting, filters, and pagination.
5. Add bounded worker pruning, export/privacy integration, performance, A/B, retry/idempotency,
   accessibility, and release evidence.

## Risks and controls

| Risk                                | Control                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Feed leaks sensitive domain data    | per-event zod metadata allowlists, redaction tests, no raw payload/request/log reuse  |
| Event and mutation diverge          | same tenant transaction plus idempotency; defined criticality instead of silent catch |
| Cross-tenant target/reference       | principal context, RLS, composite organization integrity, A/B direct-SQL/API tests    |
| Security audit exposed as activity  | separate tables/repositories/DTOs/grants; ordinary members cannot query audit         |
| Unbounded growth or slow pagination | 180-day bounded worker retention and indexed keyset query with scale plan evidence    |

## Rollout and rollback

Instrument one event family at a time behind a server flag after table/RLS tests. Roll back page and
emission flags without weakening tenant policy; preserve rows until retention. Fix schema/policies
with forward migrations only.

## Completion evidence

Attach event registry/redaction review, schema/RLS manifest, transaction/idempotency tests, tenant
A/B API/direct-SQL matrix, target FK failures, pagination scale plan, retention worker grants,
export/privacy tests, browser accessibility suite, and production smoke.
