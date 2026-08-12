/**
 * Visual baselines for the empty states (plans/UI Wave 8).
 *
 * ## Why empty states, and only empty states
 *
 * A screenshot suite is only worth its maintenance if a diff means "the design changed". Populated
 * surfaces fail that test: their content is fixture data, and every fixture edit repaints the baseline
 * for reasons no reviewer can distinguish from a real regression. An empty state has no data by
 * definition — it is illustration, copy, and one call to action — so a diff is always the design.
 *
 * They are also the surfaces most likely to rot unseen. Nobody develops against an empty account after
 * their first week, so an empty state that has drifted out of the design system stays broken until a new
 * user finds it, which is exactly the wrong person to find it.
 *
 * ## Why this file needs the harness and `public-surfaces.spec.ts` does not
 *
 * Public routes render for a stranger, so that suite needs no database. These are behind a session, and
 * "empty" has to be a fact rather than a hope: a shared dev database has whatever the last person left in
 * it. So this spins up the standard per-worker disposable database and a freshly created organization —
 * an org that has never tracked a builder, saved a list, or booked anything. Every route below is
 * therefore genuinely at zero, on every run, on any machine.
 *
 * ## Baselines are per-platform, and the Linux ones are not here
 *
 * Playwright names snapshots per project *and* per OS. The committed files are `-darwin` because they were
 * generated on macOS. CI runs Linux and will fail with "snapshot missing" until someone runs
 * `pnpm test:visual --update-snapshots` on the runner and commits the `-linux` files. That is a known,
 * recorded gap in `plans/UI/tasks.md` — not something to paper over by loosening the diff ratio.
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
import { dismissOverlays, gotoHydrated, waitForTilesSettled } from '../harness/browser'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  principal: Principal
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}empty` }
    // `pro`, so no surface renders an upgrade prompt in place of the empty state it is here to capture.
    const { principal } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
      // Fixed, because the default ends in six random characters and the font is proportional:
      // `111111` and `WWWWWW` are the same length and not the same width. The org switcher is
      // masked, but a mask follows its element — so a wider name means a wider rectangle, and a
      // name wide enough to wrap moves everything below it. That is what made `empty-alerts`
      // disagree with a baseline taken twenty minutes earlier on this same machine.
      name: 'E2E visual baseline org',
    })
    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      principal,
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
  await disposePrincipal(h.principal).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${h.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(h.workerIndex, h.databaseName)
  await dropWorkerRedisNamespace(h.redisPrefix)
})

/**
 * The surfaces a brand-new organization actually lands on.
 *
 * Each has a designed zero state — an explanation and one way forward — and each is reached by a nav item
 * the new user can see, which is the reason it is worth a baseline at all.
 */
const EMPTY_ROUTES = [
  { path: '/dashboard', name: 'empty-dashboard' },
  { path: '/lists', name: 'empty-lists' },
  { path: '/alerts', name: 'empty-alerts' },
  { path: '/interviews', name: 'empty-interviews' },
  { path: '/exports', name: 'empty-exports' },
] as const

/** Same three sources of false diffs as `public-surfaces.spec.ts`: time, motion, fonts. */
const MAX_DIFF_PIXEL_RATIO = 0.01

/**
 * The one piece of per-run text on these pages.
 *
 * The harness names each organization with a random suffix, so the switcher in the topbar reads
 * "E2E pro org 030e8a" on one run and something else on the next. Masking it is the honest fix: the
 * alternative is leaning on the diff tolerance to absorb the difference, which quietly spends the same
 * tolerance that is supposed to be catching regressions.
 */
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
  // The cookie banner and the ToS modal sit above the page. Left up, every baseline would be a
  // screenshot of the banner and none of them would be a screenshot of the empty state.
  await dismissOverlays(page)

  /**
   * Wait for the dashboard to finish filling in before capturing it.
   *
   * Until Wave 1 this was unnecessary: `DashboardPage` returned a whole-page skeleton until every core fetch had
   * resolved, so a screenshot caught either the skeleton or the finished page and never anything between. Removing
   * that early return — which is what makes the shell usable during a slow request — also means the page now paints
   * its chrome first and fills the widget grid as data arrives.
   *
   * A capture taken right after hydration therefore lands mid-fill, and on a CI runner it did: the regenerated
   * Linux baseline was missing the three metric tiles, the action queue, recency, sprints, recommendations and
   * alerts, with a 650 px hole where they belong and the sidebar cut off at the same height. It reproduced twice,
   * so the refresh workflow's stability check accepted it — a half-rendered page can be perfectly stable.
   *
   * `data-dashboard-state="ready"` is the signal the page already publishes for exactly this question, and it is
   * the same one `auth-and-sessions.spec.ts` waits on before navigating away. Scoped to the dashboard route
   * because no other empty state has it.
   */
  if (path === '/dashboard') {
    await page.locator('[data-dashboard-state="ready"]').waitFor({ state: 'attached', timeout: 20_000 })
    /**
     * And then wait for the grid to actually arrive.
     *
     * `ready` was not enough, and the way it failed is worth keeping: the Linux gate captured a 751px
     * band of bare page background where macOS captured six widgets, at the same page height, twice,
     * byte-identically. Tiles mid-entrance hold their height at `opacity: 0`, so neither the diff
     * ratio nor the height comparison could say which widgets were missing — see
     * `waitForTilesSettled`, which names them instead.
     */
    await waitForTilesSettled(page)
  }

  await page.evaluate(() => document.fonts.ready)
}

/**
 * Uncaught page errors, asserted before the screenshot.
 *
 * A thrown render leaves the surface incomplete, and `toHaveScreenshot` reports that as a diff ratio —
 * a number that names neither the widget that vanished nor the exception that removed it. Checking
 * first means the failure says what happened.
 */
function collectCrashes(page: import('playwright/test').Page): string[] {
  const crashes: string[] = []
  page.on('pageerror', (error) => crashes.push(error.message))
  return crashes
}

test.describe('empty states — desktop', () => {
  for (const route of EMPTY_ROUTES) {
    test(`${route.name} matches its baseline`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.principal.storageState! })
      const page = await context.newPage()
      const crashes = collectCrashes(page)
      try {
        await prepare(page, route.path)
        expect(crashes, 'the page threw while rendering').toEqual([])
        await expect(page).toHaveScreenshot(`${route.name}.png`, {
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

test.describe('empty states — mobile', () => {
  for (const route of EMPTY_ROUTES) {
    test(`${route.name} matches its baseline @mobile-only`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.principal.storageState! })
      const page = await context.newPage()
      const crashes = collectCrashes(page)
      try {
        await prepare(page, route.path)
        expect(crashes, 'the page threw while rendering').toEqual([])
        await expect(page).toHaveScreenshot(`${route.name}.png`, {
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
