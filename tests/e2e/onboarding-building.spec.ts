/**
 * The building branch (plan: phase-2/03-onboarding-segmentado).
 *
 * Three states have to exist and be distinguishable, because verification here is asynchronous — the
 * claimant publishes a challenge on the account being claimed and the product checks it later:
 *
 * - **found** — the profile is in the index and the claim opens with a clear next step;
 * - **not found** — a real answer, said plainly, with the exit still available;
 * - **pending** — the challenge is not live yet. Not an error, and not a spinner.
 *
 * Plus the property the whole step turns on: the activation is recorded at the *started* claim, not
 * at verification. Waiting for verification would make this route's activation rate a measurement of
 * how quickly people get round to editing a profile somewhere else.
 *
 * The external fetch is faked through the seam in `src/shared/lib/claim-sources/index.ts` — see
 * `harness/fakes/claim-proof.ts` for why it cannot be exercised for real. What is covered is
 * everything the product owns: the lookup, the claim, the states, and where each one leads.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import { seedBuilderIdentity } from './harness/fixtures/builders'
import { setServerClaimProofScenario } from './harness/fakes/claim-proof'

let harness: InterviewHarness
let builderIdentityId: string
const HANDLE = 'e2eclaimant'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'onbbld',
    flags: { USER_SEGMENTATION_ENABLED: 'true', CLAIMABLE_PROFILES_ENABLED: 'true' },
  })

  await harness.sql`
    insert into user_consents (id, user_id, document, version)
    values (${`c-${harness.owner.userId}-tos`}, ${harness.owner.userId}, 'tos', 'v1.0'),
           (${`c-${harness.owner.userId}-privacy`}, ${harness.owner.userId}, 'privacy', 'v1.0')
    on conflict (id) do nothing
  `
  await harness.sql`
    insert into user_preferences (user_id, primary_segment, segment_source, segment_schema_version)
    values (${harness.owner.userId}, 'building', 'onboarding', 1)
    on conflict (user_id) do update set primary_segment = 'building'
  `

  // A `github` identity: only sources with a fetchable bio support challenge proof at all.
  builderIdentityId = (await seedBuilderIdentity(harness.sql, { scope: 'onbbld', username: HANDLE })).builderIdentityId
})

test.afterAll(async () => {
  await setServerClaimProofScenario(harness.redisPrefix, null).catch(() => undefined)
  await stopInterviewHarness(harness)
})

async function claimRows() {
  return harness.sql<{ id: string; status: string; subject_user_id: string; builder_identity_id: string }[]>`
    select id, status, subject_user_id, builder_identity_id from builder_claims
  `
}

test('offers a lookup and an exit that does not need it', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/building`)

  await expect(page.getByTestId('building-handle')).toBeVisible()
  await expect(page.getByTestId('building-find')).toBeDisabled()
  // Skip is on the first screen, before anything has been asked of anybody — the spec is explicit
  // that onboarding never blocks the dashboard.
  await expect(page.getByTestId('building-skip')).toBeEnabled()
})

/**
 * Not being indexed is an ordinary outcome, not a failure. The step says so and offers nothing it
 * cannot do — in particular it does not offer to create a profile, because the index is built from
 * public activity and a row this flow invented would be a profile nobody could prove.
 */
test('says plainly when nothing is indexed under that handle', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/building`)

  await page.getByTestId('building-handle').fill('nobody-by-that-name')
  await page.getByTestId('building-find').click()

  await expect(page.getByTestId('building-not-found')).toBeVisible()
  await expect(page.getByTestId('building-candidates')).toHaveCount(0)
  expect(await claimRows()).toHaveLength(0)
})

/**
 * Exact match, and the reason is not pedantry: a prefix search over the identity table would be a
 * handle enumerator for every authenticated account.
 */
test('a prefix of a real handle finds nothing', async () => {
  const response = await harness.owner.api!.get(`/api/builders/claim/candidates?handle=${HANDLE.slice(0, 4)}`)
  expect(response.status()).toBe(200)
  expect((await response.json()).candidates).toHaveLength(0)

  // The same handle in a different case is the same handle, though.
  const exact = await harness.owner.api!.get(`/api/builders/claim/candidates?handle=${HANDLE.toUpperCase()}`)
  expect((await exact.json()).candidates).toHaveLength(1)
})

test('finds the profile, opens the claim, and records the activation there', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/building`)

  await page.getByTestId('building-handle').fill(HANDLE)
  await page.getByTestId('building-find').click()
  await expect(page.getByTestId('building-candidates')).toBeVisible()

  await page.getByTestId('building-claim').click()

  // The pending screen is the clear next step the spec asks for: the challenge, where to put it, and
  // a way to check again.
  await expect(page.getByTestId('building-pending')).toBeVisible()
  const challenge = await page.getByTestId('building-challenge').innerText()
  expect(challenge.length).toBeGreaterThan(8)

  const claims = await claimRows()
  expect(claims).toHaveLength(1)
  expect(claims[0].status).toBe('pending')
  expect(claims[0].subject_user_id).toBe(harness.owner.userId)
  expect(claims[0].builder_identity_id).toBe(builderIdentityId)

  // Activation at the started claim, not at verification.
  const status = await (await harness.owner.api!.get('/api/onboarding/v2')).json()
  expect(status.preset).toBe('building')
  expect(status.activationType).toBe('builder_claim')
  expect(status.activatedAt).not.toBeNull()
})

/** The challenge is not live yet. That is the common case, and it is not an error state. */
test('a failed check leaves the claim pending and says why', async ({ page }) => {
  await setServerClaimProofScenario(harness.redisPrefix, 'not_found')

  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/building`)
  await page.getByTestId('building-handle').fill(HANDLE)
  await page.getByTestId('building-find').click()
  await page.getByTestId('building-claim').click()
  await page.getByTestId('building-check').click()

  await expect(page.getByTestId('building-proof-failure')).toContainText(/not_found/)
  await expect(page.getByTestId('building-pending')).toBeVisible()
  expect((await claimRows())[0].status).toBe('pending')
})

test('a successful check verifies the claim and ends on the builder success step', async ({ page }) => {
  await setServerClaimProofScenario(harness.redisPrefix, 'success')

  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/onboarding/building`)
  await page.getByTestId('building-handle').fill(HANDLE)
  await page.getByTestId('building-find').click()
  await page.getByTestId('building-claim').click()
  await page.getByTestId('building-check').click()

  await page.waitForURL(/\/onboarding\/success/)
  // The last screen is the builder's, not the recruiter's: it used to tell everybody their radar was
  // live, which was simply untrue for somebody who never saved a search.
  await expect(page.getByTestId('onboarding-success')).toHaveAttribute('data-preset', 'building')
  await expect(page.getByTestId('onboarding-success-heading')).toHaveText('The profile is yours')
  await expect(page.getByRole('link', { name: /go to my profile/i })).toHaveAttribute('href', '/me')

  expect((await claimRows())[0].status).toBe('verified')
})

test('an unauthenticated visitor is sent to sign in', async ({ page }) => {
  await page.goto(`${harness.baseURL}/onboarding/building`)
  await page.waitForURL(/\/auth\/sign-in/)
})
