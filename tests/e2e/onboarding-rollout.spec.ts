/**
 * The cohort ramp (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why one server at 50 % rather than two runs at 0 % and 100 %
 *
 * The harness spawns one server per worker and flags only reach it before that spawn, so a spec
 * cannot flip an env var between tests — an earlier attempt at a flag-off test in this plan was
 * abandoned for exactly that reason. But the cohort is a property of the *person*, not of the
 * request: at 50 % some accounts are in and some are out, against one server. So the spec finds one
 * of each and asserts both positions.
 *
 * That is also the stronger claim. It proves the bucketing gates the interface, not merely that a
 * boolean is readable.
 *
 * ## What "flag off serves v1" means concretely
 *
 * The two flows are live at once. Being out of the cohort means `welcome` sends somebody straight to
 * the v1 search step and never shows them the goal step — no deploy, no migration, and a rollback is
 * the same choice made the other way.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import { createOwnerPrincipal, type Principal } from './harness/fixtures/principals'
import { fixedClockFromEnv } from './harness/clock'
import { onboardingCohortBucket } from '~/shared/lib/onboarding-rollout'

const PERCENT = 50

let harness: InterviewHarness
let inCohort: Principal
let outOfCohort: Principal

test.describe.configure({ mode: 'serial' })

async function acceptTerms(userId: string) {
  await harness.sql`
    insert into user_consents (id, user_id, document, version)
    values (${`c-${userId}-tos`}, ${userId}, 'tos', 'v1.0'),
           (${`c-${userId}-privacy`}, ${userId}, 'privacy', 'v1.0')
    on conflict (id) do nothing
  `
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'onbroll',
    flags: { USER_SEGMENTATION_ENABLED: 'true', ONBOARDING_V2_ROLLOUT_PERCENT: String(PERCENT) },
  })

  /**
   * Accounts are created until one lands either side of the line.
   *
   * The bucket is a hash of the user id and the ids are minted by signup, so which side a fresh
   * account falls on is not something the test can choose — it can only keep looking. Twelve is far
   * beyond what a 50/50 split needs (the chance of twelve one-sided draws is about 1 in 2,000) and
   * it fails loudly rather than hanging if the hash ever stops spreading.
   */
  for (let attempt = 0; attempt < 12 && (!inCohort || !outOfCohort); attempt += 1) {
    const { principal } = await createOwnerPrincipal(harness.ctx, {
      tier: 'free',
      seatLimit: 1,
      clock: fixedClockFromEnv(),
    })
    harness.extraPrincipals.push(principal)
    await acceptTerms(principal.userId!)

    const bucket = onboardingCohortBucket(principal.userId!)
    if (bucket < PERCENT && !inCohort) inCohort = principal
    else if (bucket >= PERCENT && !outOfCohort) outOfCohort = principal
  }

  expect(inCohort, 'no account landed inside the cohort').toBeTruthy()
  expect(outOfCohort, 'no account landed outside the cohort').toBeTruthy()
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test('the server decides the cohort, and reports the ramp it used', async () => {
  const inside = await (await inCohort.api!.get('/api/onboarding/v2')).json()
  expect(inside.rollout).toEqual({ inCohort: true, percent: PERCENT })

  const outside = await (await outOfCohort.api!.get('/api/onboarding/v2')).json()
  expect(outside.rollout).toEqual({ inCohort: false, percent: PERCENT })
})

test('somebody in the cohort is sent to the goal step, and the machine moves with them', async ({ page }) => {
  await page.context().addCookies(inCohort.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/welcome`)

  await expect(page.getByTestId('onboarding-start')).toHaveAttribute('data-flow-version', '2')
  await page.getByTestId('onboarding-start').click()
  await page.waitForURL(/\/onboarding\/goal/)

  /**
   * The column the interface never wrote.
   *
   * The v2 state machine was fully built and tested, and nothing on screen advanced it — every
   * account sat at `current_step_key = null`, so the per-step funnel had a schema and no data. This
   * is the assertion that says a screen moves the server's state, not just the browser's URL.
   */
  await expect(async () => {
    const rows = await harness.sql<{ current_step_key: string | null; flow_version: number | null }[]>`
      select current_step_key, flow_version from onboarding_progress where user_id = ${inCohort.userId}
    `
    expect(rows[0]?.current_step_key).toBe('goal')
    expect(rows[0]?.flow_version).toBe(2)
  }).toPass({ timeout: 10_000 })
})

/** v1 has no v2 machine to move, so nothing writes a step key for somebody outside the cohort. */
test('the machine stays still for somebody outside it', async ({ page }) => {
  await page.context().addCookies(outOfCohort.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/welcome`)
  await page.getByTestId('onboarding-start').click()
  await page.waitForURL(/\/onboarding\/search/)

  const rows = await harness.sql<{ current_step_key: string | null }[]>`
    select current_step_key from onboarding_progress where user_id = ${outOfCohort.userId}
  `
  // Either no row at all, or v1's row with no v2 key on it — never a step key they never reached.
  expect(rows[0]?.current_step_key ?? null).toBeNull()
})

/** v1, unchanged: welcome straight to the search step, and the goal step never appears. */
test('somebody outside the cohort gets the flow they already had', async ({ page }) => {
  await page.context().addCookies(outOfCohort.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/welcome`)

  await expect(page.getByTestId('onboarding-start')).toHaveAttribute('data-flow-version', '1')
  await page.getByTestId('onboarding-start').click()
  await page.waitForURL(/\/onboarding\/search/)
})

/**
 * The ramp decides where `welcome` sends people; it is not an access control. Somebody out of the
 * cohort who types the URL gets a working step rather than a wall — the spec is explicit that
 * onboarding never blocks, and hiding the step behind a 404 would strand anybody mid-flow the moment
 * the percentage was lowered.
 */
test('being outside the cohort is not a lock on the v2 steps', async ({ page }) => {
  await page.context().addCookies(outOfCohort.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/goal`)

  await expect(page.getByRole('group', { name: /what brings you here/i })).toBeVisible()
})
