/**
 * The goal step (plan: phase-2/03-onboarding-segmentado).
 *
 * The property that needs a browser is the one about the URL: a hint may decide which option starts
 * checked and may never write anything. Anybody can send anybody a link, so a hint that persisted
 * would be a preference appearing in an account that never expressed it.
 */
import { expect, test, type Page } from 'playwright/test'

import { SEGMENT_HINT_STORAGE_KEY, SEGMENT_HINT_TTL_MS } from '~/shared/lib/landing-segment-hint'
import { dismissOverlays } from './harness/browser'
import { allowlistEmailForSignup } from './harness/fixtures/principals'
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

/**
 * Carrying the hint across sign-up (plan: phase-2/06-landing-segmentada).
 *
 * The query is lost at the sign-up form — a different page, a different URL — so the hint waits in
 * `sessionStorage`. What has to be true on the other side is that it still only *preselects*, and
 * that anything hand-written into that key reads as no hint at all. `sessionStorage` is writable by
 * anything on the origin, which is what the forged and expired cases below are about.
 */
const NOTHING_CHECKED = ['Hiring builders', 'Investing or scouting', 'Building', 'Something else']

async function expectNothingPreselected(page: Page): Promise<void> {
  for (const label of NOTHING_CHECKED) {
    await expect(page.getByRole('radio', { name: new RegExp(label, 'i') })).not.toBeChecked()
  }
}

/**
 * Writes the stash the way a page on the origin would.
 *
 * A navigation to the origin first, because `sessionStorage` is per-origin and unreachable from
 * `about:blank`. Deliberately not `addInitScript`: that re-seeds on every navigation, which would
 * make the one-shot test below pass whether the value is consumed or not.
 */
async function seedStash(page: Page, value: string): Promise<void> {
  await page.goto(`${harness.baseURL}/onboarding/welcome`)
  await page.evaluate(
    ([key, raw]) => window.sessionStorage.setItem(key, raw),
    [SEGMENT_HINT_STORAGE_KEY, value] as const,
  )
}

function stashValue(segment: string, expiresAt: number): string {
  return JSON.stringify({ v: 1, segment, expiresAt })
}

test('a hint stashed at sign-up preselects on the goal step, once', async ({ page }) => {
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await seedStash(page, stashValue('investing', Date.now() + SEGMENT_HINT_TTL_MS))

  // No `?goal=` anywhere: the stash is the only thing that could have decided this.
  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await expect(page.getByRole('radio', { name: /investing or scouting/i })).toBeChecked()

  // Spent. A hint that survived its own reading would keep deciding screens nobody linked it to.
  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await expectNothingPreselected(page)
})

test('an expired stash preselects nothing', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await seedStash(page, stashValue('building', Date.now() - 1))

  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await expectNothingPreselected(page)
})

test('a hand-written stash preselects nothing', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)

  for (const forged of [
    stashValue('platform_admin', Date.now() + SEGMENT_HINT_TTL_MS),
    // No expiry at all — the obvious way to try to make one permanent.
    JSON.stringify({ v: 1, segment: 'hiring' }),
    'hiring',
  ]) {
    await seedStash(page, forged)
    await page.goto(`${harness.baseURL}/onboarding/goal`)
    await expectNothingPreselected(page)
  }
})

/** The URL is the link they just followed; the stash is one they followed before a form. */
test('the URL outranks the stash', async ({ page }) => {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await seedStash(page, stashValue('building', Date.now() + SEGMENT_HINT_TTL_MS))

  await page.goto(`${harness.baseURL}/onboarding/goal?goal=hiring`)
  await expect(page.getByRole('radio', { name: /hiring builders/i })).toBeChecked()
  await expect(page.getByRole('radio', { name: /^building/i })).not.toBeChecked()
})

/**
 * A stored segment is something this person said. A hint is a guess read off a URL, and the URL is
 * the half somebody else can write — so the worst a crafted link may do is offer a change that still
 * needs Continue pressed.
 */
test('a stored choice outranks a hint in the URL', async ({ page }) => {
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  await page.context().addCookies(harness.owner.storageState!.cookies)

  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await page.getByText('Building', { exact: true }).click()
  await page.getByRole('button', { name: /^continue/i }).click()
  await page.waitForURL(/\/onboarding\/building/)
  expect(await storedSegment()).toBe('building')

  await page.goto(`${harness.baseURL}/onboarding/goal?goal=hiring`)
  await expect(page.getByRole('radio', { name: /^building/i })).toBeChecked()
  await expect(page.getByRole('radio', { name: /hiring builders/i })).not.toBeChecked()
})

/**
 * The whole chain, in a browser: a public segment page, the real sign-up form, and the goal step on
 * the other side. Each half is covered above; this is the join, which is where a hint has died
 * before — the query is simply not on the URL the form posts from.
 */
test('a hint survives the segment page, the sign-up form and the redirect', async ({ page }) => {
  const email = `e2e-goal-hint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
  // Invite-only sign-up: pre-approve so the real gate admits this account.
  await allowlistEmailForSignup(harness.sql, email)

  await page.goto(`${harness.baseURL}/for/investors`)
  // The CTA carries it. Asserted on the href because this is the only link that leaves the public
  // site, and followed with a full navigation so `dismissOverlays` has a document to work on — a
  // cookie banner mounting mid-typing has already emptied a controlled form in this suite once.
  const signUp = page.getByRole('link', { name: /create an account/i })
  await expect(signUp).toHaveAttribute('href', /\/auth\/sign-up\?.*goal=investing/)
  await page.goto(`${harness.baseURL}${await signUp.getAttribute('href')}`)
  await dismissOverlays(page)

  await page.locator('#email').fill(email)
  await page.locator('#password').fill('e2e-Test-Passw0rd1')
  await page.getByRole('button', { name: /create account/i }).click()
  await page.waitForURL(/\/onboarding\//)

  // Bare URL: whatever preselects here came through the form, not along it.
  await page.goto(`${harness.baseURL}/onboarding/goal`)
  await dismissOverlays(page)
  await expect(page.getByRole('radio', { name: /investing or scouting/i })).toBeChecked()

  // And it is still only a preselection — a fresh account that has confirmed nothing has nothing stored.
  const rows = await harness.sql<{ primary_segment: string | null }[]>`
    select p.primary_segment from user_preferences p
    join auth_users u on u.id = p.user_id
    where u.email = ${email}
  `
  expect(rows[0]?.primary_segment ?? null).toBeNull()
})
