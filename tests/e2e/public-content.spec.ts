/**
 * Wave 2 Task 6 — public content pages: landing, pricing, legal, changelog,
 * blog, status/incidents, public builder profiles (including the
 * anonymous-data-redaction boundary), and the 404 page.
 *
 * Runs against a per-worker disposable database + Redis namespace +
 * dedicated app server (Wave 1 harness). Every browser test is wired
 * through `expectStrictBrowser`.
 */
import { test, expect, type Browser, type Page } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv, type FixedClock } from './harness/clock'
import { newApiContext, type StorageState } from './harness/auth'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import { createPlatformAdminPrincipal, registerPlatformAdminEnv, reservePlatformAdminSeed } from './harness/fixtures/platform-admin'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { uniqueId } from './harness/ids'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import {
  expectStrictBrowser,
  gotoHydrated,
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
  owner: Principal
  organization: OrganizationFixture
  admin: Principal
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

  // Reserved and allow-listed BEFORE the server spawns — the worker server
  // inherits process.env, and there is no product flow to allow-list an id
  // after the fact (see fixtures/platform-admin.ts).
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}content`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}content` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock,
    })
    await seedConsent(sql, {
      userId: owner.userId!,
      document: 'tos',
      version: 'v1.0',
      acceptedAt: clock.now(),
    })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      clock,
      owner,
      organization,
      admin,
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
  await disposePrincipal(h.owner).catch(() => undefined)
  await disposePrincipal(h.admin).catch(() => undefined)
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

// ---------------------------------------------------------------------------
// Landing + 404
// ---------------------------------------------------------------------------

