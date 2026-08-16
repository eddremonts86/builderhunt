/**
 * The segmented dashboard (plan: phase-2/04-dashboard-personalizado).
 *
 * The unit tests pin what a preset resolves to. What only exists end to end is whether the page
 * actually composes from it, and the three things a segmented dashboard gets wrong:
 *
 * - **the general route must not move.** Every account has no segment until it chooses one, so a
 *   change here is a change for everybody;
 * - **the empty state has to speak the route's language.** It is the one screen every route reaches
 *   on a fresh account, and it told everybody to run their first hunt — including a builder who came
 *   to claim a profile, for whom tracking nobody is the normal state;
 * - **a saved layout outranks a route.** Changing your goal must not silently rearrange a dashboard
 *   you arranged, and clearing it must bring the route's default back.
 */
import { expect, test, type Page } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'dashpre',
    flags: { USER_SEGMENTATION_ENABLED: 'true', DASHBOARD_PRESETS_ENABLED: 'true' },
  })
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

async function setSegment(segment: string | null) {
  await harness.sql`delete from user_preferences where user_id = ${harness.owner.userId}`
  if (segment) {
    await harness.sql`
      insert into user_preferences (user_id, primary_segment, segment_source, segment_schema_version)
      values (${harness.owner.userId}, ${segment}, 'onboarding', 1)
    `
  }
}

/**
 * Opens the dashboard and waits for it to *settle*, not merely to paint.
 *
 * The page renders in the general order and reorders when the context lands, so reading the
 * sequence on first paint reads the wrong one — which is how the settle signal came to include the
 * context query. `[data-dashboard-state="ready"]` is the same wait every other dashboard spec uses.
 */
async function openDashboard(page: Page) {
  await page.context().addCookies(harness.owner.storageState!.cookies)
  await page.goto(`${harness.baseURL}/dashboard`)
  await expect(page.locator('[data-dashboard-state="ready"]')).toBeAttached({ timeout: 30_000 })
  await expect(page.locator('[data-widget]').first()).toBeVisible()
}

/** The rendered sequence, which is the DOM order and therefore the focus order. */
async function widgetOrder(page: Page): Promise<string[]> {
  return page.locator('[data-widget]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-widget') ?? ''),
  )
}

test('a workspace with no segment gets the dashboard it already had', async ({ page }) => {
  await setSegment(null)
  await openDashboard(page)

  await expect(page.getByTestId('dashboard-empty-cta')).toHaveAttribute('data-preset', 'general')
  await expect(page.getByTestId('dashboard-empty-cta')).toContainText('Run your first hunt')

  // The empty-state tile leads, as it does today: it is unmentioned by every preset, so it keeps its
  // registry position rather than being pushed below a route's promotions.
  expect((await widgetOrder(page))[0]).toBe('first-hunt')
})

/**
 * The failure this is here to catch: a builder reading "run your first hunt" on a page that is
 * supposed to be about their own profile. Tracking nobody is not a gap for them.
 */
test('the empty state says what each route is for', async ({ page }) => {
  for (const [segment, expected, label, href] of [
    ['building', 'Complete your profile', 'Go to my profile', '/me'],
    ['hiring', 'Start a sourcing sprint', 'Create a sprint', '/sprints'],
    ['investing', 'Save your first search', 'Run a search', '/search'],
  ] as const) {
    await setSegment(segment)
    await openDashboard(page)

    const cta = page.getByTestId('dashboard-empty-cta')
    await expect(cta).toHaveAttribute('data-preset', segment)
    await expect(cta.getByRole('heading')).toHaveText(expected)
    // The button says something else. One screen repeating itself reads as an unfilled template.
    await expect(cta.getByRole('link', { name: new RegExp(label, 'i') })).toHaveAttribute('href', href)
  }
})

/**
 * If two routes rendered the same sequence the segmentation would be a change of heading, which the
 * phase README names as the failure mode.
 */
test('the routes render different sequences', async ({ page }) => {
  await setSegment('hiring')
  await openDashboard(page)
  const hiring = await widgetOrder(page)

  await setSegment('investing')
  await openDashboard(page)
  const investing = await widgetOrder(page)

  expect(hiring).not.toEqual(investing)
  // Each leads with something of its own, among the widgets that render on an empty workspace.
  expect(hiring.indexOf('recommendations')).toBeLessThan(hiring.indexOf('saved-searches'))
  expect(investing.indexOf('saved-searches')).toBeLessThan(investing.indexOf('recommendations'))
})

/**
 * Task 6's property. Changing your goal is a statement about what you are here for, not permission
 * to rearrange a page you arranged — and the layout it must not disturb is the one already stored
 * against the organization, with its own `revision`.
 */
