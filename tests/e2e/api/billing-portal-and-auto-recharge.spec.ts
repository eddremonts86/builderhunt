/**
 * The Portal, auto-recharge, and the checkout return status (plan 53, task 3 — the rest of the billing surface).
 *
 * `billing-authorization.spec.ts` already pins the anonymous floor across every billing route, so nothing here
 * repeats a 401. What is left is the behaviour those three routes are actually responsible for, and each has a
 * failure that a status code alone would not catch:
 *
 * - **The Portal's return URL is a redirect target.** Stripe sends the customer back to it after they finish
 *   editing a payment method. An off-origin one is an open redirect *out of a payment flow* — the most
 *   convincing possible place to land someone on a page they think is still checkout. `PortalBody` accepts any
 *   syntactically valid URL, so the schema is not what stops it; `isAllowedReturnUrl` is.
 * - **Auto-recharge charges a saved card with nobody present.** So the consent flag is not decoration, the cap
 *   is not advisory, and "off by default" is a property worth asserting rather than assuming.
 * - **The checkout return status is polled from a URL the customer's browser controls.** Its own doc says it
 *   ignores every query parameter and answers from the authenticated principal's own state. A route that read
 *   `?status=success` would let anyone declare their own payment complete by editing the address bar.
 *
 * ## Four drifts between the task text and the code, recorded rather than coded around
 *
 * The task in plan 53 describes this surface from the spec rather than from the implementation, and four
 * details do not survive contact:
 *
 * 1. It asks for `POST /api/billing/auto-recharge`. The route is **`GET`/`PUT`** — there is no POST.
 * 2. It expects an over-cap amount to answer **422** against `MAX_AUTO_RECHARGE_AMOUNT_CENTS`. The real answer
 *    is **400 `invalid_monthly_cap`**, and the ceiling is `ROLLING_RISK_MAX_AMOUNT_CENTS` (100 000 cents) —
 *    deliberately the same constant the rolling pack-charge limit uses, so a cap can never authorize more than
 *    the risk ceiling allows in the first place.
 * 3. It expects `GET /api/billing/checkout/status/$id`. There is no `$id` segment; the route is
 *    `/api/billing/checkout/status` and ignoring the id is the point (see above).
 * 4. It expects `POST /api/billing/subscription/preview` to reject a fingerprint mismatch with 409. `preview`
 *    takes only `{newCatalogKey}` — the fingerprint guard lives on `change`, and is asserted there.
 *
 * The tests follow the code. A test written to the task text would have failed for being wrong about the
 * product, which is the least useful kind of red.
 */
import { expect, test } from 'playwright/test'

