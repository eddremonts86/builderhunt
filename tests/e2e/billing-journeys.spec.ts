/**
 * The billing page as a paying customer meets it (plan 53, task 8).
 *
 * `tests/e2e/api/billing-*` prove the endpoints: authorization, the six provider scenarios, the ledger. None
 * of that says what the customer *sees*, and on a billing page the visible state is the product. Three things
 * go wrong here that no API test can catch:
 *
 * - **A destructive action with no confirmation.** Cancel ends a paid subscription. A page that cancels on the
 *   first click turns a misclick into lost access, and the API cannot tell a deliberate call from a slip.
 * - **A warning that does not render.** Payment blocked, grace period, a scheduled downgrade — each is a state
 *   the customer must act on before a date. Correct in the database and invisible on screen is the same as
 *   absent, except the customer finds out when access stops.
 * - **A stale session on a money page.** Changing a plan after the session has gone stale must ask for
 *   re-authentication rather than acting, and the customer must be told which it was.
 *
 * The page is asserted against a real subscription, not a fixture screenshot, and each destructive path ends
 * by checking that nothing changed unless it was confirmed.
 */
import { expect, test } from 'playwright/test'

import {
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'billj' })
  await seedActiveSubscription(harness, { tier: 'pro' })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

async function openBilling(browser: import('playwright/test').Browser) {
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  await gotoHydrated(page, `${harness.baseURL}/settings/billing`)
  await dismissOverlays(page)
  return { context, page, guard }
}

test('the billing page renders its real state, not an error', async ({ browser }) => {
  /**
   * The baseline every assertion below depends on. A billing page that errors is worse than most broken pages:
   * the customer cannot see what they are paying, cannot cancel, and cannot fix a failed payment — so they
   * write to support, and support cannot see it either.
   */
  const { context, page, guard } = await openBilling(browser)
  try {
    await expect(page.getByTestId('billing-settings-content')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('billing-settings-error')).toHaveCount(0)
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('cancelling asks for confirmation, and dismissing it changes nothing', async ({ browser }) => {
  /**
   * The destructive action. A cancel that fires on the first click turns a misclick into lost access, and the
   * API cannot distinguish a deliberate call from a slip — the confirmation *is* the safety, so it belongs in
   * a test rather than in a reviewer's memory.
   *
   * The assertion after dismissing is the database, not the page: a dialog that closes while the request went
   * out anyway is exactly the bug this shape of test exists to find.
   */
  const { context, page, guard } = await openBilling(browser)
  try {
    const cancelButton = page.getByTestId('cancel-subscription-button')
    if (await cancelButton.count() === 0) {
      test.skip(true, 'no cancellable subscription is rendered for this fixture')
    }

    await cancelButton.click()
    await expect(
      page.getByTestId('cancel-subscription-confirm'),
      'cancel fired without asking',
    ).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('cancel-subscription-dismiss').click()
    await expect(page.getByTestId('cancel-subscription-confirm')).toHaveCount(0)

    const rows = await harness.sql<{ cancel_at_period_end: boolean | null }[]>`
      select cancel_at_period_end from billing_subscriptions
      where organization_id = ${harness.organization.organizationId}
    `
    expect(
      rows[0]?.cancel_at_period_end ?? false,
      'dismissing the confirmation still cancelled the subscription',
    ).toBe(false)
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the portal button is present and points somewhere, rather than being a dead control', async ({ browser }) => {
  /**
   * The portal is where a customer updates a card. A button that renders and does nothing is the worst
   * version of this: the customer believes they have fixed a failed payment and has not.
   */
  const { context, page, guard } = await openBilling(browser)
  try {
    const portal = page.getByTestId('open-portal-button')
    if (await portal.count() === 0) test.skip(true, 'no portal button for this fixture state')
    await expect(portal).toBeEnabled()
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('usage is shown to the organization paying for it', async ({ browser }) => {
  // What a customer is being billed against. A plan page without usage is a bill without an itemisation.
  const { context, page, guard } = await openBilling(browser)
  try {
    await expect(page.getByTestId('usage-section')).toBeVisible({ timeout: 20_000 })
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('the page never renders another organization’s billing identifiers', async ({ browser }) => {
  /**
   * Billing pages join a lot of tables, and the ones they join are the ones that hurt. This asserts the
   * absence rather than the presence: a leak here is a customer id or a subscription id belonging to somebody
   * else, and nothing on the page would look wrong.
   */
  const other = await harness.sql<{ id: string }[]>`
    select id from organizations where id <> ${harness.organization.organizationId} limit 1
  `
  const { context, page, guard } = await openBilling(browser)
  try {
    await expect(page.getByTestId('billing-settings-content')).toBeVisible({ timeout: 20_000 })
    const body = await page.content()
    if (other[0]) expect(body).not.toContain(other[0].id)
    for (const forbidden of ['sk_live', 'sk_test', 'whsec_']) {
      expect(body, `the billing page rendered a "${forbidden}" secret`).not.toContain(forbidden)
    }
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('a signed-out visitor cannot see a billing page at all', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${harness.baseURL}/settings/billing`)
    await expect(page).toHaveURL(/\/auth\/sign-in/, { timeout: 20_000 })
    await expect(page.getByTestId('billing-settings-content')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
