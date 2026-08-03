/**
 * The admin console in a browser (plan 53, task 9).
 *
 * `tests/e2e/api/admin.spec.ts` probes all 70 admin endpoints for authorization. This is the other half: the
 * pages themselves, where two distinct things can go wrong that the API matrix cannot see.
 *
 * **The route renders for the wrong person.** An endpoint returning 403 is not the same as a page refusing to
 * render. A shell that mounts, shows the admin chrome, and only then discovers the caller is a tenant owner
 * has already told them the console exists and what it contains. Worse, in this app the admin surface is
 * reached by URL — there is no link for a non-admin to click — so the only thing between a curious customer
 * and the operations console is the route guard.
 *
 * **The page renders for the right person and is broken.** These pages are only ever opened during an
 * incident, by someone under time pressure. An admin page that errors is discovered at the worst possible
 * moment, and its failure is invisible until then because nobody browses the console for fun.
 *
 * So: every admin page, twice — refused for a tenant owner, rendered for a platform admin.
 */
import { expect, test } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from './harness/fixtures/platform-admin'
import { disposePrincipal, type Principal } from './harness/fixtures/principals'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'

let harness: InterviewHarness
let admin: Principal

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  // Env-allowlisted, so the id has to exist before the server process starts.
  const seed = reservePlatformAdminSeed(`w${workerIndex}-adminj`)
  registerPlatformAdminEnv(seed)

  harness = await startInterviewHarness({ scope: 'adminj' })
  admin = await createPlatformAdminPrincipal(harness.ctx, seed)
})

test.afterAll(async () => {
  await disposePrincipal(admin).catch(() => undefined)
  await stopInterviewHarness(harness)
})

/**
 * Every admin page that declares a page-level test id, with the route that reaches it.
 *
 * `/admin/plan-requests` was removed on 2026-08-03: the self-service upgrade queue it managed could not be fed
 * — `LegacyPlanMutationDisabledError` refused every request once billing was enabled — so the screen reviewed
 * an empty list by construction. Granting a tier by hand now happens on `/admin/users`, against the
 * organization that is actually entitled.
 */
const PAGES = [
  { path: '/admin/users', testId: 'admin-users-page' },
  { path: '/admin/incidents', testId: 'admin-incidents-page' },
  { path: '/admin/roadmap', testId: 'admin-roadmap-page' },
  { path: '/admin/changelog', testId: 'admin-changelog-page' },
  { path: '/admin/content', testId: 'admin-content-page' },
  { path: '/admin/metrics', testId: 'admin-metrics-page' },
  { path: '/admin/operations', testId: 'admin-operations-page' },
  { path: '/admin/integrations', testId: 'admin-integrations-page' },
  { path: '/admin/claims', testId: 'admin-claims-page' },
  { path: '/admin/solutions-gold-set', testId: 'gold-set-page' },
] as const

test.describe('a platform admin', () => {
  for (const page of PAGES) {
    test(`${page.path} renders`, async ({ browser }) => {
      /**
       * "It renders" is a low bar everywhere else and the right bar here. These pages are opened during an
       * incident by someone under time pressure; nobody browses the console for fun, so a page that throws on
       * mount stays broken until the moment it is needed most.
       */
      const context = await browser.newContext({ storageState: admin.storageState! })
      const tab = await context.newPage()
      const guard = expectStrictBrowser(tab)
      try {
        await gotoHydrated(tab, `${harness.baseURL}${page.path}`)
        await dismissOverlays(tab)
        await expect(tab.getByTestId(page.testId)).toBeVisible({ timeout: 20_000 })
      } finally {
        guard.dispose()
        await context.close()
      }
    })
  }
})

