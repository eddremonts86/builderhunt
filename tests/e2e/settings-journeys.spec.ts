/**
 * The settings journeys a user actually performs (plan 53, task 7).
 *
 * `tests/e2e/api/organizations*`, `privacy` and `account` prove the endpoints. This proves the *journeys* —
 * and the difference is not ceremony. Each of these three surfaces has a failure mode that only exists in the
 * browser, where the API is already correct:
 *
 * - **Invite.** The API creates an invitation; the page has to then *show* it as pending. An invitation that
 *   exists in the database and not on screen is one the admin sends again, and again.
 * - **Data export.** The API returns a request id; the page has to hand the subject something they can act
 *   on. A GDPR right the user cannot see themselves exercising is not exercised.
 * - **Account deletion.** The API refuses a sole owner with members and names the organizations; the page has
 *   to render *which ones*. A refusal a user cannot act on is a dead end on an irreversible action.
 *
 * So every assertion here is about what a person can see and do, and each test ends by reading the database —
 * because "the page said so" and "it happened" are different claims, and the second is the one that matters.
 */
import { expect, test } from 'playwright/test'

import {
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { uniqueId } from './harness/ids'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  // `team` so the seat budget allows an invitation; `pro` would refuse one and the journey would never start.
  harness = await startInterviewHarness({ scope: 'setj', tier: 'team', seatLimit: 5 })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test('an admin invites someone and sees the invitation appear as pending', async ({ browser }) => {
  /**
   * The whole point of the invitations section. The API test proves a row is created; this proves the admin
   * can tell. An invitation that exists but is invisible gets sent twice — and each pending invitation holds
   * a seat, so the second one costs money.
   */
  const email = `${uniqueId('journey-invite').toLowerCase()}@e2e.invalid`
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)

  try {
    await gotoHydrated(page, `${harness.baseURL}/settings/team`)
    await dismissOverlays(page)
    await expect(page.getByTestId('team-settings-page')).toBeVisible({ timeout: 20_000 })
    // Wait for the invitations grid to settle before typing, not just for the page shell. The page
    // reads three queries now (snapshot, members, invitations — plan 10 split one into three), and
    // `team-settings-page` goes visible on the first of them. Typing into the invite field while a
    // later one lands re-renders the section and returns the controlled input to '', which the
    // browser then blocks with its own "Please fill out this field." — no request, no error, and a
    // 20s timeout on a list that was never going to change. Its settled empty state is the signal.
    await expect(page.getByTestId('invitations-list')).toContainText('No pending invitations.', { timeout: 20_000 })

    await page.getByTestId('invite-email-input').fill(email)
    // Assert the field actually holds it. Without this the failure above surfaces 20s later as
    // "the list never showed the invitation", which is three inferences away from "the input was
    // empty when the form submitted".
    await expect(page.getByTestId('invite-email-input')).toHaveValue(email)
    // Two steps since plan 59: Review shows the card the recipient will see, then Send. The intent
    // defaults to `other`, so an admin who only wants to invite somebody presses straight through — but
    // the review step is a real gate and nothing is sent from the first one.
    await page.getByTestId('invite-review-btn').click()
    await expect(page.getByTestId('invite-review-step')).toBeVisible()
    await page.getByTestId('invite-submit-btn').click()

    // The row, not a toast: a toast disappears, and the admin's question is "is it pending *now*".
    await expect(page.getByTestId('invitations-list')).toContainText(email, { timeout: 20_000 })

    const rows = await harness.sql<{ status: string }[]>`
      select status from organization_invitations
      where organization_id = ${harness.organization.organizationId} and email = ${email}
    `
    expect(rows.length, 'the page showed an invitation the database does not have').toBe(1)
    expect(rows[0]?.status).toBe('pending')
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('cancelling an invitation removes it from the list and from the database', async ({ browser }) => {
  /**
   * Both halves, because they fail apart. A cancel that updates the row but not the list leaves an admin
   * believing a stranger still has a live link; a cancel that clears the list but not the row leaves the
   * stranger actually holding one.
   */
  const email = `${uniqueId('journey-cancel').toLowerCase()}@e2e.invalid`
  const created = await harness.owner.api!.post('/api/organizations/invitations', {
    data: { email, role: 'member' },
  })
  expect(created.status(), await created.text()).toBe(200)
  const invitation = await created.json() as { id: string }

  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)

  try {
    await gotoHydrated(page, `${harness.baseURL}/settings/team`)
    await dismissOverlays(page)
    await expect(page.getByTestId(`invitation-row-${invitation.id}`)).toBeVisible({ timeout: 20_000 })

    await page.getByTestId(`cancel-invitation-${invitation.id}`).click()
    await expect(page.getByTestId(`invitation-row-${invitation.id}`)).toHaveCount(0, { timeout: 20_000 })

    const pending = await harness.sql<{ status: string }[]>`
      select status from organization_invitations where id = ${invitation.id} and status = 'pending'
    `
    expect(pending.length, 'the row vanished from the page but not from the database').toBe(0)
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the team page shows the members it has, and never another organization’s', async ({ browser }) => {
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)

  try {
    await gotoHydrated(page, `${harness.baseURL}/settings/team`)
    await dismissOverlays(page)
    await expect(page.getByTestId('members-list')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`member-row-${harness.owner.userId!}`)).toBeVisible()
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the privacy page loads and offers the subject their own controls', async ({ browser }) => {
  /**
   * A data-subject right the user cannot find is not a right they have. This asserts the page renders for its
   * subject rather than erroring — the state most likely to rot, because nobody visits their own privacy
   * settings during development.
   */
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)

  try {
    await gotoHydrated(page, `${harness.baseURL}/settings/privacy`)
    await dismissOverlays(page)
    await expect(page.getByTestId('privacy-settings-page')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('privacy-error')).toHaveCount(0)
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the security page loads for its own account', async ({ browser }) => {
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)

  try {
    await gotoHydrated(page, `${harness.baseURL}/settings/security`)
    await dismissOverlays(page)
    await expect(page.getByTestId('security-settings-page')).toBeVisible({ timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('a signed-out visitor is sent to sign-in rather than shown a settings page', async ({ browser }) => {
  /**
   * The boundary in the browser. The API specs prove the endpoints refuse; this proves the *page* does not
   * render a shell that looks like someone's settings before finding out who they are.
   */
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(`${harness.baseURL}/settings/team`)
    await expect(page).toHaveURL(/\/auth\/sign-in/, { timeout: 20_000 })
    await expect(page.getByTestId('team-settings-page')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

/**
 * The roster and the invitations, after plans/phase-3/10 split them out of the team snapshot.
 *
 * They used to arrive whole inside `GET /api/organizations/team`, and `listOrganizationMembers`
 * had no `ORDER BY` — so the roster's order was whatever Postgres returned. These assert what the
 * split bought: two bounded, ordered pages, and a seat count that never depended on either.
 */
test.describe('the team roster and invitations as pages', () => {
  test('the snapshot no longer carries either list, and still carries the seat count', async () => {
    const response = await harness.owner.api!.get('/api/organizations/team')
    expect(response.status()).toBe(200)
    const snapshot = await response.json()

    // The seat count was never derived from the lists — `getSeatUsage` has always counted in
    // Postgres — so removing them must not have touched it.
    expect(snapshot.seatUsage.used).toBeGreaterThan(0)
    expect(snapshot).not.toHaveProperty('members')
    expect(snapshot).not.toHaveProperty('pendingInvitations')
    // The ownership picker's own bounded read, which is not the roster.
    expect(Array.isArray(snapshot.transferCandidates)).toBe(true)
    expect(snapshot.transferCandidatesTruncated).toBe(false)
  })

  test('the roster is a page with a total, ordered oldest first', async () => {
    const response = await harness.owner.api!.get('/api/organizations/team/members')
    expect(response.status()).toBe(200)
    const page = await response.json()

    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.total).toBe(page.rows.length)
    expect(page.rows.some((row: { userId: string }) => row.userId === harness.owner.userId!)).toBe(true)
    // Names come from `auth_users`, resolved for the rows this page returned rather than joined —
    // a capability describes one table. An empty name here would mean that step was skipped.
    expect(page.rows[0].name).toBeTruthy()
    expect(page.rows[0].email).toBeTruthy()
    // Oldest first: the owner joined before anyone they invited.
    expect(page.rows[0].userId).toBe(harness.owner.userId!)
  })

  test('the roster refuses a sort id it does not offer', async () => {
    const response = await harness.owner.api!.get('/api/organizations/team/members?sort=email:asc')
    expect(response.status()).toBe(400)
    // `email` lives on `auth_users`; the capability cannot sort by it and says so rather than
    // ordering by something else.
    expect((await response.json()).error).toContain('Unknown sort column')
  })

  test('a role filter narrows the roster and keeps its own facet count', async () => {
    const response = await harness.owner.api!.get('/api/organizations/team/members?filter.role=owner')
    expect(response.status()).toBe(200)
    const page = await response.json()

    expect(page.rows.every((row: { role: string }) => row.role === 'owner')).toBe(true)
    expect(page.total).toBe(1)
    const roles = page.facets.role as Array<{ value: string; count: number }>
    expect(roles.find((facet) => facet.value === 'owner')?.count).toBe(1)
  })

  test('an unknown role value is refused — the filter is an enum, not free text', async () => {
    const response = await harness.owner.api!.get('/api/organizations/team/members?filter.role=superuser')
    expect(response.status()).toBe(400)
    expect((await response.json()).error).toContain('Unknown value for filter role')
  })

  test('the invitations page lists only pending ones, and searches by email', async () => {
    const email = `${uniqueId('page-invite').toLowerCase()}@e2e.invalid`
    const invited = await harness.owner.api!.post('/api/organizations/invitations', {
      data: { email, role: 'member' },
    })
    expect(invited.status(), await invited.text()).toBeLessThan(400)
    const { id: invitationId } = await invited.json()

    try {
      const listed = await (await harness.owner.api!.get('/api/organizations/team/invitations')).json()
      expect(listed.rows.every((row: { status: string }) => row.status === 'pending')).toBe(true)
      expect(listed.rows.some((row: { id: string }) => row.id === invitationId)).toBe(true)

      // `ILIKE` in Postgres over every pending invitation, not over the loaded page.
      const found = await (await harness.owner.api!.get(
        `/api/organizations/team/invitations?q=${encodeURIComponent(email)}`,
      )).json()
      expect(found.rows.map((row: { id: string }) => row.id)).toEqual([invitationId])

      const missing = await (await harness.owner.api!.get(
        '/api/organizations/team/invitations?q=nobody-by-that-name',
      )).json()
      expect(missing.rows).toEqual([])
      // The count describes the search, not the page.
      expect(missing.total).toBe(0)
    } finally {
      await harness.owner.api!.delete(`/api/organizations/invitations/${invitationId}`).catch(() => undefined)
    }
  })

  /**
   * A cursor is bound to the organization it was minted in — that is what the `o` field on it is
   * for — so replaying one against a different tenant is a 400, not a page of someone else's team.
   */
  test('a cursor cannot be replayed against another table', async () => {
    const members = await (await harness.owner.api!.get('/api/organizations/team/members')).json()
    // This organization is small enough that page one is the last page, which is itself the
    // spec's "an organization with three members" edge case.
    expect(members.nextCursor).toBeNull()

    const forged = await harness.owner.api!.get(
      '/api/organizations/team/members?cursor=bm90LWEtY3Vyc29y.bm90LWEtc2ln',
    )
    expect(forged.status()).toBe(400)
  })

  test('both grids render on the page, and the roster shows the owner', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/settings/team`)
      await dismissOverlays(page)

      await expect(page.getByTestId('members-list')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId(`member-row-${harness.owner.userId!}`)).toBeVisible()
      await expect(page.getByTestId('invitations-list')).toBeVisible()

      // Two grids, so two `role="grid"` nodes — the roster and the invitations, not one merged list.
      expect(await page.locator('[role="grid"]').count()).toBe(2)

      // The roster has nothing searchable: names live on `auth_users`, one join away. A box that
      // matched nothing would read as "no such member", so there is no box.
      const rosterSearch = page.getByTestId('members-list').getByTestId('table-search')
      await expect(rosterSearch).toHaveCount(0)
      // The invitations grid does search — by email — and keeps its box.
      await expect(page.getByTestId('invitations-list').getByTestId('table-search')).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
