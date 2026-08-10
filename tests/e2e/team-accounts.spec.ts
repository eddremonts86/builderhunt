import { test, expect, type Page, type BrowserContext } from 'playwright/test'
import { loadHarnessEnv } from './harness/load-env'
import { observerSql } from './harness/observer-sql'
import { dismissOverlays, gotoHydrated, waitForHydration } from './harness/browser'
import { allowlistEmailForSignup } from './harness/fixtures/principals'

// This spec file runs as a plain Node process, not through vite/vitest —
// nothing auto-loads `.env` here the way the app (and vitest.config.ts) do,
// so direct-DB seeding below would otherwise fall back to postgres's own
// default connection (the OS user, no password) instead of the real local
// database.
loadHarnessEnv()

/**
 * Real-browser coverage of the team-accounts release matrix: switch, create,
 * invite, accept, role change, removal, re-invite+transfer, a genuine
 * final-seat race (two concurrent requests, only one seat), and a keyboard
 * check — run against a real dev server and real local Postgres, never
 * mocks. Two isolated browser contexts (never cookies from the same
 * session) stand in for tenant A and tenant B throughout.
 *
 * Scope note, in keeping with this project's "no silent caps" convention:
 * this file does not add a dedicated multi-tab/stale-tab scenario beyond
 * what `test/security/team-cache-isolation.test.tsx` already covers at the
 * query-cache level (the actual mechanism a stale tab would depend on), and
 * accessibility coverage here is a keyboard-operability check on the
 * organization switcher, not a full automated a11y audit — both are
 * reasonable, but real, gaps to close in a follow-up rather than something
 * silently declared "done."
 */

function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
}

const PASSWORD = 'e2e-Test-Passw0rd!'

/**
 * TanStack Start ships the initial HTML from the server and hydrates React
 * on top of it — interacting with a form before hydration finishes attaches
 * typed input to a pre-hydration DOM whose value never reaches React state
 * (confirmed directly: the same keystrokes that update the DOM `value`
 * left the "Create account" button disabled and the password-strength
 * checklist unrendered, both of which read React state, not the DOM).
 * `gotoHydrated` waits on the HydrationSignal marker (`e2e/harness/
 * browser.ts`) — the semantic "React is live" signal — instead of the
 * old `networkidle` + fixed-delay guess.
 */
async function goto(page: Page, url: string) {
  await gotoHydrated(page, url)
}

/**
 * `acceptInvitation` deliberately requires `session.emailVerified` (part of
 * its anti-enumeration matching, organization-lifecycle.ts) — a real
 * security property, not a bug, but this app has no email-verification flow
 * wired up at all (confirmed: no `requireEmailVerification` config
 * anywhere), so a real sign-up never becomes verified on its own. Seed-admin
 * accounts (`scripts/db/seed-admin.ts`) sidestep this by inserting
 * `email_verified = true` directly; do the same here for a freshly
 * signed-up test user.
 */
async function markEmailVerified(email: string) {
  const sql = observerSql()
  try {
    await sql`update auth_users set email_verified = true where email = ${email}`
  } finally {
    await sql.end()
  }
}

/**
 * Real, confirmed bug (not a test flake — verified directly via psql: a
 * fresh sign-up's `auth_sessions.active_organization_id` stays `null` even
 * though the personal-workspace membership row exists): a brand-new
 * session's default active organization
 * (`pickDefaultActiveOrganizationId`/`databaseHooks.session.create.before`,
 * better-auth.ts) is not reliably set on the very first session, likely a
 * hook-ordering race against `ensurePersonalOrganization`
 * (`user.create.after`) for the same signup request — reloading the
 * dashboard doesn't self-heal it, since the session row itself has the
 * `null` baked in. Flagged as a separate follow-up (out of team-accounts
 * task 9's scope); worked around here by doing what a real user hitting
 * this would have to do — explicitly pick an organization from the
 * switcher — so this suite still exercises the real product surfaces
 * rather than getting stuck on an unrelated auth bug.
 */
async function waitForActiveOrganization(page: Page) {
  const trigger = page.getByRole('button', { name: 'Switch organization' })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await trigger.textContent())?.includes('Select organization')) return
    await trigger.click()
    const firstOrg = page.getByRole('menuitemradio').first()
    await expect(firstOrg).toBeVisible()
    await firstOrg.click()
    await page.waitForURL(/\/dashboard/)
    await goto(page, '/dashboard')
  }
}

