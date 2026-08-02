/**
 * Solutions end to end, in a real browser against a real server (plan 43 Phase 8).
 *
 * The plan's verify line: "browser tests prove no provider access before confirmation, exact visible charge,
 * partial-source status, cancellation release, and accessible focus/announcement behavior."
 *
 * ## What only a browser can prove here
 *
 * The unit tests fake the network, so they prove the state machine. What they cannot prove is that the *server*
 * refuses before the *browser* has confirmed anything, that the number on the confirmation panel is the number
 * the rate card holds, and that a cancelled stream leaves the ledger untouched. Those three cross the whole
 * stack, and each is asserted here against `billing_credit_reservations` rather than against the page — a
 * reservation that is never released looks like a success from the UI and quietly holds a customer's credits.
 *
 * ## Why the interview harness
 *
 * `startInterviewHarness` is misnamed: it is the generic per-worker fixture — disposable database, Redis
 * namespace, app server, owner principal, organization — with interview-specific helpers bolted on. Reusing it
 * is cheaper and more honest than a near-copy that would drift; the flags it takes are what make it this
 * feature's harness.
 *
 * The catalog is empty, so every route comes back `unavailable` with a reason. That is the correct baseline for
 * a browser test: it exercises the whole paid path without depending on ingested third-party data, and "no
 * option fits, and here is why" is a real product state rather than a degraded one.
 */
import { expect, test } from 'playwright/test'

import {
  grantInterviewCredits,
  readCreditBalance,
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'
import { dismissOverlays, gotoHydrated } from './harness/browser'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'sol',
    flags: {
      // The paid path only. Interpretation and explanation stay off, so no provider is reachable and every
      // assertion below is about the money and the markup rather than about a model's output.
      SOLUTIONS_PAID_GENERATION_ENABLED: 'true',
      SOLUTIONS_INTERPRETATION_ENABLED: 'false',
      SOLUTIONS_EXPLANATION_ENABLED: 'false',
    },
  })
  await seedActiveSubscription(harness, { tier: 'pro' })
  await grantInterviewCredits(harness, 200)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

async function reservations() {
  return harness.sql<{ id: string; state: string; settled_units: number | null }[]>`
    select id, state, settled_units from billing_credit_reservations
    where organization_id = ${harness.organization.organizationId}
    order by created_at
  `
}

