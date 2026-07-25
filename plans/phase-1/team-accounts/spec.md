# Feature: Team Account Experience

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md)
> **Blocks**: [`shared-resources`](../shared-resources/spec.md), [`activity-feed`](../activity-feed/spec.md),
> [`stripe-billing-platform`](../stripe-billing-platform/spec.md)
> **Reality check**: no Team UI or organization runtime exists. The previous plan proposed custom
> organization tables, one organization per user, bearer-style invite acceptance, and a nullable
> `plans.organizationId`; those decisions are superseded by the approved Better Auth multi-org,
> organization-entitlement, tenant-context, and RLS foundation.

## Purpose

Expose the organization capabilities built by `security-and-multitenancy` as a coherent Team product
experience. This plan does not own identity tables, invitation security, active-tenant resolution,
database RLS, or plan storage. It composes those verified services into organization creation,
switching, membership management, seat visibility, billing context, and ownership/deletion UX.

## Goals

1. A Team-entitled user can create an organization and invite members up to the organization seat
   limit.
2. A user with multiple memberships can switch active organization and see the correct name, role,
   entitlement, and private workspace without leakage.
3. Owners/admins can manage permitted roles and invitations; ordinary members see only allowed
   actions.
4. Ownership transfer and account deletion follow the foundation's recent-auth, atomicity, audit,
   and session invalidation contract.
5. Personal workspaces and non-Team accounts retain current behavior and have a clear upgrade path.

## Non-goals

- Defining organization/member/invitation/session tables or custom invitation tokens.
- Adding custom roles, Better Auth nested teams, SSO, SCIM, or domain auto-join.
- Implementing shared searches/lists or activity events; downstream plans own them.
- Adding a payment processor.
- Bypassing organization entitlements with a user-level plan fallback.

## Dependencies consumed

The foundation must provide and verify:

- Better Auth organization client/server plugin with multiple memberships;
- `TenantPrincipal`, active organization switching, and stale-session handling;
- static `owner | admin | member` permissions;
- verified-recipient, expiring, single-use invitations and email delivery;
- organization entitlements and race-safe seat checks;
- organization lifecycle operations and redacted audit events;
- non-owner runtime roles, RLS, tenant A/B tests, and public/private DTO boundaries.

Team routes may call those services but may not query organization tables directly or accept
client-provided organization IDs as authority.

## UX contract

### Organization switcher

The dashboard shell shows the active organization name/avatar and a switcher containing only current
memberships. Switching calls the server organization-switch operation, refreshes tenant-bound query
caches, invalidates open tenant resource state, and navigates to `/dashboard`. Tabs synchronize
through session revalidation; cached rows are keyed by organization and never rendered under a new
header.

If membership was removed, the switcher removes it and the server chooses another valid membership
or the personal organization. No valid organization produces a blocking workspace-selection state,
not an unscoped private query.

### Team settings

`/settings/team` shows organization name, current role, entitlement status, member/usable-invite seat
usage, member list, pending invitations allowed for the role, and audited actions. Buttons render
from the shared permission matrix, while the server repeats authorization.

Owner capabilities: rename, invite/cancel, promote/demote allowed roles, remove members, transfer
ownership, and request organization deletion. Admin capabilities: rename, invite/cancel, manage
members but not owner/admin peers where prohibited. Members: view members/seat usage and leave.

### Invitation acceptance

Use Better Auth invitation lifecycle. A signed-out recipient signs in/up and returns to the invitation
page. Acceptance requires verified session email matching the normalized invitation recipient. The UI
has generic expired/used/revoked/wrong-account/seat-full states without revealing unrelated account
existence. It never accepts a role or organization from the page request.

### Billing and deletion

Billing displays the active organization's entitlement. A member sees that the organization provides
the plan; admins can inspect billing and usage, but only the owner may create charges or change the
subscription, payment method, auto-recharge, refund request, or billing contact. Seat usage includes
accepted members and usable pending invitations.

Team includes 10 fixed seats at launch. An eleventh accepted member or usable invitation is blocked
race-safely. Team cannot downgrade to a one-seat tier until the owner removes extra accepted members
and cancels every usable invitation; billing never evicts members automatically. If Team access ends
through non-payment, membership/data remain, only the owner retains workspace access, and other
members are suspended until reactivation or reduction to one seat.

An owner cannot delete their account while they are the sole owner of any organization with other
members; transfer ownership first. Leaving/switching affects no organization-owned data. Organization
deletion is separate, recent-auth protected, delayed/cancellable, audited, and owned by the security
foundation.

## Security requirements

This plan follows `_meta/security-policy.md` without exception:

- organization context is server/session resolved;
- membership/permission is rechecked on every mutation;
- list/query caches include organization ID and clear on switch;
- invitation identifiers/emails are role-minimized in responses;
- cross-organization attempts return consistent non-enumerating responses;
- every action has tenant A/B plus role-matrix tests;
- no route imports global `db` or serializes Better Auth/Drizzle rows directly;
- switching/removal/concurrent ownership and final-seat races are tested;
- audit logs contain no token, cookie, email body, or request payload.

## Acceptance criteria

- One user can belong to two organizations, switch between them, and sees correct isolated data,
  entitlement, role, and cache state.
- Wrong-recipient, replayed, revoked, expired, and concurrent seat-limit invitations fail safely.
- Member/admin/owner UI and server behavior match the authorization matrix exactly.
- A tenant A actor cannot list, invite, mutate, transfer, leave, or infer tenant B resources.
- Ownership transfer updates roles atomically, invalidates stale authority, and unblocks deletion.
- Personal/free/pro users have no Team-data regression.
- Foundation DB-role, RLS, security, migration, static, build, and runtime gates remain green.

## Future

- SSO/SAML, SCIM, domain policies, custom roles, Better Auth nested teams, and per-seat payment
  automation after this static-role experience is proven.
