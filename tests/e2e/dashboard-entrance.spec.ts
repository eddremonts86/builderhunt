/**
 * The widget grid is actually visible once the dashboard reports ready (plan 57, Wave 1).
 *
 * ## Why this is not covered by the visual baselines
 *
 * It was supposed to be, and the way that failed is the reason this file exists.
 *
 * `empty-states.spec.ts` screenshots `/dashboard` for a brand-new organization. On 2026-08-12 the
 * Linux gate captured a 751px band of bare `--color-bh-bg` — measured: a single colour,
 * `rgb(10, 10, 13)`, not one card border — exactly where macOS captured the action queue, the three
 * headline tiles, builder recency, sourcing sprints, For you and Alerts. Same page height to within
 * 2px. Both attempts byte-identical. The region below the band rendered perfectly, and
 * `data-dashboard-state="ready"` was set the whole time.
 *
 * Measuring the DOM instead of the pixels named the state in one run: nine widgets at
 * `opacity: 0` with `transform: matrix(1, 0, 0, 1, 0, 12)` — the `hidden` keyframe of
 * `fadeInUpVariants` — twenty seconds after the page said it was ready. `action-queue`,
 * `stat-builders`, `stat-active`, `stat-searches`, `activity`, `sprints`, `recommendations`,
 * `alerts`, `source-mix`. The same nine, in the same order, as the band.
 *
 * A screenshot suite could not have told anyone that. `toHaveScreenshot` finishes the animations it
 * can enumerate before it captures, so on macOS the picture showed widgets the live page did not —
 * the baseline was a photograph of a state no user was in. A diff ratio names neither the widget nor
 * the reason, and a page whose tiles hold their height while painting nothing has the same height as
 * one that renders correctly, so neither the ratio nor the dimensions could catch it.
 *
 * So the property belongs in the DOM, on the platform CI and production both run:
 *
 *   **after the dashboard reports ready, every tile it rendered is visible.**
 *
 * Asserted as effective opacity up the ancestor chain plus an identity transform, rather than by
 * asking the animation library whether it finished. What matters is whether the pixels are there,
 * and a tile hidden by a parent is exactly as invisible as one hidden by itself.
 *
 * ## Why a fresh organization
 *
 * The empty workspace is where the fault appeared and it is the harder case: several widgets decide
 * what to render from section data that arrives after the core query, so it exercises the
 * mount-after-ready path that a seeded workspace can skip. `dashboard-shell.spec.ts` covers the
 * settled seeded dashboard and its three headline tiles; this covers the grid arriving at all.
 */
import { expect, test } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { dismissOverlays, gotoHydrated, waitForTilesSettled } from './harness/browser'

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
  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}entrance` }
    // `pro`, so no surface swaps an upgrade prompt in for the widget it is here to check.
    const { principal } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
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
  const current = harness
  if (!current) return
  await disposePrincipal(current.principal).catch(() => undefined)
  await current.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(current.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${current.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(current.workerIndex, current.databaseName)
  await dropWorkerRedisNamespace(current.redisPrefix)
})

test.describe('the dashboard widget grid', () => {
  test('every tile it renders is visible once the page reports ready', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.principal.storageState! })
    const page = await context.newPage()

    /**
     * Deliberately no `emulateMedia`, no fixed browser clock and no injected animation-killing CSS.
     *
     * Those three are how `empty-states.spec.ts` makes a screenshot reproducible, and any of them
     * could be the reason a tile never arrives — which would make this a harness artifact rather
     * than something a user meets. Leaving them off is what makes a failure here mean the product.
     */
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(error.message))

    try {
      await gotoHydrated(page, `${harness.baseURL}/dashboard`)
      await dismissOverlays(page)
      await expect(page.locator('[data-dashboard-state="ready"]')).toBeVisible({ timeout: 20_000 })

      // Named first: a thrown render explains a missing widget, and the wait below would only report
      // that one is missing.
      expect(crashes, 'the dashboard threw while rendering').toEqual([])

      // At least one tile, so this cannot pass by finding nothing to check.
      await expect(page.locator('[data-widget]').first()).toBeAttached()
      await waitForTilesSettled(page)
    } finally {
      await context.close()
    }
  })

  test('and is visible for a viewer who asked for reduced motion', async ({ browser }) => {
    /**
     * The case above passes, which narrows the fault to something the visual suite emulates. Of the
     * three candidates — a fixed `Date`, injected animation-killing CSS, and
     * `prefers-reduced-motion` — only the last is a state a real person is in, so it is the only one
     * whose failure would be a defect rather than a harness artifact. Hence its own case.
     *
     * What makes it plausible rather than paranoid: the grid's entrance is a Framer Motion stagger,
     * and its opt-out is `variants={reduceMotion ? undefined : fadeInUpVariants}`. Dropping the
     * variants removes the animation, and with it anything that would set `opacity` — while the
     * server-rendered markup was produced with `prefersReducedMotion` at its module default of
     * `false`, so it ships the `hidden` keyframe inline. Nothing in that path clears it.
     *
     * If that is what happens, a viewer who asked for less movement gets no dashboard widgets at
     * all, which is the most expensive way possible to respect a motion preference.
     */
    const context = await browser.newContext({
      storageState: harness.principal.storageState!,
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/dashboard`)
      await dismissOverlays(page)
      await expect(page.locator('[data-dashboard-state="ready"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-widget]').first()).toBeAttached()
      await waitForTilesSettled(page)
    } finally {
      await context.close()
    }
  })
})
