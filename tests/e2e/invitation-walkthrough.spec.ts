import { test, expect, type Page } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv, installFixedBrowserClock } from './harness/clock'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from './harness/fixtures/platform-admin'
import { dismissOverlays, gotoHydrated, waitForFontsSettled } from './harness/browser'

/**
 * The walkthrough: every screen plans 58 and 59 ask a human to look at, captured.
 *
 * ## What this is and is not
 *
 * It is **not** a substitute for somebody's judgement. A screenshot proves a control rendered; it cannot
 * tell you the copy reads well or that the flow feels calm, and both plans ask for exactly that. What it
 * does is make the human pass cheap: every screen in one place, in order, so the review is two minutes of
 * looking rather than twenty of seeding fixtures and clicking.
 *
 * It is also the only assertion available for the beta-mode admin control, which until now had been
 * verified over HTTP (401/405) and never actually rendered. A component that has never been drawn is a
 * component whose first render is in front of an operator.
 *
 * Screenshots land in `tests/artifacts/walkthrough/`, which is git-ignored — evidence for a review, not a
 * baseline to compare against. The visual *baselines* are `tests/e2e/visual/`, and conflating the two is
 * how a review artifact becomes a gate nobody can update.
 */
const OUT = join(process.cwd(), 'tests', 'artifacts', 'walkthrough')

interface Harness {
  workerIndex: number
  databaseName: string
  baseURL: string
  sql: Sql
  admin: Principal
  sender: Principal
  senderOrgName: string
  recipientEmail: string
}

let harness: Harness
let shot = 0

test.describe.configure({ mode: 'serial' })

/** Numbered, so the directory reads in journey order rather than alphabetically. */
async function capture(page: Page, name: string): Promise<void> {
  shot += 1
  const file = join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  test.info().annotations.push({ type: 'screenshot', description: file })
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')
  await mkdir(OUT, { recursive: true })

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-walk`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}walk` }
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    const senderOrgName = 'Walkthrough Studio'
    const { principal: sender } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
      name: senderOrgName,
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      baseURL: server.baseURL,
      sql,
      admin,
      sender,
      senderOrgName,
      recipientEmail: `walkthrough-invitee@example.test`,
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerRedisNamespace(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await disposePrincipal(h.admin).catch(() => undefined)
  await disposePrincipal(h.sender).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  await dropWorkerRedisNamespace(h.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(h.workerIndex, h.databaseName).catch(() => undefined)
})

async function open(page: Page, path: string): Promise<void> {
  await installFixedBrowserClock(page)
  await gotoHydrated(page, `${harness.baseURL}${path}`)
  await dismissOverlays(page)
  await waitForFontsSettled(page)
}

test.describe('plan 59 — the sender', () => {
  test('the two-step composer, both steps', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.sender.storageState! })
    const page = await context.newPage()
    try {
      await open(page, '/settings/team')
      await capture(page, 'team-settings-before')

      // Step one: the fields, including the intent select and the counted role title.
      await page.getByTestId('invite-email-input').fill(harness.recipientEmail)
      await page.getByTestId('invite-role-title-input').fill('Staff Engineer')
      await expect(page.getByTestId('invite-role-title-count')).toContainText('14 / 120')
      await capture(page, 'composer-details')

      // Step two: the card the recipient will see, from the same component they will see it from.
      await page.getByTestId('invite-review-btn').click()
      await expect(page.getByTestId('invite-review-step')).toBeVisible()
      await expect(page.getByTestId('invitation-value-preview')).toBeVisible()
      await capture(page, 'composer-review')

      // Back must be non-destructive — the whole reason the values live above the step state.
      await page.getByTestId('invite-back-btn').click()
      await expect(page.getByTestId('invite-email-input')).toHaveValue(harness.recipientEmail)
      await expect(page.getByTestId('invite-role-title-input')).toHaveValue('Staff Engineer')
      await capture(page, 'composer-back-preserves-values')

      await page.getByTestId('invite-review-btn').click()
      await page.getByTestId('invite-submit-btn').click()
      await expect(page.getByTestId('invitations-list')).toContainText(harness.recipientEmail, { timeout: 20_000 })
      await capture(page, 'invitation-pending')
    } finally {
      await context.close()
    }
  })
})

