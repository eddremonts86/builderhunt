/**
 * Wave 2 Task 6 — crawl/discovery surfaces: robots.txt, sitemap.xml, the
 * blog Atom feed, the public /explore experience, OG image responses, and
 * the capability-token-protected saved-search RSS feed.
 *
 * Determinism note: `/explore`, `/api/og/explore`, and `/api/feeds/:id`
 * all call `searchBuilders`, whose FIRST cache layer is Redis
 * (`search:<key>`). Every test that would otherwise fan out to real
 * external sources seeds that Redis key with unique, worker-scoped
 * keywords first — the seeded usernames are then asserted verbatim, so a
 * cache-key mismatch (which would silently fall through to live search)
 * fails loudly instead of passing on nondeterministic data.
 */
import { test, expect, type Browser, type Page } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import Redis from 'ioredis'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

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
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { uniqueId } from './harness/ids'
import {
  expectStrictBrowser,
  gotoHydrated,
  type StrictBrowserGuard,
} from './harness/browser'
import { createFeedCapability } from '../../src/shared/lib/security/feed-capability'

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
  redis: Redis
  seededSearchKeys: string[]
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
  let redis: Redis | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    redis = new Redis(env.REDIS_URL!, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}feeds` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock,
    })

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
      redis,
      seededSearchKeys: [],
    }

    // Warm the dev server's SSR compile pipeline before the first test —
    // a cold vite worker can take tens of seconds on its first render.
    // (Plain fetch, not a browser context: Playwright tracing does not
    // cope well with browser contexts opened inside beforeAll.)
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
  } catch (error) {
    redis?.disconnect()
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
  // The `search:*` cache keys are deliberately app-global (the app reads
  // them unprefixed) — remove exactly the keys this spec seeded.
  if (h.seededSearchKeys.length > 0) {
    await h.redis.del(...h.seededSearchKeys).catch(() => undefined)
  }
  h.redis.disconnect()
  await disposePrincipal(h.owner).catch(() => undefined)
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

// --- search cache seeding (mirrors cacheKey() in src/lib/search.ts) --------

interface FakeBuilder {
  id: string
  kind: 'person' | 'repo'
  source: 'github'
  sourceId: string
  username: string
  displayName?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  topics: string[]
  metadata: Record<string, unknown>
  lastSeen?: string
}

function searchCacheKey(opts: {
  keywords: string[]
  sources?: string[]
  country?: string
  language?: string
  page?: number
  perPage?: number
}): string {
  return `${[...opts.keywords].sort().join(',')}-${[...(opts.sources ?? [])].sort().join(',')}-${opts.country ?? ''}-${opts.language ?? ''}-${opts.page ?? 1}-${opts.perPage ?? 30}`
}

async function seedSearchCache(
  opts: Parameters<typeof searchCacheKey>[0],
  builders: FakeBuilder[],
): Promise<void> {
  const key = `search:${searchCacheKey(opts)}`
  harness.seededSearchKeys.push(key)
  // Match the app's own write: 5-minute TTL is plenty for one spec run.
  await harness.redis.set(key, JSON.stringify(builders), 'EX', 300)
}

function fakePerson(tag: string, n: number): FakeBuilder {
  const id = `${tag}-person-${n}`
  return {
    id,
    kind: 'person',
    source: 'github',
    sourceId: id,
    username: `${tag}-user-${n}`,
    displayName: `E2E Person ${tag} ${n}`,
    bio: `Deterministic seeded person #${n} for ${tag}`,
    profileUrl: `https://e2e.test/github/${id}`,
    followersCount: 1000 + n,
    topics: ['rust', 'async'],
    metadata: { lastSeen: Date.now() - 60_000 },
    lastSeen: new Date(Date.now() - 60_000).toISOString(),
  }
}

function fakeRepo(tag: string, n: number): FakeBuilder {
  const id = `${tag}-repo-${n}`
  return {
    id,
    kind: 'repo',
    source: 'github',
    sourceId: id,
    username: `${tag}/repo-${n}`,
    displayName: `E2E Repo ${tag} ${n}`,
    bio: `Deterministic seeded repository #${n} for ${tag}`,
    profileUrl: `https://e2e.test/github/${id}`,
    followersCount: 250 + n,
    language: 'Rust',
    topics: ['runtime'],
    metadata: { lastSeen: Date.now() - 120_000 },
  }
}

