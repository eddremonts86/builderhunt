/**
 * The investing branch (plan: phase-2/03-onboarding-segmentado).
 *
 * The unit tests already pin the thesis composition and both arming branches against a stubbed
 * fetch. What only exists end to end is what this spec covers:
 *
 * - **the resource is tenant-scoped** — the saved search the step creates belongs to the
 *   organization that created it, and another organization cannot see it. A unit test cannot say
 *   this: it connects as the superuser and would pass with no grants and no policies at all;
 * - **the free plan still arrives somewhere** — `/api/alerts` answers 402 without
 *   `paidActionsAllowed`, and a new organization is on `free`. The step has to arm the search
 *   anyway, and say truthfully which way it did;
 * - **the copy does not promise deal flow** — the product models people and what they ship, not
 *   companies, rounds or cap tables, and the spec is explicit that the word is not to be used until
 *   it does.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import { createOwnerPrincipal } from './harness/fixtures/principals'
import { fixedClockFromEnv } from './harness/clock'

let harness: InterviewHarness
/** Captured on the first activation so the second arming can be compared against it. */
let firstActivatedAt: string | null = null

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  /**
   * `free` on purpose. It is the tier a real signup lands on, and it is the tier that makes
   * `/api/alerts` answer 402 — the branch the whole arming fallback exists for. A `team` harness
   * would have exercised the paid path and left the common one unproven.
   */
  harness = await startInterviewHarness({
    scope: 'onbinv',
    tier: 'free',
    flags: { USER_SEGMENTATION_ENABLED: 'true' },
  })

  // Accept the terms in the database rather than dismissing a full-viewport modal in every test —
  // the same reason as `onboarding-goal.spec.ts`, where clicking through it made each test wait
  // thirty seconds for an element the modal was intercepting.
  await harness.sql`
    insert into user_consents (id, user_id, document, version)
    values (${`c-${harness.owner.userId}-tos`}, ${harness.owner.userId}, 'tos', 'v1.0'),
           (${`c-${harness.owner.userId}-privacy`}, ${harness.owner.userId}, 'privacy', 'v1.0')
    on conflict (id) do nothing
  `

  // The route is the person's, and the person's route comes from their stored segment.
  await harness.sql`
    insert into user_preferences (user_id, primary_segment, segment_source, segment_schema_version)
    values (${harness.owner.userId}, 'investing', 'onboarding', 1)
    on conflict (user_id) do update set primary_segment = 'investing'
  `
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

async function savedQueries() {
  return harness.sql<{ id: string; organization_id: string; user_id: string; name: string }[]>`
    select id, organization_id, user_id, name from saved_queries order by created_at
  `
}

test('offers themes and states what the product does not model', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/investing`)

  await expect(page.getByTestId('investing-themes')).toBeVisible()
  await expect(page.getByTestId('investing-theme')).toHaveCount(8)

  // The limitation is on the screen, not left for somebody to discover.
  await expect(page.getByTestId('investing-scope-notice')).toContainText(/does not model companies/i)

  // And the promise the spec forbids is nowhere on it. Checked as page text rather than against one
  // element, because the failure this guards against is somebody adding the phrase somewhere else.
  const body = (await page.locator('body').innerText()).toLowerCase()
  expect(body).not.toContain('deal flow')
  expect(body).not.toContain('dealflow')
})

test('nothing is saved until the thesis is confirmed', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/investing`)

  await expect(page.getByTestId('investing-save')).toBeDisabled()
  await page.getByTestId('investing-theme').first().click()
  await expect(page.getByTestId('investing-save')).toBeEnabled()
  // Selecting is not confirming.
  expect(await savedQueries()).toHaveLength(0)
})

/**
 * The free path, which is the one a new account is on. The search still has to be delivered by
 * something, or "we will keep it running" is a sentence with nothing behind it.
 */
