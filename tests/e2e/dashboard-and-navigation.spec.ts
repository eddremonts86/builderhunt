/**
 * Wave 2 Task 8 — dashboard and navigation (docs/superpowers/plans/
 * 2026-07-23-exhaustive-local-e2e.md).
 *
 * Covers the dashboard's empty/loading/error/non-empty states, stats,
 * saved searches, recent builders, the recommendations entry, onboarding/
 * ToS surfaces, main navigation, the account menu (tenant vs platform
 * admin), organization switching, stale-org recovery, back/forward, deep
 * links, sign-out, and two-context tenant isolation. Runs against a
 * per-worker disposable database + Redis namespace + app server (Wave 1
 * harness); every browser test runs under the strict collectors.
 *
 * Determinism note: the dashboard's "For you" recommendations re-run the
 * organization's saved queries through the real federated search pipeline
 * (src/routes/api/recommendations/index.ts → src/lib/search.ts). Search's
 * first lookup is the app's own Redis cache, so these specs seed that
 * cache for run-unique keywords — the server executes its full real
 * pipeline with zero external egress. Route interception appears only in
 * the loading-gate and forced-500 tests, where no product path can
 * produce those states deterministically.
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
import { seedFeaturedSearchCache } from './harness/fixtures/search-cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { uniqueId } from './harness/ids'
import {
  createMemberPrincipal,
  createOwnerPrincipal,
  createVerifiedPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from './harness/fixtures/platform-admin'
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
  owner: Principal
  sharedOrganization: OrganizationFixture
  platformAdmin: Principal
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

  // Platform admin is env-allow-listed (`ADMIN_USER_IDS`) — the id must be
  // reserved and registered BEFORE the app server process is spawned.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}-dash`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}-dash` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization: sharedOrganization } = await createOwnerPrincipal(ctx, {
      tier: 'team',
      seatLimit: 5,
      clock,
    })
    const platformAdmin = await createPlatformAdminPrincipal(ctx, adminSeed)
    minted.push(owner, platformAdmin)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      owner,
      sharedOrganization,
      platformAdmin,
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
 * Mirrors `cacheKey` in src/lib/search.ts. The recommendations worker calls
 * searchBuilders({ keywords, sources: sourcesUnion, perPage: 20 }) with
 * page/country/language unset.
 */
function searchCacheKey(keywords: string[], perPage: number, sources: string[] = []): string {
  const keywordsPart = [...keywords].sort().join(',')
  const sourcesPart = [...sources].sort().join(',')
  return `search:${[keywordsPart, sourcesPart, '', '', '1', String(perPage)].join('-')}`
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

/**
 * Metric tiles are bento widgets, addressed by their registry id rather than by
 * a CSS class. (This helper used to filter `.glass-panel`, which only ever
 * matched the floating dropdown panels — the stat tiles have always rendered
 * `.card` — so it could not have matched anything.)
 */
function statCard(page: Page, label: string) {
  return page.locator('[data-widget^="stat-"]').filter({ hasText: label }).first()
}

/**
 * Level 1 of the dashboard shell: the area rail. Clicking an area navigates to
 * that area's first destination.
 */
function areaLink(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name, exact: true })
}

/** Level 2: the destinations inside whichever area is currently open. */
function sectionLink(page: Page, name: string) {
  return page.locator('nav[aria-label^="Sections of"]').getByRole('link', { name, exact: true })
}

/** Run-unique fixtures for the owner's non-empty dashboard, seeded once. */
const ownerQueryName = uniqueId('ownerq', 'dash')
const ownerTracked = makeSeedBuilders(`trk-${Date.now().toString(36)}`, 2)
const ownerRecommended = makeSeedBuilders(`rec-${Date.now().toString(36)}`, 3)
let ownerSeeded = false

async function seedOwnerDashboard(): Promise<void> {
  if (ownerSeeded) return
  const { owner } = harness
  const createQuery = await owner.api!.post('/api/queries', {
    data: { name: ownerQueryName, keywords: [ownerQueryName], sources: ['github'] },
  })
  expect(createQuery.ok(), 'POST /api/queries').toBe(true)
  for (const builder of ownerTracked) {
    const { id: _id, kind: _kind, ...payload } = builder
    const tracked = await owner.api!.post('/api/builders/track', { data: payload })
    expect(tracked.ok(), `track ${builder.username}`).toBe(true)
  }
  // Recommendations re-run the saved query through the real search
  // pipeline — seed its exact cache key with candidates that are NOT
  // tracked (tracked ones are excluded by the API).
  await seedSearchCache(searchCacheKey([ownerQueryName], 20, ['github']), ownerRecommended)
  // `/search` searches on mount; unseeded that runs live and renders third-party avatars. See the
  // helper for the full account of why this made an unrelated navigation test fail.
  await seedFeaturedSearchCache(harness.redisPrefix)
  ownerSeeded = true
}


