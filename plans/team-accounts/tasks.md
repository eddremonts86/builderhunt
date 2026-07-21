# Tasks: Team Account Experience

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md)
> **Blocks**: [`shared-resources`](../shared-resources/tasks.md), [`activity-feed`](../activity-feed/tasks.md),
> [`stripe-billing-platform`](../stripe-billing-platform/tasks.md)
> **Reality check**: this plan no longer creates organization tables, custom invitation tokens, a
> one-org membership constraint, or `plans.organizationId`. It consumes the implemented and tested
> Better Auth organization/tenant/RLS foundation.

- [ ] **Lock Team consumers to foundation contracts**
  - Files: `src/shared/lib/organizations/contracts.ts`, `src/shared/lib/organizations/contracts.test.ts`, `src/shared/lib/auth/tenant-principal.ts`, `src/shared/lib/authorization/permissions.ts`
  - Do: Export allowlisted `OrganizationSummaryDto`, `OrganizationMemberDto`, `InvitationSummaryDto`, `SeatUsageDto`, lifecycle error codes, and typed service functions from the security foundation. Add boundary tests forbidding Team modules from importing DB/schema tables or implementing role checks directly.
  - Verify: contract tests pass and deliberate `db`/schema import or `role ===` check inside Team routes fails `pnpm security:boundaries`.

- [ ] **Create an organization-aware dashboard query provider**
  - Files: `src/shared/components/TenantQueryProvider.tsx`, `src/shared/lib/auth/client.ts`, `src/shared/lib/query-keys.ts`, `src/shared/lib/query-keys.test.ts`, `src/routes/_dashboard/route.tsx`
  - Do: Scope every private query key under `['organization', activeOrganizationId, ...]`; on confirmed organization switch cancel old requests, clear private cached data, update Better Auth active organization, refetch session/principal, and navigate to `/dashboard`. Render no private children while context is missing/stale.
  - Verify: component tests prove A cache never renders after B switch, in-flight A response is ignored, failed switch retains A, and membership removal enters safe selection state.

- [ ] **Build the multi-organization switcher**
  - Files: `src/modules/dashboard/components/OrganizationSwitcher.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`, `src/modules/dashboard/components/OrganizationSwitcher.test.tsx`
  - Do: Render current memberships from Better Auth's allowlisted organization list, active marker, role, personal/team label, and create/manage links permitted by entitlement. Call the server switch operation only; never submit arbitrary organization as authority or pre-render private B data under A.
  - Verify: tests cover zero/one/multiple orgs, switch success/failure, removed membership, keyboard operation, and no cross-org cached content.

- [ ] **Build Team settings from organization DTOs**
  - Files: `src/routes/_dashboard/settings/team.tsx`, `src/modules/dashboard/components/TeamSettingsPage.tsx`, `src/modules/dashboard/components/TeamSettingsPage.test.tsx`
  - Do: Show name, entitlement, current role, members, permitted pending invites, and accepted+usable-invite seat usage. Render create/rename/invite/cancel/resend/role/remove/leave/transfer/delete controls from shared permissions; repeat no authorization logic client-side beyond presentation.
  - Verify: role snapshot tests match every authorization-matrix cell; member cannot see admin/owner actions; DTO fixtures containing extra auth/token fields never render them.

- [ ] **Wire organization and membership mutations to foundation services**
  - Files: `src/routes/api/organizations/index.ts`, `src/routes/api/organizations/members/$memberId.ts`, `src/routes/api/organizations/transfer-ownership.ts`, `test/security/team-api-isolation.test.ts`
  - Do: Validate inputs with zod, resolve `TenantPrincipal`, call foundation lifecycle services, map typed errors to consistent non-enumerating responses, require recent auth for ownership/destructive actions, and return explicit DTOs. Add no direct DB queries.
  - Verify: A/B plus member/admin/owner API matrix passes; spoofed body/header/query organization has no effect; transfer is atomic and stale owner authority is revoked.

- [ ] **Build secure invitation management and acceptance UI**
  - Files: `src/routes/api/organizations/invitations/index.ts`, `src/routes/api/organizations/invitations/$invitationId.ts`, `src/routes/team/invite/$invitationId.tsx`, `src/modules/auth/components/OrganizationInvitationPage.tsx`, `test/security/team-invitations.test.ts`
  - Do: Use Better Auth lifecycle wrappers for invite/resend/cancel/accept; signed-out users return after authentication; acceptance requires verified matching email and takes no role/org input. Render generic wrong-account/expired/revoked/used/full states and rate-limit management by user+organization.
  - Verify: wrong email, unverified email, replay, revocation, expiry, enumeration, cross-org cancel, and concurrent final-seat tests pass; logs/responses contain no secret/cookie/email body.

- [ ] **Integrate active organization entitlement into billing**
  - Files: `src/routes/_dashboard/settings/billing.tsx`, `src/modules/dashboard/components/OrganizationBillingCard.tsx`, `src/modules/dashboard/components/OrganizationBillingCard.test.tsx`
  - Do: Replace user-plan Team assumptions with active organization entitlement and accepted-member plus usable-invitation seat usage. Members see provider organization/minimal state, admins see read-only billing, and only owners receive billing mutation capability. Export race-safe one-seat downgrade blockers and suspend non-owner Team access after entitlement loss without deleting membership/data. Switching organizations refreshes billing without mutating another organization.
  - Verify: personal Free/Pro and two Team organizations render correct independent tier/status/seats; admin/member cannot request a paid change; concurrent eleventh seat and downgrade blockers are correct; Team lapse suspends/restores members; B switch never displays A entitlement.

- [ ] **Integrate ownership, account deletion, and organization deletion UX**
  - Files: `src/routes/_dashboard/settings/privacy.tsx`, `src/modules/dashboard/components/OrganizationDangerZone.tsx`, `src/modules/dashboard/components/OrganizationDangerZone.test.tsx`
  - Do: Surface foundation deletion guard when a subject is sole owner with other members; provide recent-auth transfer flow. Organization deletion uses owner-only challenge, grace period, cancel/status UI, and does not reuse account deletion. All operations display audit/reference IDs but no sensitive payload.
  - Verify: owner/member/multi-org tests prove account deletion blocks only affected ownership, transfer unblocks, organization deletion is delayed/cancellable, and tenant B remains unchanged.

- [ ] **Run the Team isolation and release matrix**
  - Files: `e2e/team-accounts.spec.ts`, `test/security/team-cache-isolation.test.ts`, `docs/operations/team-accounts.md`, `.github/workflows/quality.yml`
  - Do: Seed users with personal plus A/B memberships and exercise switch, create, invite, accept, role, removal, transfer, billing, export/deletion links, stale tabs, and final-seat race. Run using non-owner app DB role with RLS; include accessibility and mobile/keyboard checks.
  - Verify: `pnpm test:security && pnpm test:rls && pnpm test:e2e -- e2e/team-accounts.spec.ts && pnpm lint && pnpm type-check && pnpm test && pnpm build` passes before unblocking `shared-resources`.

## Future

- Custom roles, nested teams, SSO/SAML, SCIM, domain policies, and per-seat payment automation.
