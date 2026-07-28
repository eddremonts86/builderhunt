# Delivery Plan: Shared Searches and Builder Lists

> **Status**: `blocked`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/plan.md), [`team-accounts`](../26-team-accounts/plan.md)
> **Blocks**: [`activity-feed`](../28-activity-feed/plan.md)
> **Reality check**: current resources are user-scoped and the prior shared design predated canonical
> tenant repositories/RLS/global builder identities. Do not add nullable organization columns or
> direct `mine OR org` route queries outside the foundation migration.

## Phase 1 — Consume canonical tenant contracts

Verify active tenant, entitlements, permissions, normalized saved query/alert/builder identity tables,
organization tracking, RLS, and organization-keyed cache contracts. Define shared-resource DTOs and
characterization tests before feature behavior.

## Phase 2 — Tenant repositories and permissions

Build saved-query and builder-list repositories accepting `TenantTransaction`. Implement private vs
organization visibility and creator/admin/owner mutations with the centralized permission service.
All child relationships preserve organization identity.

## Phase 3 — API integration

Migrate existing query/alert endpoints and add list/item endpoints. Validate bodies, ignore/reject
client tenant authority, return allowlisted DTOs, and emit redacted activity hooks. Replace public RSS
access to raw query IDs with a revocable publication capability owned by `rss-feeds`.

## Phase 4 — Organization-aware UI

Add visibility/creator UI, lists pages, and add-to-list actions using Team's tenant query provider.
Cache and optimistic updates include active organization; switch/removal invalidates them.

## Phase 5 — Isolation and release

Run RLS/direct-SQL/API/browser A/B matrices, cross-tenant FK tests, permission matrix, alerts/email
semantics, cache switching, export/privacy, accessibility, and non-Team regression. Emit activity
events only after activity-feed's schema accepts the same tenant contract.

## Risks and controls

| Risk                                    | Control                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| Cross-org read/mutation/reference       | tenant repositories + RLS + composite FKs + A/B API/direct-SQL tests                   |
| Per-user/global builder duplication     | canonical `builder_identities` plus tenant organization association                    |
| RSS discloses private saved query       | explicit revocable public-feed capability; raw tenant query ID is not public authority |
| Organization switch leaves stale cache  | organization-keyed cache and Team provider invalidation contract                       |
| Shared search unexpectedly emails users | no auto-alert; recipient-owned opt-in alert semantics                                  |

## Rollout and rollback

Release tenant-private saved queries first, then visibility, lists/items, alert provenance, and UI.
Use per-surface canonical read flags from the foundation while compatibility exists. Roll back
feature routes/UI without weakening RLS or dropping tenant data; fix schema/policies forward.

## Completion evidence

Attach contract tests, permission matrix, schema/RLS manifest, composite FK failures, tenant A/B API
and direct-SQL results, cache switch trace, RSS capability test, alert/email proof, browser suite, and
production smoke.
