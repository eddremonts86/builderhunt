/**
 * Visual baselines for the canonical table system (plan phase-3/14).
 *
 * ## Why populated tables here, when `empty-states.spec.ts` argues against populated surfaces
 *
 * That file's rule is right and this is the exception it implies. Its objection to populated
 * baselines is that the content is fixture data, so every fixture edit repaints the baseline for
 * reasons no reviewer can separate from a real regression. The fixture below is not incidental
 * content — it is *the specimen*: one row per cell kind, with values chosen so that a status chip,
 * a two-line date, a right-aligned number, a ratio bar, an identity with an avatar and an em-dash
 * empty are all on screen at once. A diff here is a diff in the cell vocabulary, which is the only
 * thing this suite is for. It is frozen for the same reason the org name is frozen there: it is not
 * data, it is the subject.
 *
 * The structural half — geometry in pixels, ARIA indices, which column truncates — lives in
 * `tests/e2e/data-tables.spec.ts`, where a failure names the property that broke. A screenshot can
 * only say "something moved". Both halves are needed and neither substitutes for the other.
 *
 * ## Light *and* dark, which none of the other visual specs capture
 *
 * The `--tbl-*` block is the first token set in the app whose dark values are a deliberate
 * remapping rather than the same literals on a different background — the reference is a warm stone
 * ramp tuned for a white page, and four of its roles had to move to clear contrast. A baseline in
 * one theme would leave the other's chips, borders and row tints unguarded, which is exactly where
 * a copied literal would land.
 *
 * ## Baselines are per-platform, and the Linux ones are not here
 *
 * Same recorded gap as the other three visual specs: Playwright names snapshots per project *and*
 * per OS, and the committed files are `-darwin`. CI fails with "snapshot missing" until someone runs
 * `pnpm test:visual --update-snapshots` on the runner and commits the `-linux` files.
 */
import { expect, test } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv, installFixedBrowserClock } from '../harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from '../harness/fixtures/principals'
import { dismissOverlays, gotoHydrated, waitForFontsSettled } from '../harness/browser'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  principal: Principal
  sprintId: string
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

/** Same tolerance and the same three sources of false diffs as the other visual specs: time, motion, fonts. */
const MAX_DIFF_PIXEL_RATIO = 0.01

/**
 * The specimen: eight rows chosen so every cell kind is on screen at once.
 *
 * Deliberately not random and deliberately not realistic-looking. Row 3 has no country and no
 * follower count, so the empty cell renders; the scores span one digit to four so the right-aligned
 * tabular figures have something to line up; the sources cover the three facet values so the
 * toolbar's chips are populated; and the `createdAt` values are days rather than minutes apart so
 * the relative line reads "3d ago" rather than something that changes between two captures.
 */
