/**
 * The segmented landing with its flag off (plan: phase-2/06-landing-segmentada).
 *
 * Its own file, on a per-worker server, because this is the one property the shared server cannot
 * test: `playwright.config.ts` pins `SEGMENTED_LANDING_ENABLED='true'` there so
 * `segmented-landing.spec.ts` exercises a feature that is actually on.
 *
 * What "off" has to mean is *absent*, on all three surfaces at once:
 *
 * - **the pages answer 404.** Not a 200 with the content hidden, which is a switched-off public URL
 *   that still gets indexed, and not a redirect to `/`, which tells a crawler the page moved
 *   permanently somewhere it did not move to;
 * - **the selector does not render**, so the home page is the page it was before this plan;
 * - **the sitemap does not list them**, because a sitemap advertising three 404s is worse for
 *   discovery than one that never mentioned them.
 *
 * Three surfaces reading one flag is three chances to disagree about whether a page exists, and the
 * disagreement is invisible until somebody follows a sitemap entry into a 404. That is what this
 * file is for.
 */
import { expect, test } from 'playwright/test'

import { SEGMENT_PAGES } from '~/modules/landing/content/segment-pages'
import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'

const PAGES = Object.values(SEGMENT_PAGES)

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'landingflag',
    flags: { SEGMENTED_LANDING_ENABLED: 'false' },
  })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

for (const page of PAGES) {
  test(`/for/${page.slug} does not exist`, async ({ request }) => {
    const response = await request.get(`${harness.baseURL}/for/${page.slug}`)
    expect(response.status(), 'a switched-off public page must 404, not 200').toBe(404)

    // And it must not leak its copy into the not-found body, which would leave the page indexable
    // under a 404 that a crawler treats as soft.
    expect(await response.text()).not.toContain(page.heading)
  })
}

test('the home page is the page it was before this plan', async ({ page }) => {
  await page.goto(`${harness.baseURL}/`)

  await expect(page.getByTestId('segment-selector')).toHaveCount(0)
  await expect(page.getByTestId('segment-selector-option')).toHaveCount(0)
  // The hero is untouched either way — the band was always below it — so this is the real check
  // that the rest of the page still renders rather than erroring into an empty tree.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('the sitemap does not advertise three 404s', async ({ request }) => {
  const xml = await (await request.get(`${harness.baseURL}/sitemap.xml`)).text()

  for (const page of PAGES) {
    expect(xml, `/for/${page.slug} must be absent`).not.toContain(`/for/${page.slug}`)
  }
  // Still a sitemap, not an empty document: the gate must remove three entries and nothing else.
  expect(xml).toContain('<urlset')
  expect(xml).toContain('/pricing')
})
