/**
 * The properties every migrated table must have, asserted once and reused.
 *
 * plans/phase-3/07-first-surface-sprint-results — "the durable deliverable". Plans 08–11 add a
 * surface to `SURFACES` below rather than writing their own spec, so the properties cannot drift
 * apart between tables the way the nineteen hand-built lists did.
 *
 * These are the assertions that a unit test cannot make, because they are about a real browser
 * against a real Postgres: that a row inserted *between* two page fetches neither duplicates nor
 * disappears, that the DOM stays bounded while the announced count does not, and that keyboard
 * focus survives scrolling past the render window.
 */
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
import { cachedSearchBuilders, searchCacheKey, seedSearchCache } from './harness/fixtures/search-cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'

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

/** Enough rows that page one is a page rather than the whole list, and the DOM has to be bounded. */
const SEEDED_ROWS = 500

interface Surface {
  name: string
  /** Built after seeding, because the path carries a seeded id. */
  path: () => string
  /** The `data-testid` prefix each row carries. */
  rowPrefix: string
  /** A column id with a sort control. */
  sortColumn: string
  /** A facet dimension and one of its values. */
  facet: { id: string; value: string }
  /** Inserts one more row that the current query would match. Returns its id. */
  insertMatchingRow: () => Promise<string>
}

let sprintId = ''