async function signUp(page: Page, email: string, name: string) {
  // Invite-only sign-up (waitlist-launch): the real /api/auth/sign-up/email refuses any address
  // without an approved access_requests row when ACCESS_ALLOWLIST_ENABLED=true, which a developer's
  // `.env` may set (and dotenvx's override means webServer.env can't turn it off). Pre-approve the
  // address so this helper keeps creating accounts with the gate in its real, production config.
  await allowlistEmailForSignup(observerSql(), email)
  await goto(page, '/auth/sign-up')
  await page.locator('#name').fill(name)
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/onboarding\/welcome/)
  await markEmailVerified(email)
  await goto(page, '/dashboard')
  await dismissOverlays(page)
  await waitForActiveOrganization(page)
}

async function signIn(page: Page, email: string) {
  await goto(page, '/auth/sign-in')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  await dismissOverlays(page)
}

async function switchToOrg(page: Page, orgName: string) {
  await page.getByRole('button', { name: 'Switch organization' }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(orgName) }).click()
  await page.waitForURL(/\/dashboard/)
}

async function createTeam(page: Page, teamName: string) {
  await goto(page, '/dashboard')
  await page.getByRole('button', { name: 'Switch organization' }).click()
  await page.getByRole('button', { name: 'Create team' }).click()
  await page.getByLabel('New team name').fill(teamName)
  await page.getByRole('button', { name: 'Create team' }).click()
  await page.waitForURL(/\/dashboard/)
  // `waitForURL` resolves immediately (the page is already on /dashboard),
  // so wait for the switcher to show the new team — the semantic signal
  // that the server actually committed the organization. Without this,
  // `seedTeamEntitlement`'s INSERT..SELECT can race org creation and
  // silently insert zero rows (the 400ms buffers this file used to carry
  // were masking exactly this).
  await expect(page.getByRole('button', { name: 'Switch organization' })).toContainText(teamName)
}

/**
 * A freshly created organization has no `organization_entitlements` row at
 * all — `resolveEntitlementPolicy(null)` defaults it to free tier, seat
 * limit 1, and the owner alone already occupies that one seat (a real,
 * pre-existing gap: there is no product path that grants a non-personal org
 * a Team-tier entitlement — see team-accounts task 7's evidence). Direct DB
 * seeding, same as this plan's own manual verification during development,
 * is the only way to get a non-personal org to real seats without Stripe
 * (stripe-billing-platform, still pending).
 */
async function seedTeamEntitlement(teamName: string, seatLimit: number) {
  const sql = observerSql()
  try {
    await sql`
      insert into organization_entitlements (organization_id, tier, status, seat_limit)
      select id, 'team', 'active', ${seatLimit} from organizations where name = ${teamName}
      on conflict (organization_id) do update set tier = 'team', seat_limit = ${seatLimit}
    `
  } finally {
    await sql.end()
  }
}

async function inviteAndGetDevLink(page: Page, email: string): Promise<string> {
  await goto(page, '/settings/team')
  await page.getByTestId('invite-email-input').fill(email)
  // Two steps since plan 59: Review shows the card the recipient will see, then Send. The intent
  // defaults to `other`, so a caller that only wants to invite somebody presses through unchanged.
  await page.getByTestId('invite-review-btn').click()
  await expect(page.getByTestId('invite-review-step')).toBeVisible()
  await expect(page.getByTestId('invitation-value-preview')).toBeVisible()
  await page.getByTestId('invite-submit-btn').click()
  const copyLink = page.locator('[data-testid^="copy-invitation-link-"]').first()
  await expect(copyLink).toBeVisible()
  const href = await copyLink.getAttribute('title')
  if (!href) throw new Error('devLink was not surfaced on the copy-invitation-link button')
  return href
}

test.describe.configure({ mode: 'serial' })

