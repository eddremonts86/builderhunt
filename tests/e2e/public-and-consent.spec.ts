/**
 * Wave 2 Task 6 — public consent surfaces: cookie banner customization and
 * persistence, ToS acceptance lifecycle, and the public roadmap's
 * voting/auth boundary.
 *
 * Everything runs against a per-worker disposable database + Redis
 * namespace + dedicated app server (Wave 1 harness). All browser tests run
 * under `expectStrictBrowser`: any console.error, uncaught page error,
 * failed same-origin request, or third-party egress fails the test.
 */
import { test, expect, type Browser, type Page } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

// Pure-Node spec — no vite/vitest to auto-load .env.
loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv, type FixedClock } from './harness/clock'
import { newApiContext, type StorageState } from './harness/auth'
import {
  createVerifiedPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import { seedConsent } from './harness/fixtures/privacy'
import { uniqueId } from './harness/ids'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import {
  expectStrictBrowser,
  gotoHydrated,
  dismissOverlays,
  type StrictBrowserGuard,
} from './harness/browser'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  clock: FixedClock
  /** Fresh verified user with NO consents — the ToS lifecycle subject. */
  tosUser: Principal
  /** Verified user whose current ToS consent is pre-seeded — the roadmap voter. */
  voter: Principal
}

let harness: Harness