/* ─────────────────────────────── tests ─────────────────────────────── */

test('the ToS modal blocks a fresh signed-in session until accepted, then stays accepted', async ({ browser }) => {
  const principal = await mintVerified('tos')
  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    const modal = page.getByTestId('tos-modal')
    await expect(modal).toBeVisible()
    await page.getByTestId('tos-modal-accept').click()
    await expect(modal).toHaveCount(0)
    // Cookie banner is the other first-visit overlay — decline non-essential.
    await page.getByTestId('cookie-banner-essential').click()

    // Acceptance is a server-side consent row, not client state.
    await page.reload()
    await waitForHydration(page)
    await expect(page.getByTestId('tos-modal')).toHaveCount(0)
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('an empty workspace shows zeroed stats, empty panels, and the onboarding banner entry', async ({ browser }) => {
  const principal = await mintVerified('empty-dash')
  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(statCard(page, 'Builders tracked').locator('.text-3xl')).toHaveText('0')
    await expect(statCard(page, 'Saved searches').locator('.text-3xl')).toHaveText('0')

    // Empty-state guidance in every panel.
    await expect(page.getByText('Run your first hunt')).toBeVisible()
    await expect(page.getByText('No saved searches yet')).toBeVisible()
    await expect(page.getByText('No builders tracked yet')).toBeVisible()
    await expect(page.getByText('No tracked builders have shipped in the last 7 days yet.')).toBeVisible()

    // Recommendations: the no-saved-searches entry state with starter chips.
    await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible()
    await expect(page.getByText('Save a search to start getting daily picks.')).toBeVisible()

    // The onboarding banner is the tour entry for an eligible fresh user.
    const banner = page.getByTestId('onboarding-banner')
    await expect(banner).toBeVisible()
    await page.getByTestId('onboarding-banner-cta').click()
    await page.waitForURL(/\/onboarding\/welcome/)
    await expect(page.getByRole('heading', { name: 'Welcome to BuilderHunt' })).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('the dashboard shows its loading skeleton while stats are in flight', async ({ browser }) => {
  const principal = await mintVerified('loading-dash')
  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    // Hold the real stats response at the network layer (continue, never
    // mock) so the loading branch is observable instead of a race.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/dashboard/stats', async (route) => {
      await gate
      await route.continue()
    })

    await go(page, '/dashboard')
    await expect(page.locator('.animate-pulse').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0)

    release()
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(page.locator('.animate-pulse')).toHaveCount(0)
    await page.unroute('**/api/dashboard/stats')
    await dismissOverlays(page)
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('a stats failure degrades to the partial-data notice instead of a blank page', async ({ browser }) => {
  const principal = await mintVerified('error-dash')
  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    // No product path produces a deterministic stats failure locally —
    // fulfill our own endpoint with a 500 for exactly this scenario.
    await page.route('**/api/dashboard/stats', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to fetch stats' }),
      }),
    )
    // The page logs the load failure — expected exactly once here.
    guard.allowExpectedFailure(/Dashboard load error/)

    await go(page, '/dashboard')
    await dismissOverlays(page)
    await expect(page.getByText('Heads up:')).toBeVisible()
    await expect(page.getByText(/Some data may be missing/)).toBeVisible()
    await page.unroute('**/api/dashboard/stats')
    assertStrictClean(sp, [/\/api\/dashboard\/stats/])
  } finally {
    await closeStrictPage(sp)
  }
})

test('a working workspace shows stats, saved searches, recent builders, and recommendations', async ({ browser }) => {
  test.setTimeout(120_000)
  await seedOwnerDashboard()
  const sp = await openStrictPage(browser, harness.owner)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)

    // Stats derived from the seeded rows.
    await expect(statCard(page, 'Builders tracked').locator('.text-3xl')).toHaveText('2')
    await expect(statCard(page, 'Saved searches').locator('.text-3xl')).toHaveText('1')

    // Saved searches panel lists the query with its re-run action.
    await expect(page.getByText(ownerQueryName).first()).toBeVisible()
    const runLink = page.locator('a[title="Re-run this search"]').first()
    await expect(runLink).toHaveAttribute('href', new RegExp(`/search\\?q=${ownerQueryName}`))

    // Recent builders panel lists both tracked builders.
    for (const builder of ownerTracked) {
      await expect(page.getByText(builder.displayName)).toBeVisible()
    }

    // Recommendations entry: picks derived from the saved search, with the
    // why-this-match footer, and per-card dismissal.
    await expect(page.getByText(`3 picks based on your 1 saved search`)).toBeVisible()
    await expect(page.getByText(`@${ownerRecommended[0].username}`)).toBeVisible()
    await expect(page.getByText('Why these?')).toBeVisible()
    const firstCard = page.locator('article').filter({ hasText: `@${ownerRecommended[0].username}` })
    await firstCard.hover()
    await firstCard.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByText(`2 picks based on your 1 saved search`)).toBeVisible()

    // A user with saved searches is no longer onboarding-eligible.
    await expect(page.getByTestId('onboarding-banner')).toHaveCount(0)
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('the main navigation pills reach every primary surface', async ({ browser }) => {
  test.setTimeout(120_000)
  await seedOwnerDashboard()
  const sp = await openStrictPage(browser, harness.owner)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)

    // Home's level-2 panel carries shortcuts to Search and Sprints; Exports
    // lives under Signals, so that hop goes through the rail first.
    await sectionLink(page, 'Search builders').click()
    await page.waitForURL(/\/search/)
    await expect(page.getByRole('heading', { name: 'Search builders' })).toBeVisible()

    await areaLink(page, 'Pipeline').click()
    await page.waitForURL(/\/sprints/)
    await expect(page.getByTestId('sprints-page')).toBeVisible()

    await areaLink(page, 'Signals').click()
    await page.waitForURL(/\/alerts/)
    await expect(page.getByTestId('alerts-inbox-page')).toBeVisible()

    await sectionLink(page, 'Exports').click()
    await page.waitForURL(/\/exports/)
    await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible()

    await areaLink(page, 'Home').click()
    await page.waitForURL(/\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('workspace links live in the sidebar, admin is hidden from tenants and shown to platform admins', async ({ browser }) => {
  const ownerPage = await openStrictPage(browser, harness.owner)
  try {
    const { page, guard } = ownerPage
    await go(page, '/dashboard')
    await dismissOverlays(page)

    // The avatar menu is session-scoped now: Account and Sign out only. The
    // workspace settings pages and the admin console moved to the sidebar when
    // the shell gained one, so asserting them here would assert a duplicate.
    await page.getByRole('button', { name: 'Account menu' }).click()
    const menu = page.getByRole('menu', { name: 'Account' })
    await expect(menu).toBeVisible()
    for (const item of ['Account', 'Sign out']) {
      await expect(menu.getByRole('menuitem', { name: item })).toBeVisible()
    }
    await expect(menu.getByRole('menuitem', { name: 'Team' })).toHaveCount(0)

    // Escape closes it; reopening and picking Account navigates.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Account' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Account' }).click()
    await page.waitForURL(/\/me/)
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()

    // Workspace destinations: the rail's area, then its level-2 panel.
    await expect(page.getByRole('navigation', { name: 'Areas' })).toBeVisible()
    await sectionLink(page, 'Team').click()
    await page.waitForURL(/\/settings\/team/)
    await expect(page.getByTestId('team-settings-page')).toBeVisible()

    // A tenant owner is not a platform admin — the Admin area is absent from
    // the rail entirely, not merely unlinked.
    await expect(areaLink(page, 'Admin')).toHaveCount(0)
    assertStrictClean(ownerPage)
  } finally {
    await closeStrictPage(ownerPage)
  }

  // The platform admin sees the allow-listed admin area.
  const adminPage = await openStrictPage(browser, harness.platformAdmin)
  try {
    const { page, guard } = adminPage
    await go(page, '/dashboard')
    await dismissOverlays(page)

    // The Admin area appears in the rail, and opening it lists the console's
    // destinations in the level-2 panel — grouped, not in a dropdown.
    await expect(areaLink(page, 'Admin')).toBeVisible()
    await areaLink(page, 'Admin').click()
    await page.waitForURL(/\/admin\/metrics/)
    for (const item of ['Metrics', 'Users', 'Incidents']) {
      await expect(sectionLink(page, item)).toBeVisible()
    }
    assertStrictClean(adminPage)
  } finally {
    await closeStrictPage(adminPage)
  }
})

test('browser back/forward retrace client-side dashboard navigation', async ({ browser }) => {
  const sp = await openStrictPage(browser, harness.owner)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)
    await sectionLink(page, 'Search builders').click()
    await page.waitForURL(/\/search/)
    await areaLink(page, 'Pipeline').click()
    await page.waitForURL(/\/sprints/)

    await page.goBack()
    await page.waitForURL(/\/search/)
    await expect(page.getByRole('heading', { name: 'Search builders' })).toBeVisible()

    await page.goBack()
    await page.waitForURL(/\/dashboard/)
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

    await page.goForward()
    await page.waitForURL(/\/search/)
    await expect(page.getByRole('heading', { name: 'Search builders' })).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('deep links land directly on nested surfaces; unauthenticated deep links bounce to sign-in', async ({ browser }) => {
  test.setTimeout(120_000)
  const sp = await openStrictPage(browser, harness.owner)
  const { page, guard } = sp
  try {
    await go(page, '/settings/team')
    await dismissOverlays(page)
    await expect(page.getByTestId('team-settings-page')).toBeVisible()
    await expect(page.locator('h1')).toContainText(harness.sharedOrganization.name)

    await go(page, '/exports')
    await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible()

    await go(page, '/alerts')
    await expect(page.getByTestId('alerts-inbox-page')).toBeVisible()

    await go(page, '/me')
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }

  const anonymous = await openStrictPage(browser)
  try {
    await go(anonymous.page, '/settings/team')
    expect(new URL(anonymous.page.url()).pathname).toBe('/auth/sign-in')
    assertStrictClean(anonymous)
  } finally {
    await closeStrictPage(anonymous)
  }
})

test('organization switching re-scopes the whole dashboard to the selected tenant', async ({ browser }) => {
  test.setTimeout(120_000)
  await seedOwnerDashboard()
  const { owner, sharedOrganization } = harness
  const sp = await openStrictPage(browser, owner)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)
    const switcher = page.getByRole('button', { name: 'Switch organization' })
    await expect(switcher).toContainText(sharedOrganization.name)

    // The owner belongs to two organizations: the team org and the
    // personal workspace created at sign-up.
    await switcher.click()
    await expect(page.getByRole('menu', { name: 'Organizations' })).toBeVisible()
    await expect(page.getByRole('menuitemradio')).toHaveCount(2)
    await page.getByRole('menuitemradio').filter({ hasText: 'Personal' }).click()
    await page.waitForURL(/\/dashboard/)
    await expect(switcher).not.toContainText(sharedOrganization.name)

    // Fresh document under the personal workspace: none of the team org's
    // data may appear (tenant isolation across the switch).
    await go(page, '/dashboard')
    await expect(statCard(page, 'Builders tracked').locator('.text-3xl')).toHaveText('0')
    await expect(page.getByText('Save a search to start getting daily picks.')).toBeVisible()
    await expect(page.getByText(ownerQueryName)).toHaveCount(0)

    // Switch back to the team org — data returns.
    await switcher.click()
    await page.getByRole('menuitemradio').filter({ hasText: sharedOrganization.name }).click()
    await page.waitForURL(/\/dashboard/)
    await expect(switcher).toContainText(sharedOrganization.name)
    await go(page, '/dashboard')
    await expect(statCard(page, 'Builders tracked').locator('.text-3xl')).toHaveText('2')
    await expect(page.getByText(ownerQueryName).first()).toBeVisible()
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})

test('two isolated contexts never leak one tenant into the other', async ({ browser }) => {
  test.setTimeout(120_000)
  await seedOwnerDashboard()
  const other = await mintVerified('isolated')
  const spA = await openStrictPage(browser, harness.owner)
  const spB = await openStrictPage(browser, other)
  try {
    await go(spA.page, '/dashboard')
    await dismissOverlays(spA.page)
    await go(spB.page, '/dashboard')
    await dismissOverlays(spB.page)

    // A sees the team org's data…
    await expect(spA.page.getByText(ownerQueryName).first()).toBeVisible()
    await expect(statCard(spA.page, 'Builders tracked').locator('.text-3xl')).toHaveText('2')
    // …B sees only its own empty personal workspace.
    await expect(spB.page.getByText(ownerQueryName)).toHaveCount(0)
    await expect(statCard(spB.page, 'Builders tracked').locator('.text-3xl')).toHaveText('0')
    await expect(
      spB.page.getByRole('button', { name: 'Switch organization' }),
    ).not.toContainText(harness.sharedOrganization.name)
    for (const builder of ownerTracked) {
      await expect(spB.page.getByText(builder.displayName)).toHaveCount(0)
    }

    assertStrictClean(spA)
    assertStrictClean(spB)
  } finally {
    await closeStrictPage(spA)
    await closeStrictPage(spB)
  }
})

test('a member removed from their active organization degrades gracefully and recovers by switching', async ({ browser }) => {
  test.setTimeout(120_000)
  const { owner, sharedOrganization } = harness
  const staleMember = await createMemberPrincipal(harness.ctx, sharedOrganization.organizationId, 'member')
  minted.push(staleMember)

  // Real product path: the owner removes the member, which also clears the
  // member's active-organization pointer — their session now targets no
  // valid tenant ("stale org").
  const removal = await owner.api!.delete(`/api/organizations/members/${staleMember.userId}`)
  expect(removal.ok(), 'owner removes member').toBe(true)

  const sp = await openStrictPage(browser, staleMember)
  const { page, guard } = sp
  try {
    // Tenant-scoped fetches now 403 — the dashboard degrades to the
    // partial-data notice (and logs the load failure exactly once).
    guard.allowExpectedFailure(/Dashboard load error/)
    await go(page, '/dashboard')
    await dismissOverlays(page)
    await expect(page.getByText(/Some data may be missing/)).toBeVisible()

    // Recovery: the switcher still lists the personal workspace.
    const switcher = page.getByRole('button', { name: 'Switch organization' })
    await expect(switcher).toContainText('Select organization')
    await switcher.click()
    await page.getByRole('menuitemradio').filter({ hasText: 'Personal' }).click()
    await page.waitForURL(/\/dashboard/)
    // The switch resolves through router.invalidate() → a server-fn fetch;
    // reloading before it settles would abort that fetch and crash the app
    // into its root error boundary. The switcher label changing is the
    // semantic "switch committed" signal — wait for it, never a delay.
    await expect(switcher).not.toContainText('Select organization')

    // A fresh document under the recovered workspace loads cleanly — the
    // single allowed failure above was consumed, so this must be violation-free.
    await go(page, '/dashboard')
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(page.getByText(/Some data may be missing/)).toHaveCount(0)
    await expect(statCard(page, 'Builders tracked').locator('.text-3xl')).toHaveText('0')
    // The degraded mount 403s every tenant-scoped fetch — each one is a
    // handled rejection Chrome still logs. The recovered second document
    // must not add any beyond the ever-present admin probe.
    //
    // Keep this in step with what the dashboard actually requests: the bento
    // rewrite added the sprints, alerts, plan-usage and unread-count widgets,
    // and this list silently went stale because CI never ran this spec.
    assertStrictClean(sp, [
      /\/api\/dashboard\/stats/,
      /\/api\/queries/,
      /\/api\/builders\/recent/,
      /\/api\/recommendations/,
      /\/api\/onboarding\/status/,
      /\/api\/organizations\/invitations\/mine/,
      /\/api\/sprints/,
      /\/api\/alerts\/triggers/,
      /\/api\/plans\/me/,
    ])
  } finally {
    await closeStrictPage(sp)
  }
})

test('signing out from the account menu ends the session for real', async ({ browser }) => {
  const principal = await mintVerified('signout')
  const sp = await openStrictPage(browser, principal)
  const { page, guard } = sp
  try {
    await go(page, '/dashboard')
    await dismissOverlays(page)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await page.waitForURL(/\/auth\/sign-in/)

    // The session is revoked server-side, not just client-side: a fresh
    // full-page visit to the dashboard bounces back to sign-in.
    await go(page, '/dashboard')
    expect(new URL(page.url()).pathname).toBe('/auth/sign-in')
    assertStrictClean(sp)
  } finally {
    await closeStrictPage(sp)
  }
})