import {
  addMember,
  addSecondOrganization,
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from '../harness/fixtures/interviews'
import type { Principal } from '../harness/fixtures/principals'

let harness: InterviewHarness
/** An admin: elevated enough to read the financial summary, never enough to move money. */
let admin: Principal
/** A plain member: no financial detail at all. */
let member: Principal
/** An owner of a different organization that has never subscribed — so it has no billing customer. */
let unsubscribedOwner: Principal

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'billportal' })
  await seedActiveSubscription(harness, { tier: 'team', interval: 'monthly' })
  admin = await addMember(harness, 'admin')
  member = await addMember(harness, 'member')
  unsubscribedOwner = (await addSecondOrganization(harness)).principal
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test.describe('POST /api/billing/portal', () => {
  test('opens a session for the owner and returns a usable URL', async () => {
    const response = await harness.owner.api!.post('/api/billing/portal', {
      data: { returnUrl: `${harness.baseURL}/settings/billing` },
    })
    const body = await response.text()
    expect(response.status(), body).toBe(200)
    const session = JSON.parse(body) as { url: string }
    expect(session.url, 'the caller needs somewhere to send the customer').toMatch(/^https?:\/\//)
  })

  test('refuses an off-origin return URL with invalid_url, not with a schema error', async () => {
    /**
     * The distinction is the whole test. `z.string().url()` is satisfied by `https://evil.test/paid` — a
     * schema-only defence would let it through to Stripe, which would then redirect the customer there after
     * they finished editing their card. Both refusals are 400, so the *code* is what proves which layer caught
     * it, and therefore that the origin check exists at all.
     */
    const offOrigin = await harness.owner.api!.post('/api/billing/portal', {
      data: { returnUrl: 'https://evil.test/paid' },
    })
    expect(offOrigin.status(), await offOrigin.text()).toBe(400)
    expect(await offOrigin.json()).toMatchObject({ code: 'invalid_url' })

    // The contrast: a value that is not a URL at all is stopped one layer earlier and carries no product code.
    const notAUrl = await harness.owner.api!.post('/api/billing/portal', { data: { returnUrl: 'not-a-url' } })
    expect(notAUrl.status()).toBe(400)
    expect(await notAUrl.json(), 'a malformed URL is a schema failure, not a policy one').not.toMatchObject({
      code: 'invalid_url',
    })
  })

  test('an organization that never subscribed gets 404, not a session', async () => {
    // No billing customer exists, so there is nothing to open a Portal onto. 404 rather than 500: the absence
    // is an ordinary state for a free organization, not a server fault.
    const response = await unsubscribedOwner.api!.post('/api/billing/portal', {
      data: { returnUrl: `${harness.baseURL}/settings/billing` },
    })
    expect(response.status(), await response.text()).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'no_customer' })
  })

  test('an admin is refused — the Portal is owner-only', async () => {
    /**
     * An admin can read this organization's whole financial position, which is exactly why this is worth
     * pinning separately: the Portal is not a read. It reaches a saved payment method, so the role that may
     * look at invoices must not be the role that can change the card they are paid from.
     */
    const response = await admin.api!.post('/api/billing/portal', {
      data: { returnUrl: `${harness.baseURL}/settings/billing` },
    })
    expect(response.status(), await response.text()).toBe(403)
  })
})

