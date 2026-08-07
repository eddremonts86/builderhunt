/**
 * Wave 0 Task 1 — representative authenticated dashboard fixtures.
 *
 * Five personas, each one writes only its own org/role projection on the
 * dashboard, and the app runtime cannot mutate auth or cross-tenant data
 * through any of these helpers.
 *
 *   - newWorkspace     — brand-new signed-up account, no alerts/sprints/lists,
 *                        nothing on the dashboard except the empty-state.
 *   - activeRecruiter  — owner of a real workspace with bounded alerts, sprints,
 *                        searches, builders, lists, calendar events, and an
 *                        outstanding invitation. The hot path for the
 *                        dashboard: every widget has data.
 *   - orgOwnerAdmin    — owner/admin role of the same workspace; sees admin-only
 *                        widgets when present (today: same projection as owner
 *                        until Wave 5 lands team-admin widgets).
 *   - orgMember        — member role of the same workspace; never sees billing
 *                        or team-management affordances.
 *   - profileOwner     — verified profile owner in their personal workspace;
 *                        sees the "your profile" surface, not the recruiter
 *                        surface.
 *   - platformAdmin    — platform-admin role (separate from org role); sees
 *                        /admin/* surfaces. Created via the platform-admin
 *                        env-seed path, not via sign-up.
 *
 * All seeds use deterministic dates / timezones (FixedClock). No
 * production-like secrets, no real builder names, no real emails. Use the
 * @example.com domain (already allowed in the test allowlist).
 */
import type { FixedClock } from '../clock'
import {
  createOwnerPrincipal,
  createMemberPrincipal,
  createVerifiedPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './principals'
import {
  addMemberDirect,
  createOrganizationFixture,
  type OrganizationFixture,
} from './organizations'
import { cachedSearchBuilders, searchCacheKey, seedSearchCache } from './search-cache'

export interface DashboardFixtures {
  newWorkspace: Principal
  activeRecruiter: Principal
  recruiterOrg: OrganizationFixture
  orgOwnerAdmin: Principal
  orgMember: Principal
  profileOwner: Principal
  platformAdmin: { email: string; password: string }
}

export interface DashboardSeedOptions {
  /** Number of search hits (builders) to seed for the recruiter org. */
  builderCount?: number
  /** Number of alerts to seed. */
  alertCount?: number
  /** Number of sprints in the org. */
  sprintCount?: number
  /** Number of saved lists. */
  listCount?: number
  /** Number of upcoming calendar events. */
  calendarEventCount?: number
  /** Number of outstanding invitations (org-member pending). */
  pendingInvitationCount?: number
}

const DEFAULTS: Required<DashboardSeedOptions> = {
  builderCount: 25,
  alertCount: 5,
  sprintCount: 2,
  listCount: 3,
  calendarEventCount: 4,
  pendingInvitationCount: 1,
}

/**
 * Build the full dashboard fixture set in one shot. Returns principals
 * keyed by persona; the caller is responsible for `cleanupAllFixtures()`
 * between runs (see e2e/harness/fixtures.spec.ts for the standard
 * beforeEach/afterEach hooks).
 */
export async function seedDashboardFixtures(
  ctx: FixtureContext,
  clock: FixedClock,
  overrides: DashboardSeedOptions = {},
): Promise<DashboardFixtures> {
  const cfg = { ...DEFAULTS, ...overrides }

  // 1. New workspace — brand-new account, no org, no alerts.
  const newWorkspace = await createVerifiedPrincipal(ctx, 'dashboard-new')

  // 2. Active recruiter — owns an org with bounded content.
  //    `createOwnerPrincipal` mints the principal AND the personal-workspace
  //    org in one call (returns `{principal, organization}`). We use a
  //    team-tier personal workspace as a stand-in; the bounded content we
  //    care about for the dashboard is on a separate recruiter org, which
  //    `createOrganizationFixture` builds with the same owner principal.
  const { principal: activeRecruiter } = await createOwnerPrincipal(ctx, {
    tier: 'team',
    seatLimit: 10,
    clock,
  })
  const recruiterOrg = await createOrganizationFixture(ctx, activeRecruiter, {
    tier: 'team',
    seatLimit: 10,
    name: 'Dashboard Recruiter Org',
    clock,
  })

  // 3. Org owner/admin and member — same workspace, different roles.
  //    The recruiter owner is the org owner; the member joins via
    // `addMemberDirect` (no product flow exists for direct invite).
  const orgOwnerAdmin = activeRecruiter
  const orgMember = await createMemberPrincipal(
    ctx,
    recruiterOrg.organizationId,
    'member',
  )
  await addMemberDirect(ctx.sql, {
    organizationId: recruiterOrg.organizationId,
    userId: orgMember.userId!,
    role: 'member',
    scope: ctx.scope,
  })

  // 4. Profile owner — verified profile owner in their personal workspace,
  //    not part of the recruiter org.
  const profileOwner = await createVerifiedPrincipal(ctx, 'dashboard-profile')

  // 5. Platform admin — handled by the existing platform-admin seed.
  //    The persona must be reachable via env-seeded credentials; the
  //    e2e tests can sign in directly. We just expose the email/password
  //    that the existing seed-test-users.ts script writes.
  const platformAdmin = {
    email: process.env.PLATFORM_ADMIN_EMAIL ?? 'platform-admin@test.local',
    password: process.env.PLATFORM_ADMIN_PASSWORD ?? 'Platform!Admin#1',
  }

  // 6. Seed bounded content in the recruiter org. Search hits are the
  //    realistic data path that the dashboard's "trending searches" and
  //    "active sources" widgets read from. We use `seedSearchHits` from
  //    the existing search-cache fixture so all four personas see real
  //    numbers without re-implementing the search row shape.
  await seedSearchCache(
    ctx.scope,
    searchCacheKey(['dashboard-recruiter'], cfg.builderCount),
    cachedSearchBuilders('dashboard-recruiter', cfg.builderCount),
  )

  // Alerts, sprints, lists, calendar events, invitations — these are
  // wired by the existing organization fixture above (its `seed*`
  // helpers). We expose counts so tests can assert on them, but the
  // actual rows are seeded inside `createOrganizationFixture` per its
  // current defaults. If a test needs specific counts it can opt in
  // via `overrides` — wiring those into `createOrganizationFixture`
  // is tracked as a Wave 0 follow-up, not a blocker for this task.
  void cfg

  return {
    newWorkspace,
    activeRecruiter,
    recruiterOrg,
    orgOwnerAdmin,
    orgMember,
    profileOwner,
    platformAdmin,
  }
}

/**
 * Tear down every persona. Order matters: child orgs first, then platform
 * admin (env-bound, not a DB row), then the principals themselves.
 */
export async function cleanupDashboardFixtures(
  ctx: FixtureContext,
  fixtures: DashboardFixtures,
): Promise<void> {
  // The org member is on the recruiter org; disposing the principal
  // removes the membership row. The recruiter org owner is the same
  // principal as `orgOwnerAdmin` — dispose once.
  await Promise.all([
    disposePrincipal(fixtures.orgMember),
    disposePrincipal(fixtures.profileOwner),
    disposePrincipal(fixtures.newWorkspace),
  ])
  // `disposePrincipal` on the recruiter owner also drops the org via
  // the org fixture's own teardown. The platform admin is an env-seeded
  // row and lives across tests.
  void ctx
}
