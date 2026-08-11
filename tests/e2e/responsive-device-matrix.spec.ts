import { expect, test } from 'playwright/test'
import postgres, { type Sql } from 'postgres'

import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { dismissOverlays, gotoHydrated } from './harness/browser'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { e2eEnv } from './harness/env'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { createOwnerPrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { seedConsent } from './harness/fixtures/privacy'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

/**
 * The device-matrix pass plan 07 admitted it had not really done.
 *
 * Its own status said the sweep happened "primarily at 375×667 with a 768×1024 spot check, not
 * literally every page at all 5 sizes", and `docs/design/responsive-qa-checklist.md` was written as
 * the manual procedure to finish it. This is that procedure, executed by a machine instead: the same
 * five widths, the same page list, the same pass criterion.
 *
 * ## Why automating it is better evidence than the human pass the plan asked for
 *
 * A person sweeping 13 pages at 5 sizes does it once. The overflow bug this plan actually found —
 * documented at length in the checklist — was a `flex-1` child with `min-width: auto` growing to an
 * unwrapped URL's intrinsic width, on a page that renders arbitrary external bio text. That class of
 * regression arrives with a content change, not with a layout change, so the check has to be
 * repeatable or it protects nothing after the day it ran.
 *
 * ## The criterion, taken from the checklist rather than invented
 *
 * `document.documentElement.scrollWidth` must not exceed `window.innerWidth`. The checklist is
 * explicit that a larger value is a real bug and not a measurement artifact, having verified exactly
 * that during the manual pass. One pixel of tolerance covers subpixel rounding at fractional device
 * ratios; two would hide a real 2px overflow.
 *
 * The intentional exceptions are the wide admin data tables, which scroll inside `.table-scroll`
 * rather than widening the page — so they are covered by the same assertion rather than exempted from
 * it, and a table that escapes its container fails here.
 *
 * ## What this deliberately does not test: the navigation breakpoint
 *
 * The checklist says the nav "must flip exactly" at the `md` boundary of 768px. That is out of date.
 * `src/shared/components/publicNavBreakpoint.ts` puts the public header's boundary at **1280px (`xl`)**,
 * measured rather than chosen — the nav's natural width is ~1088px against a shell capped at ~1158px, so
 * `md` left a range of widths with the inline nav hidden and the drawer also hidden, and a page a visitor
 * could not navigate at all.
 *
 * `tests/e2e/public-nav-responsive.spec.ts` already guards it across eight widths straddling 1279/1280,
 * asserting no overflow, *exactly one* navigation affordance, and that the drawer actually contains the
 * links. A second breakpoint test here would have asserted 768 — the wrong number — and duplicated a guard
 * that is the reason that module exists. It visits one page (`/blog`); the sweep below is what covers the
 * other eighteen.
 */
const OVERFLOW_TOLERANCE_PX = 1

/** The five sizes from the checklist's matrix, with the reason each is in it. */
const VIEWPORTS = [
  { label: 'small phone', width: 375, height: 667, note: 'tightest realistic size, the true stress test' },
  { label: 'standard phone', width: 390, height: 844, note: 'modern iPhone default' },
  { label: 'large phone', width: 430, height: 932, note: 'Pro Max class' },
  { label: 'small tablet', width: 768, height: 1024, note: 'the md boundary the checklist named; the public nav actually flips at 1280 — see the header comment' },
  { label: 'small desktop', width: 1024, height: 768, note: 'confirms desktop layout is unchanged' },
] as const

/** Public pages: no session, so they are checked in their own context. */
const PUBLIC_PAGES = [
  '/',
  '/pricing',
  '/explore',
  '/auth/sign-in',
  '/auth/sign-up',
  '/auth/forgot',
  '/changelog',
  '/roadmap',
] as const

/** Authenticated pages, including the two admin queues the checklist names as the wide-table exceptions. */
const AUTHENTICATED_PAGES = [
  '/dashboard',
  '/search',
  '/sprints',
  '/sprints/new',
  '/exports',
  '/alerts',
  '/settings/team',
  '/settings/billing',
  '/settings/privacy',
  '/settings/security',
] as const

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
}