test.describe('GET/PUT /api/billing/auto-recharge', () => {
  test('is off by default', async () => {
    // spec.md: "Auto-recharge is off by default, owner-only". A product that shipped this on would charge a
    // saved card without the customer ever having asked, which is the one thing off-session consent exists for.
    const response = await harness.owner.api!.get('/api/billing/auto-recharge')
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json(), 'an organization that never configured auto-recharge has no rule').toEqual({
      rule: null,
    })
  })

  test('refuses a cap above the risk ceiling', async () => {
    /**
     * 400 `invalid_monthly_cap`, not the 422 the task text predicted — see the drift note at the top. The
     * ceiling is `ROLLING_RISK_MAX_AMOUNT_CENTS`, 100 000 cents, and reusing the rolling-limit constant is
     * deliberate: a monthly cap that exceeded the risk ceiling would be a promise the charge path could not
     * keep anyway.
     */
    const response = await harness.owner.api!.fetch('/api/billing/auto-recharge', {
      method: 'PUT',
      data: {
        enabled: true,
        packCatalogKey: 'starter_300',
        balanceThresholdUnits: 50,
        monthlyCapCents: 100_001,
        acknowledgedOffSessionCharge: true,
      },
    })
    expect(response.status(), await response.text()).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_monthly_cap' })

    const [row] = await harness.sql<{ count: string }[]>`
      select count(*)::text as count from billing_auto_recharge_rules
      where organization_id = ${harness.organization.organizationId}
    `
    expect(row.count, 'a rejected configuration must not leave a rule behind').toBe('0')
  })

  test('cannot be enabled without acknowledging the off-session charge', async () => {
    /**
     * `acknowledgedOffSessionCharge` is a `z.literal(true)`, so this is refused by the schema rather than by a
     * service check — which is the stronger arrangement: there is no code path that could enable the rule
     * without the acknowledgement, not merely one that remembers to look.
     */
    const response = await harness.owner.api!.fetch('/api/billing/auto-recharge', {
      method: 'PUT',
      data: {
        enabled: true,
        packCatalogKey: 'starter_300',
        balanceThresholdUnits: 50,
        monthlyCapCents: 5_000,
        acknowledgedOffSessionCharge: false,
      },
    })
    expect(response.status(), await response.text()).toBe(400)

    const [row] = await harness.sql<{ count: string }[]>`
      select count(*)::text as count from billing_auto_recharge_rules
      where organization_id = ${harness.organization.organizationId} and enabled = true
    `
    expect(row.count, 'auto-recharge was enabled without off-session consent').toBe('0')
  })

  test('enables with a recorded consent version, then disables', async () => {
    /**
     * The success path, asserted against the row rather than the response: `consent_version` is what proves the
     * owner agreed to *these* terms, and it is the field a later dispute is answered from. The response body
     * could report an enabled rule while writing nothing.
     */
    const enable = await harness.owner.api!.fetch('/api/billing/auto-recharge', {
      method: 'PUT',
      data: {
        enabled: true,
        packCatalogKey: 'starter_300',
        balanceThresholdUnits: 50,
        monthlyCapCents: 5_000,
        acknowledgedOffSessionCharge: true,
      },
    })
    expect(enable.status(), await enable.text()).toBe(200)

    const [enabled] = await harness.sql<{
      enabled: boolean; state: string; monthly_cap_cents: number; consent_version: string | null
    }[]>`
      select enabled, state, monthly_cap_cents, consent_version from billing_auto_recharge_rules
      where organization_id = ${harness.organization.organizationId}
    `
    expect(enabled.enabled).toBe(true)
    expect(enabled.state).toBe('active')
    expect(enabled.monthly_cap_cents).toBe(5_000)
    expect(enabled.consent_version, 'an off-session charge with no recorded consent version is unanswerable').toBeTruthy()

    const disable = await harness.owner.api!.fetch('/api/billing/auto-recharge', {
      method: 'PUT',
      data: { enabled: false },
    })
    expect(disable.status(), await disable.text()).toBe(200)

    const [disabled] = await harness.sql<{ enabled: boolean }[]>`
      select enabled from billing_auto_recharge_rules
      where organization_id = ${harness.organization.organizationId}
    `
    expect(disabled.enabled, 'turning auto-recharge off must actually stop it').toBe(false)
  })

  test('an admin can neither read nor write it', async () => {
    // Unlike the financial summary, the auto-recharge rule is payment-method-adjacent in both directions —
    // spec.md classifies the configuration itself, not just its mutation, as owner-only.
    const read = await admin.api!.get('/api/billing/auto-recharge')
    expect(read.status(), await read.text()).toBe(403)

    const write = await admin.api!.fetch('/api/billing/auto-recharge', {
      method: 'PUT',
      data: { enabled: false },
    })
    expect(write.status(), await write.text()).toBe(403)
  })
})

test.describe('GET /api/billing/checkout/status', () => {
  test('ignores forged query parameters entirely', async () => {
    /**
     * The route's own claim, asserted rather than trusted: "a URL with a forged `session_id`/`status=success`
     * parameter has zero effect". The customer's browser is what returns to this page, so the parameters are
     * attacker-controlled by construction. Comparing the two bodies byte for byte is the assertion — a route
     * that read either parameter would differ somewhere.
     */
    const [plain, forged] = await Promise.all([
      harness.owner.api!.get('/api/billing/checkout/status'),
      harness.owner.api!.get('/api/billing/checkout/status?session_id=cs_forged&status=success&paid=true'),
    ])

    expect(plain.status(), await plain.text()).toBe(200)
    expect(forged.status()).toBe(200)
    expect(await forged.text(), 'a forged return URL changed what the product reports').toBe(await plain.text())
  })

  test('a plain member is refused', async () => {
    // The checkout status says whether this organization has paid. That is financial detail, and a member gets
    // feature availability only.
    const response = await member.api!.get('/api/billing/checkout/status')
    expect(response.status(), await response.text()).toBe(403)
  })
})