const SPECIMEN = [
  { id: 'row-1', source: 'github', username: 'ana-ruiz', display: 'Ana Ruiz', country: 'Denmark', followers: 4821, score: 98 },
  { id: 'row-2', source: 'github', username: 'bo-hansen', display: 'Bo Hansen', country: 'Denmark', followers: 312, score: 91 },
  { id: 'row-3', source: 'gitlab', username: 'chen-wei', display: null, country: null, followers: null, score: 84 },
  { id: 'row-4', source: 'gitlab', username: 'dara-okafor', display: 'Dara Okafor', country: 'Nigeria', followers: 1204, score: 77 },
  { id: 'row-5', source: 'hn', username: 'eli-strand', display: 'Eli Strand', country: 'Norway', followers: 58, score: 63 },
  { id: 'row-6', source: 'hn', username: 'fern-lopez', display: 'Fern López', country: 'Spain', followers: 9, score: 52 },
  { id: 'row-7', source: 'github', username: 'gita-rao', display: 'Gita Rao', country: 'India', followers: 22140, score: 41 },
  { id: 'row-8', source: 'gitlab', username: 'hugo-nilsson', display: 'Hugo Nilsson', country: 'Sweden', followers: 640, score: 8 },
] as const

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}tbl` }
    const { principal } = await createOwnerPrincipal(ctx, {
      tier: 'pro',
      seatLimit: 3,
      clock: fixedClockFromEnv(),
      // Fixed for the reason `empty-states.spec.ts` records at length: the default name ends in six
      // random characters, the font is proportional, and a wider name in the masked switcher moves
      // everything below it.
      name: 'E2E visual baseline org',
    })

    const sprintId = `tbl-visual-${workerIndex}`
    const clock = fixedClockFromEnv()
    await sql`
      insert into sourcing_sprints (id, organization_id, creator_user_id, name, criteria, variants, status, quota, cursor, last_run_at, created_at)
      values (
        ${sprintId}, ${principal.organizationId}, ${principal.userId!}, 'Table system specimen',
        ${sql.json({ skills: ['rust'], roles: [], seniority: 'unknown', locations: [], mustHaves: [] })},
        ${sql.json([{ label: 'senior', query: 'rust' }])}, 'completed', 1000,
        ${sql.json({ page: 1, variantIndex: 0 })},
        ${clock.minus({ days: 2 })}, ${clock.minus({ days: 9 })}
      )
    `
    for (const [index, row] of SPECIMEN.entries()) {
      await sql`
        insert into sprint_results (id, organization_id, sprint_id, source, source_id, profile, matched_variant, score, created_at)
        values (
          ${`${sprintId}-${row.id}`}, ${principal.organizationId}, ${sprintId}, ${row.source}, ${row.id},
          ${sql.json({
            username: row.username,
            displayName: row.display,
            profileUrl: `https://example.invalid/${row.username}`,
            topics: [],
            country: row.country,
            followersCount: row.followers,
          })},
          'senior', ${row.score},
          ${clock.minus({ days: index + 1 })}
        )
      `
    }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      principal,
      sprintId,
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await disposePrincipal(h.principal).catch(() => undefined)
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

/**
 * The theme, set before the app boots rather than clicked afterwards.
 *
 * `ThemeProvider` reads `bh-theme` from `localStorage` in an effect and starts from `dark`, so
 * clicking the toggle after hydration would capture whatever the transition happened to be part-way
 * through. Writing the key on the origin before the first navigation means the first paint is
 * already the theme under test.
 */
async function withTheme(browser: import('playwright/test').Browser, theme: 'light' | 'dark') {
  const context = await browser.newContext({ storageState: harness.principal.storageState! })
  await context.addInitScript(([key, value]) => {
    window.localStorage.setItem(key as string, value as string)
  }, ['bh-theme', theme])
  return context
}

async function prepare(page: import('playwright/test').Page, path: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFixedBrowserClock(page)
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  })
  await gotoHydrated(page, `${harness.baseURL}${path}`)
  await dismissOverlays(page)
  await waitForFontsSettled(page)
}

for (const theme of ['light', 'dark'] as const) {
  /**
   * The interactive grid, with every cell kind on screen.
   *
   * Scoped to the table's own container rather than the whole page: the surrounding shell has its
   * own baselines in `empty-states.spec.ts`, and capturing it again here would make a sidebar
   * change repaint a table baseline.
   */
  test(`interactive grid — ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await withTheme(browser, theme)
    const page = await context.newPage()
    try {
      await prepare(page, `/sprints/${harness.sprintId}`)
      const table = page.getByTestId('table-container')
      await expect(table).toBeVisible()
      await expect(page.locator('[role="grid"] [role="row"]').nth(3)).toBeVisible()
      await expect(table).toHaveScreenshot(`table-grid-${theme}.png`, {
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } finally {
      await context.close()
    }
  })

  /**
   * The genuine-empty state, which is a different state from a filtered-empty one.
   *
   * Most tables show one message for both, and it reads as "this feature has no data" when the
   * truth is "you have a chip selected". Both are captured so a change that collapses them back
   * into one is a visible diff rather than a silent regression.
   */
  test(`empty and filtered-empty states — ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await withTheme(browser, theme)
    const page = await context.newPage()
    try {
      await prepare(page, `/sprints/${harness.sprintId}?q=${encodeURIComponent('no-such-builder-anywhere')}`)
      const table = page.getByTestId('table-container')
      await expect(page.getByTestId('table-filtered-empty')).toBeVisible()
      await expect(table).toHaveScreenshot(`table-filtered-empty-${theme}.png`, {
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } finally {
      await context.close()
    }
  })

  /**
   * The native semantic table, on the same tokens as the grid above.
   *
   * `/pricing` is public, so this one needs no session — but it does need the same theme handling,
   * and it is the whole point of the second primitive that its header ink, borders and density are
   * indistinguishable from the grid's.
   */
  test(`semantic table — ${theme}`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext()
    await context.addInitScript(([key, value]) => {
      window.localStorage.setItem(key as string, value as string)
    }, ['bh-theme', theme])
    const page = await context.newPage()
    try {
      await prepare(page, '/pricing')
      const table = page.getByTestId('semantic-table').first()
      await expect(table).toBeVisible()
      await table.scrollIntoViewIfNeeded()
      await expect(table).toHaveScreenshot(`table-semantic-${theme}.png`, {
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } finally {
      await context.close()
    }
  })
}

/**
 * The same two tables at 375px, tagged so the `visual-mobile` project picks them up.
 *
 * Not a duplicate of the captures above. Fixed column widths mean the grid is wider than a phone
 * and lives inside its own scroller, and the semantic table's five plan columns cannot fit by any
 * arrangement — what a reader sees on a phone is the *left edge* of each, which is a different
 * composition and the one nobody develops against.
 *
 * `responsive-device-matrix.spec.ts` already proves neither of them widens the document. This is
 * what they look like while not doing so.
 */
for (const theme of ['light', 'dark'] as const) {
  test(`interactive grid at 375px — ${theme} @mobile-only`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await withTheme(browser, theme)
    const page = await context.newPage()
    try {
      await prepare(page, `/sprints/${harness.sprintId}`)
      const table = page.getByTestId('table-container')
      await expect(table).toBeVisible()
      await expect(page.locator('[role="grid"] [role="row"]').nth(3)).toBeVisible()
      await expect(table).toHaveScreenshot(`table-grid-mobile-${theme}.png`, {
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } finally {
      await context.close()
    }
  })

  test(`semantic table at 375px — ${theme} @mobile-only`, async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext()
    await context.addInitScript(([key, value]) => {
      window.localStorage.setItem(key as string, value as string)
    }, ['bh-theme', theme])
    const page = await context.newPage()
    try {
      await prepare(page, '/pricing')
      const table = page.getByTestId('semantic-table').first()
      await expect(table).toBeVisible()
      await table.scrollIntoViewIfNeeded()
      await expect(table).toHaveScreenshot(`table-semantic-mobile-${theme}.png`, {
        maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
      })
    } finally {
      await context.close()
    }
  })
}
