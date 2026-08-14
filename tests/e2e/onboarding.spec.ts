/**
 * Wave 2 Task 8 — onboarding flows (docs/superpowers/plans/
 * 2026-07-23-exhaustive-local-e2e.md).
 *
 * Covers the /onboarding/welcome → search → save → success journey, the
 * required three saves, duplicate submissions, empty/error/retry states,
 * refresh restoration, skip exhaustion, and the anonymous redirect. Runs
 * against a per-worker disposable database + Redis namespace + app server
 * (Wave 1 harness), with every browser test under the strict collectors.
 *
 * Determinism note: `/api/search/builders` has no E2E provider fake — it
 * federates real external sources (src/lib/search.ts). Its first lookup is
 * the app's own Redis cache (`search:<key>`), so these specs seed that
 * cache with deterministic builders for run-unique query strings. The
 * server then executes its full real pipeline (scoring, tracked-state
 * annotation, embedding write-through) with zero external egress. The
 * only interception is the deliberate 500 in the error-state test, where
 * no product path can produce a deterministic failure.
 *
 * Coverage gaps recorded:
 *   - There is no "completed users are redirected away from /onboarding/*"
 *     behavior in the product — completed users can revisit every step
 *     (asserted below as the actual behavior).
 *
 * Regression coverage: POST /api/onboarding/complete and
 * `advanceOnboarding` (src/shared/lib/onboarding.ts) are aligned on the
 * `builderId` field, so each onboarding save writes an
 * `onboarding_selected_builders` row and `status.firstBuilderIds` is
 * populated — asserted in the full-journey test below.
 */
import { test, expect as baseExpect, type Browser, type BrowserContext, type Page } from 'playwright/test'

// Two vite dev servers compile routes on demand while both workers run —
// data-dependent assertions can legitimately take longer than the 5s
// default under that contention. Still bounded, never a fixed delay.
const expect = baseExpect.configure({ timeout: 15_000 })
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

// Plain Node process — nothing auto-loads `.env` the way vite/vitest do.
loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace, redis } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
/**
 * The onboarding tour's headings read their source count from this constant, so the expectation must
 * too. It said `12` until 2026-08-05 and failed the whole `ci:local` e2e step: `sourcehut` and
 * `hashnode` were retired on 2026-08-04, `welcome.tsx` renders `${SEARCH_SOURCE_COUNT} sources, one
 * search` and moved with them, and this literal did not. Nine product surfaces were converted to the
 * constant in that change and the assertion about them was missed — which is the whole argument for
 * deriving it here rather than writing the new number.
 */
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv } from './harness/clock'
import { uniqueId } from './harness/ids'
import {
  createVerifiedPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import {
  dismissOverlays,
  expectStrictBrowser,
  gotoHydrated,
  waitForHydration,
  type StrictBrowserGuard,
} from './harness/browser'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
}

let harness: Harness
let toreDown = false
const minted: Principal[] = []
const seededCacheKeys: string[] = []

test.describe.configure({ mode: 'serial' })

// Cold on-demand vite compiles of a route tree can exceed the 30s default
// while the sibling worker's server is booting; every test stays bounded.
test.beforeEach(() => {
  test.setTimeout(120_000)
})

test.beforeAll(async () => {
  // Disposable DB + migrations + vite dev server boot — far beyond 30s.
  test.setTimeout(300_000)

  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx: { baseURL: server.baseURL, sql, scope: `w${workerIndex}-onb` },
    }
  } catch (error) {
    // Never leak the worker's server/database/redis on a failed setup.
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  if (toreDown) return
  toreDown = true
  const h = harness
  if (!h) return
  for (const principal of minted) {
    await disposePrincipal(principal).catch(() => undefined)
  }
  // The app's search cache is deliberately unprefixed (src/lib/search.ts) —
  // clean our seeded keys explicitly since the namespace drop can't see them.
  if (seededCacheKeys.length > 0) {
    const client = await redis.client(h.redisPrefix)
    try {
      await client.del(...seededCacheKeys)
    } finally {
      await client.quit()
    }
  }
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

/* ────────────────────────────── helpers ────────────────────────────── */

interface StrictPage {
  context: BrowserContext
  page: Page
  guard: StrictBrowserGuard
  /** URLs of Chrome's own "Failed to load resource" console errors, in order. */
  resourceErrorUrls: string[]
}

async function openStrictPage(browser: Browser, principal?: Principal): Promise<StrictPage> {
  const context = await browser.newContext(
    principal?.storageState ? { storageState: principal.storageState } : {},
  )
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  // The guard records Chrome's auto-generated "Failed to load resource"
  // console lines, but their text carries no URL — capture the URL from the
  // same events (listeners fire in registration order, so both arrays stay
  // aligned for resource-error lines) so assertStrictClean can distinguish
  // intentional rejections from real breakage.
  const resourceErrorUrls: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().startsWith('Failed to load resource')) {
      resourceErrorUrls.push(msg.location().url)
    }
  })
  return { context, page, guard, resourceErrorUrls }
}

