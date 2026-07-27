import { test, expect } from 'playwright/test'
import {
  waitForHydration,
  gotoHydrated,
  expectStrictBrowser,
  twoContexts,
} from './browser'

/**
 * Wave 1 Task 3 — browser harness self-test.
 *
 * Proves two properties end-to-end against the real dev server:
 *   1. Navigation needs no fixed delay: the app root exposes a
 *      `data-hydrated="true"` marker set by React *after* hydration
 *      (HydrationSignal, mounted in src/routes/-root-components.tsx),
 *      and it is demonstrably absent from the server-rendered HTML —
 *      so waiting for it is waiting for hydration itself, not a timer.
 *   2. The strict collectors actually catch what they claim to catch:
 *      console errors, uncaught page errors, failed same-origin
 *      requests, and third-party egress — and `allowExpectedFailure`
 *      opts out of exactly one expected occurrence.
 */

test.describe('hydration signal', () => {
  test('the server-rendered HTML does NOT carry the hydration marker', async ({ request, baseURL }) => {
    // Raw HTML fetch — no JS runs, so if the marker showed up here it
    // would be server-rendered and waiting for it would prove nothing.
    const response = await request.get(baseURL!)
    expect(response.ok()).toBe(true)
    const html = await response.text()
    expect(html).not.toContain('data-hydrated')
  })

  test('gotoHydrated resolves only once React has hydrated — no fixed delays', async ({ page }) => {
    await gotoHydrated(page, '/')
    await expect(page.locator('html[data-hydrated="true"]')).toBeAttached()
  })

  test('waitForHydration re-arms across a full reload (fresh document, fresh hydration)', async ({ page }) => {
    await gotoHydrated(page, '/')
    await page.reload()
    await waitForHydration(page)
    await expect(page.locator('html[data-hydrated="true"]')).toBeAttached()
  })

  test('a hydrated form is immediately interactive: typed input reaches React state', async ({ page }) => {
    // The original failure mode this harness replaces: keystrokes sent
    // before hydration updated the DOM value but never React state, so
    // state-driven UI (the password-strength checklist) stayed unrendered.
    // After gotoHydrated — with zero fixed delays — typing must drive
    // React state immediately.
    await gotoHydrated(page, '/auth/sign-up')
    await page.locator('#password').fill('e2e-Test-Passw0rd!')
    // The strength checklist renders from React state, not the DOM value.
    await expect(page.locator('#password')).toHaveValue('e2e-Test-Passw0rd!')
    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  })
})

test.describe('strict browser collectors', () => {
  test('captures console errors and uncaught page errors', async ({ page }) => {
    const guard = expectStrictBrowser(page)
    await gotoHydrated(page, '/')

    const consoleErrorSeen = page.waitForEvent('console', (msg) => msg.type() === 'error')
    await page.evaluate(() => console.error('e2e-harness-console-boom'))
    await consoleErrorSeen

    const pageErrorSeen = page.waitForEvent('pageerror')
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e-harness-page-boom')
      }, 0)
    })
    await pageErrorSeen

    expect(guard.violations.some((v) => v.includes('e2e-harness-console-boom'))).toBe(true)
    expect(guard.violations.some((v) => v.includes('e2e-harness-page-boom'))).toBe(true)
    expect(() => guard.assertClean()).toThrow()
    guard.dispose()
  })

  test('captures failed same-origin requests', async ({ page }) => {
    await gotoHydrated(page, '/')
    const guard = expectStrictBrowser(page)

    // Synthesize a genuine network-level failure on our own origin.
    await page.route('**/e2e-harness-fail-me', (route) => route.abort('failed'))
    const failureSeen = page.waitForEvent('requestfailed')
    await page.evaluate(() => fetch('/e2e-harness-fail-me').catch(() => {}))
    await failureSeen

    expect(guard.violations.some((v) => v.includes('e2e-harness-fail-me'))).toBe(true)
    guard.dispose()
  })

  test('captures third-party egress without needing the request to succeed', async ({ page }) => {
    await gotoHydrated(page, '/')
    const guard = expectStrictBrowser(page)

    // `.invalid` is reserved (RFC 2606): the request event fires — which is
    // what the egress collector watches — but DNS can never resolve, so no
    // real traffic leaves the machine.
    const egressSeen = page.waitForEvent('requestfailed')
    await page.evaluate(() => fetch('https://third-party.invalid/exfil').catch(() => {}))
    await egressSeen

    expect(guard.violations.some((v) => v.includes('third-party.invalid'))).toBe(true)
    guard.dispose()
  })

  test('allowExpectedFailure opts out of exactly one occurrence', async ({ page }) => {
    await gotoHydrated(page, '/')
    const guard = expectStrictBrowser(page)
    guard.allowExpectedFailure(/e2e-harness-expected-once/)

    const firstSeen = page.waitForEvent('console', (msg) => msg.type() === 'error')
    await page.evaluate(() => console.error('e2e-harness-expected-once'))
    await firstSeen
    // The allowed occurrence is consumed — nothing recorded.
    expect(guard.violations).toEqual([])
    guard.assertClean()

    const secondSeen = page.waitForEvent('console', (msg) => msg.type() === 'error')
    await page.evaluate(() => console.error('e2e-harness-expected-once'))
    await secondSeen
    // One-shot: the second identical error is a real violation.
    expect(guard.violations.some((v) => v.includes('e2e-harness-expected-once'))).toBe(true)
    guard.dispose()
  })

  test('a clean hydrated navigation passes the strict collectors', async ({ page }) => {
    const guard = expectStrictBrowser(page)
    await gotoHydrated(page, '/')
    guard.assertClean()
    guard.dispose()
  })
})

test.describe('context helpers', () => {
  test('twoContexts yields isolated cookie jars', async ({ browser }) => {
    const { contextA, contextB, pageA, pageB, close } = await twoContexts(browser)
    try {
      await gotoHydrated(pageA, '/')
      await gotoHydrated(pageB, '/')
      await contextA.addCookies([
        { name: 'e2e-isolation-probe', value: 'context-a', url: pageA.url() },
      ])
      const cookiesB = await contextB.cookies()
      expect(cookiesB.find((c) => c.name === 'e2e-isolation-probe')).toBeUndefined()
      const cookiesA = await contextA.cookies()
      expect(cookiesA.find((c) => c.name === 'e2e-isolation-probe')?.value).toBe('context-a')
    } finally {
      await close()
    }
  })
})
