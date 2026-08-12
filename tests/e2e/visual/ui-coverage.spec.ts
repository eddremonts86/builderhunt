/**
 * Visual baselines for the six surfaces plan 56-UI names, and the two authorization classes they split
 * into.
 *
 * ## Why this file exists alongside `empty-states.spec.ts`
 *
 * That file captures a signed-in tenant's empty states with one owner principal. Three of the surfaces
 * here — Operations, Integrations, Claims — are platform-admin only, so they need a second principal
 * whose seed must be registered in the environment *before* the server spawns. Putting them in
 * `empty-states.spec.ts` would make every one of its baselines depend on a platform-admin fixture none of
 * them use.
 *
 * ## What is deliberately not here
 *
 * Public mobile navigation. `public-surfaces.spec.ts` already captures the public surfaces at the mobile
 * viewport through the `visual-mobile` project, and a second capture of the same DOM under a different
 * file name is a baseline to maintain rather than a regression to catch.
 *
 * ## The org name is fixed, and that is not cosmetic
 *
 * `empty-states.spec.ts` records the reason and it applies identically here: the default name ends in six
 * random characters, the font is proportional, and the organization switcher is *masked* — but a mask
 * follows its element, so a wider name is a wider rectangle, and one wide enough to wrap moves everything
 * below it. That is what made a baseline disagree with one taken twenty minutes earlier on the same
 * machine.
 */
import { expect, test } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv, installFixedBrowserClock } from '../harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from '../harness/fixtures/platform-admin'
import { dismissOverlays, gotoHydrated, waitForFontsSettled } from '../harness/browser'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
  admin: Principal
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

/** Same tolerance and the same reason as the other two visual specs: time, motion, fonts. */
const MAX_DIFF_PIXEL_RATIO = 0.01

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  // The allowlist is read from the environment by the app process, so the id has to be reserved and
  // registered before the server starts. Minting the principal afterwards is too late.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-uicoverage`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}uicov` }
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    // `pro`, so no surface renders an upgrade prompt in place of the layout this is here to capture.
    const { principal: owner } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
      name: 'E2E visual baseline org',
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      owner,
      admin,
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await disposePrincipal(h.owner).catch(() => undefined)
  await disposePrincipal(h.admin).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  await dropWorkerDatabase(h.workerIndex, h.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(h.redisPrefix).catch(() => undefined)
})

/** The switcher carries a per-run organization name, so it is masked here as it is elsewhere. */
function masks(page: import('playwright/test').Page) {
  return [page.getByLabel('Switch organization')]
}

async function prepare(page: import('playwright/test').Page, path: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFixedBrowserClock(page)
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  })
  await gotoHydrated(page, `${harness.baseURL}${path}`)
  // Left up, every baseline would be a screenshot of the cookie banner and none of them a screenshot of
  // the surface.
  await dismissOverlays(page)
  await waitForFontsSettled(page)
}

const OWNER_SURFACES = [
  { path: '/calendar', name: 'calendar' },
  { path: '/interviews', name: 'interviews-agenda' },
  { path: '/status', name: 'status-form' },
] as const

const ADMIN_SURFACES = [
  { path: '/admin/operations', name: 'admin-operations' },
  { path: '/admin/integrations', name: 'admin-integrations' },
  { path: '/admin/claims', name: 'admin-claims' },
] as const

for (const [label, surfaces, principalOf] of [
  ['tenant owner', OWNER_SURFACES, () => harness.owner],
  ['platform admin', ADMIN_SURFACES, () => harness.admin],
] as const) {
  test.describe(`${label} surfaces — desktop`, () => {
    for (const surface of surfaces) {
      test(`${surface.name} matches its baseline`, async ({ browser }) => {
        const context = await browser.newContext({ storageState: principalOf().storageState! })
        const page = await context.newPage()
        try {
          await prepare(page, surface.path)
          await expect(page).toHaveScreenshot(`${surface.name}.png`, {
            fullPage: true,
            maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
            animations: 'disabled',
            mask: masks(page),
          })
        } finally {
          await context.close()
        }
      })
    }
  })

  test.describe(`${label} surfaces — mobile`, () => {
    for (const surface of surfaces) {
      test(`${surface.name} matches its baseline @mobile-only`, async ({ browser }) => {
        const context = await browser.newContext({ storageState: principalOf().storageState! })
        const page = await context.newPage()
        try {
          await prepare(page, surface.path)
          await expect(page).toHaveScreenshot(`${surface.name}.png`, {
            fullPage: true,
            maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
            animations: 'disabled',
            mask: masks(page),
          })
        } finally {
          await context.close()
        }
      })
    }
  })
}