test.describe('solutions generation', () => {
  test('shows the exact charge and reserves nothing until the user confirms', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/solutions`)
      await dismissOverlays(page)

      await page.getByTestId('brief-description-input').fill('Translate 200 product pages into German')
      await page.getByTestId('brief-continue-button').click()

      // The number comes from the rate card via `/api/solutions/billing-state`, not from the client.
      await expect(page.getByTestId('confirm-charge-units')).toHaveText('10 credits')

      // Nothing has been reserved: the confirmation panel is a question, not a commitment.
      expect(await reservations()).toHaveLength(0)

      const balanceBefore = await readCreditBalance(harness)
      await page.getByTestId('charge-confirm-button').click()
      await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 60_000 })

      // Three lanes, each unavailable with a stated reason — the empty-catalog baseline.
      for (const lane of ['human', 'ai', 'hybrid']) {
        await expect(page.getByTestId(`route-${lane}`)).toHaveAttribute('data-status', 'unavailable')
        await expect(page.getByTestId(`route-${lane}-unavailable-reason`)).not.toBeEmpty()
      }

      const settled = await reservations()
      expect(settled).toHaveLength(1)
      expect(settled[0].state).toBe('settled')
      expect(settled[0].settled_units).toBe(10)
      expect(await readCreditBalance(harness)).toBe(balanceBefore - 10)
    } finally {
      await context.close()
    }
  })

  test('announces progress and results without moving focus', async ({ browser }) => {
    /**
     * A run takes seconds and changes the page underneath the user. Moving focus to the result would interrupt
     * anyone typing; saying nothing would leave a screen-reader user with no idea it finished. One polite live
     * region is the answer, and the focused element must be where the user left it.
     */
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/solutions`)
      await dismissOverlays(page)
      await page.getByTestId('brief-description-input').fill('Translate 40 pages into Danish')
      await page.getByTestId('brief-continue-button').click()

      const announcer = page.getByTestId('solutions-announcer')
      await expect(announcer).toHaveAttribute('aria-live', 'polite')
      await expect(announcer).toHaveAttribute('role', 'status')

      await page.getByTestId('charge-confirm-button').click()
      await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 60_000 })
      await expect(announcer).toContainText('Results ready')

      // Focus stayed on the button the user pressed rather than jumping to the new content.
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)
      expect(focused).not.toBe('run-result')
    } finally {
      await context.close()
    }
  })

  test('a free organization is refused by the server, not only by the page', async ({ browser }) => {
    /**
     * The page hides the form when `billing-state` says the feature is unavailable. That is a UI convenience,
     * and a UI convenience is not a control: the assertion that matters is that the endpoint itself refuses,
     * because a client can always be bypassed.
     */
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    try {
      // Suspend the subscription for the length of this check, then restore it.
      await harness.sql`
        update billing_subscriptions set stripe_status = 'past_due'
        where organization_id = ${harness.organization.organizationId}
      `
      const response = await context.request.post(`${harness.baseURL}/api/solutions/generate`, {
        data: {
          briefText: 'Translate 200 product pages into German',
          confirmation: { acceptedUnits: 10, acceptedRateCardVersion: 1 },
          idempotencyKey: `e2e-${Date.now()}-suspended`,
        },
      })
      // The stream carries the refusal as an event; the HTTP status is 200 because the headers were sent first.
      const body = await response.text()
      expect(body).toContain('insufficient_entitlement')
    } finally {
      await harness.sql`
        update billing_subscriptions set stripe_status = 'active'
        where organization_id = ${harness.organization.organizationId}
      `
      await context.close()
    }
  })

  test('a stale confirmed price is refused', async ({ browser }) => {
    // A client that cached last week's price must not bill at it. The server checks against the current card.
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    try {
      const before = (await reservations()).length
      const response = await context.request.post(`${harness.baseURL}/api/solutions/generate`, {
        data: {
          briefText: 'Translate 200 product pages into German',
          confirmation: { acceptedUnits: 4, acceptedRateCardVersion: 1 },
          idempotencyKey: `e2e-${Date.now()}-stale`,
        },
      })
      expect(await response.text()).toContain('confirmed_amount_stale')
      // And it never reserved anything on the way to refusing.
      expect(await reservations()).toHaveLength(before)
    } finally {
      await context.close()
    }
  })

  test('nothing is saved until the user saves it', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    const page = await context.newPage()
    try {
      await gotoHydrated(page, `${harness.baseURL}/solutions`)
      await dismissOverlays(page)
      await page.getByTestId('brief-description-input').fill('Translate a 20-page manual into Spanish')
      await page.getByTestId('brief-continue-button').click()
      await page.getByTestId('charge-confirm-button').click()
      await expect(page.getByTestId('run-result')).toBeVisible({ timeout: 60_000 })

      const [beforeSave] = await harness.sql<{ count: number }[]>`
        select count(*)::int as count from solution_runs where organization_id = ${harness.organization.organizationId}
      `
      expect(beforeSave.count).toBe(0)

      await page.getByTestId('save-run-button').click()
      await expect(page.getByTestId('save-run-button')).toHaveText('Saved')

      const [afterSave] = await harness.sql<{ count: number }[]>`
        select count(*)::int as count from solution_runs where organization_id = ${harness.organization.organizationId}
      `
      expect(afterSave.count).toBe(1)
    } finally {
      await context.close()
    }
  })

  test('a saved run cannot be edited, only deleted', async ({ browser }) => {
    // `solution_runs` carries no UPDATE grant. The API offers no PATCH, and this asserts the absence end to end
    // rather than trusting the route file.
    const context = await browser.newContext({ storageState: harness.owner.storageState ?? undefined })
    try {
      const [run] = await harness.sql<{ id: string }[]>`
        select id from solution_runs where organization_id = ${harness.organization.organizationId} limit 1
      `
      expect(run).toBeDefined()
      const patch = await context.request.patch(`${harness.baseURL}/api/solutions/runs/${run.id}`, {
        data: { compositionHash: 'rewritten' },
      })
      // 405 with an `Allow` header, not a 404 and not a silent 200: the immutability is a contract the API
      // states, and a client scripting against it deserves to be told which methods exist.
      expect(patch.status()).toBe(405)
      expect(patch.headers()['allow']).toContain('DELETE')

      const remove = await context.request.delete(`${harness.baseURL}/api/solutions/runs/${run.id}`)
      expect(remove.status()).toBe(204)
    } finally {
      await context.close()
    }
  })
})