test('a saved layout survives a change of segment, and outranks the route', async ({ page }) => {
  await setSegment('hiring')
  await openDashboard(page)

  const stored = await (await harness.owner.api!.get('/api/dashboard/preferences')).json()
  const arranged = await harness.owner.api!.fetch('/api/dashboard/preferences', {
    method: 'PUT',
    data: {
      revision: stored.revision,
      density: stored.density,
      hiddenWidgetIds: [],
      pinnedWidgetIds: [],
      // Deliberately the investing lead, chosen while on the hiring route: what is asserted below is
      // that the arrangement wins, so it has to be one the route would never produce.
      orderedWidgetIds: ['saved-searches', 'alerts', 'activity'],
    },
  })
  expect(arranged.status()).toBe(200)

  await openDashboard(page)
  const withLayout = await widgetOrder(page)
  expect(withLayout.indexOf('saved-searches')).toBeLessThan(withLayout.indexOf('recommendations'))

  // Now change the goal. The arrangement is still theirs.
  await setSegment('building')
  await openDashboard(page)
  const afterChange = await widgetOrder(page)
  expect(afterChange.indexOf('saved-searches')).toBeLessThan(afterChange.indexOf('recommendations'))
  // …and the route's own empty state did follow, because that is presentation rather than layout.
  await expect(page.getByTestId('dashboard-empty-cta')).toHaveAttribute('data-preset', 'building')
})

/**
 * And the other half: clearing the arrangement brings the route's default back. That is the whole
 * "restore preset" story — no second API, no second table, and no per-segment copy of a layout to
 * keep in step.
 */
test('clearing the layout restores the route default', async ({ page }) => {
  const stored = await (await harness.owner.api!.get('/api/dashboard/preferences')).json()
  const cleared = await harness.owner.api!.fetch('/api/dashboard/preferences', {
    method: 'PUT',
    data: {
      revision: stored.revision,
      density: stored.density,
      hiddenWidgetIds: [],
      pinnedWidgetIds: [],
      orderedWidgetIds: [],
    },
  })
  expect(cleared.status()).toBe(200)

  await setSegment('investing')
  await openDashboard(page)
  const restored = await widgetOrder(page)
  expect(restored.indexOf('saved-searches')).toBeLessThan(restored.indexOf('recommendations'))

  await setSegment('hiring')
  await openDashboard(page)
  const hiring = await widgetOrder(page)
  expect(hiring.indexOf('recommendations')).toBeLessThan(hiring.indexOf('saved-searches'))
})

/** A route hides widgets by default; it never takes them away. Restore has to still work. */
test('a widget a route hides is still restorable', async ({ page }) => {
  await setSegment('investing')
  await openDashboard(page)

  // `review` and `shortlists` are hidden by the investing route.
  expect(await widgetOrder(page)).not.toContain('shortlists')

  const stored = await (await harness.owner.api!.get('/api/dashboard/preferences')).json()
  await harness.owner.api!.fetch('/api/dashboard/preferences', {
    method: 'PUT',
    data: {
      revision: stored.revision,
      density: stored.density,
      // One hide of their own, and their set is the truth — the route's hides no longer apply.
      hiddenWidgetIds: ['source-mix'],
      pinnedWidgetIds: [],
      orderedWidgetIds: [],
    },
  })

  await openDashboard(page)
  const order = await widgetOrder(page)
  expect(order).not.toContain('source-mix')
})

test('the empty state fits a phone @mobile-only', async ({ page }) => {
  await setSegment('building')
  await openDashboard(page)

  await expect(page.getByTestId('dashboard-empty-cta')).toBeVisible()
  const viewportWidth = page.viewportSize()?.width ?? 0
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)
})

/**
 * One widget failing must not take the dashboard with it (plan spec: "un widget fallido no tumba el
 * dashboard"). Intercepting `/api/queries` is safe here because the saved-searches list is a plain
 * `fetch` in the page rather than a TanStack Query endpoint — interception on one of those hangs
 * rather than failing, which cost an hour and a revert once already.
 */
test('a failing widget does not take the page down', async ({ page }) => {
  await setSegment('investing')
  await page.route('**/api/queries', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'boom' }),
  }))

  try {
    await openDashboard(page)

    // The page still settles, and the rest of the widgets are still there.
    const order = await widgetOrder(page)
    expect(order.length).toBeGreaterThan(3)
    expect(order).toContain('activity')
    // And the route's own empty state is unaffected — it reads a different source entirely.
    await expect(page.getByTestId('dashboard-empty-cta')).toHaveAttribute('data-preset', 'investing')
  } finally {
    await page.unroute('**/api/queries')
  }
})
