# Plan: Team Accounts & Seats

**Status:** Not yet implemented. Blocking dependency for [`shared-resources`](../shared-resources/plan.md) and [`activity-feed`](../activity-feed/plan.md) — do this one first.

## Goal recap

Introduce a multi-user **organization** concept so the "Team" pricing tier can actually
back its headline promise — "Up to 10 team seats" — with real infrastructure. Today
there is no such thing as a team account anywhere in the schema or the app.

## Why this is a valuable addition

1. **The Team plan is currently unsellable as advertised.** `PLAN_LIMITS`/`PLAN_PRICING`
   in [`billing-shared.ts`](../../src/shared/lib/billing-shared.ts) list "Up to 10 team
   seats" as a Team-tier feature, but `plans` is keyed
   `userId text('user_id').primaryKey()` — a strict 1:1 user-to-plan relationship. There
   is no `organizations` table, no membership table, and no invite flow. A prospect who
   pays for Team today gets nothing beyond what Pro already gives them.
2. **It's the prerequisite for the other two Team-only promises.** "Shared saved
   searches & builder lists" and the "Activity feed" both require knowing which users
   belong to the same paying account — neither can be built before this.
3. **Revenue ceiling.** Without seats, BuilderHunt has no natural path from $19/mo
   individual buyers to $99+/mo company accounts, which is normally where SaaS revenue
   concentrates.

## Current-state constraints this plan must work around

- `plans.userId` is the **primary key** (`src/shared/lib/db/schema.ts`) — one plan per
  user, no room for a shared plan today without a migration.
- `savedQueries`, `builderNotes`, `alerts`, `dataExportRequests`, `deletionRequests` are
  all owned by a single `userId` with no group concept.
- Auth is `better-auth` email/password only, session-cookie based, with no existing
  notion of invitations or multi-tenant scoping.

## Phases

### Phase 1: Database schema
- Add `organizations` table: `id`, `name`, `ownerUserId` (references `auth_users`),
  `createdAt`.
- Add `organization_members` table: `id`, `organizationId`, `userId`, `role`
  (`'owner' | 'admin' | 'member'`), `invitedAt`, `joinedAt` (null while pending),
  unique constraint on `(organizationId, userId)`.
- Add `organization_invites` table: `id`, `organizationId`, `email`, `role`, `token`,
  `expiresAt`, `acceptedAt`.
- Add nullable `organizationId` to `plans` (keep `userId` as-is for personal
  free/pro accounts; a `team` plan row's `userId` becomes the org owner and
  `organizationId` is set). Add a `seats` column to `PLAN_LIMITS.team` in
  `billing-shared.ts` (default 10) so the limit is enforced from the same source of
  truth as every other plan limit.

### Phase 2: Server logic
- `src/shared/lib/organizations.ts` (mirrors the shape of `billing.ts`): create org,
  invite member (generates `organization_invites` row + email via Resend), accept
  invite, remove member, change role, list members.
- Seat-limit enforcement: reuse the existing `LimitCheck`/`checkLimit` pattern from
  `billing.ts` — inviting past the `seats` limit is rejected the same way saving a 4th
  search on Free is today.
- A `getBillingScope(userId)` helper resolving "does this user act on behalf of a
  personal plan or an org plan" — every existing per-user query (saved searches,
  notes, alerts) will eventually call through this instead of assuming `userId` is
  always the right scope.

### Phase 3: UI
- New `/settings/team` route (sibling to `settings/billing`, `settings/privacy`):
  member list with role + pending-invite badges, "Invite by email" form, seat usage
  bar ("3 of 10 seats used"), remove/role-change actions gated to `owner`/`admin`.
- Invite-acceptance flow: emailed link → `/team/invite/$token` → sign in or sign up →
  join the org.
- Add a lightweight org switcher to the dashboard topbar only when a user belongs to
  an org (most users never see it — no UI cost for personal accounts).

### Phase 4: Billing integration
- `settings/billing.tsx`: when `plan === 'team'`, show org name + seat usage instead
  of the personal-plan card.
- `admin/plan-requests.tsx`: extend the existing admin plan-request review flow to
  handle "upgrade to Team + create organization" as a distinct request type.

### Phase 5: Verification
- Seat-limit enforcement (11th invite on a 10-seat org is rejected, matches the
  existing `checkLimit` test pattern in `billing.test.ts`).
- Invite → accept → member appears in the list, can access org-scoped resources.
- A user who is not an org member cannot read another org's members or resources.
- Personal (non-team) accounts see zero behavior change — no org switcher, no
  `/settings/team` link, no regression to today's single-user flows.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Touches auth/session code used by every route** | Medium | High | Keep org membership strictly additive — no existing query changes scope until `shared-resources` explicitly opts a resource into org visibility. |
| **Invite email deliverability** | Medium | Medium | Reuse the existing Resend integration (already used for alerts); fall back to a copyable invite link if email fails. |
| **Migrating a `plans.userId` primary key** | Low | High | Don't change the PK — add `organizationId` as a nullable sibling column instead of restructuring `plans`. |

## Rollback plan

- Feature-flaggable: if `organizations`/`organization_members` are empty, the app
  behaves exactly as it does today (no org switcher renders, no `/settings/team` link
  appears). Dropping the three new tables is a clean, isolated rollback with no
  foreign keys reaching into pre-existing tables other than `auth_users` and `plans`.