test('saves the thesis and arms it with a feed link on the free plan', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/investing`)

  await page.getByTestId('investing-theme').filter({ hasText: 'Climate tech' }).click()
  await page.getByTestId('investing-free-text').fill('grid software')
  await page.getByTestId('investing-save').click()

  await expect(page.getByTestId('investing-armed')).toBeVisible()
  // It says which way it armed the search, and it is the truthful one for this plan.
  await expect(page.getByTestId('investing-armed-feed')).toBeVisible()
  await expect(page.getByTestId('investing-armed-alert')).toHaveCount(0)

  const queries = await savedQueries()
  expect(queries).toHaveLength(1)
  expect(queries[0].organization_id).toBe(harness.organization.organizationId)
  expect(queries[0].user_id).toBe(harness.owner.userId)
  // Free text first, then the theme's keywords — what was picked is what was saved.
  expect(queries[0].name).toBe('grid software, climate tech, energy')

  const capabilities = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from feed_capabilities where query_id = ${queries[0].id}
  `
  expect(Number(capabilities[0].count)).toBe(1)
  // The paid path was attempted and refused; no alert was written.
  const alertRows = await harness.sql<{ count: string }[]>`select count(*)::text as count from alerts`
  expect(Number(alertRows[0].count)).toBe(0)
})

/**
 * The activation the whole route exists to produce, and the reason the evidence is counted on the
 * server: the request names a kind, the server decides whether it happened.
 */
test('the server records the activation, having counted the rows itself', async () => {
  const status = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(status.preset).toBe('investing')
  expect(status.activationType).toBe('saved_search_alert')
  expect(status.activatedAt).not.toBeNull()
  firstActivatedAt = status.activatedAt
})

/** A saved search belongs to one organization. Another one asking gets its own list, not this one. */
test('another organization cannot see the saved search', async () => {
  const outsider = await createOwnerPrincipal(harness.ctx, {
    tier: 'free',
    seatLimit: 1,
    clock: fixedClockFromEnv(),
  })
  harness.extraPrincipals.push(outsider.principal)

  const response = await outsider.principal.api!.get('/api/queries')
  expect(response.status()).toBe(200)
  const visible = (await response.json()) as Array<{ id: string }>
  const ours = await savedQueries()
  expect(visible.map((query) => query.id)).not.toContain(ours[0].id)
})

/** With the plan that allows it, the same step arms the search the paid way and says so. */
test('arms with an alert once the plan allows it', async ({ page }) => {
  await harness.sql`
    update organization_entitlements set tier = 'pro', status = 'active'
    where organization_id = ${harness.organization.organizationId}
  `

  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/investing`)
  await page.getByTestId('investing-theme').filter({ hasText: 'Security' }).click()
  await page.getByTestId('investing-save').click()

  await expect(page.getByTestId('investing-armed-alert')).toBeVisible()
  await expect(page.getByTestId('investing-armed-feed')).toHaveCount(0)

  const alertRows = await harness.sql<{ query_id: string | null; organization_id: string }[]>`
    select query_id, organization_id from alerts
  `
  expect(alertRows).toHaveLength(1)
  // Tied to the saved query, which is what makes it countable as "this search is armed" rather than
  // "some alert exists".
  expect(alertRows[0].query_id).not.toBeNull()
  expect(alertRows[0].organization_id).toBe(harness.organization.organizationId)
})

/**
 * The first real act is the one that counts — a second arming must not move `activated_at`, or every
 * time-to-activation figure computed from it is wrong.
 */
test('the second arming does not re-activate', async () => {
  const status = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(status.activationType).toBe('saved_search_alert')
  expect(status.activatedAt).toBe(firstActivatedAt)
})

test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
  await page.goto(`${harness.baseURL}/onboarding/investing`)
  await page.waitForURL(/\/auth\/sign-in/)
})

/**
 * The smoke the plan's Verify line asks for on a phone.
 *
 * The `mobile` project only runs tests tagged `@mobile-only`, so a spec that does not carry the tag
 * has no mobile coverage however many times it is run with `--project=mobile` — the project's `grep`
 * simply matches nothing and the run reports green.
 *
 * What it checks is the thing a small viewport actually breaks: the theme chips are a wrapping row
 * and the composed-query preview is a long string, either of which can push the page wider than the
 * screen. Horizontal overflow is the failure; the rest of the behaviour is covered above.
 */
test('the thesis step fits a phone @mobile-only', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/investing`)

  await expect(page.getByTestId('investing-themes')).toBeVisible()
  await page.getByTestId('investing-theme').first().click()
  await page.getByTestId('investing-free-text').fill('a fairly long thesis about grid software and storage')
  await expect(page.getByTestId('investing-preview')).toBeVisible()

  const viewportWidth = page.viewportSize()?.width ?? 0
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)

  // The primary action has to be reachable, not merely present.
  await expect(page.getByTestId('investing-save')).toBeInViewport()
})