// The full sequential journey only needs to run once — desktop chromium.
// `playwright.config.ts` scopes this file to the `chromium` project only;
// the `mobile` project instead matches the separate viewport check below
// via its own `testMatch`.
test.describe('team accounts release matrix', () => {
  let contextA: BrowserContext
  let contextB: BrowserContext
  let pageA: Page
  let pageB: Page
  const emailA = uniqueEmail('owner')
  const emailB = uniqueEmail('invitee')
  const teamName = `Playwright Co ${Date.now()}`
  let devLink = ''

  test.beforeAll(async ({ browser }) => {
    contextA = await browser.newContext()
    contextB = await browser.newContext()
    pageA = await contextA.newPage()
    pageB = await contextB.newPage()
  })

  test.afterAll(async () => {
    await contextA.close()
    await contextB.close()
  })

  test('A signs up and creates a team, switching to it', async () => {
    await signUp(pageA, emailA, 'Owner A')
    await createTeam(pageA, teamName)
    await seedTeamEntitlement(teamName, 5)
    await expect(pageA.getByRole('button', { name: 'Switch organization' })).toContainText(teamName)
    await goto(pageA, '/settings/team')
    await expect(pageA.locator('h1')).toContainText(teamName)
  })

  test('A invites B, capturing the dev-mode share link (no email provider in this environment)', async () => {
    devLink = await inviteAndGetDevLink(pageA, emailB)
    expect(devLink).toContain('/team/invite/')
  })

  test('B signs up, is redirected through sign-in when visiting the link signed out, and accepts', async () => {
    await signUp(pageB, emailB, 'Invitee B')
    // Visit the invite link fresh — already signed in as B at this point,
    // so this exercises the direct (not redirect-through-sign-in) path;
    // the redirect-and-return path itself is covered by
    // `test/security/team-invitations.test.ts` and the OrganizationInvitationPage wiring.
    const path = new URL(devLink).pathname
    await goto(pageB, path)
    await expect(pageB.getByTestId('invitation-page')).toBeVisible()

    // Plan 59: the page now shows the value card before the buttons, and both Accept and Decline are
    // present. The invitation came from the plain inline form with no intent, so it is the `other`
    // experience — which is exactly the legacy path that has to keep working.
    const preview = pageB.getByTestId('invitation-value-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('data-intent', 'other')
    await expect(pageB.getByTestId('invitation-preview-organization')).toContainText(teamName)
    await expect(pageB.getByTestId('invitation-decline-btn')).toBeVisible()
    // No role title was given, so that line must be absent rather than empty.
    await expect(pageB.getByTestId('invitation-preview-role-title')).toHaveCount(0)

    // Three real builders, from `builder_identities` rather than from the federated pipeline. Asserted
    // as "0 or 3, never 1 or 2" plus safe links: the harness database may hold no person-kind rows with
    // an avatar, and an empty result must render no section rather than an empty heading. Demanding 3
    // unconditionally would make this spec fail on a freshly seeded cluster for no product reason.
    const builders = pageB.getByTestId('invitation-preview-builders')
    if (await builders.count() > 0) {
      const links = builders.locator('a')
      await expect(links).toHaveCount(3)
      for (const link of await links.all()) {
        expect(await link.getAttribute('rel')).toContain('noopener')
        expect(await link.getAttribute('target')).toBe('_blank')
      }
    }

    await pageB.getByTestId('invitation-accept-btn').click()
    // Acceptance lands on the onboarding search with the intent's suggested query prefilled, not on
    // `/dashboard` — `/dashboard` is now only the fallback for a failed organization switch.
    await pageB.waitForURL(/\/onboarding\/search/)
    await expect(pageB.getByTestId('onboarding-query-input')).toHaveValue('open source builders')
  })

  test('A sees B as a member and promotes them to admin', async () => {
    await goto(pageA, '/settings/team')
    await pageA.reload()
    await waitForHydration(pageA)
    await expect(pageA.getByTestId('members-list').getByText('Invitee B')).toBeVisible()
    // The role picker is a Radix Select (the testid sits on its trigger
    // button, TeamSettingsPage.tsx) — drive it the way a user does: open
    // the trigger, click the option. `selectOption` only works on native
    // <select> elements and can never match this UI.
    await pageA.locator('[data-testid^="role-select-"]').first().click()
    await pageA.getByRole('option', { name: 'Admin' }).click()
    await expect(pageA.getByTestId('team-error')).toHaveCount(0)
  })

  test('billing view differs by role: owner (A) gets a plan-change CTA, admin (B) gets read-only', async () => {
    // The billing surface was rebuilt by the Stripe billing platform work
    // after this scenario was written — the old testids (billing-card,
    // billing-email-us, billing-*-cta) no longer exist anywhere in src/.
    // Same intent, current UI: the owner gets the owner-only plan/portal
    // controls (`canOpenBillingPortal` is role-gated to owner —
    // src/shared/lib/billing/permissions.ts), the admin gets the same
    // billing content read-only, with no owner controls.
    await goto(pageA, '/settings/billing')
    await expect(pageA.getByTestId('billing-settings-content')).toBeVisible()
    await expect(pageA.getByTestId('open-portal-button')).toBeVisible()

    // B is on `/onboarding/search` after accepting (plan 59), and onboarding routes are outside the
    // dashboard shell — so there is no organization switcher on the page yet. Go to the dashboard
    // first, which is where a real new member would find it.
    await goto(pageB, '/dashboard')
    await switchToOrg(pageB, teamName)
    await goto(pageB, '/settings/billing')
    await expect(pageB.getByTestId('billing-settings-content')).toBeVisible()
    await expect(pageB.getByTestId('open-portal-button')).toHaveCount(0)
    await expect(pageB.getByTestId('plan-picker')).toHaveCount(0)
  })

  test('A removes B from the team', async () => {
    await goto(pageA, '/settings/team')
    await pageA.locator('button[data-testid^="remove-member-"]').first().click()
    await expect(pageA.getByTestId('members-list').getByText('Invitee B')).toHaveCount(0)
  })

  test('A re-invites B, B accepts again, and A transfers ownership to B', async () => {
    devLink = await inviteAndGetDevLink(pageA, emailB)
    const path = new URL(devLink).pathname
    await goto(pageB, path)
    await pageB.getByTestId('invitation-accept-btn').click()
    // Either destination is a correct outcome of one acceptance, which is the point of the branch:
    // `/onboarding/search` when the organization switch succeeded, `/dashboard` when it did not. Being
    // removed in the previous test cleared B's active-org pointer, so which one happens here depends on
    // whether `setActiveOrganization` succeeds for a re-added member — and the test must not assert a
    // guess about that.
    await pageB.waitForURL(/\/(dashboard|onboarding\/search)/)
    // Onboarding routes sit outside the dashboard shell and carry no organization switcher, so come
    // back to the dashboard first — which is what a real user would do — then switch explicitly.
    await goto(pageB, '/dashboard')
    await switchToOrg(pageB, teamName)

    await goto(pageA, '/settings/team')
    await pageA.reload()
    await waitForHydration(pageA)
    // Radix Select, same as the role picker above — open, then pick.
    await pageA.getByTestId('transfer-target-select').click()
    await pageA.getByRole('option', { name: 'Invitee B' }).click()
    await pageA.getByTestId('transfer-ownership-btn').click()
    // The transfer button now opens a billing-impact preview dialog
    // (OrganizationDangerZone.tsx → TransferOwnershipPreview, added by the
    // team-accounts task-8 UX work after this scenario was written) —
    // confirm it, same as a real owner would.
    await pageA.getByTestId('transfer-ownership-confirm').click()
    await expect(pageA.getByTestId('leave-organization-btn')).toBeVisible()

    await goto(pageB, '/settings/team')
    await pageB.reload()
    await waitForHydration(pageB)
    await expect(pageB.getByTestId('delete-organization-btn')).toBeVisible()
  })

  test('a concurrent final-seat invite race lets exactly one request through', async () => {
    // A (admin) and B (owner) are both members at this point — 2 seats
    // used. Set the limit to exactly one more than that so only one of the
    // two concurrent invites below can win the last seat.
    await seedTeamEntitlement(teamName, 3)

    await goto(pageB, '/settings/team')
    await pageB.reload()
    await waitForHydration(pageB)

    const [first, second] = await Promise.all([
      pageB.request.post('/api/organizations/invitations', {
        data: { email: uniqueEmail('race-1'), role: 'member' },
      }),
      pageB.request.post('/api/organizations/invitations', {
        data: { email: uniqueEmail('race-2'), role: 'member' },
      }),
    ])

    const statuses = [first.status(), second.status()].sort()
    expect(statuses).toEqual([200, 409])
  })

  test('the organization switcher is keyboard-operable', async () => {
    await goto(pageA, '/dashboard')
    const trigger = pageA.getByRole('button', { name: 'Switch organization' })
    await trigger.focus()
    await pageA.keyboard.press('Enter')
    await expect(pageA.getByRole('menu', { name: 'Organizations' })).toBeVisible()
    await pageA.keyboard.press('Escape')
    await expect(pageA.getByRole('menu', { name: 'Organizations' })).toHaveCount(0)
  })
})

test.describe('team accounts — small viewport', () => {
  test('dashboard and team settings render usably on a small viewport @mobile-only', async ({ page }) => {
    const email = uniqueEmail('mobile')
    await signUp(page, email, 'Mobile User')
    await goto(page, '/settings/team')
    await expect(page.getByTestId('team-settings-page')).toBeVisible()
    // No horizontal overflow — the page's own content must fit the viewport,
    // matching this project's "wide content scrolls in its own container"
    // convention rather than pushing the whole page wider than the screen.
    const viewportWidth = page.viewportSize()?.width ?? 0
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)
  })
})