test.beforeAll(async () => {
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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}pc` }
    const clock = fixedClockFromEnv()

    const tosUser = await createVerifiedPrincipal(ctx, 'tos-lifecycle')
    const voter = await createVerifiedPrincipal(ctx, 'roadmap-voter')
    // The current ToS version is already accepted — the modal must not
    // block the voter's browser sessions.
    await seedConsent(sql, {
      userId: voter.userId!,
      document: 'tos',
      version: 'v1.0',
      acceptedAt: clock.now(),
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      clock,
      tosUser,
      voter,
    }

    // Warm the dev server's SSR compile pipeline before the first test —
    // a cold vite worker can take tens of seconds on its first render.
    // (Plain fetch, not a browser context: Playwright tracing does not
    // cope well with browser contexts opened inside beforeAll.)
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

// Two parallel per-worker vite dev servers (plus the global one) compile
// on demand — a first visit to a not-yet-transformed route can exceed the
// default 30s test budget on a cold run. No fixed delays: just budget.
test.beforeEach(async () => {
  test.setTimeout(60_000)
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  for (const principal of [h.tosUser, h.voter]) {
    await disposePrincipal(principal).catch(() => undefined)
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

/** Fresh isolated context + page wired through the strict collectors. */
async function withPage(
  browser: Browser,
  storageState: StorageState | undefined,
  run: (page: Page, guard: StrictBrowserGuard) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext(storageState ? { storageState } : {})
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  try {
    await run(page, guard)
    guard.assertClean()
  } finally {
    guard.dispose()
    await context.close()
  }
}

const CONSENT_STORAGE_KEY = 'bh_cookie_consent'

async function readCookieConsent(page: Page): Promise<{
  essential: boolean
  functional: boolean
  analytics: boolean
  decidedAt: string
} | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, CONSENT_STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// Cookie banner — customization + persistence
// ---------------------------------------------------------------------------

test.describe('cookie banner', () => {
  test('first visit shows the banner; "Essential only" persists an all-off choice across reloads', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/`)
      const banner = page.getByTestId('cookie-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toContainText('We use cookies')

      await page.getByTestId('cookie-banner-essential').click()
      await expect(banner).toBeHidden()

      const consent = await readCookieConsent(page)
      expect(consent).toMatchObject({ essential: true, functional: false, analytics: false })
      expect(typeof consent?.decidedAt).toBe('string')

      // Persistence: the decision survives a full reload.
      await page.reload()
      await gotoHydrated(page, `${harness.baseURL}/`)
      await expect(page.getByTestId('cookie-banner')).toHaveCount(0)
    })
  })

  test('customize panel saves granular preferences (functional off, analytics on)', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/`)
      await page.getByTestId('cookie-banner-customize-btn').click()
      await expect(page.getByTestId('cookie-banner-customize')).toBeVisible()

      // Functional defaults to on — turn it off. Analytics defaults to off —
      // turn it on. The essential toggle is disabled and always on.
      await page.getByTestId('cookie-banner-functional').click()
      await page.getByTestId('cookie-banner-analytics').click()
      await page.getByTestId('cookie-banner-save-prefs').click()
      await expect(page.getByTestId('cookie-banner')).toBeHidden()

      const consent = await readCookieConsent(page)
      expect(consent).toMatchObject({ essential: true, functional: false, analytics: true })

      await page.reload()
      await gotoHydrated(page, `${harness.baseURL}/`)
      await expect(page.getByTestId('cookie-banner')).toHaveCount(0)
    })
  })

  test('"Accept all" records every category as on', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/`)
      await page.getByTestId('cookie-banner-accept-all').click()
      const consent = await readCookieConsent(page)
      expect(consent).toMatchObject({ essential: true, functional: true, analytics: true })
    })
  })

  test('dismissing without deciding stores nothing — the banner returns on the next visit', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/`)
      await page.getByTestId('cookie-banner-dismiss').click()
      await expect(page.getByTestId('cookie-banner')).toBeHidden()
      expect(await readCookieConsent(page)).toBeNull()

      await page.reload()
      await gotoHydrated(page, `${harness.baseURL}/`)
      await expect(page.getByTestId('cookie-banner')).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Consent API — success, validation, auth boundary
// ---------------------------------------------------------------------------

test.describe('consent API', () => {
  test('anonymous GET reports no user and no required acceptance', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/consent')
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.userId).toBeNull()
      expect(body.needsAcceptance).toEqual([])
      // Assert the contract, not the values. This used to pin `privacy: 'v1.0'`, which is how the
      // route's frozen copy of the version map survived the policy moving to v1.1 — the test was
      // enforcing the bug. The current values are pinned in tests/unit/shared/lib/legal.test.ts,
      // next to the constant they belong to.
      expect(Object.keys(body.required).sort()).toEqual(['cookies', 'privacy', 'tos'])
      for (const version of Object.values(body.required)) {
        expect(version).toMatch(/^v\d+\.\d+$/)
      }
    } finally {
      await api.dispose()
    }
  })

  test('anonymous POST is rejected with 401', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.post('/api/consent', {
        data: { document: 'tos', version: 'v1.0' },
      })
      expect(response.status()).toBe(401)
      expect((await response.json()).error).toBe('Unauthorized')
    } finally {
      await api.dispose()
    }
  })

  test('authenticated POST validates the body — unknown document and empty body are 400', async () => {
    const { tosUser } = harness
    const unknownDocument = await tosUser.api!.post('/api/consent', {
      data: { document: 'marketing-spam', version: 'v1.0' },
    })
    expect(unknownDocument.status()).toBe(400)
    expect((await unknownDocument.json()).error).toBe('Invalid body')

    const emptyBody = await tosUser.api!.post('/api/consent', { data: {} })
    expect(emptyBody.status()).toBe(400)

    const emptyVersion = await tosUser.api!.post('/api/consent', {
      data: { document: 'tos', version: '' },
    })
    expect(emptyVersion.status()).toBe(400)
  })

  test('a fresh signed-up user still needs every current document', async () => {
    const { tosUser } = harness
    const response = await tosUser.api!.get('/api/consent')
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.userId).toBe(tosUser.userId)
    expect(body.needsAcceptance).toEqual(expect.arrayContaining(['tos', 'privacy', 'cookies']))
  })

  /*
   * Privacy is at v2.0, and this is the case that proves what that costs.
   *
   * This test used to post `v1.0` and assert that privacy dropped out of `needsAcceptance`, on the
   * grounds that v1.1 was a minor bump and `isMaterialVersionChange` compares only the major part.
   * The interview work moved the notice to v2.0 — deliberately, because the AI-processing and
   * live-transcription disclosures are not a wording change and an acceptance of v1.x must not be
   * allowed to carry — so a v1 acceptance is now *correctly* insufficient.
   *
   * The consequence is real and lands on deploy day: `requireCurrentCommercialConsent` uses the same
   * rule, so every organization holding a v1.x acceptance meets a re-acceptance gate at checkout. It
   * is recorded in the provider register; this is the assertion that would have surfaced it.
   */
  test('a stale major acceptance does not clear the requirement; the current version does', async () => {
    const { tosUser, sql } = harness

    const stale = await tosUser.api!.post('/api/consent', {
      data: { document: 'privacy', version: 'v1.0' },
    })
    // The POST itself succeeds — the ledger records what the user actually accepted, whatever it
    // was. Refusing to record it would lose the audit trail of their earlier decision.
    expect(stale.status()).toBe(200)
    expect((await stale.json()).ok).toBe(true)

    const staleRows = await sql<{ version: string }[]>`
      select version from user_consents
      where user_id = ${tosUser.userId!} and document = 'privacy'
    `
    expect(staleRows.map((r) => r.version)).toContain('v1.0')

    const afterStale = await tosUser.api!.get('/api/consent').then((r) => r.json())
    // Still required. A v1 acceptance predates the disclosures v2.0 added.
    expect(afterStale.needsAcceptance).toContain('privacy')
    expect(afterStale.consents.privacy).toBe('v1.0')

    // And the current version clears it, so the assertion above is about the major bump rather than
    // about the endpoint having stopped working.
    const current = await tosUser.api!.post('/api/consent', {
      data: { document: 'privacy', version: CURRENT_CONSENT_VERSIONS.privacy },
    })
    expect(current.status()).toBe(200)

    const afterCurrent = await tosUser.api!.get('/api/consent').then((r) => r.json())
    expect(afterCurrent.needsAcceptance).not.toContain('privacy')
    expect(afterCurrent.consents.privacy).toBe(CURRENT_CONSENT_VERSIONS.privacy)
  })
})

// ---------------------------------------------------------------------------
// ToS lifecycle — the blocking modal for signed-in users
// ---------------------------------------------------------------------------

test.describe('ToS acceptance lifecycle', () => {
  test('signed-in user without current ToS consent is blocked by the modal; accepting persists and unblocks', async ({ browser }) => {
    const { tosUser, sql, baseURL } = harness
    await withPage(browser, tosUser.storageState!, async (page, guard) => {
      // KNOWN PRODUCT ISSUE (do not copy this pattern casually): when a
      // signed-in user loads a _landing page, the server renders the
      // signed-out header (Sign in / Get started) while the client can
      // already have the session by hydration time, so React logs a
      // recoverable "Hydration failed" error for the session-dependent
      // header CTA. It is racy — it may or may not fire — and is unrelated
      // to the consent lifecycle under test. Tracked as a plan issue; these
      // one-shot allowances keep the strict guard armed for everything else.
      // (one console + one pageerror per full page load; two loads here)
      for (let i = 0; i < 4; i++) guard.allowExpectedFailure(/Hydration failed|error while hydrating/)
      await gotoHydrated(page, `${baseURL}/`)

      const modal = page.getByTestId('tos-modal')
      await expect(modal).toBeVisible()
      await expect(modal).toContainText('Updated Terms of Service')
      // The modal links out to the full legal documents.
      await expect(page.getByTestId('tos-modal-read')).toHaveAttribute('href', '/legal/terms')
      await expect(page.getByTestId('tos-modal-privacy')).toHaveAttribute('href', '/legal/privacy')

      await page.getByTestId('tos-modal-accept').click()
      await expect(modal).toBeHidden()

      // The acceptance is durable: recorded in user_consents…
      //
      // Asserted against the current version, never a literal. Pinning `'v1.0'` is what broke this
      // when terms moved to v1.1 for the interview sections: the app correctly records what the user
      // was shown, and the test was the only thing still claiming v1.0.
      const rows = await sql<{ version: string }[]>`
        select version from user_consents
        where user_id = ${tosUser.userId!} and document = 'tos'
      `
      expect(rows.map((r) => r.version)).toContain(CURRENT_CONSENT_VERSIONS.tos)

      // …and a full reload no longer shows the modal.
      await page.reload()
      await gotoHydrated(page, `${baseURL}/`)
      await expect(page.getByTestId('tos-modal')).toHaveCount(0)
    })

    const status = await tosUser.api!.get('/api/consent')
    const body = await status.json()
    expect(body.needsAcceptance).not.toContain('tos')
    expect(body.consents.tos).toBe(CURRENT_CONSENT_VERSIONS.tos)
  })

  test('anonymous visitors are never blocked by the ToS modal', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/legal/terms`)
      await expect(page.getByTestId('tos-modal')).toHaveCount(0)
      await expect(page.getByTestId('legal-terms')).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Roadmap — public page, voting, and its auth boundary