test.describe('a tenant owner who is not a platform admin', () => {
  for (const page of PAGES) {
    test(`${page.path} does not render for them`, async ({ browser }) => {
      /**
       * The boundary that matters, and the reason it is asserted per page rather than once: the admin surface
       * is reached by URL — a non-admin has no link to click — so the route guard is the only thing between a
       * curious customer and the operations console. One page missing its guard is the whole console.
       *
       * A 403 from the API is not enough on its own: a shell that mounts and *then* discovers who is asking
       * has already shown that the page exists and roughly what is on it.
       */
      const context = await browser.newContext({ storageState: harness.owner.storageState! })
      const tab = await context.newPage()
      const guard = expectStrictBrowser(tab)
      // A refused admin fetch legitimately logs a 401/403 — that is the guard working, not page breakage.
      guard.allowExpectedFailure(/40[13]/)
      try {
        await gotoHydrated(tab, `${harness.baseURL}${page.path}`)
        /**
         * No `dismissOverlays` here, unlike the admin-side tests above, and the reason is a finding rather
         * than a convenience: on an admin route loaded by a *non-admin*, `getByTestId('tos-modal-accept')`
         * resolves to **two** elements. Two accept buttons means two modals, which means two shells mounted at
         * once — the guarded one and whatever it falls back to.
         *
         * It does not affect this assertion (nothing needs clicking to prove a page did not render), so the
         * helper is dropped rather than worked around, and the duplicate is recorded as a `fixme` below where
         * it can be seen.
         */
        await expect(tab.getByTestId(page.testId)).toHaveCount(0)
      } finally {
        guard.dispose()
        await context.close()
      }
    })
  }
})

test('a signed-out visitor reaches sign-in, not the console', async ({ browser }) => {
  const context = await browser.newContext()
  const tab = await context.newPage()
  try {
    await tab.goto(`${harness.baseURL}/admin/users`)
    await expect(tab).toHaveURL(/\/auth\/sign-in/, { timeout: 20_000 })
    await expect(tab.getByTestId('admin-users-page')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('the admin user list never renders a password hash or session token', async ({ browser }) => {
  /**
   * `/admin/users` is the one console page that renders other people's accounts. The API matrix proves who may
   * call it; this proves what comes back is safe to put on a screen — a leak here is every user at once.
   */
  const context = await browser.newContext({ storageState: admin.storageState! })
  const tab = await context.newPage()
  const guard = expectStrictBrowser(tab)
  try {
    await gotoHydrated(tab, `${harness.baseURL}/admin/users`)
    await dismissOverlays(tab)
    await expect(tab.getByTestId('admin-users-page')).toBeVisible({ timeout: 20_000 })

    const html = (await tab.content()).toLowerCase()
    for (const forbidden of ['passwordhash', 'password_hash', 'sessiontoken', 'session_token', 'twofactorsecret']) {
      expect(html, `the admin user list rendered "${forbidden}"`).not.toContain(forbidden)
    }
  } finally {
    guard.dispose()
    await context.close()
  }
})

test.fixme('an admin route refused to a tenant owner mounts one shell, not two', async ({ browser }) => {
  /**
   * **Found by this spec, deliberately not fixed here.**
   *
   * Loading `/admin/users` as a tenant owner puts two `tos-modal-accept` buttons in the DOM. Playwright's
   * strict mode caught it — a click would have been ambiguous — but the underlying fact is that the refused
   * route renders two overlapping shells rather than one.
   *
   * Why it is worth fixing rather than tolerating: two mounted shells means two copies of every effect the
   * shell runs, so a duplicated modal is the *visible* symptom of duplicated data fetching, duplicated
   * analytics, and a focus trap that can fight itself. It is also a real accessibility problem — a screen
   * reader meets two dialogs with the same accessible name and no way to tell which one is live.
   *
   * Not chased further here because the fix is in the route-guard/layout composition rather than in this test,
   * and the surrounding assertion (the admin page does not render for a non-admin) holds regardless.
   */
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const tab = await context.newPage()
  const guard = expectStrictBrowser(tab)
  guard.allowExpectedFailure(/40[13]/)
  try {
    await gotoHydrated(tab, `${harness.baseURL}/admin/users`)
    await expect(tab.getByTestId('tos-modal-accept')).toHaveCount(1)
  } finally {
    guard.dispose()
    await context.close()
  }
})