test.describe('plan 58 — the operator', () => {
  test('the beta-mode control renders, confirms, and handles a stale revision', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    try {
      await open(page, '/admin/billing')
      // The first time this component has been drawn rather than probed over HTTP.
      await expect(page.getByTestId('beta-mode-control')).toBeVisible()
      await expect(page.getByTestId('beta-mode-state')).toHaveText('Disabled')
      await expect(page.getByTestId('beta-mode-revision')).toHaveText('0')
      await capture(page, 'beta-mode-disabled')

      // It confirms before committing, and states what will happen in the direction it is going.
      await page.getByTestId('beta-mode-toggle').click()
      await expect(page.getByTestId('beta-mode-confirm')).toBeVisible()
      await capture(page, 'beta-mode-confirm-enable')

      await page.getByTestId('beta-mode-commit').click()
      await expect(page.getByTestId('beta-mode-state')).toHaveText('Enabled', { timeout: 15_000 })
      await expect(page.getByTestId('beta-mode-revision')).toHaveText('1')
      await capture(page, 'beta-mode-enabled')

      /**
       * The conflict, driven for real rather than mocked.
       *
       * Another operator's change is simulated by moving the revision underneath the open page, which is
       * exactly what a second admin screen would do. The page must adopt the winning state and say so —
       * not show a red error, and not loop refetching.
       */
      await harness.sql`update platform_beta_mode set revision = revision + 1 where id = 'global'`
      await page.getByTestId('beta-mode-toggle').click()
      await page.getByTestId('beta-mode-commit').click()
      await expect(page.getByTestId('beta-mode-notice')).toBeVisible({ timeout: 15_000 })
      await capture(page, 'beta-mode-revision-conflict')
    } finally {
      // Left disabled: this is the state the rollout ships in, and a leaked `true` would change what every
      // later spec in a serial run authorizes.
      await harness.sql`update platform_beta_mode set enabled = false where id = 'global'`
      await context.close()
    }
  })

  test('the member badge appears only while it is on', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.sender.storageState! })
    const page = await context.newPage()
    try {
      await open(page, '/dashboard')
      await page.getByRole('button', { name: 'Account menu' }).click()
      await expect(page.getByTestId('beta-mode-badge')).toHaveCount(0)
      await capture(page, 'badge-absent-when-off')

      await harness.sql`update platform_beta_mode set enabled = true, revision = revision + 1 where id = 'global'`

      /**
       * Reloaded in a loop, because the five-second display cache is real and this is where you meet it.
       *
       * The shell reads `/api/beta-mode` once per mount, and that endpoint serves
       * `getCachedBetaModeStatus()` — a five-second in-process cache. So a single reload immediately after
       * the UPDATE gets the *stale* `false`, correctly: the plan documents the badge as following within
       * five seconds, and authorization as having no lag at all because it reads in-transaction.
       *
       * The first version of this test reloaded once and failed after 15 s against a badge that was never
       * going to appear without a second fetch. That was the test's mistake, not the product's — and the
       * loop is the honest way to assert "within five seconds" rather than "immediately".
       */
      await expect.poll(async () => {
        await open(page, '/dashboard')
        await page.getByRole('button', { name: 'Account menu' }).click()
        return await page.getByTestId('beta-mode-badge').count()
      }, { timeout: 20_000, intervals: [1_000, 2_000, 3_000, 5_000, 5_000] }).toBeGreaterThan(0)

      await expect(page.getByTestId('beta-mode-badge')).toContainText('700 credits/month')
      await capture(page, 'badge-present-when-on')
    } finally {
      await harness.sql`update platform_beta_mode set enabled = false where id = 'global'`
      await context.close()
    }
  })
})
