/**
 * The segmented landing pages (plan: phase-2/06-landing-segmentada).
 *
 * These are public, unauthenticated, server-rendered pages, so what has to be true end to end is
 * different from the rest of this suite:
 *
 * - **they answer 200 to a request with no session and no JavaScript.** A landing page that needs a
 *   client bundle to say anything is a landing page no crawler reads;
 * - **the selector is links.** That is what makes the other two pages reachable without JavaScript,
 *   crawlable, and middle-clickable;
 * - **the sitemap lists them.** A page nothing links to and nothing indexes is a page nobody visits;
 * - **`?goal=` reaches the page and never becomes a preference.** Anybody can send anybody a link.
 */
import { expect, test } from 'playwright/test'

import { SEGMENT_PAGES } from '~/modules/landing/content/segment-pages'

const PAGES = Object.values(SEGMENT_PAGES)

/**
 * The raw HTML the server sends, before any hydration.
 *
 * `request.get` rather than a page visit: the point is what a crawler receives, and a browser would
 * hydrate and hide the difference between a server-rendered page and an empty shell.
 */
test.describe('server-rendered, with no session and no JavaScript', () => {
  for (const page of PAGES) {
    test(`/for/${page.slug} answers 200 with its own copy`, async ({ request, baseURL }) => {
      const response = await request.get(`${baseURL}/for/${page.slug}`)
      expect(response.status()).toBe(200)

      const html = await response.text()
      expect(html).toContain(page.heading)
      // Every claim, in the markup, not behind a fetch.
      for (const claim of page.claims) expect(html).toContain(claim.text)
      // And the limits, which are the half a landing page usually leaves out.
      for (const limit of page.limits) expect(html).toContain(limit)
    })

    test(`/for/${page.slug} carries its own title and description`, async ({ request, baseURL }) => {
      const html = await (await request.get(`${baseURL}/for/${page.slug}`)).text()
      expect(html).toContain(page.title)
      expect(html).toContain(page.metaDescription)
    })
  }

  /** Three pages, three titles. One shared title would make them one page to a search engine. */
  test('no two pages share a title', async ({ request, baseURL }) => {
    const titles = await Promise.all(PAGES.map(async (page) => {
      const html = await (await request.get(`${baseURL}/for/${page.slug}`)).text()
      return /<title[^>]*>([^<]*)<\/title>/.exec(html)?.[1] ?? ''
    }))
    expect(new Set(titles).size).toBe(PAGES.length)
  })
})

test.describe('the selector', () => {
  test('offers all three routes from the home page, as links', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`)

    const options = page.getByTestId('segment-selector-option')
    await expect(options).toHaveCount(3)
    for (const content of PAGES) {
      await expect(page.locator(`[data-segment="${content.segment}"]`))
        .toHaveAttribute('href', new RegExp(`/for/${content.slug}`))
    }
  })

  /**
   * Links rather than tabs, asserted rather than assumed: an anchor with an `href` is what survives
   * JavaScript being off, what a crawler follows, and what a middle-click opens.
   */
  test('is anchors with real hrefs', async ({ request, baseURL }) => {
    const html = await (await request.get(`${baseURL}/`)).text()
    for (const content of PAGES) {
      expect(html).toContain(`href="/for/${content.slug}`)
    }
  })

  test('marks the page you are on rather than offering it', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/for/investors`)
    await expect(page.locator('[data-segment="investing"]')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-segment="hiring"]')).not.toHaveAttribute('aria-current', 'page')
  })

  test('is reachable and operable from the keyboard', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/for/hiring-teams`)
    const investing = page.locator('[data-segment="investing"]')
    await investing.focus()
    await expect(investing).toBeFocused()
    await page.keyboard.press('Enter')
    await page.waitForURL(/\/for\/investors/)
  })

  /** Named, so a screen-reader user knows this is a way out of the page rather than a summary of it. */
  test('is a navigation landmark with a name', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`)
    await expect(page.getByRole('navigation', { name: /what brings you here/i })).toBeVisible()
  })
})

/**
 * The hint travels and never writes. The URL is attacker-controlled — anybody can send anybody a
 * link — so arriving with one may decide what starts selected and nothing else.
 */
test('the goal hint reaches the page and is not a preference', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/for/builders?goal=building`)
  await expect(page.getByTestId('segment-heading')).toBeVisible()

  // Nothing was stored: an anonymous visitor has nowhere to store it, and that is the point.
  const stored = await page.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
  }))
  expect(JSON.stringify(stored)).not.toContain('primary_segment')
})

/**
 * The one link that leaves the public site carries the hint (plan: phase-2/06-landing-segmentada).
 *
 * In the served HTML, because that is where it has to be: the query is dropped by the form itself,
 * and a hint that only exists once a client bundle has rewritten the href is a hint that a slow
 * connection loses. What happens on the other side — the stash, its TTL, and a stored choice
 * outranking it — is `onboarding-goal.spec.ts`.
 */
test.describe('the hint into sign-up', () => {
  for (const page of PAGES) {
    test(`/for/${page.slug} sends its own segment to the sign-up form`, async ({ request, baseURL }) => {
      const html = await (await request.get(`${baseURL}/for/${page.slug}`)).text()
      expect(html).toMatch(new RegExp(`href="/auth/sign-up\\?[^"]*goal=${page.segment}`))
    })
  }
})

test('the sitemap lists every segment page exactly once', async ({ request, baseURL }) => {
  const xml = await (await request.get(`${baseURL}/sitemap.xml`)).text()
  for (const content of PAGES) {
    const matches = xml.match(new RegExp(`<loc>[^<]*/for/${content.slug}</loc>`, 'g')) ?? []
    expect(matches.length, `/for/${content.slug} in sitemap`).toBe(1)
  }
})

test('a segment page fits a phone @mobile-only', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/for/hiring-teams`)
  await expect(page.getByTestId('segment-heading')).toBeVisible()

  const viewportWidth = page.viewportSize()?.width ?? 0
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)
})
