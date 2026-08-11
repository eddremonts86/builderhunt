/**
 * The Admin Metrics lazy widget shell, in a real browser (plan 57, Admin track — "Rebuild `/admin/metrics` as
 * a route-driven lazy widget shell").
 *
 * `tests/unit/modules/admin/metrics/AdminMetricsPage.test.tsx` covers the rendering rules against mocked
 * responses. This covers the four things a mock cannot:
 *
 * - **A bookmarked URL restores the view it names.** `validateSearch` runs in the router, so this is the only
 *   place it actually runs.
 * - **An invalid value normalizes *and the URL is corrected*.** Silently rendering the overview while the
 *   address bar still says `traffic` is the failure worth catching: the operator would share that URL.
 * - **The hidden sections are never requested.** Asserted against the network, not against a mock's call log.
 * - **A non-admin is refused before the shell mounts.** A page that renders the admin chrome and only then
 *   discovers the caller is a tenant has already told them the console exists.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from './harness/fixtures/platform-admin'
import { disposePrincipal, type Principal } from './harness/fixtures/principals'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'

let harness: InterviewHarness
let admin: Principal

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  // Env-allowlisted, so the id has to exist before the server process starts.
  const seed = reservePlatformAdminSeed(`w${workerIndex}-metshell`)
  registerPlatformAdminEnv(seed)

  harness = await startInterviewHarness({ scope: 'metshell' })
  admin = await createPlatformAdminPrincipal(harness.ctx, seed)
})

test.afterAll(async () => {
  await disposePrincipal(admin).catch(() => undefined)
  await stopInterviewHarness(harness)
})

test.describe('the Admin Metrics shell', () => {
  test('restores a bookmarked section, window and view from the URL alone', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      // Absolute, against this worker's own server. A relative path resolves against the config's shared
      // `baseURL` and would measure a different process.
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=7d&variant=latency`)
      await dismissOverlays(tab)

      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('admin-metrics-section-traffic')).toHaveAttribute('data-active', 'true')
      await expect(tab.getByTestId('admin-metrics-range-7d')).toHaveAttribute('data-active', 'true')
      await expect(tab.getByTestId('admin-metrics-variant-latency')).toHaveAttribute('data-active', 'true')
      // And the URL was left alone, because nothing needed correcting.
      expect(new URL(tab.url()).search).toContain('section=traffic')
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('normalizes an invalid section and rewrites the URL to what is actually shown', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=surveillance&range=18mo&variant=nonsense`)
      await dismissOverlays(tab)

      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('admin-metrics-section-overview')).toHaveAttribute('data-active', 'true')

      /**
       * The rewrite, which is the half that is easy to skip.
       *
       * Falling back without correcting the URL means the operator shares `?section=surveillance`, the next
       * person also gets the overview, and neither of them can tell that the URL asked for something else.
       */
      await expect
        .poll(() => new URL(tab.url()).searchParams.get('section'), { timeout: 10_000 })
        .toBe('overview')
      expect(new URL(tab.url()).searchParams.get('range')).toBe('24h')
      expect(new URL(tab.url()).searchParams.get('variant')).toBe('summary')
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('requests only the section on screen, and the next one only when it is opened', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    const sectionRequests: string[] = []
    tab.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/admin/metrics/sections') {
        sectionRequests.push(url.searchParams.get('section') ?? '')
      }
    })
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => sectionRequests.length, { timeout: 15_000 }).toBeGreaterThan(0)

      /**
       * The claim the rebuild makes, asserted against the network.
       *
       * Before it, this page read the monolithic endpoint every fifteen seconds and rendered every section at
       * once — so an operator reading latency was paying for a platform billing sweep, an interview capability
       * read and a removal aggregate, and the query nobody wanted looked exactly like the one they did.
       */
      expect(new Set(sectionRequests)).toEqual(new Set(['traffic']))

      await tab.getByTestId('admin-metrics-section-search').click()
      await expect(tab.getByTestId('admin-metrics-section-search')).toHaveAttribute('data-active', 'true')
      await expect.poll(() => sectionRequests.includes('search'), { timeout: 15_000 }).toBe(true)
      // Opening search did not go back for traffic, or fetch the six nobody asked for.
      expect(new Set(sectionRequests)).toEqual(new Set(['traffic', 'search']))
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('never renders a number without a unit, a scope and a window', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=runtime&range=24h&variant=process`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      // Runtime always has numbers — they are in-process counters, so there is no window in which it is
      // `unavailable`. That makes it the section that can assert the rules unconditionally.
      const values = tab.locator('[data-testid^="metric-value-"]')
      await expect(values.first()).toBeVisible({ timeout: 20_000 })
      const count = await values.count()
      expect(count).toBeGreaterThan(0)
      for (let index = 0; index < count; index += 1) {
        // Every runtime value is this instance's, and says so beside itself rather than in a legend.
        await expect(values.nth(index)).toHaveAttribute('data-scope', 'process')
        await expect(values.nth(index)).toContainText('not a platform total')
      }
      await expect(tab.getByTestId('metric-section-window')).toBeVisible()
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('reports data freshness as a lag, and says how many instances are reporting', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=runtime&range=24h&variant=freshness`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      /**
       * `reporting_instances` is present whatever the store holds, which is the point of the widget: zero
       * instances reporting is the state that otherwise looks exactly like no traffic. The lag values are
       * conditional — there is genuinely no lag to state before the first minute is written.
       */
      await expect(tab.getByTestId('metric-value-reporting_instances')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('metrics-freshness-note')).toContainText('older than it looks')
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('asks the server for a comparison only when the toggle is on', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    const compareFlags: string[] = []
    tab.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/admin/metrics/sections') {
        compareFlags.push(url.searchParams.get('compare') ?? 'absent')
      }
    })
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-compare-toggle')).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => compareFlags.length, { timeout: 15_000 }).toBeGreaterThan(0)
      expect(compareFlags.every((flag) => flag === 'false')).toBe(true)

      await tab.getByTestId('admin-metrics-compare-toggle').click()
      await expect(tab.getByTestId('admin-metrics-compare-toggle')).toHaveAttribute('data-active', 'true')
      await expect.poll(() => compareFlags.includes('true'), { timeout: 15_000 }).toBe(true)

      // Bookmarkable: the toggle is URL state, not component state.
      expect(new URL(tab.url()).searchParams.get('compare')).toBe('true')
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('offers no comparison toggle for a section that cannot honour one', async ({ browser }) => {
    // Runtime counters have no previous window. A toggle there would change nothing, and an operator would
    // read the unchanged numbers as "no change".
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=runtime&range=24h&variant=process`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('admin-metrics-compare-toggle')).toHaveCount(0)
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('worker and source health read the registries the operations pages read', async ({ browser }) => {
    /**
     * Plan 57, Admin track — "Build Worker and Integration Health admin widgets".
     *
     * Asserted in a browser against the harness's own database rather than against mocks, because the thing worth
     * proving is that the section reads registries that *exist*. The projection the Command Center task named
     * reads eight `platform_*` tables that appear in no migration and throws
     * `relation "platform_incidents" does not exist` on its first call — this one answers.
     */
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=operations&range=24h&variant=integrations`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      // The source registers are migration-managed, so they are never empty in a migrated database.
      await expect(tab.getByTestId('metric-value-sources_registered')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('metric-value-sources_enabled_without_connector')).toBeVisible()

      /**
       * The workers variant is allowed to answer either way, and both answers are correct.
       *
       * An empty schedule registry means the sync has never run in this database — which is `dependency_unavailable`
       * and deliberately not "0 overdue", because zeros over an empty registry read as healthy. What must never
       * happen is numbers appearing without a registry behind them.
       */
      await tab.getByTestId('admin-metrics-variant-workers').click()
      await expect(tab.getByTestId('admin-metrics-variant-workers')).toHaveAttribute('data-active', 'true')

      /**
       * Polled until one of the two settles, rather than counting immediately.
       *
       * Changing variant remounts the section host — that is deliberate, so one section's numbers can never
       * appear under another's heading — which means there is a loading window after the click. The first
       * version of this case read the DOM straight after asserting the tab was active, saw neither state, and
       * reported a product failure for a race in the test. The API answers
       * `unavailable: dependency_unavailable` here; asserting that only after the section has settled is what
       * makes the case mean what it says.
       */
      const settled = await Promise.race([
        tab.getByTestId('metric-section-unavailable-dependency_unavailable').waitFor({ timeout: 20_000 }).then(() => 'unavailable' as const),
        tab.getByTestId('metric-value-jobs_registered').waitFor({ timeout: 20_000 }).then(() => 'ready' as const),
      ])
      if (settled === 'ready') {
        await expect(tab.getByTestId('metric-value-jobs_overdue')).toBeVisible()
      } else {
        // An empty registry means the sync has never run in this database. Zeros here would read as healthy,
        // which is the strongest form of the lie this section exists to avoid.
        await expect(tab.getByTestId('metric-values')).toHaveCount(0)
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('the action queue is what Overview shows first, and it only appears when it has a row', async ({ browser }) => {
    /**
     * Plan 57, Admin track — "Build the Platform Action Queue and service-health widgets".
     *
     * Asserted against the harness's own database rather than a fixture, because the property worth proving is
     * that the queue is assembled from sources that exist. In a migrated database the source register is
     * populated and its enabled rows have unreviewed terms, so there is at least one honest row to find; if a
     * future seed changes that, the empty case is equally valid and the assertion covers both.
     */
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=overview&range=24h&variant=summary`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('metric-values')).toBeVisible({ timeout: 20_000 })

      const queue = tab.getByTestId('admin-action-queue')
      if ((await queue.count()) > 0) {
        // Above the numbers, because that is where an operator's eye lands at 02:00.
        const rows = tab.locator('[data-testid^="admin-action-queue-row-"]')
        await expect(rows.first()).toBeVisible()
        // Severity as a word, and a destination that is an in-app path — never an absolute URL.
        const severity = await rows.first().getAttribute('data-severity')
        expect(['critical', 'high', 'medium', 'low']).toContain(severity)
        const href = await rows.first().getAttribute('href')
        expect(href).toMatch(/^\/[a-z0-9/_-]+$/)
        // And it goes somewhere that resolves for this admin rather than a guessed path.
        await rows.first().click()
        await expect(tab).toHaveURL(new RegExp(`${href}$`))
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('refuses a tenant owner before the console chrome appears', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const tab = await context.newPage()
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate`)
      await dismissOverlays(tab)
      // The admin surface is reached by URL — there is no link for a non-admin to click — so the route guard is
      // the only thing between a curious customer and the operations console.
      await expect(tab.getByTestId('admin-metrics-page')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
