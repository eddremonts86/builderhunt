/**
 * The dashboard shell renders independently of its slowest fetch (plan 57, Wave 1 — "Refactor the page into core
 * and lazy section queries").
 *
 * ## Why this spec did not exist for five days
 *
 * The task's own note recorded it as blocked on Playwright: an attempt on 2026-08-06 found that holding
 * `/api/dashboard/stats` produced a page with an empty `main` and a navigation that never settled, for the full
 * 120 s timeout, and concluded that something about intercepting the request was at fault.
 *
 * Nothing was. `DashboardPage` had a whole-page `if (loading) return <skeleton />`, and `loading` was set false only
 * by the effect fetching `stats`. Holding that request held the entire page — the shell, the navigation and the
 * action queue with it — so the interception was working perfectly and there was simply nothing to assert against.
 * Repointing the counts at a different endpoint just moved the same early return onto that endpoint, which is why
 * changing the URL never helped.
 *
 * The early return is gone, so the property the Verify line asks for is now observable: **one slow request leaves
 * the queue and the navigation usable.** That is what this file tests.
 *
 * ## Why the interception is on `/api/dashboard/stats` specifically
 *
 * It is a plain `useEffect` fetch. A `page.route` against a TanStack Query endpoint hangs in this repository — the
 * reason `admin-metrics-shell.spec.ts` says the same thing — so the endpoint under test here is the one whose
 * request Playwright can actually hold.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import { dismissOverlays, gotoHydrated } from './harness/browser'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'dashshell' })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test.describe('the dashboard shell', () => {
  test('a held headline request leaves the shell, the navigation and the queue usable', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const tab = await context.newPage()

    /**
     * Held open, then released in `finally`.
     *
     * Deliberately not `route.abort()`: an aborted request is a *failed* one, and this case is about a request
     * that has not answered yet. The two render differently by design — a failure surfaces the page-level error
     * banner, while a pending request must show a skeleton and claim nothing.
     */
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await tab.route('**/api/dashboard/stats', async (route) => {
        await held
        await route.continue()
      })

      await gotoHydrated(tab, `${harness.baseURL}/dashboard`)
      await dismissOverlays(tab)

      /**
       * The shell is present and honestly labelled as still loading.
       *
       * `data-dashboard-state` carries the state now rather than the element's existence carrying it, so this
       * assertion is what proves the settle signal still means something: `loading` here, `ready` only once the
       * fetch resolves.
       */
      const shell = tab.locator('[data-dashboard-state]')
      await expect(shell).toBeVisible({ timeout: 20_000 })
      await expect(shell).toHaveAttribute('data-dashboard-state', 'loading')

      // The heading is part of the shell, not part of the payload — under the old early return this was absent.
      await expect(tab.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()

      /**
       * The headline tiles show a skeleton, not a zero.
       *
       * This is the assertion the whole five-part change exists for. `MetricWidgetProps.value` used to be a
       * non-nullable `number` fed `stats?.totalBuilders ?? 0`, so a tile with nothing loaded rendered a confident
       * `0` — invisible only because the page-level skeleton covered it. Asserted as "no digits in the tile"
       * rather than "not 0", because the failure mode is any plausible number.
       */
      const loadingTiles = tab.locator('[data-metric-state="loading"]')
      await expect(loadingTiles.first()).toBeVisible()
      for (const text of await loadingTiles.allTextContents()) {
        expect(text).not.toMatch(/[0-9]/)
      }

      /**
       * The empty-workspace CTA is absent while the count is unknown.
       *
       * Its predicate is `!ctx.stats || ctx.stats.totalBuilders === 0`, and `!ctx.stats` is true before the fetch
       * resolves — so without the `statsLoading` guard this owner, who has a seeded workspace, would be told to
       * run their first hunt.
       */
      await expect(tab.getByRole('heading', { name: 'Run your first hunt' })).toHaveCount(0)

      /**
       * And the navigation still works while the request is outstanding — the Verify line, literally.
       *
       * Under the early return there was no nav in the DOM to click.
       */
      await tab.getByRole('link', { name: 'Search builders' }).click()
      await expect(tab).toHaveURL(/\/search/)
    } finally {
      release?.()
      await context.close()
    }
  })

  test('the settle signal flips to ready once the request answers, and the numbers replace the skeletons', async ({ browser }) => {
    /**
     * The control for the case above.
     *
     * Without it, every assertion there would also hold if the tiles never resolved at all — the shell would look
     * correct and the dashboard would be permanently skeletal. Same reason the preference-store spec has a
     * positive case.
     */
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const tab = await context.newPage()
    try {
      await gotoHydrated(tab, `${harness.baseURL}/dashboard`)
      await dismissOverlays(tab)

      await expect(tab.locator('[data-dashboard-state="ready"]')).toBeVisible({ timeout: 20_000 })
      // Every tile has a value; none is left claiming to load.
      await expect(tab.locator('[data-metric-state="loading"]')).toHaveCount(0)
      await expect(tab.locator('[data-metric-state="ready"]').first()).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
