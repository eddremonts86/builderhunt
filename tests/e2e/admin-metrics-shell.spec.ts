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

import { addMember, startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
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

  test('meets the response budgets the plan sets, measured as a p95 rather than a single sample', async () => {
    /**
     * Plan 57, Admin track — "Overview p95 <= 400 ms and one cached analytical section p95 <= 750 ms".
     *
     * A p95 over eleven samples rather than one request, because a single sample on a laptop that just finished a
     * build measures the laptop. Eleven is the smallest count where the 95th is a real element (index 10) rather
     * than an interpolation, and the first response is discarded — it pays for the route module's first import,
     * which every subsequent reader does not.
     *
     * The budgets are the plan's, not mine, and they are asserted against the *harness* database. That is a
     * weaker claim than production and it is the honest one available here: what this catches is a section that
     * regresses by an order of magnitude, not a ten-millisecond drift.
     */
    const p95 = async (path: string) => {
      const samples: number[] = []
      // Discarded: the first call compiles and imports the route module.
      await admin.api!.fetch(path)
      for (let index = 0; index < 11; index += 1) {
        const startedAt = Date.now()
        const response = await admin.api!.fetch(path)
        expect(response.status(), path).toBe(200)
        samples.push(Date.now() - startedAt)
      }
      return samples.sort((a, b) => a - b)[10]
    }

    // Overview is the section the page loads first and re-reads on a timer, so it is the one whose cost has to
    // stay bounded — two indexed aggregate reads plus the action queue's bounded aggregates.
    expect(await p95('/api/admin/metrics/overview')).toBeLessThanOrEqual(400)
    // One analytical section, at the wider budget: traffic sums the minute buckets and computes percentiles.
    expect(await p95('/api/admin/metrics/sections?section=traffic&range=24h&variant=latency&compare=false')).toBeLessThanOrEqual(750)
  })

  test('keeps every payload collection inside the caps the contract declares', async () => {
    /**
     * The Verify line's "query/payload budgets", asserted on the wire.
     *
     * The schema caps these at parse time, so a violation cannot reach a client — which means this is really a
     * check that the caps are the numbers the plan chose, and that a section has not started returning a
     * collection nobody bounded. `check-admin-metrics-budgets.mjs` catches the *removal* of a cap statically;
     * this catches a cap that is present and too generous.
     */
    for (const query of [
      'section=overview&variant=summary',
      'section=traffic&variant=rate',
      'section=trust&variant=abuse',
      'section=operations&variant=integrations',
      'section=runtime&variant=process',
    ]) {
      const response = await admin.api!.fetch(`/api/admin/metrics/sections?${query}&range=24h&compare=false`)
      expect(response.status(), query).toBe(200)
      const payload = (await response.json()).payload
      if (payload.status === 'unavailable') continue
      expect(payload.data.values.length, `${query} values`).toBeLessThanOrEqual(24)
      expect((payload.data.ranked ?? []).length, `${query} ranked`).toBeLessThanOrEqual(10)
      expect((payload.data.queue ?? []).length, `${query} queue`).toBeLessThanOrEqual(12)
      expect((payload.data.series ?? []).length, `${query} series`).toBeLessThanOrEqual(6)
    }
  })

  test('renders at 320 px without a horizontally scrolling page', async ({ browser }) => {
    /**
     * WCAG 1.4.10, and the viewport where a fixed width or an unwrapped table actually shows up — 390 is
     * forgiving enough that a layout can be broken and still look fine.
     *
     * The page body must never scroll sideways. Wide content is allowed to, inside its own container, which is
     * why this measures `documentElement` rather than every descendant.
     */
    const context = await browser.newContext({ storageState: admin.storageState!, viewport: { width: 320, height: 720 } })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      for (const section of ['overview', 'traffic', 'operations']) {
        await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=${section}&range=24h&variant=${section === 'traffic' ? 'rate' : section === 'operations' ? 'workers' : 'summary'}&compare=false`)
        await dismissOverlays(tab)
        await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow, `${section} overflows at 320px by ${overflow}px`).toBeLessThanOrEqual(1)
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('survives 400 % zoom without clipping a number or overlapping a label', async ({ browser }) => {
    /**
     * WCAG 1.4.4 at its real threshold: 400 % of a 1280 px viewport is a 320 px CSS layout, which the case above
     * already covers for *overflow*. What it does not cover is what zoom does that a narrow viewport does not —
     * every glyph is four times larger, so text that fitted at 320 px can now be clipped by a fixed-height box or
     * collide with the label beside it.
     *
     * Emulated as `deviceScaleFactor: 4` on a 320 px viewport rather than by a browser zoom command, because
     * Playwright has no zoom API and this is the combination that reproduces the CSS-pixel layout a zoomed user
     * gets.
     *
     * Two assertions, and neither is "does it look right":
     *   - **Nothing is clipped.** A value's `scrollWidth`/`scrollHeight` exceeding its client box means the number
     *     is cut off — the specific failure a `text-3xl` inside a fixed-height tile produces, and the one an
     *     operator reads as a smaller number than it is.
     *   - **Nothing overlaps.** Two metric values whose rectangles intersect are unreadable regardless of what
     *     either says.
     */
    const context = await browser.newContext({
      storageState: admin.storageState!,
      viewport: { width: 320, height: 720 },
      deviceScaleFactor: 4,
    })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      for (const section of ['overview', 'trust', 'runtime']) {
        const variant = section === 'trust' ? 'anomalies' : section === 'runtime' ? 'process' : 'summary'
        await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=${section}&range=24h&variant=${variant}&compare=false`)
        await dismissOverlays(tab)
        await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
        await expect(tab.locator('[data-testid^="metric-value-"]').first()).toBeVisible({ timeout: 20_000 })

        const problems = await tab.evaluate(() => {
          const nodes = [...document.querySelectorAll('[data-testid^="metric-value-"]')]
          const clipped = nodes
            .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)
            .map((node) => `clipped:${node.getAttribute('data-testid')}`)
          const boxes = nodes.map((node) => ({ id: node.getAttribute('data-testid'), rect: node.getBoundingClientRect() }))
          const overlapping: string[] = []
          for (let a = 0; a < boxes.length; a += 1) {
            for (let b = a + 1; b < boxes.length; b += 1) {
              const one = boxes[a]!.rect
              const two = boxes[b]!.rect
              const intersects =
                one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1
              if (intersects) overlapping.push(`overlap:${boxes[a]!.id}+${boxes[b]!.id}`)
            }
          }
          return [...clipped, ...overlapping]
        })
        expect(problems, `${section} at 400% zoom`).toEqual([])
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('lays out the longest label the contract allows, at 320 px and at 400 % zoom', async ({ browser }) => {
    /**
     * The long-label case from the Verify line, and the contract is what makes it a bounded one.
     *
     * `metricValueSchema.key` is `^[a-z][a-z0-9_]{1,62}$` — 63 characters at most, lower_snake_case — and the
     * client displays an unknown key by replacing its underscores with spaces (`labelFor`). So the worst label
     * this page can ever render is 63 characters of prose, which is what this fixture sends. A test that invented
     * a 500-character label would be testing a payload the schema refuses.
     *
     * Intercepted rather than seeded, because no real metric key is anywhere near the limit and the point is the
     * limit. The interception is on a `useEffect` fetch, which is the one `page.route` can hold here — the same
     * note the failing-section case carries.
     */
    const LONGEST_KEY = `a_${'label_'.repeat(10)}end` // 63 chars: 2 + 60 + 3 minus the trailing underscore
    const key = LONGEST_KEY.slice(0, 63).replace(/_$/, 'z')

    const context = await browser.newContext({
      storageState: admin.storageState!,
      viewport: { width: 320, height: 720 },
      deviceScaleFactor: 4,
    })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await tab.route('**/api/admin/metrics/sections?section=operations*', async (route) => {
        const now = new Date('2026-08-11T12:00:00.000Z').toISOString()
        // A day earlier, because `metricWindowSchema` refines `from < to`. The first version of this fixture used
        // `now` for both, the payload failed its own contract, and the section rendered an error state — which the
        // "payload has to have been accepted" assertion below now catches instead of passing silently.
        const dayBefore = new Date('2026-08-10T12:00:00.000Z').toISOString()
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            section: 'operations',
            // Required by `adminMetricSectionResponseSchema`, and omitting it is why the first version of this
            // fixture rendered nothing: the parse threw, the section fell back to an error state, and the two
            // layout assertions below would have passed against an empty section.
            variant: 'workers',
            generatedAt: now,
            payload: {
              status: 'ready',
              generatedAt: now,
              window: { range: '24h', from: dayBefore, to: now, timezone: 'UTC' },
              data: {
                values: [
                  { key, value: 1234567, unit: 'count', scope: 'database', platformTotal: true },
                  { key: `${key.slice(0, 60)}two`, value: 987654, unit: 'count', scope: 'database', platformTotal: true },
                ],
              },
            },
          }),
        })
      })

      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=operations&range=24h&variant=workers&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      /**
       * The payload has to have been accepted, or this case proves nothing.
       *
       * Without it, a fixture the contract rejected would render `unavailable`, the two assertions below would
       * pass against an empty section, and the long label would never have been laid out at all.
       */
      const values = tab.locator('[data-testid^="metric-value-"]')
      await expect(values.first()).toBeVisible({ timeout: 20_000 })
      await expect(values).toHaveCount(2)
      await expect(values.first()).toContainText('label')

      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `a 63-character label overflows the page by ${overflow}px`).toBeLessThanOrEqual(1)

      // And the number itself is not pushed out of its tile by the label above it.
      const clipped = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="metric-value-"]')]
          .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1)
          .map((node) => node.getAttribute('data-testid')),
      )
      expect(clipped, 'clipped by a maximum-length label').toEqual([])
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('respects reduced motion and forced colors', async ({ browser }) => {
    /**
     * WCAG 2.3.3 and 1.4.1's harder half, both emulated rather than asserted from a stylesheet — a `@media` query
     * that exists and does not match anything is the failure mode a source-level check cannot see.
     *
     * **Reduced motion:** no element may report a running animation or a non-zero transition. The page has a
     * refresh timer and a lazy-loading section, so a spinner or a fade left unguarded is the likely offender.
     *
     * **Forced colors:** the assertion is that the numbers are still *there* and still say what they mean. In
     * forced-colors mode the OS replaces every colour, so anything carrying meaning by colour alone becomes
     * indistinguishable — which is why this asserts the same text guarantees as the colour case above rather than
     * comparing pixels.
     */
    const context = await browser.newContext({
      storageState: admin.storageState!,
      reducedMotion: 'reduce',
      forcedColors: 'active',
    })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=runtime&range=24h&variant=process&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })
      const values = tab.locator('[data-testid^="metric-value-"]')
      await expect(values.first()).toBeVisible({ timeout: 20_000 })

      /**
       * No *running animation* on a rendered element.
       *
       * Narrower than it first looks, and the first version was wrong in both directions. It walked every
       * `*` and also flagged a non-zero `transitionDuration`, which reported `html`, `head`, `meta` and `link`
       * as animating: a global `* { transition: … }` rule makes every node in the document declare one, including
       * nodes that have no box and can never change. A declared transition that nothing triggers is not motion.
       *
       * So this asks the checkable question instead — is a keyframe animation actually running on something the
       * user can see — and scopes it to `body` descendants with a layout box.
       */
      const moving = await tab.evaluate(() =>
        [...document.body.querySelectorAll('*')]
          .filter((node) => {
            const rect = node.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return false
            const style = getComputedStyle(node)
            if (style.visibility === 'hidden' || style.display === 'none') return false
            return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0
          })
          .slice(0, 5)
          .map((node) => `${node.tagName.toLowerCase()}.${node.className}`.slice(0, 80)),
      )
      expect(moving, 'animating under prefers-reduced-motion').toEqual([])

      // And the scope is still stated in words, which is what survives an OS colour override.
      const count = await values.count()
      for (let index = 0; index < count; index += 1) {
        await expect(values.nth(index)).toContainText('not a platform total')
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('conveys every threshold and scope in text, not by colour alone', async ({ browser }) => {
    /**
     * WCAG 1.4.1. The specific failure this rules out: a breached tile that is only red, and a per-process
     * counter that is only styled differently from a platform total.
     *
     * A screenshot pasted into an incident channel loses colour semantics entirely, and that is a real path for
     * this page — which is why the assertion is on text content rather than on a class.
     */
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=runtime&range=24h&variant=process&compare=false`)
      await dismissOverlays(tab)
      const values = tab.locator('[data-testid^="metric-value-"]')
      await expect(values.first()).toBeVisible({ timeout: 20_000 })
      // Every process counter states its scope in words beside itself.
      const count = await values.count()
      for (let index = 0; index < count; index += 1) {
        await expect(values.nth(index)).toContainText('not a platform total')
      }

      // And a breach, where one exists, names itself rather than only colouring.
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=operations&range=24h&variant=integrations&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('metric-values')).toBeVisible({ timeout: 20_000 })
      const breached = tab.locator('[data-breach]')
      if ((await breached.count()) > 0) {
        await expect(tab.getByTestId('metric-section-breach')).toContainText('threshold')
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('reaches every section tab by keyboard', async ({ browser }) => {
    // They are links, so this is largely the browser's job — which is the point: the first version of the nav
    // used `<button onClick>`, and a filter that is not a link is not reachable, shareable or restorable.
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=overview&range=24h&variant=summary&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      const trafficTab = tab.getByTestId('admin-metrics-section-traffic')
      await trafficTab.focus()
      await expect(trafficTab).toBeFocused()
      await tab.keyboard.press('Enter')
      await expect(tab.getByTestId('admin-metrics-section-traffic')).toHaveAttribute('data-active', 'true')
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('refuses every persona that is not a platform admin, and the same way each time', async ({ browser }) => {
    /**
     * Plan 57, Admin track — "Add admin scope, audit, and performance release gates". The Verify line names four
     * personas, and the point of testing them together is the *consistency*: an organization admin who gets a
     * different refusal from a plain member has learned that the difference exists.
     *
     * An organization **admin** is the persona most likely to be let through by a guard written as "is this person
     * an admin", because they are one — of an organization, which is a different authority entirely. The tenant
     * owner is the highest tenant privilege and the API and the database both re-check underneath; this asserts the
     * page never renders.
     */
    const orgAdmin = await addMember(harness, 'admin')
    const orgMember = await addMember(harness, 'member')

    for (const [label, principal] of [
      ['organization owner', harness.owner],
      ['organization admin', orgAdmin],
      ['organization member', orgMember],
    ] as const) {
      const context = await browser.newContext({ storageState: principal.storageState! })
      const tab = await context.newPage()
      try {
        await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
        await dismissOverlays(tab)
        await expect(tab.getByTestId('admin-metrics-page'), label).toHaveCount(0)
        // And the API refuses them too, so the page guard is not the only thing standing there.
        const api = await principal.api!.fetch('/api/admin/metrics/sections?section=traffic')
        expect([401, 403], `${label} API`).toContain(api.status())
      } finally {
        await context.close()
      }
    }

    // Signed out: the same refusal, and never a hint that the console exists.
    const anonymous = await browser.newContext()
    const anonymousTab = await anonymous.newPage()
    try {
      await gotoHydrated(anonymousTab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
      await expect(anonymousTab.getByTestId('admin-metrics-page')).toHaveCount(0)
    } finally {
      await anonymous.close()
    }
  })

  test('every control in the console chrome meets the 24 px touch target', async ({ browser }) => {
    /**
     * WCAG 2.5.8 (AA): a target is at least 24 × 24 CSS pixels, or spaced so a 24 px circle centred on it touches
     * nothing else. Nothing in this repository measured touch targets before this case.
     *
     * The console's chrome is where the risk is, and it is not hypothetical: the section tabs are
     * `text-sm px-3 py-1.5`, the range and variant links are `text-xs px-2 py-1`, and a 12 px line box with 4 px of
     * vertical padding is exactly 24 — a single Tailwind step from failing. These are the controls an operator uses
     * one-handed at 02:00, and a target under the minimum is one they hit twice.
     *
     * Measured at the phone width, because that is where the row wraps and where a thumb is the pointer. The
     * assertion reports every offender with its size rather than the first, so one run says what to fix.
     */
    const context = await browser.newContext({ storageState: admin.storageState!, viewport: { width: 390, height: 844 } })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      const small = await tab.evaluate(() => {
        const page = document.querySelector('[data-testid="admin-metrics-page"]')
        if (!page) return ['no page']
        /**
         * Links and buttons inside the page, excluding anything not rendered.
         *
         * Scoped to the metrics page rather than the document so the shell's own navigation — which belongs to a
         * different plan and a different set of tests — is not measured here.
         */
        return [...page.querySelectorAll('a, button, [role="button"]')]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0)
          .filter(({ rect }) => rect.width < 24 || rect.height < 24)
          .map(({ node, rect }) =>
            `${node.getAttribute('data-testid') ?? (node.textContent ?? '').trim().slice(0, 24)}: ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          )
      })
      expect(small, 'controls below the 24px minimum touch target').toEqual([])
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('the same four personas resolve the same way on a phone, and the console is usable there', async ({ browser }) => {
    /**
     * The mobile half of the release gate's Verify line — "authenticated desktop/mobile runtime passes for
     * organization admin, owner, platform admin, and negative personas" (plan 57, Admin track).
     *
     * The case above is the desktop pass. This is not a duplicate of it with a smaller viewport: a mobile runtime
     * pass asks two questions the desktop one cannot.
     *
     * **Does the refusal still happen?** A guard that runs in `beforeLoad` is viewport-independent in principle,
     * and this asserts it in practice — because the thing that differs on a phone is *layout*, and a shell that
     * renders its chrome before the redirect resolves has told a tenant the console exists. `toHaveCount(0)` on the
     * page testid is the same assertion at both sizes for exactly that reason.
     *
     * **Is the console actually usable by the person who is allowed in?** The desktop case never checks that,
     * because it is only about refusals. An admin paged at 02:00 is holding a phone, so the positive pass asserts
     * the three things that make the page worth opening there: a section renders numbers, the section navigation is
     * reachable and switches, and the page does not scroll sideways.
     *
     * 390 × 844 rather than 320: the a11y cases already cover 320 as the narrowest survivable layout, and this one
     * is about the device an operator really has.
     */
    const phone = { width: 390, height: 844 }
    const orgAdmin = await addMember(harness, 'admin')
    const orgMember = await addMember(harness, 'member')

    for (const [label, principal] of [
      ['organization owner', harness.owner],
      ['organization admin', orgAdmin],
      ['organization member', orgMember],
    ] as const) {
      const context = await browser.newContext({ storageState: principal.storageState!, viewport: phone })
      const tab = await context.newPage()
      try {
        await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
        await dismissOverlays(tab)
        await expect(tab.getByTestId('admin-metrics-page'), `${label} on a phone`).toHaveCount(0)
      } finally {
        await context.close()
      }
    }

    // Signed out, on a phone: the same nothing.
    const anonymous = await browser.newContext({ viewport: phone })
    const anonymousTab = await anonymous.newPage()
    try {
      await gotoHydrated(anonymousTab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
      await expect(anonymousTab.getByTestId('admin-metrics-page')).toHaveCount(0)
    } finally {
      await anonymous.close()
    }

    /**
     * And the platform admin gets a working console, which is the half a refusal matrix cannot prove.
     *
     * Under `expectStrictBrowser`, so a layout that only *looks* fine while logging a failed request or a React
     * warning fails here rather than being discovered by whoever is on call.
     */
    const context = await browser.newContext({ storageState: admin.storageState!, viewport: phone })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=overview&range=24h&variant=summary&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      /**
       * The navigation works at this width — a wrapped tab row that overflows its container is unreachable — and it
       * lands on numbers rather than on an empty shell.
       *
       * **`runtime` is the only section guaranteed to have values in this environment**, and getting that wrong cost
       * three attempts here. A section tab opens its *first* variant: `trust`'s is `removals`, which correctly
       * answers `not_enabled` because `PROFILE_REMOVAL_ENABLED` is false, and `operations`' `workers` renders
       * registry rows rather than `metric-value-` tiles. Both are honest behaviours the sections were built to have,
       * and asserting tiles against either was asserting against the design. Runtime's numbers are in-process
       * counters, so there is no window in which it is unavailable — the same reason the unit-and-scope case above
       * uses it.
       */
      await tab.getByTestId('admin-metrics-section-runtime').scrollIntoViewIfNeeded()
      await tab.getByTestId('admin-metrics-section-runtime').click()
      await expect(tab.getByTestId('admin-metrics-section-runtime')).toHaveAttribute('data-active', 'true')
      await expect(tab.locator('[data-testid^="metric-value-"]').first()).toBeVisible({ timeout: 20_000 })

      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `the console overflows a 390px phone by ${overflow}px`).toBeLessThanOrEqual(1)
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  test('a failing section leaves the other seven readable, on the page and not just in the payload', async ({ browser }) => {
    /**
     * "Per-section failures" from the Verify line, asserted where it matters: the monolith could not have this
     * property, because one failed read meant no numbers at all.
     *
     * Driven by intercepting one section's request rather than by breaking a database, because what is under test
     * is the page's isolation and not the query's. The interception is against a `useEffect` fetch — a
     * `page.route` on a TanStack Query endpoint hangs in this repository, which is why this hook uses plain
     * `fetch`.
     */
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    try {
      await tab.route('**/api/admin/metrics/sections?section=traffic*', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Failed"}' }),
      )
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
      await dismissOverlays(tab)

      // The section says it failed, in words, and the page around it still works.
      await expect(tab.getByTestId('metric-section-load-error')).toBeVisible({ timeout: 20_000 })
      await expect(tab.getByTestId('admin-metrics-sections')).toBeVisible()

      // And another section still loads — the failure was confined to the one that asked.
      await tab.getByTestId('admin-metrics-section-runtime').click()
      await expect(tab.getByTestId('metric-values')).toBeVisible({ timeout: 20_000 })
    } finally {
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

  test('the account-anomaly distribution runs against the real table, as the role that reads it', async ({ browser }) => {
    /**
     * The half a unit test cannot cover (plan 57, Admin track — "Build Billing, Abuse, Trust, and User Anomaly
     * admin widgets").
     *
     * The task recorded this as blocked on "a user-anomaly source". One has existed since plan 32 — impossible
     * travel, mid-session user-agent change, concurrent distinct IPs and seat overuse, called from
     * `tenant-principal.ts` on authenticated requests — and every detection writes `abuse_signals`. The note had
     * not been re-checked, and the aggregate was the only thing missing.
     *
     * `abuse_signals` is worker-role-only with no RLS, and the unit tests inject a fake `db`, so this is what
     * proves the `GROUP BY … WHERE type IN (…)` actually executes as the identity that serves the request. Three
     * defects in this repository came from a superuser connection hiding a missing GRANT.
     */
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    const guard = expectStrictBrowser(tab)
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=trust&range=24h&variant=anomalies`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      /**
       * Five values, and the point is that they are *values* rather than an `unavailable` code.
       *
       * A seeded harness has no anomalies in the last 24 hours, so every count is zero — which is exactly the
       * case worth asserting here: zero has to arrive as a read number, not as a section that gave up. The
       * distribution keeps all four types so its shape does not change between windows.
       */
      const values = tab.locator('[data-testid^="metric-value-"]')
      await expect(values.first()).toBeVisible({ timeout: 20_000 })
      await expect(values).toHaveCount(5)

      // And the variant is offered by the section that owns it, so it is reachable without editing the URL.
      await expect(tab.getByTestId('admin-metrics-variant-anomalies')).toHaveAttribute('data-active', 'true')

      /**
       * Nothing about *who*. Structural — the query groups and counts and selects no other column — but asserted
       * on the rendered DOM because that is where a leak would be seen.
       */
      const html = await tab.locator('[data-testid="admin-metrics-page"]').innerHTML()
      for (const forbidden of ['userId', 'organizationId', 'requestId', 'details']) {
        expect(html, forbidden).not.toContain(forbidden)
      }
    } finally {
      guard.dispose()
      await context.close()
    }
  })

  /**
   * The saved landing view (plan 57, Admin track — "Persist isolated platform-admin preferences").
   *
   * The store, its route and its GRANT isolation landed with five e2e cases connecting as the roles themselves.
   * What had no coverage was the half a person touches: nothing called the store from the page, so "reset" and
   * "keyboard reorder" in the Verify line had no surface to exercise.
   *
   * These three run in one test rather than three, and the ordering is the reason: the preference is persistent
   * per-admin state, so a case that saves without resetting changes what every later case in this file sees from a
   * bare URL. One test that saves, asserts, and resets leaves the store as it found it.
   */
  test('a saved landing view is where /admin opens, an explicit URL wins, and reset undoes it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: admin.storageState! })
    const tab = await context.newPage()
    try {
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=reliability&range=7d&variant=summary`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-page')).toBeVisible({ timeout: 20_000 })

      // Keyboard-reachable, which is the Verify line's word for it — not clicked by coordinate.
      const save = tab.getByTestId('admin-metrics-save-landing')
      await expect(save).toBeVisible()
      await save.focus()
      await tab.keyboard.press('Enter')

      /**
       * The button reports the *stored* state, not the click.
       *
       * It re-labels itself from the PUT's response body rather than from what it sent, so this assertion is the
       * one that would fail if the route normalized the value to something else — the "reports success and the
       * next read disagrees" shape this plan keeps finding.
       */
      await expect(save).toHaveText('This is your default view', { timeout: 20_000 })

      // Opening the console — `/admin`, the index that means "open the console" — now lands on the saved view.
      await gotoHydrated(tab, `${harness.baseURL}/admin`)
      await dismissOverlays(tab)
      await expect(tab).toHaveURL(/section=reliability/)
      await expect(tab).toHaveURL(/range=7d/)
      await expect(tab.getByTestId('admin-metrics-section-reliability')).toHaveAttribute('data-active', 'true')

      /**
       * And an explicit URL is *not* overridden — the assertion this pair exists for.
       *
       * A personal default that won over a named section would mean two admins following the same incident link
       * saw different pages while both address bars agreed, which is worse than having no default at all.
       */
      await gotoHydrated(tab, `${harness.baseURL}/admin/metrics?section=traffic&range=24h&variant=rate&compare=false`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-section-traffic')).toHaveAttribute('data-active', 'true')
      await expect(tab).toHaveURL(/section=traffic/)

      /**
       * Reset, and then a bare URL stops redirecting at all.
       *
       * "Reset" is an update back to the defaults rather than a delete — the store has no DELETE grant — so the
       * observable consequence is the absence of a redirect, not the absence of a row.
       */
      await gotoHydrated(tab, `${harness.baseURL}/admin`)
      await dismissOverlays(tab)
      const reset = tab.getByTestId('admin-metrics-reset-landing')
      await expect(reset).toBeVisible({ timeout: 20_000 })
      await reset.focus()
      await tab.keyboard.press('Enter')
      await expect(reset).toHaveCount(0, { timeout: 20_000 })

      await gotoHydrated(tab, `${harness.baseURL}/admin`)
      await dismissOverlays(tab)
      await expect(tab.getByTestId('admin-metrics-section-overview')).toHaveAttribute('data-active', 'true')
      await expect(tab).not.toHaveURL(/section=reliability/)
    } finally {
      await context.close()
    }
  })
})
