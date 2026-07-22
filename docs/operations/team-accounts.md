# Team Accounts

Every user has exactly one personal organization (`org_personal_<hash>`, seat limit 1 by default),
created at signup and never independently deletable. A user may also own or join team
organizations. Membership is `owner | admin | member`; ownership is unique per organization
(enforced by a partial unique index, not application logic) and moves only through
`transferOwnership` — never a direct role edit.

## Foundation

All lifecycle operations (`organization-lifecycle.ts`) route through `authDb`
(`builderhunt_auth`), the same connection Better Auth's adapter uses for
`organizations`/`organization_members`/`organization_invitations`/`organization_deletion_requests`.
Product code never queries these tables directly — Team-account UI/routes may only import from
`src/shared/lib/organizations/contracts.ts`, enforced by `pnpm security:boundaries`. Every mutation
resolves the acting organization from the caller's own session
(`requireTenantPrincipal`/`TenantPrincipal.organizationId`) — never from a client-supplied id — and
recent, destructive, or ownership-changing actions (`transferOwnership`, `changeMemberRole`,
`removeMember` on someone else, `requestOrganizationDeletion`) require the session to have
authenticated within the last 15 minutes (`requireRecentAuthentication`), returning a distinct
"Please sign in again to continue" error the client special-cases with a re-auth link rather than a
generic failure.

## Invitations

`inviteMember`/`resendInvitation`/`cancelInvitation`/`acceptInvitation` are rate-limited
(`org-invite`: 20/hr per user+org; `org-invite-accept`: 20/hr per user) and every failure mode of
`acceptInvitation` (wrong account, unverified email, expired, revoked, replayed, seat limit)
collapses into one generic message/status so a request can't be used to enumerate emails or
invitation state. Seat enforcement is atomic: `createInvitation` locks the organization's member
rows (`for update`) before counting, so two concurrent invites at the last seat can't both succeed.
When no email provider is configured (no `RESEND_API_KEY`, i.e. every local/dev environment),
invitation email delivery silently no-ops — `inviteMember`/`resendInvitation` thread a `devLink`
back to the admin UI in that case (a manual "copy link" fallback) and the invitee sees their own
pending invitations surfaced on the Dashboard (`GET /api/organizations/invitations/mine`, always
keyed off the caller's own verified session email, never a client-supplied one).

## Billing entitlement

`organization_entitlements` (tier/status/seat_limit) is tenant-private and RLS-forced, read via
`withTenantContext`/`builderhunt_app`, never `authDb`. There is no Stripe integration yet
(`stripe-billing-platform` plan, still pending) — tiers are admin-managed only, via
`/admin/users`'s plan grant (`setPlatformUserPlan`), which is the one place a tier can shrink.
That path calls `assertSeatLimitDowngradeIsSafe` (same row-locking pattern as invite-time seat
enforcement) before writing a smaller seat limit, refusing the downgrade with a 409 if the
organization currently has more members+pending invitations than the new tier allows. A lapsed
paid tier (`status` flipped to `past_due`/`canceled`) is read via `resolveEntitlementPolicy`'s
`paidActionsAllowed` flag — this suspends paid-feature access in the UI, never membership or data.

## Deletion (account and organization — two separate models, deliberately)

Both use a 30-day grace period but do not share a table or worker, since an organization's deletion
affects every other member, not just the requester:

- **Account**: `deletion_requests` (accountDb), `legal.ts`'s `requestDeletion`/`cancelDeletion`,
  swept by `processPendingDeletions`. Blocked
  (`AccountDeletionOwnershipError`, 409) only while the user owns an organization that has at least
  one *other* member — every account's own solo personal workspace never blocks this on its own.
- **Organization**: `organization_deletion_requests` (authDb, same RLS/grant shape as
  `organizations`), `requestOrganizationDeletion`/`cancelOrganizationDeletion`
  (owner-only; requesting needs recent auth, cancelling doesn't), swept by
  `processPendingOrganizationDeletions`. The owner-facing UI requires typing the organization's
  exact name before the request is submitted.

Both sweeps run from `POST /api/admin/legal/run-worker` (platform-admin gated). Point a daily cron
at it; there is no automatic scheduler otherwise.

## Verifying tenant isolation locally

1. `pnpm test:security` (or `pnpm test test/security`) — route-level isolation and cache-isolation
   checks (a client can never select another org's id; a real `useQuery` consumer never renders
   stale data across an org switch).
2. `pnpm test:rls:local` — exact runtime roles against a disposable database (see
   `database-roles.md`; never test RLS as the table owner).
3. Live check: sign in, create a second organization, switch to it via the header switcher, and
   confirm `/settings/team`, `/settings/billing`, and `/settings/privacy` show only that
   organization's data — then switch back and confirm the first organization's data reappears
   unchanged. `TenantQueryProvider` clears its entire query cache on every organization-id change,
   not just the switched keys, specifically so a render between "cancel A's in-flight requests" and
   "drop only A's keys" can't paint A's data under B's chrome.