const SURFACES: Surface[] = [
  {
    name: 'sprint results',
    path: () => `/sprints/${sprintId}`,
    rowPrefix: 'sprint-result-',
    sortColumn: 'score',
    facet: { id: 'source', value: 'github' },
    insertMatchingRow: async () => {
      const id = `${sprintId}-inserted-${Date.now()}`
      await harness.sql`
        insert into sprint_results (id, organization_id, sprint_id, source, source_id, profile, matched_variant, score, created_at)
        values (
          ${id}, ${harness.organization.organizationId}, ${sprintId}, 'github', ${id},
          ${harness.sql.json({ username: 'inserted', profileUrl: 'https://example.invalid/inserted', topics: [], country: 'Denmark', followersCount: 1 })},
          'senior', 50, now()
        )
      `
      return id
    },
  },
]

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
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}tables` }
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

    sprintId = await seedSprintWithResults(SEEDED_ROWS)
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

async function seedSprintWithResults(count: number): Promise<string> {
  const { sql, organization, owner } = harness
  const id = `tables-sprint-${harness.workerIndex}`
  await sql`
    insert into sourcing_sprints (id, organization_id, creator_user_id, name, criteria, variants, status, quota, cursor, created_at)
    values (
      ${id}, ${organization.organizationId}, ${owner.userId!}, 'Data table spec sprint',
      ${sql.json({ skills: ['rust'], roles: [], seniority: 'unknown', locations: [], mustHaves: [] })},
      ${sql.json([])}, 'active', 1000, ${sql.json({ page: 1, variantIndex: 0 })}, now()
    )
  `

  const sources = ['github', 'gitlab', 'codeberg']
  const countries = ['Denmark', 'Spain', 'Japan']
  for (let index = 0; index < count; index += 1) {
    await sql`
      insert into sprint_results (id, organization_id, sprint_id, source, source_id, profile, matched_variant, score, created_at)
      values (
        ${`${id}-r${index}`}, ${organization.organizationId}, ${id},
        ${sources[index % sources.length]}, ${`builder-${index}`},
        ${sql.json({
    username: `builder${index}`,
    displayName: `Builder ${index}`,
    profileUrl: `https://example.invalid/builder${index}`,
    followersCount: index * 7,
    country: countries[index % countries.length],
    topics: ['rust'],
  })},
        ${index % 2 === 0 ? 'senior' : 'junior'}, ${index}, now() - (${index} * interval '1 minute')
      )
    `
  }
  return id
}

for (const surface of SURFACES) {
  test.describe(surface.name, () => {
    /**
     * The assertion the tiebreaker exists for.
     *
     * Page one is fetched, a matching row is inserted, then page two is fetched with the cursor
     * minted before the insert. With `OFFSET` the insert shifts every later row by one and a row is
     * served twice or skipped. With a keyset over a total order, neither can happen.
     */
    test('pages are stable across a concurrent insert', async () => {
      const api = harness.owner.api!
      const base = `/api/sprints/${sprintId}/results`

      const first = await (await api.get(base)).json()
      expect(first.rows.length).toBeGreaterThan(0)
      expect(first.nextCursor).toBeTruthy()

      const insertedId = await surface.insertMatchingRow()

      const second = await (await api.get(`${base}?cursor=${encodeURIComponent(first.nextCursor)}`)).json()

      const firstIds = first.rows.map((row: { id: string }) => row.id)
      const secondIds = second.rows.map((row: { id: string }) => row.id)
      expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([])

      // Walk the rest and confirm the whole set is covered exactly once.
      const seen = new Set<string>([...firstIds, ...secondIds])
      let cursor: string | null = second.nextCursor
      let guard = 0
      while (cursor && guard < 30) {
        const nextPage = await (await api.get(`${base}?cursor=${encodeURIComponent(cursor)}`)).json()
        for (const row of nextPage.rows as Array<{ id: string }>) {
          expect(seen.has(row.id), `row ${row.id} served twice`).toBe(false)
          seen.add(row.id)
        }
        cursor = nextPage.nextCursor
        guard += 1
      }

      await harness.sql`delete from sprint_results where id = ${insertedId}`
      // The inserted row may or may not fall after the cursor; either is correct. What is not
      // correct is a duplicate or a gap, and both are covered above.
      expect(seen.size).toBeGreaterThanOrEqual(SEEDED_ROWS)
    })

    test('the total is the filtered set and the page is bounded', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        const grid = page.locator('[role="grid"]')
        await expect(grid).toBeVisible()

        // `total + 1` for the header row, which carries aria-rowindex 1.
        await expect(grid).toHaveAttribute('aria-rowcount', String(SEEDED_ROWS + 1))

        const rows = page.locator(`[data-testid^="${surface.rowPrefix}"]:not([data-testid$="-select"])`)
        const rendered = await rows.count()
        expect(rendered).toBeGreaterThan(0)
        expect(rendered).toBeLessThanOrEqual(50)
      } finally {
        await context.close()
      }
    })

    /** Announcing "row 3 of 500" for the third row *of the window* is the failure axe cannot see. */
    test('every rendered row carries its absolute index', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        const rows = page.locator(`[data-testid^="${surface.rowPrefix}"]:not([data-testid$="-select"])`)
        const count = await rows.count()
        const first = await rows.first().getAttribute('aria-rowindex')
        const last = await rows.nth(count - 1).getAttribute('aria-rowindex')
        expect(Number(first)).toBe(2)
        expect(Number(last)).toBe(count + 1)
      } finally {
        await context.close()
      }
    })

    /**
     * A roving tabindex has one focusable cell. A virtualizer unmounts it when it scrolls out of
     * range, and the browser drops focus to `<body>` — keyboard navigation dies with no error, in
     * exactly the long lists virtualization is for.
     */
    test('focus survives a PageDown/PageUp round trip', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        const cell = page.locator('[role="gridcell"][tabindex="0"]').first()
        await cell.focus()
        const before = await page.evaluate(() =>
        document.activeElement?.closest('[role="row"]')?.getAttribute('aria-rowindex') ?? null)

        await page.keyboard.press('PageDown')
        await page.keyboard.press('PageDown')
        await page.keyboard.press('PageUp')
        await page.keyboard.press('PageUp')

        const after = await page.evaluate(() =>
        document.activeElement?.closest('[role="row"]')?.getAttribute('aria-rowindex') ?? null)
        expect(after).toBe(before)
        expect(await page.locator('[role="gridcell"][tabindex="0"]').count()).toBe(1)
      } finally {
        await context.close()
      }
    })

    test('sorting asks the server and shows in the URL', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        await page.locator(`[data-testid="table-sort-${surface.sortColumn}"]`).click()
        await expect(page).toHaveURL(new RegExp(`sort=${surface.sortColumn}`))

        const header = page.locator('[role="columnheader"]', { hasText: new RegExp(surface.sortColumn, 'i') }).first()
        await expect(header).toHaveAttribute('aria-sort', 'ascending')
      } finally {
        await context.close()
      }
    })

    /**
     * The facet count for the dimension being filtered is computed with the *other* dimensions
     * applied and its own not, so the chips say what each option would add rather than zero.
     */
    test('a facet filter narrows the rows and keeps its own counts', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        const chip = page.locator(`[data-testid="table-facet-${surface.facet.id}-${surface.facet.value}"]`)
        const before = await chip.textContent()
        await chip.click()
        await expect(chip).toHaveAttribute('aria-pressed', 'true')

        // `expect.poll`, not a one-shot `getAttribute`. `aria-pressed` above is the chip's own
        // optimistic state and flips on click, so it says nothing about the filtered query having
        // resolved — and a bare `getAttribute` has no retry, unlike every `expect(locator)` in this
        // file. It read the pre-filter count of exactly SEEDED_ROWS + 1 on CI and failed there while
        // passing everywhere else, which is what that window looks like from outside.
        const grid = page.locator('[role="grid"]')
        await expect.poll(
          async () => Number(await grid.getAttribute('aria-rowcount')),
          { timeout: 10_000 },
        ).toBeLessThan(SEEDED_ROWS + 1)
        // Its own count did not collapse to the filtered set.
        await expect(chip).toHaveText(before!.trim())
      } finally {
        await context.close()
      }
    })

    test('selection says how many it selected, not "all"', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}`)
        await dismissOverlays(page)

        const header = page.locator('[data-testid="table-select-loaded"]')
        if (await header.count() === 0) {
        test.skip(true, `${surface.name} does not enable selection`)
        return
        }
        await expect(header).toHaveAttribute('aria-label', 'Select loaded rows')
      } finally {
        await context.close()
      }
    })

    test('a filter that matches nothing is a different state from an empty table', async ({ browser }) => {
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const page = await context.newPage()
      try {
        await gotoHydrated(page, `${harness.baseURL}${surface.path()}?q=zzzz-no-such-builder`)
        await dismissOverlays(page)

        await expect(page.locator('[data-testid="table-filtered-empty"]')).toBeVisible()
        await expect(page.locator('[data-testid="table-blank"]')).toHaveCount(0)
      } finally {
        await context.close()
      }
    })

    test('an unknown sort id is refused rather than absorbed', async () => {
      const response = await harness.owner.api!.get(
        `/api/sprints/${sprintId}/results?sort=totally-not-a-column:desc`,
      )
      expect(response.status()).toBe(400)
      expect((await response.json()).error).toContain('Unknown sort column')
    })

    test('a tampered cursor is refused', async () => {
      const response = await harness.owner.api!.get(
        `/api/sprints/${sprintId}/results?cursor=bm90LWEtY3Vyc29y.bm90LWEtc2ln`,
      )
      expect(response.status()).toBe(400)
    })
  })
}