test.describe('landing page', () => {
  test('renders the hero and anonymous auth CTAs with a clean browser', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/`)
      await expect(page.locator('h1')).toContainText('Find')
      await expect(page.locator('h1')).toContainText('not just repos.')
      await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute(
        'href',
        '/auth/sign-in',
      )
      await expect(page.getByRole('link', { name: 'Get started' }).first()).toHaveAttribute(
        'href',
        '/auth/sign-up',
      )
    })
  })

  test('an unknown route renders the 404 page', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/this-route-does-not-exist')
      expect(response.status()).toBe(404)
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // The document itself is served with 404 — Chromium logs that as a
      // console error, which is exactly the expected behavior here.
      guard.allowExpectedFailure(/status of 404/)
      await gotoHydrated(page, `${harness.baseURL}/this-route-does-not-exist`)
      await expect(page.getByText('404')).toBeVisible()
      await expect(page.getByText('Page not found')).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test.describe('pricing page', () => {
  test('anonymous visitor sees all four plan cards and sign-up CTAs; the billing toggle switches periods', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/pricing`)
      await expect(page.getByTestId('pricing-page')).toBeVisible()

      for (const tier of ['free', 'pro', 'pro_max', 'team']) {
        await expect(page.getByTestId(`plan-${tier}`)).toBeVisible()
      }

      // Auth boundary: the free plan routes to sign-up; paid-plan subscribe
      // buttons prompt anonymous visitors to sign in instead of starting a
      // checkout.
      await expect(
        page.getByTestId('plan-free').getByRole('link', { name: 'Get started' }),
      ).toHaveAttribute('href', '/auth/sign-up')
      await page.getByTestId('pricing-cta-pro').click()
      await expect(page.getByTestId('pricing-msg')).toContainText('sign in')
      await expect(page.getByTestId('pricing-msg').getByRole('link', { name: 'sign in' })).toHaveAttribute(
        'href',
        '/auth/sign-in',
      )

      // Monthly is the default period; switching to annual re-labels prices.
      await expect(page.getByTestId('plan-pro')).toContainText('/mo')
      await page.getByTestId('period-annual').click()
      await expect(page.getByTestId('plan-pro')).toContainText('/yr')
      await page.getByTestId('period-monthly').click()
      await expect(page.getByTestId('plan-pro')).toContainText('/mo')

      // Feature matrix, credit packs, and FAQ sections are present.
      await expect(page.getByTestId('pricing-features')).toBeVisible()
      await expect(page.getByTestId('pricing-packs')).toBeVisible()
      await expect(page.getByTestId('pricing-faq')).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Legal pages
// ---------------------------------------------------------------------------

test.describe('legal pages', () => {
  test('terms of service renders a contiguous section list and the version it is accepted at', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/legal/terms`)
      const article = page.getByTestId('legal-terms')
      await expect(article).toBeVisible()

      /*
       * The version comes from `CURRENT_CONSENT_VERSIONS`, not a literal.
       *
       * This used to assert `Version v1.0` and `12. Contact`. Adding section 11 for the interview
       * features moved Contact to 13 and left the page claiming v1.0 for text nobody had accepted —
       * so the literal caught the renumbering and said nothing about the version being stale, which
       * was the part that mattered. Reading the constant makes the page and the consent ledger agree
       * by construction, which is the property worth pinning.
       */
      await expect(article).toContainText(`Version ${CURRENT_CONSENT_VERSIONS.tos}`)
      await expect(article).toContainText('1. Acceptance of terms')

      // Contiguous and complete, wherever Contact ends up: gaps and duplicates in a numbered
      // agreement are what make one unenforceable.
      const headings = await article.getByRole('heading', { level: 2 }).allInnerTexts()
      const numbers = headings
        .map((heading) => Number(heading.match(/^(\d+)\./)?.[1] ?? NaN))
        .filter((n) => Number.isFinite(n))
      expect(numbers.length, 'the sections are numbered').toBeGreaterThan(10)
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1))
      expect(headings.at(-1), 'Contact is last, whatever number it now has').toMatch(/Contact$/)

      // The interview obligations are present, since a customer is bound by them.
      await expect(article).toContainText(/Interview features/i)
      await expect(article).toContainText(/never stored/i)

      await expect(page).toHaveTitle(/Terms of Service — BuilderHunt/)
    })
  })

  test('privacy policy and imprint render', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/legal/privacy`)
      await expect(page.getByTestId('legal-privacy')).toBeVisible()

      await gotoHydrated(page, `${harness.baseURL}/legal/imprint`)
      await expect(page.getByTestId('legal-imprint')).toBeVisible()
    })
  })

  test('cookie policy lists every first-party cookie and no analytics cookies', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/legal/cookies`)
      await expect(page.getByTestId('legal-cookies')).toBeVisible()
      for (const cookie of ['bh_session', 'bh_cookie_consent', 'bh_onboarding_state', 'bh_claim_token']) {
        await expect(page.getByTestId(`cookie-row-${cookie}`)).toBeVisible()
      }
      await expect(page.getByTestId('legal-cookies')).toContainText(
        'we currently do not use any analytics cookies',
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

async function seedChangelogEntry(
  sql: Sql,
  input: { title: string; content: string; slug: string; tags: string[]; publishedAt: Date },
): Promise<string> {
  const id = uniqueId('changelog')
  await sql`
    insert into changelog (id, title, content, slug, tags, published_at)
    values (${id}, ${input.title}, ${input.content}, ${input.slug},
            ${JSON.stringify(input.tags)}::jsonb, ${input.publishedAt})
  `
  return id
}

test.describe('changelog', () => {
  const slugs = {
    newest: uniqueId('cl-newest').replace(/_/g, '-'),
    older: uniqueId('cl-older').replace(/_/g, '-'),
    hostile: uniqueId('cl-hostile').replace(/_/g, '-'),
  }

  test('empty state: no entries yet on the page and [] from the API', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/changelog')
      expect(response.status()).toBe(200)
      expect(await response.json()).toEqual([])
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/changelog`)
      await expect(page.getByText('No changelog entries yet.')).toBeVisible()
    })
  })

  test('seeded entries list newest-first with tags, and read-more navigates to the detail page', async ({ browser }) => {
    const { sql, clock } = harness
    await seedChangelogEntry(sql, {
      title: 'E2E newest release',
      content: '## Shipped\n\nThe **newest** e2e changelog entry body with enough text to be truncated in the list view preview paragraph rendering.',
      slug: slugs.newest,
      tags: ['feature'],
      publishedAt: clock.minus({ days: 1 }),
    })
    await seedChangelogEntry(sql, {
      title: 'E2E older release',
      content: 'An older entry body used to verify ordering of the changelog list page in the public content spec.',
      slug: slugs.older,
      tags: ['bugfix', 'improvement'],
      publishedAt: clock.minus({ days: 10 }),
    })

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/changelog`)
      const entries = page.getByTestId('changelog-entry')
      await expect(entries).toHaveCount(2)
      // Newest first.
      await expect(entries.first()).toContainText('E2E newest release')
      await expect(entries.first()).toContainText('feature')
      await expect(entries.last()).toContainText('E2E older release')

      // Read more → detail page for that slug.
      await entries.first().getByTestId('changelog-read-more').click()
      await expect(page).toHaveURL(new RegExp(`/changelog/${slugs.newest}$`))
      await expect(page.locator('h1')).toContainText('E2E newest release')
      await expect(page.getByText('newest', { exact: false }).first()).toBeVisible()
    })
  })

  test('changelog API: entry by slug is 200, unknown slug is 404', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const found = await api.get(`/api/changelog/${slugs.newest}`)
      expect(found.status()).toBe(200)
      expect((await found.json()).slug).toBe(slugs.newest)

      const missing = await api.get('/api/changelog/no-such-slug')
      expect(missing.status()).toBe(404)
      expect((await missing.json()).error).toBe('Not found')
    } finally {
      await api.dispose()
    }
  })

  test('unknown changelog slug renders the not-found card with a way back', async ({ browser }) => {
    await withPage(browser, undefined, async (page, guard) => {
      // The detail page fetches the single entry (`/api/changelog/$slug`) rather
      // than downloading the whole list to find one, so an unknown slug now
      // produces a real 404 and Chromium logs it. Same expectation the 404 tests
      // above and the blog/feed tests below already declare.
      guard.allowExpectedFailure(/status of 404/)
      await gotoHydrated(page, `${harness.baseURL}/changelog/no-such-slug`)
      await expect(page.getByText('Entry not found')).toBeVisible()
      await expect(page.getByRole('link', { name: 'Back to changelog' })).toHaveAttribute(
        'href',
        '/changelog',
      )
    })
  })

  test('hostile changelog content renders as inert text on list and detail pages', async ({ browser }) => {
    const { sql, clock } = harness
    await seedChangelogEntry(sql, {
      title: '<script>window.__changelogXss=1</script> hostile title',
      content: '<img src=x onerror=alert(1)> hostile **content** with `<iframe src=//evil.invalid>` markup',
      slug: slugs.hostile,
      tags: ['breaking'],
      publishedAt: clock.minus({ hours: 1 }),
    })

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/changelog/${slugs.hostile}`)
      await expect(page.locator('h1')).toContainText('<script>window.__changelogXss=1</script>')
      expect(
        await page.evaluate(() => (window as { __changelogXss?: number }).__changelogXss),
      ).toBeUndefined()
      // Raw markup from the content column must not become live elements.
      expect(await page.locator('article img, article iframe').count()).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------

test.describe('blog', () => {
  test('the list page renders the markdown posts from content/posts with an RSS link', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/blog`)
      await expect(page.getByTestId('blog-list')).toBeVisible()
      await expect(page.getByTestId('blog-rss-link')).toHaveAttribute('href', '/blog/atom.xml')
      // Repo content: at least the three posts checked in under content/posts.
      const cards = page.locator('[data-testid^="blog-post-card-"]')
      expect(await cards.count()).toBeGreaterThanOrEqual(3)
      await expect(page.getByTestId('blog-post-card-why-i-built-builderhunt')).toBeVisible()
      // The empty state is not shown when posts exist.
      await expect(page.getByTestId('blog-empty')).toHaveCount(0)
    })
  })

  test('a post detail page renders body, metadata, JSON-LD, and the explore CTA', async ({ browser }) => {
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/blog/why-i-built-builderhunt`)
      await expect(page.getByTestId('blog-post-title')).toContainText('Why I built BuilderHunt')
      await expect(page.getByTestId('blog-post-body')).toContainText('The problem')
      await expect(page.getByTestId('blog-cta-explore')).toHaveAttribute('href', '/explore')
      await expect(page.getByTestId('blog-back')).toHaveAttribute('href', '/blog')

      // The root document already carries a site-wide JSON-LD block — find
      // the BlogPosting entry among all structured-data scripts.
      const jsonLdBlocks = await page
        .locator('script[type="application/ld+json"]')
        .allTextContents()
      const blogPosting = jsonLdBlocks
        .flatMap((raw) => {
          try {
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            return []
          }
        })
        .find((entry) => entry?.['@type'] === 'BlogPosting')
      expect(blogPosting).toBeTruthy()
      expect(blogPosting.headline).toBe('Why I built BuilderHunt')
      await expect(page).toHaveTitle(/Why I built BuilderHunt — BuilderHunt Blog/)
    })
  })

  test('blog post SSR carries article OG metadata', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/blog/why-i-built-builderhunt')
      expect(response.status()).toBe(200)
      const html = await response.text()
      expect(html).toContain('property="og:type"')
      expect(html).toContain('article')
      expect(html).toContain('og:title')
    } finally {
      await api.dispose()
    }
  })

  test('an unknown blog slug renders the 404 page', async ({ browser }) => {
    await withPage(browser, undefined, async (page, guard) => {
      guard.allowExpectedFailure(/status of 404/)
      await gotoHydrated(page, `${harness.baseURL}/blog/this-post-does-not-exist`)
      await expect(page.getByText('Page not found')).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Status + incidents
// ---------------------------------------------------------------------------

async function seedIncident(
  sql: Sql,
  input: {
    title: string
    description?: string | null
    status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
    severity: 'minor' | 'major' | 'critical'
    startedAt: Date
    resolvedAt?: Date | null
  },
): Promise<string> {
  const id = uniqueId('incident')
  await sql`
    insert into incidents (id, title, description, status, severity, affected_components, started_at, resolved_at)
    values (${id}, ${input.title}, ${input.description ?? null}, ${input.status}, ${input.severity},
            '[]'::jsonb, ${input.startedAt}, ${input.resolvedAt ?? null})
  `
  return id
}

interface OutboxEmail {
  to: string
  subject: string
  html: string
  scenario?: string
  sentAt: string
}

async function readServerOutbox(): Promise<OutboxEmail[]> {
  const res = await fetch(`${harness.baseURL}/api/e2e/outbox`)
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { emails: OutboxEmail[] }
  return body.emails
}

async function clearServerOutbox(): Promise<void> {
  const res = await fetch(`${harness.baseURL}/api/e2e/outbox`, { method: 'DELETE' })
  expect(res.ok).toBe(true)
}

/** Extract the unsubscribe link the subscribe-confirmation email carries. */
function unsubscribeLinkFrom(email: OutboxEmail): string {
  const match = email.html.match(/href="([^"]+)"/)
  expect(match, 'confirmation email carries an unsubscribe link').toBeTruthy()
  return match![1]
}

test.describe('status page', () => {
  test('the status API reports db and redis health', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/status')
      const body = await response.json()
      // db + redis are real local services in E2E and must be healthy.
      expect(body.checks.db.ok).toBe(true)
      expect(body.checks.redis.ok).toBe(true)
      expect(typeof body.uptime).toBe('number')
      expect(body.version).toBeTruthy()
      // Overall status is consistent with its own checks.
      const allOk = Object.values(body.checks as Record<string, { ok: boolean }>).every((c) => c.ok)
      expect(body.status).toBe(allOk ? 'ok' : 'degraded')
      expect(response.status()).toBe(allOk ? 200 : 503)
    } finally {
      await api.dispose()
    }
  })

  test('anonymous visitors see component health and seeded incidents in the right buckets', async ({ browser }) => {
    const { sql, clock } = harness
    const openId = await seedIncident(sql, {
      title: 'E2E open incident',
      description: 'Search latency elevated (seeded by spec)',
      status: 'investigating',
      severity: 'major',
      startedAt: clock.minus({ hours: 2 }),
    })
    const resolvedId = await seedIncident(sql, {
      title: 'E2E resolved incident',
      status: 'resolved',
      severity: 'minor',
      startedAt: clock.minus({ days: 3 }),
      // Resolved 90 minutes after it started.
      resolvedAt: new Date(clock.minus({ days: 3 }).getTime() + 90 * 60 * 1000),
    })

    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/incidents')
      expect(response.status()).toBe(200)
      const incidents = (await response.json()) as Array<{ id: string; status: string }>
      expect(incidents.map((i) => i.id)).toEqual(expect.arrayContaining([openId, resolvedId]))
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // `/api/status` answers 503 whenever any component check fails, and its
      // memory check trips at 1 GB RSS — which a `vite dev` app server routinely
      // exceeds on a CI runner. That is the endpoint reporting honestly about a
      // process that is not production, not a fault in what this test asserts:
      // the db and redis rows below still read OK, and they only render at all
      // because the page now reads the body on 503 too.
      guard.allowExpectedFailure(/status of 503/)
      await gotoHydrated(page, `${harness.baseURL}/status`)
      await expect(page.getByTestId('status-page')).toBeVisible()
      await expect(page.getByTestId('status-overall')).toBeVisible()
      await expect(page.getByTestId('status-row-db')).toContainText('OK')
      await expect(page.getByTestId('status-row-redis')).toContainText('OK')
      // Memory is a real, measured check now (plans/UI Wave 4 "Make Status render only real health
      // checks") — it may read OK or DOWN depending on this process's own RSS, but it must render
      // as a genuine row, never the old hard-coded-`ok: true` Search/API rows this replaced.
      await expect(page.getByTestId('status-row-memory')).toBeVisible()
      await expect(page.getByTestId('status-row-search')).toHaveCount(0)
      await expect(page.getByTestId('status-row-api')).toHaveCount(0)

      // Open incident in "Active incidents", resolved one in "Past 30 days".
      await expect(page.getByTestId(`incident-${openId}`)).toBeVisible()
      await expect(page.getByTestId(`incident-${openId}`)).toContainText('investigating')
      await expect(page.getByTestId(`incident-${resolvedId}`)).toBeVisible()
      await expect(page.getByTestId(`incident-${resolvedId}`)).toContainText('E2E resolved incident')

      // Cross-links to the other public trust surfaces (scoped to the status
      // page container — the landing footer carries its own copies).
      const statusPage = page.getByTestId('status-page')
      await expect(statusPage.getByRole('link', { name: 'changelog' })).toHaveAttribute('href', '/changelog')
      await expect(statusPage.getByRole('link', { name: 'roadmap' })).toHaveAttribute('href', '/roadmap')
    })
  })

  test('subscribing shows a uniform success message for a new and a repeat address, and delivers a confirmation email', async ({ browser }) => {
    await clearServerOutbox()
    const email = `e2e-sub-${uniqueId('status-sub')}@e2e.test`

    await withPage(browser, undefined, async (page, guard) => {
      guard.allowExpectedFailure(/status of 503/)
      await gotoHydrated(page, `${harness.baseURL}/status`)
      const form = page.getByTestId('subscribe-form')
      await form.locator('#status-subscribe-email').fill(email)
      await form.getByRole('button', { name: 'Subscribe' }).click()
      await expect(page.getByTestId('subscribe-success')).toBeVisible()
    })

    const [confirmation] = await readServerOutbox()
    expect(confirmation?.to).toBe(email)
    expect(confirmation?.scenario).toBe('status_subscribe_confirmation')
    await clearServerOutbox()

    // Repeat subscribe with the SAME address: an enumeration probe must see the identical success
    // UI, not a different message revealing the address was already on the list.
    await withPage(browser, undefined, async (page, guard) => {
      guard.allowExpectedFailure(/status of 503/)
      await gotoHydrated(page, `${harness.baseURL}/status`)
      const form = page.getByTestId('subscribe-form')
      await form.locator('#status-subscribe-email').fill(email)
      await form.getByRole('button', { name: 'Subscribe' }).click()
      await expect(page.getByTestId('subscribe-success')).toBeVisible()
    })
    // No second confirmation email — the repeat subscribe never re-sends the (single-use) token.
    expect(await readServerOutbox()).toHaveLength(0)
  })

  test('the emailed unsubscribe link stops further mail, and clicking it again reports invalid', async ({ browser }) => {
    await clearServerOutbox()
    const email = `e2e-unsub-${uniqueId('status-sub')}@e2e.test`
    const subscribeRes = await fetch(`${harness.baseURL}/api/status/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(subscribeRes.ok).toBe(true)

    const [confirmation] = await readServerOutbox()
    const unsubscribeUrl = unsubscribeLinkFrom(confirmation)

    await withPage(browser, undefined, async (page) => {
      await page.goto(unsubscribeUrl)
      await page.waitForURL(/\/status\?unsubscribed=ok/)
      await expect(page.getByTestId('unsubscribe-result')).toContainText('unsubscribed')
    })

    const [subscriberRow] = await harness.sql<{ unsubscribed_at: Date | null }[]>`
      select unsubscribed_at from status_subscribers where email_lower = ${email.toLowerCase()}
    `
    expect(subscriberRow?.unsubscribed_at).not.toBeNull()

    // The same link again: the row is already unsubscribed, so this must report invalid rather
    // than a second "ok" — the token is single-use, not idempotently re-clickable forever.
    await withPage(browser, undefined, async (page) => {
      await page.goto(unsubscribeUrl)
      await page.waitForURL(/\/status\?unsubscribed=invalid/)
      await expect(page.getByTestId('unsubscribe-result')).toContainText('invalid')
    })
  })

  test('a platform admin creating and resolving an incident emails every confirmed subscriber', async () => {
    await clearServerOutbox()
    const email = `e2e-incident-${uniqueId('status-sub')}@e2e.test`
    const subscribeRes = await fetch(`${harness.baseURL}/api/status/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(subscribeRes.ok).toBe(true)
    await clearServerOutbox() // the confirmation email isn't what this test is about

    const created = await harness.admin.api!.post('/api/admin/incidents', {
      data: { title: 'E2E notified incident', severity: 'major', affectedComponents: ['api'] },
    })
    expect(created.status()).toBeLessThan(300)
    const { id: incidentId } = await created.json() as { id: string }

    const afterCreate = await readServerOutbox()
    const opened = afterCreate.find((e) => e.to === email && e.scenario === 'status_incident')
    expect(opened, 'subscriber is emailed when the incident opens').toBeTruthy()
    await clearServerOutbox()

    const resolved = await harness.admin.api!.patch(`/api/admin/incidents/${incidentId}`, {
      data: { status: 'resolved' },
    })
    expect(resolved.status()).toBeLessThan(300)

    const afterResolve = await readServerOutbox()
    const resolution = afterResolve.find((e) => e.to === email && e.scenario === 'status_incident')
    expect(resolution, 'subscriber is emailed when the incident resolves').toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Public builder profiles — publication + anonymous-data-redaction boundary
// ---------------------------------------------------------------------------

interface SeededIdentity {
  id: string
  username: string
}

async function seedIdentity(
  sql: Sql,
  input: { username: string; displayName?: string | null; bio?: string | null },
): Promise<SeededIdentity> {
  const id = uniqueId('pub-identity')
  await sql`
    insert into builder_identities (id, source, source_id, username, display_name, bio, profile_url, followers_count)
    values (${id}, 'github', ${id}, ${input.username}, ${input.displayName ?? null},
            ${input.bio ?? null}, ${`https://e2e.test/github/${input.username}`}, 321)
  `
  return { id, username: input.username }
}

test.describe('public builder profiles', () => {
  test('a published profile is visible to anonymous visitors with only public fields (redaction)', async ({ browser }) => {
    const { sql, owner, organization } = harness
    const username = `e2e-pub-${uniqueId('u').slice(-8)}`
    const hostileBio = '<script>window.__builderXss=1</script> Rust maintainer'
    const identity = await seedIdentity(sql, {
      username,
      displayName: 'E2E Published Builder',
      bio: 'identity-level bio',
    })
    await sql`
      insert into published_builder_profiles (builder_identity_id, published_by_user_id, display_name, bio, open_to_status, topics)
      values (${identity.id}, ${owner.userId!}, 'E2E Published Builder', ${hostileBio},
              '["consulting"]'::jsonb, '["rust","async"]'::jsonb)
    `
    // Legacy `builders` row with the same id feeds the route's SSR head/meta.
    // `organization_id` became NOT NULL in drizzle/0081, so the row needs the
    // owner's tenant even though this test only reads it anonymously.
    await sql`
      insert into builders (id, user_id, organization_id, source, source_id, username, display_name, bio, profile_url)
      values (${identity.id}, ${owner.userId!}, ${organization.organizationId}, 'github', ${identity.id}, ${username},
              'E2E Published Builder', 'meta bio', ${`https://e2e.test/github/${username}`})
    `

    // Anonymous API view: public fields only — nothing tenant- or
    // account-scoped leaks through.
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(`/api/builders/${identity.id}`)
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.id).toBe(identity.id)
      expect(body.username).toBe(username)
      expect(body.displayName).toBe('E2E Published Builder')
      expect(body.isClaimed).toBe(false)
      expect(body.claimedByUserId).toBeNull()
      for (const forbidden of [
        'privateMetadata',
        'organizationId',
        'creatorUserId',
        'email',
        'publishedByUserId',
        'userId',
      ]) {
        expect(body, `public builder payload must not expose ${forbidden}`).not.toHaveProperty(forbidden)
      }

      // SSR head/meta: OG profile tags are emitted for the public page.
      const html = await (await api.get(`/builders/${identity.id}`)).text()
      expect(html).toContain('property="og:type"')
      expect(html).toContain('profile')
      expect(html).toContain('E2E Published Builder')
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // Anonymous visitors have no tenant, so every account-scoped card on the
      // profile is rejected without breaking the public page. The page's own
      // notes/stats calls are now skipped when there is no session; what remains
      // is three cards that mount unconditionally and each fetch on their own —
      // PersonaCard (`/enrichment`), TeamFitCard (`/synergy`) and
      // WorkSamplePanel. Doubled for dev-mode StrictMode remounts.
      //
      // 401 or 503 depending on the environment: with an AI provider configured
      // the auth guard rejects first, without one `/enrichment` answers 503
      // `ai_unconfigured` before it gets that far. CI has no provider, a
      // developer machine usually does, and this test cares about neither.
      //
      // Whether those three should render for a signed-out visitor at all is a
      // product question, not a test one: "team fit against your tracked
      // builders" has no meaning without an account. Left as-is deliberately.
      for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of (401|503)/)
      await gotoHydrated(page, `${harness.baseURL}/builders/${identity.id}`)
      await expect(page.locator('h1')).toContainText('E2E Published Builder')
      // Hostile bio renders as inert text.
      await expect(page.getByText('<script>window.__builderXss=1</script>', { exact: false })).toBeVisible()
      expect(
        await page.evaluate(() => (window as { __builderXss?: number }).__builderXss),
      ).toBeUndefined()
    })
  })

  test('a tracked-but-unpublished builder is hidden from anonymous callers but visible to their organization', async ({ browser }) => {
    const { sql, owner, organization } = harness
    const identity = await seedIdentity(sql, {
      username: `e2e-priv-${uniqueId('u').slice(-8)}`,
      displayName: 'E2E Private Tracked Builder',
    })
    const trackingId = uniqueId('org-builder')
    await sql`
      insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id, visibility, status, private_metadata)
      values (${trackingId}, ${organization.organizationId}, ${identity.id}, ${owner.userId!},
              'organization', 'tracked', '{"topics":["secret-sourcing-topic"],"country":"Denmark"}'::jsonb)
    `

    // Anonymous: the builder does not exist publicly — API 404 and the page
    // renders its not-found card. Private tenant data is fully redacted.
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(`/api/builders/${identity.id}`)
      expect(response.status()).toBe(404)
      const text = await response.text()
      expect(text).not.toContain('secret-sourcing-topic')
      expect(text).not.toContain('Denmark')
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // The builder 404 and the tenant-only notes 401 — each possibly
      // twice (dev-mode StrictMode re-runs the mount effect).
      for (let i = 0; i < 2; i++) {
        guard.allowExpectedFailure(/status of 404/)
        guard.allowExpectedFailure(/status of 401/)
      }
      await gotoHydrated(page, `${harness.baseURL}/builders/${identity.id}`)
      await expect(page.getByTestId('builder-not-found')).toBeVisible()
    })

    // The organization that tracks the builder still sees it, including the
    // org's own private annotations.
    const memberView = await owner.api!.get(`/api/builders/${identity.id}`)
    expect(memberView.status()).toBe(200)
    const body = await memberView.json()
    expect(body.username).toBe(identity.username)
    expect(body.topics).toContain('secret-sourcing-topic')
    expect(body.country).toBe('Denmark')
    // Even the tenant view never exposes raw internals.
    expect(body).not.toHaveProperty('privateMetadata')
    expect(body).not.toHaveProperty('organizationId')
  })

  test('an unknown builder id is a 404 on the API and a not-found card on the page', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/builders/definitely-not-a-builder')
      expect(response.status()).toBe(404)
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page, guard) => {
      // The builder 404 and the tenant-only notes 401 — each possibly
      // twice (dev-mode StrictMode re-runs the mount effect).
      for (let i = 0; i < 2; i++) {
        guard.allowExpectedFailure(/status of 404/)
        guard.allowExpectedFailure(/status of 401/)
      }
      await gotoHydrated(page, `${harness.baseURL}/builders/definitely-not-a-builder`)
      await expect(page.getByTestId('builder-not-found')).toBeVisible()
    })
  })
})
