/**
 * The goal step (plan: phase-2/03-onboarding-segmentado).
 *
 * The property that needs a browser is the one about the URL: a hint may decide which option starts
 * checked and may never write anything. Anybody can send anybody a link, so a hint that persisted
 * would be a preference appearing in an account that never expressed it.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'goal', flags: { USER_SEGMENTATION_ENABLED: 'true' } })

  /**
   * Accept the terms once, in the database, rather than dismissing a modal in every test.
   *
   * The terms gate is a real full-viewport dialog that intercepts every click, and it appears for a
   * fresh account — which is exactly what this harness creates. Clicking through it per test made
   * each one wait thirty seconds for an element the modal was covering, and the failure read as a
   * broken selector rather than as an unaccepted agreement. Seeding the consent puts the account in
   * the state anybody who has used the product is already in, which is the state this spec is about.
   */
  await harness.sql`
    insert into user_consents (id, user_id, document, version)
    values (${`c-${harness.owner.userId}-tos`}, ${harness.owner.userId}, 'tos', 'v1.0'),
           (${`c-${harness.owner.userId}-privacy`}, ${harness.owner.userId}, 'privacy', 'v1.0')
    on conflict (id) do nothing
  `
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * Clears the terms-of-service modal if the account has not accepted yet.
 *
 * It is a real product gate that covers the whole viewport, and it appears for a fresh account —
 * which is what this harness creates. Without this, a click on the goal step waits thirty seconds
 * for an element the modal is intercepting, and the failure reads as a broken selector rather than
 * as an unaccepted agreement.
 */
async function storedSegment(): Promise<string | null> {
  const rows = await harness.sql<{ primary_segment: string | null }[]>`
    select primary_segment from user_preferences where user_id = ${harness.owner.userId}
  `
  return rows[0]?.primary_segment ?? null
}

test('offers every goal, each with its own description', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal`)

  await expect(page.getByRole('group', { name: /what brings you here/i })).toBeVisible()
  for (const label of ['Hiring builders', 'Investing or scouting', 'Building', 'Something else']) {
    await expect(page.getByRole('radio', { name: new RegExp(label, 'i') })).toBeVisible()
  }
  // The promise the surface has to make, and the reason the step is safe to answer honestly.
  await expect(page.getByText(/does not change your permissions/i)).toBeVisible()
})

test('a hint preselects and, on its own, writes nothing', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal?goal=investing`)

  await expect(page.getByRole('radio', { name: /investing or scouting/i })).toBeChecked()
  // Arriving is not choosing. Nothing may be persisted until Continue is pressed.
  expect(await storedSegment()).toBeNull()
})

/**
 * A manipulated hint has to be indistinguishable from no hint — otherwise the URL becomes a way to
 * probe which values the enum accepts.
 */
test('a manipulated hint leaves the step exactly as if there were none', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal?goal=platform_admin`)

  for (const label of ['Hiring builders', 'Investing or scouting', 'Building', 'Something else']) {
    await expect(page.getByRole('radio', { name: new RegExp(label, 'i') })).not.toBeChecked()
  }
  await expect(page.getByRole('button', { name: /^continue/i })).toBeDisabled()
})

test('confirming persists the choice and moves on', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal?goal=hiring`)

  await page.getByRole('button', { name: /^continue/i }).click()
  await page.waitForURL(/\/onboarding\/search/)

  expect(await storedSegment()).toBe('hiring')
})

test('changing the answer before confirming stores the second one', async ({ page }) => {
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal?goal=hiring`)

  // The label rather than the input: the radio sits inside a `<label>` whose padding covers it, so
  // `.check()` waits for an element the label intercepts. Clicking the label is also what a person
  // does.
  await page.getByText('Building', { exact: true }).click()
  await page.getByRole('button', { name: /^continue/i }).click()
  // The answer decides the route, so changing it changes where Continue leads.
  await page.waitForURL(/\/onboarding\/building/)

  expect(await storedSegment()).toBe('building')
})

/**
 * The step is only worth answering if the answer changes something. Each branch has its own entry
 * route, and a segment whose branch is the general flow says so by landing on the search step.
 */
test('each answer leads to its own branch', async ({ page }) => {
  for (const [label, path] of [
    ['Investing or scouting', '/onboarding/investing'],
    ['Building', '/onboarding/building'],
    ['Hiring builders', '/onboarding/search'],
    ['Something else', '/onboarding/search'],
  ] as const) {
    await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
    await page.context().addCookies(harness.owner.storageState!.cookies)
    await page.goto(`${harness.baseURL}/onboarding/goal`)

    await page.getByText(label, { exact: true }).click()
    await page.getByRole('button', { name: /^continue/i }).click()
    await page.waitForURL(new RegExp(path.replace('/', '\\/')))
  }
})

/** Declining is an answer the product accepts, and it must never block the flow. */
test('declining advances without writing anything', async ({ page }) => {
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal`)

  await page.getByRole('button', { name: /rather not say/i }).click()
  await page.waitForURL(/\/onboarding\/search/)

  expect(await storedSegment()).toBeNull()
})

test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await page.waitForURL(/\/auth\/sign-in/)
})