async function closeStrictPage(sp: StrictPage): Promise<void> {
  sp.guard.dispose()
  await sp.context.close()
}

/**
 * Strict-clean assertion with a URL-scoped allowance for Chrome's own
 * "Failed to load resource" console lines on requests the product
 * intentionally lets fail — the DashboardLayout probes /api/admin/incidents
 * to decide admin visibility and every non-admin gets a handled 403, which
 * Chrome still logs as a console error. Anything else stays a violation,
 * including resource errors on URLs not explicitly allowed.
 */
const ADMIN_PROBE_URL = /\/api\/admin\/incidents/
function assertStrictClean(sp: StrictPage, allowedResourceUrls: RegExp[] = []): void {
  const allowed = [ADMIN_PROBE_URL, ...allowedResourceUrls]
  const urls = [...sp.resourceErrorUrls]
  const unexpected: string[] = []
  for (const violation of sp.guard.violations) {
    if (violation.startsWith('console.error: Failed to load resource')) {
      const url = urls.shift() ?? '<unknown resource>'
      if (allowed.some((pattern) => pattern.test(url))) continue
      unexpected.push(`${violation} [${url}]`)
    } else {
      unexpected.push(violation)
    }
  }
  expect(unexpected, 'strict browser collectors recorded unexpected violations').toEqual([])
}

async function go(page: Page, path: string): Promise<void> {
  await gotoHydrated(page, `${harness.baseURL}${path}`)
}

async function mintVerified(label: string): Promise<Principal> {
  const principal = await createVerifiedPrincipal(harness.ctx, label)
  minted.push(principal)
  return principal
}

interface OnboardingStatusDto {
  step: number
  completed: boolean
  skipped: boolean
  skippedCount: number
  eligible: boolean
  firstBuilderIds: string[]
}

async function onboardingStatus(principal: Principal): Promise<OnboardingStatusDto> {
  const response = await principal.api!.get('/api/onboarding/status')
  expect(response.ok(), 'GET /api/onboarding/status').toBe(true)
  return response.json() as Promise<OnboardingStatusDto>
}

interface SeedBuilder {
  id: string
  kind: 'person'
  source: 'github'
  sourceId: string
  username: string
  displayName: string
  bio: string
  profileUrl: string
  followersCount: number
  topics: string[]
  metadata: Record<string, unknown>
}

function makeSeedBuilders(label: string, count: number): SeedBuilder[] {
  const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return Array.from({ length: count }, (_, i) => {
    const username = `${safe}-builder-${i}`
    return {
      id: `github:${username}`,
      kind: 'person' as const,
      source: 'github' as const,
      sourceId: username,
      username,
      displayName: `Seeded Builder ${i} ${safe}`,
      bio: `Deterministic E2E search result ${i} for ${safe}.`,
      // Must satisfy src/shared/lib/security/url-policy.ts for the declared
      // source, or POST /api/builders/track rejects the save.
      profileUrl: `https://github.com/${username}`,
      followersCount: 100 + i,
      topics: [],
      metadata: {},
    }
  })
}

/**
 * Mirrors `cacheKey` in src/lib/search.ts for the exact options each caller
 * passes: keywords are the query split on /[,\s]+/ and sorted; the
 * onboarding save step sends no sources/country/language and perPage 12.
 */
function searchCacheKey(query: string, perPage: number, sources: string[] = []): string {
  const keywords = query.split(/[,\s]+/).filter(Boolean).sort().join(',')
  const sourcesPart = [...sources].sort().join(',')
  return `search:${[keywords, sourcesPart, '', '', '1', String(perPage)].join('-')}`
}