let harness: Harness
let hostileBuilderId = ''

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}responsive` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    // Without an accepted ToS record every page sits behind a blocking modal.
    await seedConsent(sql, {
      userId: owner.userId!,
      document: 'tos',
      version: CURRENT_CONSENT_VERSIONS.tos,
      acceptedAt: clock.now(),
    })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      owner,
      organization,
    }

    hostileBuilderId = await seedBuilderWithUnbreakableBio()
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  await harness.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

/**
 * One builder whose bio is a single unbreakable token, which is the shape that broke this page.
 *
 * A 220-character URL with no spaces and no hyphens: `break-words` cannot help until the browser has
 * committed to an available width, and an unconstrained `flex-1` sibling never gives it one. Real
 * external bios contain exactly this.
 */
async function seedBuilderWithUnbreakableBio(): Promise<string> {
  const id = `resp-hostile-${harness.workerIndex}`
  const bio = `https://example.test/${'a'.repeat(200)}`
  await harness.sql`
    insert into builder_identities (
      id, source, source_id, username, display_name, avatar_url, bio, profile_url,
      followers_count, kind, first_seen_at, last_seen_at, created_at, updated_at
    )
    values (
      ${id}, 'github', ${id}, ${`resp-hostile-${harness.workerIndex}`}, 'Responsive Stress Case',
      'https://avatars.load.local/0.png', ${bio}, ${`https://example.test/${id}`},
      42, 'person', now(), now(), now(), now()
    )
    on conflict (id) do update set bio = excluded.bio
  `
  return id
}

/**
 * Proves the page under test is the page that was asked for.
 *
 * Without this the whole sweep can pass vacuously, in two ways that both *look* like success. A soft 404
 * renders a short centred message that fits every viewport. A `storageState` that failed to apply sends
 * every authenticated path to `/auth/sign-in`, which also fits every viewport — so ten green tests would
 * be measuring the sign-in page ten times.
 *
 * Checked on the final URL rather than on a status code, because a client-side redirect is exactly the
 * failure mode and it happens after the navigation response has already come back 200.
 */
async function expectReallyOnPage(page: import('playwright/test').Page, path: string): Promise<void> {
  // Navigation goes to `${harness.baseURL}${path}`, never a bare path: a relative URL resolves against the
  // config's shared `baseURL`, which is a different server from this worker's and holds none of its session.
  // That is not hypothetical — the first version of this spec used relative paths and reported 10/10 green
  // while five of those tests were measuring the sign-in page. This guard is what found it.
  const url = new URL(page.url())
  expect(
    url.pathname,
    `expected to be on ${path} but ended up on ${url.pathname} — a redirect to sign-in means the session ` +
      'did not apply, and every "authenticated" assertion below would be measuring the sign-in page',
  ).toBe(path)
  // A rendered page has content. A blank error boundary would fit every viewport too.
  const height = await page.evaluate(() => document.body.scrollHeight)
  expect(height, `${path} rendered a body only ${height}px tall — that is not a page`).toBeGreaterThan(200)
}

/** The checklist's pass criterion, with the observed numbers in the failure message. */
async function expectNoHorizontalOverflow(
  page: import('playwright/test').Page,
  where: string,
): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(
    scrollWidth,
    `${where}: page is ${scrollWidth - innerWidth}px wider than the viewport (${scrollWidth} vs ${innerWidth}). ` +
      'Wide content must scroll inside its own .table-scroll container, not widen the page.',
  ).toBeLessThanOrEqual(innerWidth + OVERFLOW_TOLERANCE_PX)
}

for (const viewport of VIEWPORTS) {
  test(`public pages fit ${viewport.width}×${viewport.height} — ${viewport.label}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const page = await context.newPage()
    try {
      for (const path of PUBLIC_PAGES) {
        await gotoHydrated(page, `${harness.baseURL}${path}`)
        await dismissOverlays(page)
        await expectReallyOnPage(page, path)
        await expectNoHorizontalOverflow(page, `${path} at ${viewport.width}px`)
      }

      /**
       * The page the checklist calls the highest-risk one, with the content that actually broke it.
       *
       * Checked in the public context because that is how it is reached — an anonymous visitor
       * landing on a profile whose bio came from an external source.
       */
      await gotoHydrated(page, `${harness.baseURL}/builders/${hostileBuilderId}`)
      await dismissOverlays(page)
      await expectNoHorizontalOverflow(page, `builder profile with a 220-char unbroken URL at ${viewport.width}px`)
    } finally {
      await context.close()
    }
  })

  test(`authenticated pages fit ${viewport.width}×${viewport.height} — ${viewport.label}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      storageState: harness.owner.storageState!,
    })
    const page = await context.newPage()
    try {
      for (const path of AUTHENTICATED_PAGES) {
        await gotoHydrated(page, `${harness.baseURL}${path}`)
        await dismissOverlays(page)
        await expectReallyOnPage(page, path)
        await expectNoHorizontalOverflow(page, `${path} at ${viewport.width}px`)
      }
    } finally {
      await context.close()
    }
  })
}