/** Unique, url-safe keyword tag per call — never collides across workers/runs. */
function keywordTag(label: string): string {
  return `e2e${label}${uniqueId('kw').replace(/[^a-z0-9]/g, '').slice(-10)}`
}

// ---------------------------------------------------------------------------
// robots.txt / sitemap.xml / blog Atom feed
// ---------------------------------------------------------------------------

/**
 * The canonical origin these surfaces emit is `SITE_URL`, resolved from the
 * app's own `APP_URL` and deliberately never hardcoded (see
 * `src/shared/lib/site-url.ts`). `playwright.config.ts` hands the e2e server
 * `APP_URL: baseURL`, so under test that origin *is* the harness base URL.
 *
 * These three assertions used to pin `https://builderhunt.dev` literally, which
 * meant they could only pass against one deployment and failed everywhere else
 * — including CI, which sets `APP_URL: http://localhost:3000`. Deriving the
 * origin keeps what actually matters: the URLs are absolute and all sit on the
 * one configured canonical host.
 */
function canonicalOrigin(): string {
  return harness.baseURL.replace(/\/+$/, '')
}

test.describe('crawler surfaces', () => {
  test('robots.txt allows public content, blocks private surfaces, and points at the sitemap', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/robots.txt')
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('text/plain')
      // 60s, not the hour it used to be: per-surface indexing is now switched
      // from the admin, and an hour of cache would leave a surface crawlable
      // long after someone chose to pull it out of the index.
      expect(response.headers()['cache-control']).toContain('max-age=60')
      const body = await response.text()
      expect(body).toContain('User-agent: *')
      expect(body).toContain('Allow: /explore')
      expect(body).toContain('Disallow: /api/')
      expect(body).toContain('Disallow: /dashboard/')
      expect(body).toContain('User-agent: GPTBot')
      expect(body).toContain(`Sitemap: ${canonicalOrigin()}/sitemap.xml`)
    } finally {
      await api.dispose()
    }
  })

  test('sitemap.xml is valid urlset XML covering the public pages and curated explore queries', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/sitemap.xml')
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('application/xml')
      const body = await response.text()
      expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
      // Always in the sitemap: these pages are not behind the indexing switch.
      for (const path of ['/', '/explore', '/status', '/legal/terms']) {
        expect(body).toContain(`<loc>${canonicalOrigin()}${path === '/' ? '/' : path}</loc>`)
      }
      // Never in it while the switch sits at its default. `DEFAULT_DIRECTIVES`
      // is `{noindex: true}` — it fails closed on purpose, because an
      // un-indexed page is recoverable in a moment and an indexed one takes
      // weeks to walk back. This disposable database has no
      // `public_surface_indexing` rows, so the admin-gated surfaces must be
      // absent; listing a noindex URL in a sitemap is a contradictory
      // instruction to a crawler.
      for (const path of ['/changelog', '/roadmap']) {
        expect(body, `${path} is noindex by default and must not be advertised`)
          .not.toContain(`<loc>${canonicalOrigin()}${path}</loc>`)
      }
      // Curated explore queries are URL-encoded entries.
      expect(body).toContain('/explore?q=rust%20async%20runtime')
      // Well-formed: every <url> is closed.
      expect((body.match(/<url>/g) ?? []).length).toBe((body.match(/<\/url>/g) ?? []).length)
    } finally {
      await api.dispose()
    }
  })

  test('the blog Atom feed lists exactly the posts the blog page shows', async ({ browser }) => {
    const api = await newApiContext(harness.baseURL)
    let atomEntryCount = 0
    try {
      const response = await api.get('/blog/atom.xml')
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('application/atom+xml')
      const body = await response.text()
      expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
      expect(body).toContain(`<link href="${canonicalOrigin()}/blog/atom.xml" rel="self" />`)
      atomEntryCount = (body.match(/<entry>/g) ?? []).length
      expect(atomEntryCount).toBeGreaterThanOrEqual(3)
      expect(body).toContain(`${canonicalOrigin()}/blog/why-i-built-builderhunt`)
    } finally {
      await api.dispose()
    }

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/blog`)
      const cards = page.locator('[data-testid^="blog-post-card-"]')
      expect(await cards.count()).toBe(atomEntryCount)
    })
  })
})

// ---------------------------------------------------------------------------
// /explore — anonymous discovery
// ---------------------------------------------------------------------------

test.describe('explore', () => {
  test('without a query: hero, sources, intents, and the seeded featured builders', async ({ browser }) => {
    // The empty-query page runs the FEATURED_QUERY search server-side —
    // seed its exact cache slot so no live source is contacted.
    const featuredTag = keywordTag('feat')
    const featured = [fakePerson(featuredTag, 1), fakePerson(featuredTag, 2)]
    await seedSearchCache(
      { keywords: ['open', 'source', 'maintainers'], perPage: 6, page: 1 },
      featured,
    )

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/explore`)
      await expect(page.getByTestId('explore-page')).toBeVisible()
      await expect(page.locator('h1')).toContainText('Find the people building')
      await expect(page.getByTestId('explore-sources')).toBeVisible()
      await expect(page.getByTestId('explore-intents')).toBeVisible()
      await expect(page.getByTestId('explore-popular')).toBeVisible()

      await expect(page.getByTestId('explore-featured')).toBeVisible()
      await expect(page.getByTestId(`person-card-${featured[0].id}`)).toBeVisible()
      await expect(page.getByTestId(`person-card-${featured[1].id}`)).toBeVisible()
    })
  })

  test('with a query: people/resources tabs, counts, JSON-LD, and the sign-up CTA', async ({ browser }) => {
    const tag = keywordTag('mix')
    const keywords = [`${tag}alpha`, `${tag}beta`]
    const q = keywords.join(' ')
    const people = [fakePerson(tag, 1), fakePerson(tag, 2), fakePerson(tag, 3)]
    const repos = [fakeRepo(tag, 1), fakeRepo(tag, 2)]
    await seedSearchCache({ keywords, perPage: 50, page: 1 }, [...people, ...repos])

    await withPage(browser, undefined, async (page, guard) => {
      // KNOWN PRODUCT ISSUE: ExplorePage builds its ItemList JSON-LD (and
      // og:image URL) from `typeof window !== 'undefined' ?
      // window.location.origin : 'https://builderhunt.dev'`, so the client
      // render never matches the SSR output when the app origin is not
      // builderhunt.dev — React logs a recoverable hydration mismatch.
      // Tracked as a plan issue; allowed here (console + pageerror) so the
      // guard stays armed for everything else.
      for (let i = 0; i < 2; i++) {
        guard.allowExpectedFailure(/hydration-mismatch|Hydration failed|error while hydrating/)
      }
      await gotoHydrated(page, `${harness.baseURL}/explore?q=${encodeURIComponent(q)}`)
      await expect(page.getByTestId('explore-results')).toBeVisible()
      await expect(page.getByTestId('explore-tab-people')).toContainText('3')
      await expect(page.getByTestId('explore-tab-resources')).toContainText('2')

      // People tab (default) shows the seeded persons.
      await expect(page.getByTestId(`person-card-${people[0].id}`)).toBeVisible()

      // Switching tabs is a client-side navigation to type=resources.
      await page.getByTestId('explore-tab-resources').click()
      await expect(page).toHaveURL(/type=resources/)
      await expect(page.getByText(`E2E Repo ${tag} 1`)).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open resource' }).first()).toBeVisible()

      // Redirect/auth boundary: saving the search requires an account.
      await page.getByTestId('explore-tab-people').click()
      await expect(page.getByTestId('explore-cta-signup')).toHaveAttribute(
        'href',
        /\/auth\/sign-up/,
      )

      // Structured data for crawlers — the root document carries its own
      // site-wide JSON-LD, so find the ItemList among all blocks.
      const jsonLdBlocks = await page
        .locator('script[type="application/ld+json"]')
        .allTextContents()
      const itemList = jsonLdBlocks
        .flatMap((raw) => {
          try {
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            return []
          }
        })
        .find((entry) => entry?.['@type'] === 'ItemList')
      expect(itemList).toBeTruthy()
      expect(itemList.numberOfItems).toBe(3)
    })
  })

  test('empty result set renders the widen-your-search state', async ({ browser }) => {
    const tag = keywordTag('none')
    const keywords = [`${tag}nothing`]
    await seedSearchCache({ keywords, perPage: 50, page: 1 }, [])

    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/explore?q=${encodeURIComponent(keywords[0])}`)
      await expect(page.getByTestId('explore-empty')).toBeVisible()
      await expect(page.getByTestId('explore-empty')).toContainText('Try widening the search')
    })
  })

  test('a sub-2-character query is treated as no query (validation boundary)', async ({ browser }) => {
    // Single character never reaches the search pipeline — the discovery
    // landing state renders instead of a results section. Seed the featured
    // slot again in case the earlier entry expired.
    const featuredTag = keywordTag('feat2')
    await seedSearchCache(
      { keywords: ['open', 'source', 'maintainers'], perPage: 6, page: 1 },
      [fakePerson(featuredTag, 9)],
    )
    await withPage(browser, undefined, async (page) => {
      await gotoHydrated(page, `${harness.baseURL}/explore?q=a`)
      await expect(page.getByTestId('explore-intents')).toBeVisible()
      await expect(page.getByTestId('explore-results')).toHaveCount(0)
    })
  })

  test('explore SSR emits OG metadata pointing at the dynamic OG image', async () => {
    const tag = keywordTag('og')
    const keywords = [`${tag}query`]
    await seedSearchCache({ keywords, perPage: 50, page: 1 }, [fakePerson(tag, 1)])

    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(`/explore?q=${encodeURIComponent(keywords[0])}`)
      expect(response.status()).toBe(200)
      const html = await response.text()
      expect(html).toContain('property="og:image"')
      expect(html).toContain('/api/og/explore?q=')
      expect(html).toContain('summary_large_image')
    } finally {
      await api.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// OG image endpoint
// ---------------------------------------------------------------------------

test.describe('OG image endpoint', () => {
  test('without a query it returns a cacheable raster image', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/api/og/explore')
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('image/png')
      expect(response.headers()['cache-control']).toContain('max-age=3600')
      expect((await response.body()).length).toBeGreaterThan(1000)
    } finally {
      await api.dispose()
    }
  })

  test('with a seeded query it renders successfully', async () => {
    const tag = keywordTag('ogimg')
    const keywords = [`${tag}gamma`]
    await seedSearchCache({ keywords, perPage: 20, page: 1 }, [fakePerson(tag, 1), fakePerson(tag, 2)])

    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(`/api/og/explore?q=${encodeURIComponent(keywords[0])}`)
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('image/png')
      expect((await response.body()).length).toBeGreaterThan(1000)
    } finally {
      await api.dispose()
    }
  })

  test('a hostile query is escaped, never breaking the image render', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      // 1-char-per-keyword hostile input below the 2-char search threshold
      // exercises the escape path without touching the search pipeline.
      const response = await api.get(`/api/og/explore?q=${encodeURIComponent('<')}`)
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('image/png')
    } finally {
      await api.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Saved-search RSS feed (capability tokens)
// ---------------------------------------------------------------------------

interface SeededFeed {
  searchId: string
  token: string
  keywords: string[]
  name: string
  builder: FakeBuilder
}

async function seedFeed(): Promise<SeededFeed> {
  const { sql, owner, organization } = harness
  const secret = process.env.BETTER_AUTH_SECRET
  expect(secret, 'BETTER_AUTH_SECRET must be present to sign feed capabilities').toBeTruthy()

  const tag = keywordTag('feed')
  const keywords = [`${tag}delta`, `${tag}epsilon`]
  const searchId = uniqueId('saved-query')
  const name = 'Rust & <Async> "Devs"'
  await sql`
    insert into saved_queries (id, organization_id, user_id, name, keywords, sources)
    values (${searchId}, ${organization.organizationId}, ${owner.userId!}, ${name},
            ${JSON.stringify(keywords)}::jsonb, '["github"]'::jsonb)
  `
  const builder = fakePerson(tag, 1)
  await seedSearchCache({ keywords, sources: ['github'], perPage: 50, page: 1 }, [builder])
  const token = createFeedCapability(organization.organizationId, searchId, secret!)
  return { searchId, token, keywords, name, builder }
}

test.describe('saved-search RSS feed', () => {
  let feed: SeededFeed

  test.beforeAll(async () => {
    feed = await seedFeed()
  })

  test('a valid capability token yields the RSS document with escaped content', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(
        `/api/feeds/${feed.searchId}?token=${encodeURIComponent(feed.token)}`,
      )
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('application/rss+xml')
      expect(response.headers()['cache-control']).toContain('max-age=3600')
      const xml = await response.text()
      expect(xml).toContain('<rss version="2.0"')
      // Hostile search name is XML-escaped in the channel title.
      expect(xml).toContain('Rust &amp; &lt;Async&gt; &quot;Devs&quot;')
      expect(xml).not.toContain('<Async>')
      // The seeded builder is an item.
      expect(xml).toContain(`builderhunt-builder-${feed.builder.id}`)
      expect(xml).toContain(feed.builder.displayName!)
      // Self link keeps the capability token.
      expect(xml).toContain('rel="self"')
    } finally {
      await api.dispose()
    }
  })

  test('browsers get the human-readable HTML fallback for the same URL', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(
        `/api/feeds/${feed.searchId}?token=${encodeURIComponent(feed.token)}`,
        { headers: { accept: 'text/html,application/xhtml+xml' } },
      )
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toContain('text/html')
      const html = await response.text()
      expect(html).toContain('public RSS feed')
      expect(html).toContain(feed.builder.displayName!)
      // Hostile name is HTML-escaped here too.
      expect(html).toContain('Rust &amp; &lt;Async&gt;')
    } finally {
      await api.dispose()
    }
  })

  test('missing, malformed, or foreign tokens are all an indistinguishable 404', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      // No token at all.
      const missing = await api.get(`/api/feeds/${feed.searchId}`)
      expect(missing.status()).toBe(404)
      expect(await missing.text()).toBe('Feed not found')

      // Garbage token.
      const garbage = await api.get(`/api/feeds/${feed.searchId}?token=not.a.token`)
      expect(garbage.status()).toBe(404)

      // Structurally valid token signed for a DIFFERENT search id.
      const otherId = uniqueId('saved-query-other')
      const foreign = createFeedCapability(
        harness.organization.organizationId,
        otherId,
        process.env.BETTER_AUTH_SECRET!,
      )
      const mismatched = await api.get(
        `/api/feeds/${feed.searchId}?token=${encodeURIComponent(foreign)}`,
      )
      expect(mismatched.status()).toBe(404)

      // Token signed with the wrong secret.
      const forged = createFeedCapability(
        harness.organization.organizationId,
        feed.searchId,
        'not-the-real-secret',
      )
      const forgedResponse = await api.get(
        `/api/feeds/${feed.searchId}?token=${encodeURIComponent(forged)}`,
      )
      expect(forgedResponse.status()).toBe(404)
    } finally {
      await api.dispose()
    }
  })

  test('a token scoped to another organization cannot read this feed (tenant boundary)', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const crossTenant = createFeedCapability(
        'org-that-does-not-own-this-search',
        feed.searchId,
        process.env.BETTER_AUTH_SECRET!,
      )
      const response = await api.get(
        `/api/feeds/${feed.searchId}?token=${encodeURIComponent(crossTenant)}`,
      )
      expect(response.status()).toBe(404)
    } finally {
      await api.dispose()
    }
  })

  test('a valid token for a search that was deleted is 404', async () => {
    const { sql, organization } = harness
    const ghostId = uniqueId('saved-query-ghost')
    const token = createFeedCapability(
      organization.organizationId,
      ghostId,
      process.env.BETTER_AUTH_SECRET!,
    )
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get(`/api/feeds/${ghostId}?token=${encodeURIComponent(token)}`)
      expect(response.status()).toBe(404)
    } finally {
      await api.dispose()
    }
    // (nothing to clean — the row never existed)
    void sql
  })

  // LAST feed test on purpose: it exhausts the per-IP budget for this
  // server process, so anything after it would be throttled.
  test('the feed endpoint rate-limits abusive clients with 429', async () => {
    test.setTimeout(120_000)
    const api = await newApiContext(harness.baseURL)
    try {
      let sawRateLimit = false
      for (let i = 0; i < 70; i++) {
        const response = await api.get(`/api/feeds/${feed.searchId}?token=nope`)
        if (response.status() === 429) {
          expect(await response.text()).toContain('Rate limit exceeded')
          sawRateLimit = true
          break
        }
        expect(response.status()).toBe(404)
      }
      expect(sawRateLimit, 'expected a 429 within 70 unauthenticated feed requests').toBe(true)
    } finally {
      await api.dispose()
    }
  })
})
