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
})