/**
 * The sprints index, after plans/phase-3/10 moved it onto the shell.
 *
 * It lives here rather than in its own file because this harness already seeds a sprint with 500
 * results — which is what makes the per-page result count worth asserting: the unbounded version
 * computed it with a `leftJoin` + `groupBy` over every result of every sprint, and the paged one
 * counts only the ids on the page.
 */
test.describe('sprints index', () => {
  /** Enough sprints that page one is a page. */
  const EXTRA_SPRINTS = 60

  async function seedSprints(): Promise<string[]> {
    const { sql, organization, owner } = harness
    const ids: string[] = []
    for (let index = 0; index < EXTRA_SPRINTS; index += 1) {
      const id = `tables-extra-sprint-${harness.workerIndex}-${String(index).padStart(3, '0')}`
      await sql`
        insert into sourcing_sprints (id, organization_id, creator_user_id, name, criteria, variants, status, quota, cursor, last_run_at, created_at)
        values (
          ${id}, ${organization.organizationId}, ${owner.userId!}, ${`Extra sprint ${index}`},
          ${sql.json({ skills: ['rust'], roles: [], seniority: 'unknown', locations: [], mustHaves: [] })},
          ${sql.json([])},
          ${(['active', 'paused', 'completed'])[index % 3]}, 1000,
          ${sql.json({ page: 1, variantIndex: 0 })},
          -- Every third sprint has never run, so the nullable sort has nulls to place.
          ${index % 3 === 0 ? null : new Date(Date.UTC(2026, 7, 1 + (index % 27)))},
          now() - (${index} * interval '1 hour')
        )
      `
      ids.push(id)
    }
    return ids
  }

  async function clearSprints(): Promise<void> {
    await harness.sql`delete from sourcing_sprints where id like ${`tables-extra-sprint-${harness.workerIndex}-%`}`
  }

  test('answers a bounded page whose result counts are per sprint', async () => {
    await seedSprints()
    try {
      const page = await (await harness.owner.api!.get('/api/sprints')).json()

      expect(page.rows.length).toBe(50)
      expect(page.total).toBe(EXTRA_SPRINTS + 1)
      expect(page.nextCursor).toBeTruthy()

      // The seeded sprint is the only one with results, and it has all 500. A `leftJoin` that
      // collapsed wrongly would spread that count across the page or lose it.
      const withResults = page.rows.find((row: { id: string }) => row.id === sprintId)
      const others = page.rows.filter((row: { id: string }) => row.id !== sprintId)
      if (withResults) expect(withResults.resultCount).toBe(SEEDED_ROWS)
      expect(others.every((row: { resultCount: number }) => row.resultCount === 0)).toBe(true)
    } finally {
      await clearSprints()
    }
  })

  /**
   * The plan asked for `lastRunAt` to be the default sort. `listSprints` ordered by `createdAt`,
   * and the same plan asks the list to match its previous ordering — so `createdAt desc` stayed the
   * default and this is the assertion that keeps it that way.
   */
  test('defaults to newest-created first, as the unbounded read did', async () => {
    await seedSprints()
    try {
      const page = await (await harness.owner.api!.get('/api/sprints')).json()
      expect(new Date(page.rows[0].createdAt).getTime())
        .toBeGreaterThan(new Date(page.rows[1].createdAt).getTime())
    } finally {
      await clearSprints()
    }
  })

  test('walks every sprint exactly once, including over the nulls of the last-run sort', async () => {
    await seedSprints()
    try {
      for (const sort of ['', '&sort=lastRunAt:asc', '&sort=lastRunAt:desc']) {
        const seen = new Set<string>()
        let cursor: string | null = null
        let guard = 0
        do {
          const url: string = `/api/sprints?x=1${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
          const page = await (await harness.owner.api!.get(url)).json()
          for (const row of page.rows as Array<{ id: string }>) {
            expect(seen.has(row.id), `sprint ${row.id} served twice under "${sort}"`).toBe(false)
            seen.add(row.id)
          }
          cursor = page.nextCursor
          guard += 1
        } while (cursor && guard < 10)

        expect(seen.size, `sort "${sort}" lost a sprint`).toBe(EXTRA_SPRINTS + 1)
      }
    } finally {
      await clearSprints()
    }
  })

  test('status is a filter with facet counts, and refuses a value outside the enum', async () => {
    await seedSprints()
    try {
      const page = await (await harness.owner.api!.get('/api/sprints?filter.status=paused')).json()
      expect(page.rows.every((row: { status: string }) => row.status === 'paused')).toBe(true)
      expect(page.total).toBeLessThan(EXTRA_SPRINTS + 1)
      const statuses = page.facets.status as Array<{ value: string; count: number }>
      expect(statuses.find((facet) => facet.value === 'active')?.count).toBeGreaterThan(0)

      const refused = await harness.owner.api!.get('/api/sprints?filter.status=archived')
      expect(refused.status()).toBe(400)
      expect((await refused.json()).error).toContain('Unknown value for filter status')
    } finally {
      await clearSprints()
    }
  })

  test('searches sprint names in Postgres, not over the loaded page', async () => {
    await seedSprints()
    try {
      // `Extra sprint 59` sits beyond page one under the default sort; finding it proves the
      // `ILIKE` runs over every row rather than the fifty the client would have held.
      const page = await (await harness.owner.api!.get('/api/sprints?q=Extra%20sprint%2059')).json()
      expect(page.rows.map((row: { name: string }) => row.name)).toEqual(['Extra sprint 59'])
      expect(page.total).toBe(1)
    } finally {
      await clearSprints()
    }
  })

  test('the page renders as a grid, bounded, with the whole count announced', async ({ browser }) => {
    await seedSprints()
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/sprints`)
      await dismissOverlays(page)

      const grid = page.locator('[role="grid"]')
      await expect(grid).toHaveAttribute('aria-rowcount', String(EXTRA_SPRINTS + 2))
      expect(await page.locator('[role="row"][data-testid="sprint-row"]').count()).toBe(50)

      // Sorting is a link, so the view is one.
      await page.locator('[data-testid="table-sort-lastRunAt"]').click()
      await expect(page).toHaveURL(/sort=lastRunAt/)
    } finally {
      await context.close()
      await clearSprints()
    }
  })
})

/**
 * Federated search, after plans/phase-3/11 moved it onto the shell.
 *
 * It is **not** in `SURFACES`, and that is a statement rather than an omission. Every assertion in
 * that loop is about a SQL table: a sort control whose id reaches an `ORDER BY`, a facet computed
 * over a column, a `total` counting the filtered set, query state in the URL. Search has none of
 * them — its backend is thirteen third-party APIs, its filters re-run the federation rather than
 * re-viewing a set, and it cannot count without exhausting every upstream. Asserting those here
 * would mean asserting things that are false about this surface.
 *
 * What *does* apply is everything the shell itself promises, and that is what this block covers:
 * a DOM that stays bounded as rows accumulate, absolute row indices, focus that survives the
 * virtualizer, and an announced row count that admits it does not know.
 */
test.describe('federated search', () => {
  /** Deliberately larger than one page, one provider fan-out, and the virtualization threshold. */
  const SEEDED_SEARCH_ROWS = 500
  const SEARCH_QUERY = 'shell bounded search probe'
  const SEARCH_TERMS = SEARCH_QUERY.split(/[,\s]+/).filter(Boolean)
  /**
   * The page's own default selection, not a narrower one.
   *
   * The cache key is built from the sources the *request* names, and `SearchPage` sends
   * `DEFAULT_ACTIVE_SOURCES` unless a user has changed them. Seeding a two-source key produced a
   * cache miss and forty-five rows off the live internet — a green-looking test measuring nothing,
   * which is exactly the failure a seeded fixture exists to prevent.
   */
  const SEARCH_SOURCES = ['github', 'reddit', 'hn', 'devto', 'lobsters'] as const

  test.beforeAll(async () => {
    /*
     * One cache entry, 500 rows.
     *
     * A cache hit is restricted to the permitted sources and otherwise served whole —
     * `perPage` reaches connectors, not the cache — so a single seeded entry gives the fused set
     * 500 rows for provider page one. That is the path under test: `pageBuilderSearch` slicing a
     * large fused set at `TABLE_PAGE_SIZE` without another upstream request, rather than the
     * federation being asked for ten more pages.
     */
    await seedSearchCache(
      harness.redisPrefix,
      searchCacheKey(SEARCH_TERMS, 30, SEARCH_SOURCES),
      [
        ...cachedSearchBuilders('shell-gh', SEEDED_SEARCH_ROWS / 2, { source: 'github', followers: (i) => 20_000 - i }),
        ...cachedSearchBuilders('shell-hn', SEEDED_SEARCH_ROWS / 2, { source: 'hn', followers: (i) => 19_000 - i }),
      ],
    )
  })

  async function loadedSearchCount(page: import('playwright/test').Page): Promise<number> {
    return Number(await page.getByTestId('search-loaded-count').innerText())
  }

  /**
   * Walk exactly the seeded set: ten pages of `TABLE_PAGE_SIZE`.
   *
   * Driven by the count, not by a click counter. A click is not the only thing that loads a page —
   * the shell also fetches when its scroll container reaches the end (plan 06) — so one click can
   * land two pages. The first version asserted `(click + 2) * 50` after every click, which encoded
   * "only the button loads"; under load it failed with 300 where it wanted 250, one page *ahead*
   * rather than one page short, and passed on every isolated re-run.
   *
   * What still has to hold is the ceiling. Past the seeded set the cursor asks for provider page
   * *two*, which this fixture deliberately does not seed, and the request would leave the cache to
   * fetch from the live internet — which is how the very first version of this test ended up
   * asserting against 517 rows.
   */
  async function loadSeededSearchPages(page: import('playwright/test').Page): Promise<void> {
    let loaded = await loadedSearchCount(page)
    while (loaded < SEEDED_SEARCH_ROWS) {
      await page.getByTestId('load-more-button').click()
      // Progress, so a click that lands nothing fails here instead of spinning the loop forever.
      await expect.poll(() => loadedSearchCount(page), { timeout: 10_000 }).toBeGreaterThan(loaded)
      loaded = await loadedSearchCount(page)
      expect(loaded, 'never past the seeded set — beyond it the fixture stops isolating')
        .toBeLessThanOrEqual(SEEDED_SEARCH_ROWS)
    }
  }

  test('the DOM stays bounded while 500 rows accumulate, and the count admits it is unknown', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/search?q=${encodeURIComponent(SEARCH_QUERY)}`)
      await dismissOverlays(page)

      const grid = page.locator('[role="grid"]')
      await expect(grid).toBeVisible()
      // -1, not 501. A federation cannot count without exhausting every upstream, and the number a
      // screen reader is given has to be one nothing is pretending about.
      await expect(grid).toHaveAttribute('aria-rowcount', '-1')

      await loadSeededSearchPages(page)
      // Every seeded row was fetched — ten pages of fifty — and the browser holds a window of them.
      await expect(page.getByTestId('search-loaded-count')).toHaveText(String(SEEDED_SEARCH_ROWS))
      const rendered = await page.locator('[role="row"][data-testid^="search-result-"]').count()
      expect(rendered, 'the window is bounded, not the loaded set').toBeGreaterThan(0)
      expect(rendered).toBeLessThanOrEqual(60)
    } finally {
      await context.close()
    }
  })

  /** Announcing "row 3 of unknown" for the third row *of the window* is the failure axe cannot see. */
  test('rendered rows carry their absolute index once windowed', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/search?q=${encodeURIComponent(SEARCH_QUERY)}`)
      await dismissOverlays(page)
      await page.getByTestId('load-more-button').click()
      await page.getByTestId('load-more-button').click()
      await page.waitForTimeout(300)

      const rows = page.locator('[role="row"][data-testid^="search-result-"]')
      const count = await rows.count()
      const indices = await rows.evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute('aria-rowindex'))))
      expect(count).toBeGreaterThan(0)
      // Ascending and contiguous through the DOM, which is the order a screen reader reads them in.
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
      expect(indices[indices.length - 1] - indices[0]).toBe(count - 1)
    } finally {
      await context.close()
    }
  })

  test('focus survives a PageDown/PageUp round trip through the window', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/search?q=${encodeURIComponent(SEARCH_QUERY)}`)
      await dismissOverlays(page)
      await page.getByTestId('load-more-button').click()
      await page.getByTestId('load-more-button').click()
      await page.waitForTimeout(300)

      const cell = page.locator('[role="gridcell"][tabindex="0"]').first()
      await cell.focus()
      const before = await page.evaluate(() =>
        document.activeElement?.closest('[role="row"]')?.getAttribute('aria-rowindex') ?? null)

      await page.keyboard.press('PageDown')
      await page.keyboard.press('PageDown')
      await page.keyboard.press('PageUp')
      await page.keyboard.press('PageUp')

      const after = await page.evaluate(() =>
        document.activeElement?.closest('[role="row"]')?.getAttribute('aria-rowindex') ?? null)
      expect(after).toBe(before)
      expect(await page.locator('[role="gridcell"][tabindex="0"]').count()).toBe(1)
    } finally {
      await context.close()
    }
  })

  /**
   * The reset the continuation makes mandatory: the token is bound to the source snapshot, so rows
   * loaded under one selection cannot sit above rows loaded under another.
   */
  test('changing a source discards the loaded rows and the cursor', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState! })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/search?q=${encodeURIComponent(SEARCH_QUERY)}`)
      await dismissOverlays(page)
      const rows = page.locator('[role="row"][data-testid^="search-result-"]')
      // `expect(...).toBeVisible()`, not a bare `count()`: the page searches on mount from `?q=`,
      // and a synchronous count right after `dismissOverlays` reads the DOM before the fetch
      // resolves. It passed alone and failed in a full run, which is the shape of every race.
      await expect(rows.first()).toBeVisible()

      await page.locator('button[aria-label="Sources & filters"]').click()
      await page.getByTestId('search-source-hn').click()

      await expect(rows).toHaveCount(0)
      await expect(page.getByTestId('load-more-button')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