// ---------------------------------------------------------------------------

async function seedRoadmapItem(
  sql: Sql,
  input: {
    title: string
    description?: string | null
    status: 'planned' | 'in_progress' | 'shipped'
    shipEstimate?: string | null
    sortOrder?: number
  },
): Promise<string> {
  const id = uniqueId('roadmap-item')
  await sql`
    insert into roadmap_items (id, title, description, status, ship_estimate, category, sort_order)
    values (${id}, ${input.title}, ${input.description ?? null}, ${input.status},
            ${input.shipEstimate ?? null}, 'general', ${input.sortOrder ?? 0})
  `
  return id
}

test.describe('public roadmap', () => {
  // Populated by the seeding test below; later tests reuse the ids.
  const seeded: { planned?: string; inProgress?: string; shipped?: string; hostile?: string } = {}

  test('empty state: no items yet renders the empty card and the API returns []', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/roadmap')
      expect(response.status()).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/roadmap`)
      await expect(page.getByTestId('roadmap-page')).toBeVisible()
      await expect(page.getByText('No roadmap items yet.')).toBeVisible()
    })
  })

  test('seeded items render into the three status columns with vote affordances', async ({ browser }) => {
    const { sql } = harness
    seeded.planned = await seedRoadmapItem(sql, {
      title: 'E2E planned feature',
      description: 'A planned feature seeded by the public-and-consent spec.',
      status: 'planned',
      shipEstimate: 'Q4 2026',
      sortOrder: 1,
    })
    seeded.inProgress = await seedRoadmapItem(sql, {
      title: 'E2E in-progress feature',
      status: 'in_progress',
      sortOrder: 2,
    })
    seeded.shipped = await seedRoadmapItem(sql, {
      title: 'E2E shipped feature',
      status: 'shipped',
      sortOrder: 3,
    })
    seeded.hostile = await seedRoadmapItem(sql, {
      title: '<script>window.__roadmapXss=1</script><img src=x onerror=alert(1)>',
      description: '"><svg onload=alert(2)> hostile description',
      status: 'planned',
      sortOrder: 4,
    })

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/roadmap`)

      await expect(page.getByTestId(`roadmap-item-${seeded.planned}`)).toBeVisible()
      await expect(page.getByTestId(`roadmap-item-${seeded.inProgress}`)).toBeVisible()
      await expect(page.getByTestId(`roadmap-item-${seeded.shipped}`)).toBeVisible()

      // Planned/in-progress carry a vote button with the current count.
      await expect(
        page.locator(`[data-testid="roadmap-vote-btn"][data-item-id="${seeded.planned}"]`),
      ).toContainText('0')
      await expect(
        page.locator(`[data-testid="roadmap-vote-btn"][data-item-id="${seeded.inProgress}"]`),
      ).toBeVisible()
      // Shipped items show demand instead of a vote button.
      await expect(page.getByTestId(`roadmap-item-${seeded.shipped}`)).toContainText('+0 wanted')
      expect(
        await page
          .locator(`[data-testid="roadmap-vote-btn"][data-item-id="${seeded.shipped}"]`)
          .count(),
      ).toBe(0)

      // The ship estimate is rendered on the card.
      await expect(page.getByTestId(`roadmap-item-${seeded.planned}`)).toContainText('Q4 2026')
    })
  })

  test('hostile roadmap content renders as inert text — no script execution, no injected elements', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/roadmap`)
      const card = page.getByTestId(`roadmap-item-${seeded.hostile}`)
      await expect(card).toBeVisible()
      // React escapes — the payload is visible as literal text…
      await expect(card).toContainText('<script>window.__roadmapXss=1</script>')
      // …and never executed or parsed into the DOM.
      expect(await page.evaluate(() => (window as { __roadmapXss?: number }).__roadmapXss)).toBeUndefined()
      expect(await card.locator('img, svg[onload]').count()).toBe(0)
      // Strict guard would additionally fail on any pageerror/console.error
      // an executed payload produced.
    })
  })

  test('anonymous voting is rejected with 401 and never changes the count', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.post('/api/roadmap', { data: { itemId: seeded.planned } })
      expect(response.status()).toBe(401)
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // The intentional 401 response is logged by the browser as a
      // console error — expected exactly once here.
      guard.allowExpectedFailure(/status of 401/)
      await gotoHydrated(page, `${harness.baseURL}/roadmap`)
      await dismissOverlays(page)
      const voteButton = page.locator(
        `[data-testid="roadmap-vote-btn"][data-item-id="${seeded.planned}"]`,
      )
      await expect(voteButton).toContainText('0')

      const [voteResponse] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith('/api/roadmap') && r.request().method() === 'POST',
        ),
        voteButton.click(),
      ])
      expect(voteResponse.status()).toBe(401)
      // The page reloads the list after the attempt — the count must not move.
      await expect(voteButton).toContainText('0')
      await expect(voteButton).toHaveClass(/btn-secondary/)
    })
  })

  test('vote validation: authenticated POST without itemId is 400; unknown itemId does not crash into a false success', async () => {
    const { voter } = harness
    const missing = await voter.api!.post('/api/roadmap', { data: {} })
    expect(missing.status()).toBe(400)
    expect((await missing.json()).error).toBe('itemId required')

    const unknown = await voter.api!.post('/api/roadmap', {
      data: { itemId: 'does-not-exist' },
    })
    // FK violation surfaces as the handler's error path — a 500, never ok:true.
    expect(unknown.status()).toBe(500)
    expect((await unknown.json()).error).toBe('Failed')
  })

  test('a signed-in user can vote and un-vote from the browser; the toggle is reflected in count and style', async ({ browser }) => {
    const { voter, baseURL } = harness
    await withPage(browser, voter.storageState!, async (page, guard) => {
      // Same racy signed-in header hydration mismatch as documented in the
      // ToS lifecycle test — one page load here.
      for (let i = 0; i < 2; i++) guard.allowExpectedFailure(/Hydration failed|error while hydrating/)
      await gotoHydrated(page, `${baseURL}/roadmap`)
      await dismissOverlays(page)

      const voteButton = page.locator(
        `[data-testid="roadmap-vote-btn"][data-item-id="${seeded.planned}"]`,
      )
      await expect(voteButton).toContainText('0')
      await expect(voteButton).toHaveClass(/btn-secondary/)

      await voteButton.click()
      await expect(voteButton).toContainText('1')
      await expect(voteButton).toHaveClass(/btn-primary/)

      // Toggling again removes the vote (real product behavior).
      await voteButton.click()
      await expect(voteButton).toContainText('0')
      await expect(voteButton).toHaveClass(/btn-secondary/)
    })

    // The API agrees with what the browser showed.
    const list = await voter.api!.get('/api/roadmap')
    const items = (await list.json()) as Array<{ id: string; voteCount: number; userHasVoted: boolean }>
    const planned = items.find((i) => i.id === seeded.planned)
    expect(planned).toMatchObject({ voteCount: 0, userHasVoted: false })
  })

  test('votes from the API are attributed to the item and deduplicated per user', async () => {
    const { voter } = harness
    const first = await voter.api!.post('/api/roadmap', { data: { itemId: seeded.inProgress } })
    expect(first.status()).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, voted: true })

    const list = await voter.api!.get('/api/roadmap')
    const items = (await list.json()) as Array<{ id: string; voteCount: number; userHasVoted: boolean }>
    const item = items.find((i) => i.id === seeded.inProgress)
    expect(item).toMatchObject({ voteCount: 1, userHasVoted: true })

    // Voting again toggles OFF (one active vote per user per item, ever).
    const second = await voter.api!.post('/api/roadmap', { data: { itemId: seeded.inProgress } })
    expect(await second.json()).toMatchObject({ ok: true, voted: false })
    const after = await voter.api!.get('/api/roadmap')
    const afterItems = (await after.json()) as Array<{ id: string; voteCount: number }>
    expect(afterItems.find((i) => i.id === seeded.inProgress)?.voteCount).toBe(0)
  })
})
