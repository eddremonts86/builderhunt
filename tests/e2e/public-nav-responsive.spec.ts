/**
 * The public header must fit its own container at every width.
 *
 * This exists because it did not, and nothing noticed. Reported from a 1200px browser: "How it works" and
 * "Use cases" broken across three lines each, and the Dashboard button clipped off the right edge.
 *
 * ## The bug was not the breakpoint, which is why a guard is worth having
 *
 * The first two diagnoses were wrong, and both looked right:
 *
 *   1. "The links wrap" — true, and `whitespace-nowrap` fixes the wrapping, but the row still did not fit.
 *   2. "`md` is too low for seven nav items" — also true, but raising it to `xl` left the row overflowing by
 *      18px, and raising it further did nothing either.
 *
 * The actual cause is that `.topbar-shell` is capped at `--page-max` minus gutters — about **1158px at every
 * viewport**, deliberately, so the floating pill lines up with the landing's content column. The full nav
 * plus a text-labelled theme toggle measured **1176px**. The content was wider than its container's design
 * maximum, so **no screen was ever wide enough** and no breakpoint could have fixed it. The fix was to
 * reclaim ~90px by dropping the theme toggle's redundant "Light"/"Dark" words (each button already carries
 * `aria-label`), which brought the natural content width to ~1088px against the 1158px cap.
 *
 * A screenshot test would have caught the wrapping. It would not have caught "fits at 1440 but only because
 * flex stretched it", which is why this asserts geometry — `scrollWidth <= clientWidth` — rather than pixels.
 *
 * ## What each assertion is actually protecting
 *
 * - **No overflow at any width.** The failure the user saw.
 * - **No item taller than one line.** Wrapping mid-phrase, which is what made it look broken rather than
 *   merely tight.
 * - **Exactly one navigation affordance.** Above the breakpoint the inline nav; below it the hamburger. The
 *   original code had four independent `md:` literals that all had to agree, and a mismatch would leave a
 *   width with *neither* — a page with no way to navigate, which no visual test would flag as an error.
 * - **The drawer really contains the links.** If the inline nav hides and the drawer is empty, the nav is
 *   unreachable below the breakpoint. That would be a worse regression than the bug this file is about.
 */
import { test, expect } from 'playwright/test'
import { gotoHydrated } from './harness/browser'

/** Straddles the breakpoint deliberately: 1279/1280 are the two sides of `xl`. */
const WIDTHS = [375, 768, 1024, 1200, 1279, 1280, 1440, 1920] as const
const BREAKPOINT = 1280

test.describe('public header fits at every width', () => {
  for (const width of WIDTHS) {
    test(`${width}px — no overflow, nothing wrapped, exactly one nav affordance`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      // `gotoHydrated`, not `goto`: the header renders server-side, so the hamburger exists in the HTML
      // before React attaches its handler. A plain `goto` plus an immediate click lands pre-hydration and
      // silently does nothing — which is exactly how this test first 'failed' at 375px while the product
      // worked fine in a real browser. The harness waits for `html[data-hydrated="true"]`.
      await gotoHydrated(page, '/blog')

      const header = page.locator('header[aria-label="Primary"]')
      await expect(header).toBeVisible()

      const geometry = await header.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: Math.round(el.getBoundingClientRect().right),
        // Natural width of the three groups, which `justify-between` would otherwise hide by stretching.
        naturalWidth: [...el.children].reduce((sum, c) => sum + c.getBoundingClientRect().width, 0),
      }))

      expect(
        geometry.scrollWidth,
        `header content (${geometry.scrollWidth}px) overflows its shell (${geometry.clientWidth}px) at ${width}px`,
      ).toBeLessThanOrEqual(geometry.clientWidth + 1)

      expect(geometry.right, `header extends past the viewport at ${width}px`).toBeLessThanOrEqual(width)

      expect(
        geometry.naturalWidth,
        `header content needs ${Math.round(geometry.naturalWidth)}px but the shell caps at ${geometry.clientWidth}px`,
      ).toBeLessThanOrEqual(geometry.clientWidth + 1)

      // A nav item is one line. 44px is the interactive minimum plus slack, comfortably under two lines.
      const tall = await header.evaluate((el) =>
        [...el.querySelectorAll('a, button')]
          .filter((n) => (n.textContent ?? '').trim() && (n as HTMLElement).offsetHeight > 44)
          .map((n) => `${(n.textContent ?? '').trim()} (${(n as HTMLElement).offsetHeight}px)`))
      expect(tall, `these header items wrapped onto more than one line at ${width}px`).toEqual([])

      const inlineNav = header.locator('ul').first()
      const hamburger = header.getByRole('button', { name: 'Open menu' })

      if (width >= BREAKPOINT) {
        await expect(inlineNav, `the inline nav should show at ${width}px`).toBeVisible()
        await expect(hamburger, `the hamburger should be hidden at ${width}px`).toBeHidden()
      } else {
        await expect(inlineNav, `the inline nav should be hidden at ${width}px`).toBeHidden()
        await expect(hamburger, `the hamburger should show at ${width}px`).toBeVisible()

        // Hiding the inline nav is only acceptable if the drawer actually replaces it.
        await hamburger.click()
        // By test id, and both alternatives were tried first. A bare `getByRole('dialog')` matches two
        // elements for an anonymous visitor — the cookie-consent banner is also `role="dialog"` — and fails
        // strict mode. Adding `{ name: 'Menu' }` resolved at 1024px and above but not at 375px, because
        // Radix names the panel through `aria-labelledby` and that did not resolve at every viewport. The
        // drawer carries `data-testid="public-nav-drawer"` for exactly this.
        const drawer = page.getByTestId('public-nav-drawer')
        await expect(drawer).toBeVisible()
        for (const label of ['How it works', 'Sources', 'Explore', 'Pricing', 'Blog', 'Status']) {
          await expect(
            drawer.getByRole('link', { name: label, exact: true }),
            `"${label}" is unreachable at ${width}px: not inline, not in the drawer`,
          ).toBeVisible()
        }
      }
    })
  }
})
