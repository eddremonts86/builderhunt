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

        const grid = page.locator('[role="grid"]')
        const narrowed = Number(await grid.getAttribute('aria-rowcount'))
        expect(narrowed).toBeLessThan(SEEDED_ROWS + 1)
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
