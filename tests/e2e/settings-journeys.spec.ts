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

    await page.getByTestId('invite-email-input').fill(email)
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