async function seedSearchCache(key: string, builders: SeedBuilder[]): Promise<void> {
  const client = await redis.client(harness.redisPrefix)
  try {
    // Self-expiring so a crashed run can never leave stale global keys.
    await client.set(key, JSON.stringify(builders), 'EX', 900)
    seededCacheKeys.push(key)
  } finally {
    await client.quit()
  }
}

async function trackedBuilderCount(organizationId: string): Promise<number> {
  const rows = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from organization_builders
    where organization_id = ${organizationId}
  `
  return rows[0].count
}

/* ─────────────────────────────── tests ─────────────────────────────── */

test('anonymous visitors are redirected to sign-in from every onboarding step', async ({ browser }) => {
  const sp = await openStrictPage(browser)
  try {
    const steps = [
      { path: '/onboarding/welcome', redirect: '/onboarding/welcome' },
      { path: '/onboarding/search', redirect: '/onboarding/search' },
      // The save step's beforeLoad hardcodes its redirect target without q.
      { path: '/onboarding/save?q=anything', redirect: '/onboarding/save' },
      { path: '/onboarding/success', redirect: '/onboarding/success' },
    ]
    for (const step of steps) {
      await go(sp.page, step.path)
      const url = new URL(sp.page.url())
      expect(url.pathname, `${step.path} must land on sign-in`).toBe('/auth/sign-in')
      expect(url.searchParams.get('redirect'), `${step.path} return target`).toBe(step.redirect)
    }
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('full onboarding journey: welcome → starter query → three saves → success → dashboard', async ({ browser }) => {
  test.setTimeout(120_000)
  const journey = await mintVerified('journey')

  // The starter chip used below runs the fixed product query — seed its
  // exact cache key (save step posts { keywords: q, perPage: 12 }).
  const starterQuery = 'rust async runtime'
  const builders = makeSeedBuilders('journey', 5)
  await seedSearchCache(searchCacheKey(starterQuery, 12), builders)

  const sp = await openStrictPage(browser, journey)
  const { page, guard } = sp
  try {
    // Welcome: records step 1 the moment it mounts.
    const step1Done = page.waitForResponse(
      (r) => r.url().includes('/api/onboarding/complete') && r.ok(),
    )
    await go(page, '/onboarding/welcome')
    await dismissOverlays(page)
    await step1Done
    await expect(page.getByRole('heading', { name: 'Welcome to BuilderHunt' })).toBeVisible()
    await expect(page.getByRole('heading', { name: `${SEARCH_SOURCE_COUNT} sources, one search` })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Save a search, get daily picks' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Claim your profile' })).toBeVisible()
    expect((await onboardingStatus(journey)).step).toBe(1)

    // Start the tour → search step records step 2.
    const step2Done = page.waitForResponse(
      (r) => r.url().includes('/api/onboarding/complete') && r.ok(),
    )
    await page.getByTestId('onboarding-start').click()

    /**
     * v2 inserts the goal step between welcome and search (plan phase-2/03). This journey is about
     * the v1 flow, so it answers the question and moves on rather than asserting on it —
     * `goal.spec` owns the goal step's own behaviour. "I would rather not say" is used because it
     * is the path that must work with the segmentation feature in either position: it writes
     * nothing, so it cannot depend on the flag.
     */
    await page.waitForURL(/\/onboarding\/goal/)
    await page.getByRole('button', { name: /rather not say/i }).click()

    await page.waitForURL(/\/onboarding\/search/)
    await step2Done
    await expect(page.getByRole('heading', { name: 'What are you looking for?' })).toBeVisible()
    await expect(page.getByText('Step 2 of 3')).toBeVisible()
    await expect(page.getByTestId('onboarding-starter-query')).toHaveCount(5)
    expect((await onboardingStatus(journey)).step).toBe(2)

    // Starter chip → save step carries the query in the URL.
    await page
      .locator(`[data-testid="onboarding-starter-query"][data-query="${starterQuery}"]`)
      .click()
    await page.waitForURL(/\/onboarding\/save/)
    expect(new URL(page.url()).searchParams.get('q')).toBe(starterQuery)

    // Deterministic results from the seeded cache — real server pipeline.
    await expect(page.getByTestId('onboarding-builder-card')).toHaveCount(5)
    await expect(page.getByText('Step 3 of 3')).toBeVisible()
    const finish = page.getByTestId('onboarding-finish')
    await expect(finish).toBeDisabled()
    await expect(page.getByText('0 of 3 builders saved')).toBeVisible()

    // Three saves are required; a saved card cannot be re-submitted.
    for (let i = 0; i < 3; i++) {
      const saveButton = page.getByTestId('onboarding-save-btn').nth(i)
      await saveButton.click()
      await expect(saveButton).toHaveText(/Saved/)
      await expect(saveButton).toBeDisabled()
      await expect(page.getByText(`${i + 1} of 3 builders saved`)).toBeVisible()
      if (i < 2) await expect(finish).toBeDisabled()
    }
    await expect(finish).toBeEnabled()

    await finish.click()
    await page.waitForURL(/\/onboarding\/success/)
    await expect(page.getByTestId('onboarding-success')).toBeVisible()
    await expect(page.getByText('Your radar is live!')).toBeVisible()

    // Server-side truth: completed + ineligible, the search was saved, and
    // exactly the three builders were tracked in the personal workspace.
    const status = await onboardingStatus(journey)
    expect(status.completed).toBe(true)
    expect(status.eligible).toBe(false)
    const queriesResponse = await journey.api!.get('/api/queries')
    expect(queriesResponse.ok()).toBe(true)
    const queries = (await queriesResponse.json()) as Array<{ name: string }>
    expect(queries.some((q) => q.name === starterQuery)).toBe(true)
    expect(await trackedBuilderCount(journey.organizationId!)).toBe(3)

    // Regression: the route's `builderId` field reaches advanceOnboarding
    // (they were mismatched once — builderId vs addBuilderId — leaving
    // firstBuilderIds empty forever), so the three onboarding saves are
    // recorded in onboarding_selected_builders and surface in the status.
    expect(status.firstBuilderIds).toHaveLength(3)
    const seededIds = new Set(builders.map((b) => b.id))
    for (const ref of status.firstBuilderIds) {
      expect(seededIds.has(ref), `firstBuilderIds entry ${ref} must be a seeded builder`).toBe(true)
    }

    // Success → dashboard, where the onboarding banner no longer renders
    // for a completed user (its own status fetch resolves first).
    const bannerStatusSeen = page.waitForResponse((r) => r.url().includes('/api/onboarding/status'))
    await page.getByTestId('onboarding-go-dashboard').click()
    await page.waitForURL(/\/dashboard/)
    await bannerStatusSeen
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(page.getByTestId('onboarding-banner')).toHaveCount(0)

    // Recorded gap: the product has no completed-user redirect — every
    // onboarding step remains reachable after completion.
    await go(page, '/onboarding/welcome')
    expect(new URL(page.url()).pathname).toBe('/onboarding/welcome')
    await expect(page.getByRole('heading', { name: 'Welcome to BuilderHunt' })).toBeVisible()

    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('typed query, refresh restoration, and duplicate submissions collapsing to one row', async ({ browser }) => {
  test.setTimeout(120_000)
  const principal = await mintVerified('typed')
  const query = uniqueId('typedq', 'onb')
  await seedSearchCache(searchCacheKey(query, 12), makeSeedBuilders('typed', 3))

  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    await go(page, '/onboarding/search')
    await dismissOverlays(page)

    // Whitespace-only input never enables the search submit.
    const input = page.getByTestId('onboarding-query-input')
    const submit = page.getByTestId('onboarding-search')
    await input.fill('   ')
    await expect(submit).toBeDisabled()

    await input.fill(query)
    await expect(submit).toBeEnabled()
    await submit.click()
    await page.waitForURL(/\/onboarding\/save/)
    expect(new URL(page.url()).searchParams.get('q')).toBe(query)
    await expect(page.getByTestId('onboarding-builder-card')).toHaveCount(3)

    const firstSave = page.getByTestId('onboarding-save-btn').nth(0)
    await firstSave.click()
    await expect(firstSave).toHaveText(/Saved/)
    await expect(page.getByText('1 of 3 builders saved')).toBeVisible()
    expect(await trackedBuilderCount(principal.organizationId!)).toBe(1)

    // Refresh restoration: the step is rebuilt from the URL's q — results
    // come back, but the saved counter is client state and resets to zero
    // (actual product behavior; the tracked row itself persisted).
    await page.reload()
    await waitForHydration(page)
    expect(new URL(page.url()).searchParams.get('q')).toBe(query)
    await expect(page.getByTestId('onboarding-builder-card')).toHaveCount(3)
    await expect(page.getByText('0 of 3 builders saved')).toBeVisible()

    // Re-saving the same builder after the refresh is a duplicate
    // submission — the server collapses it onto the existing row.
    const firstSaveAgain = page.getByTestId('onboarding-save-btn').nth(0)
    await firstSaveAgain.click()
    await expect(firstSaveAgain).toHaveText(/Saved/)
    expect(await trackedBuilderCount(principal.organizationId!)).toBe(1)
    // The duplicate also collapses in onboarding_selected_builders (unique
    // on user + builderRef), so the status still reports one selection.
    expect((await onboardingStatus(principal)).firstBuilderIds).toHaveLength(1)

    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('empty results offer a path back to a different query', async ({ browser }) => {
  const principal = await mintVerified('empty-results')
  const query = uniqueId('emptyq', 'onb')
  await seedSearchCache(searchCacheKey(query, 12), [])

  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    await go(page, `/onboarding/save?q=${encodeURIComponent(query)}`)
    await dismissOverlays(page)
    await expect(page.getByText(`No results for "${query}"`)).toBeVisible()
    await page.getByRole('link', { name: 'Try a different query' }).click()
    await page.waitForURL(/\/onboarding\/search/)
    await expect(page.getByRole('heading', { name: 'What are you looking for?' })).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('search failure shows the error state and recovers via a new query', async ({ browser }) => {
  const principal = await mintVerified('error-retry')
  const query = uniqueId('errq', 'onb')

  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    // No product path produces a deterministic search failure locally —
    // fulfill our own endpoint with a 500 for exactly this scenario.
    await page.route('**/api/search/builders', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Search failed' }),
      }),
    )
    await go(page, `/onboarding/save?q=${encodeURIComponent(query)}`)
    await dismissOverlays(page)
    await expect(page.getByRole('alert')).toContainText('Search failed')

    // Retry path: back to the search step, run a (now healthy) query.
    await page.unroute('**/api/search/builders')
    await seedSearchCache(searchCacheKey(query, 12), makeSeedBuilders('retry', 2))
    await page.getByRole('link', { name: 'Try a different query' }).click()
    await page.waitForURL(/\/onboarding\/search/)
    await page.getByTestId('onboarding-query-input').fill(query)
    await page.getByTestId('onboarding-search').click()
    await page.waitForURL(/\/onboarding\/save/)
    await expect(page.getByTestId('onboarding-builder-card')).toHaveCount(2)
    assertStrictClean(sp, [/\/api\/search\/builders/])
  } finally {
    await closeStrictPage(sp)
  }
})

test('skipping records each skip and the third skip ends eligibility', async ({ browser }) => {
  test.setTimeout(120_000)
  const principal = await mintVerified('skipper')

  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    // Skip #1 from the welcome step.
    await go(page, '/onboarding/welcome')
    await dismissOverlays(page)
    await page.getByTestId('onboarding-skip').click()
    await page.waitForURL(/\/dashboard/)
    let status = await onboardingStatus(principal)
    expect(status.skipped).toBe(true)
    expect(status.skippedCount).toBe(1)
    expect(status.eligible).toBe(true)
    // Still eligible → the dashboard banner keeps offering the tour.
    await expect(page.getByTestId('onboarding-banner')).toBeVisible()

    // Skip #2 from the search step.
    await go(page, '/onboarding/search')
    await page.getByTestId('onboarding-skip-2').click()
    await page.waitForURL(/\/dashboard/)
    status = await onboardingStatus(principal)
    expect(status.skippedCount).toBe(2)
    expect(status.eligible).toBe(true)

    // Skip #3 from the dashboard banner itself — eligibility ends.
    const banner = page.getByTestId('onboarding-banner')
    await expect(banner).toBeVisible()
    const skipDone = page.waitForResponse((r) => r.url().includes('/api/onboarding/skip'))
    await page.getByTestId('onboarding-banner-skip').click()
    await skipDone
    await expect(banner).toHaveCount(0)
    status = await onboardingStatus(principal)
    expect(status.skippedCount).toBe(3)
    expect(status.eligible).toBe(false)

    // The banner stays gone on a fresh document too.
    await go(page, '/dashboard')
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(page.getByTestId('onboarding-banner')).toHaveCount(0)

    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})
