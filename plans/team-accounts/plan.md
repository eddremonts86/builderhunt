# Delivery Plan: Team Account Experience

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/plan.md)
> **Blocks**: [`shared-resources`](../shared-resources/plan.md), [`activity-feed`](../activity-feed/plan.md)
> **Reality check**: the organization, invitation, active-tenant, entitlement, authorization, audit,
> RLS, and migration layers must come from the security foundation. This plan adds product routes/UI
> only after those contracts have runtime evidence.

## Phase 1 — Verify dependency contracts

Pin the Better Auth organization service interfaces, `TenantPrincipal`, permission matrix,
organization entitlement/seat response, lifecycle errors, and audit event contract. Add contract
tests from the UI/API consumer perspective; do not duplicate foundation queries or role logic.

## Phase 2 — Organization context and switching UX

Add a tenant query provider keyed by active organization, server-backed organization switcher, and
cache invalidation/navigation behavior. Prove multi-tab switch/removal states and ensure no cached
tenant response survives under another active organization.

## Phase 3 — Team settings and invitation UX

Build Team settings from allowlisted organization/member/invitation DTOs and shared permission
predicates. Add create/rename, member roles/removal/leave, invitation create/cancel/resend, seat usage,
and verified-recipient acceptance states. The server foundation remains the authority for every
mutation.

## Phase 4 — Billing, ownership, and deletion UX

Show active organization entitlement and seat use in billing. Add recent-auth ownership transfer,
account deletion guard, and delayed organization deletion surfaces using existing lifecycle
operations/audit evidence.

## Phase 5 — Isolation and release gate

Run two-organization browser/API matrices, cache-switch tests, invitation races, role transitions,
session invalidation, accessibility, and critical runtime smoke. Only then unblock shared resources.

## Risks and controls

| Risk                                      | Control                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| UI cache displays previous tenant data    | organization-keyed query cache; synchronous clear/invalidation on confirmed switch      |
| UI permission differs from server         | shared pure permission predicates plus full server role matrix tests                    |
| Removed member keeps stale access         | foundation rechecks membership and clears session active organization; tab revalidation |
| Invite flow leaks recipient/account state | generic errors and role-minimized DTO; verified-email match enforced by foundation      |
| Team plan duplicates auth/data model      | boundary tests forbid direct organization table/global DB access in Team routes         |

## Rollout and rollback

Release switcher read-only first, then organization creation, invitations/member management, and
finally destructive ownership/deletion actions. Feature flags may hide Team UI, but foundation
tenant isolation remains enabled. Roll back UI/routes without dropping organization data or
weakening RLS/runtime roles.

## Completion evidence

Attach dependency contract results, multi-org switch/cache traces, invitation and seat race tests,
role matrix, tenant A/B browser/API suite, ownership/deletion audit evidence, accessibility run, and
production smoke. Mark implemented only after shared-resource consumers can safely use the same
active tenant without a second organization model.
