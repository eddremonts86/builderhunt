/**
 * Signed Stripe webhooks over real HTTP (plan 53, task 4).
 *
 * This endpoint is the only unauthenticated write in the product. There is no session, no tenant, no CSRF
 * token — the signature *is* the authorization, and anything that weakens it hands an attacker the ability to
 * mint payments. So the tests below are mostly refusals, and each refusal is a different way the signature can
 * be wrong:
 *
 * - **no signature at all** — the trivial probe, and the one a misconfigured proxy produces by stripping
 *   headers it does not recognise.
 * - **a signature over different bytes** — this is why the route reads `request.text()` and not `request.json()`.
 *   Any re-serialisation changes the bytes and breaks verification; a handler that parsed first and verified
 *   against the re-encoded body would accept forgeries.
 * - **a stale timestamp** — a valid signature replayed later. Without the tolerance window, a captured request
 *   is reusable forever.
 * - **the wrong API version or livemode** — a *correctly signed* event from the wrong Stripe account or a
 *   mismatched version. The signature proves origin, not relevance, and a live-mode event applied to test data
 *   (or the reverse) corrupts real money records.
 *
 * Signing is done here with the same HMAC construction Stripe documents, against the E2E secret the harness
 * gives the server — no Stripe SDK helper, so the test cannot accidentally agree with the implementation by
 * sharing a bug.
 */
import { createHmac } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from 'playwright/test'

import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'

/** Pinned rather than read from the environment, so the test and the server cannot disagree about it. */
const API_VERSION = '2025-10-29.clover'

const SECRET = 'whsec_e2e_primary_secret'
const PREVIOUS_SECRET = 'whsec_e2e_previous_secret'

let harness: InterviewHarness
/** Unauthenticated on purpose: a webhook arrives with no session, and this must work without one. */
let anonymous: APIRequestContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'whook',
    flags: {
      /**
       * The *server* verifies with `STRIPE_WEBHOOK_SECRET` / `..._PREVIOUS` — the real variables, read through
       * `env`. The `E2E_STRIPE_WEBHOOK_SECRET` pair is a read-only accessor pointing the other way: it tells a
       * harness which secret to sign fixtures with, and setting it does not change what the server accepts.
       * Setting only those is what made this spec's first run answer `invalid_signature` for a signature that
       * was, in fact, correct.
       */
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_WEBHOOK_SECRET_PREVIOUS: PREVIOUS_SECRET,
      STRIPE_API_VERSION: API_VERSION,
    },
  })
  anonymous = await playwrightRequest.newContext({ baseURL: harness.baseURL })
})

test.afterAll(async () => {
  await anonymous.dispose().catch(() => undefined)
  await stopInterviewHarness(harness)
})


function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `evt_e2e_${Math.abs(Date.parse('2026-08-02T12:00:00Z'))}`,
    object: 'event',
    api_version: API_VERSION,
    livemode: false,
    type: 'checkout.session.completed',
    created: 1_754_136_000,
    data: { object: { object: 'checkout.session', id: 'cs_e2e_1' } },
    ...overrides,
  })
}

/**
 * Stripe's documented scheme: `t=<unix>,v1=<hmac_sha256(secret, "<t>.<payload>")>`.
 *
 * Written out rather than borrowed from the Stripe SDK on purpose. If the test signed with the same helper the
 * implementation verifies with, a bug in that helper would be invisible — both sides would be wrong together.
 */
function sign(payload: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`).digest('hex')
  return `t=${timestampSeconds},v1=${signature}`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

async function post(payload: string, signature: string | null) {
  const response = await anonymous.post('/api/webhooks/stripe', {
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'stripe-signature': signature } : {}),
    },
    data: payload,
  })
  return { status: response.status(), body: await response.text() }
}

test('a correctly signed event is accepted', async () => {
  const payload = eventBody({ id: 'evt_e2e_accepted' })
  const result = await post(payload, sign(payload, SECRET, nowSeconds()))

  expect(result.status, result.body).toBe(200)
  const body = JSON.parse(result.body) as { received: boolean; eventId: string }
  expect(body.received).toBe(true)
  expect(body.eventId, 'the receipt names the event it recorded').toBe('evt_e2e_accepted')
})

test('no signature header is refused', async () => {
  const payload = eventBody({ id: 'evt_e2e_unsigned' })
  const result = await post(payload, null)

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('missing_signature')
})

test('a signature made with the wrong secret is refused', async () => {
  const payload = eventBody({ id: 'evt_e2e_wrongsecret' })
  const result = await post(payload, sign(payload, 'whsec_not_our_secret', nowSeconds()))

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('invalid_signature')
})

test('a signature over different bytes is refused', async () => {
  /**
   * The forgery this endpoint most needs to resist, and the reason the route reads the raw body. An attacker
   * who captures one legitimate request has a valid `t`/`v1` pair; if the server verified against a
   * re-serialised body, they could swap the payload underneath it and keep the signature.
   */
  const signed = eventBody({ id: 'evt_e2e_original' })
  const tampered = eventBody({ id: 'evt_e2e_original', livemode: false, type: 'invoice.paid' })
  const result = await post(tampered, sign(signed, SECRET, nowSeconds()))

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('invalid_signature')
})

test('a correctly signed but stale request is refused', async () => {
  // A replay. The signature is genuine; only the clock says no. Without the tolerance window a captured
  // request would be reusable indefinitely.
  const payload = eventBody({ id: 'evt_e2e_stale' })
  const result = await post(payload, sign(payload, SECRET, nowSeconds() - 60 * 60 * 24))

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('invalid_signature')
})

test('the previous secret still verifies, so rotation does not drop events', async () => {
  /**
   * Rotation is the operational reason this endpoint accepts two secrets. During the overlap Stripe may still
   * be signing with the old one, and an event dropped in that window is a payment the product never learns
   * about — silently, because the sender gets a 400 and moves on.
   */
  const payload = eventBody({ id: 'evt_e2e_rotated' })
  const result = await post(payload, sign(payload, PREVIOUS_SECRET, nowSeconds()))

  expect(result.status, result.body).toBe(200)
})

test('an event from the wrong livemode is refused even though it is signed', async () => {
  /**
   * The signature proves origin, not relevance. A live-mode event applied to a test database — or the reverse
   * in production — writes real money records from the wrong world, and no signature check catches it.
   */
  const payload = eventBody({ id: 'evt_e2e_livemode', livemode: true })
  const result = await post(payload, sign(payload, SECRET, nowSeconds()))

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('wrong_livemode')
})

test('an event for an unexpected API version is refused', async () => {
  // Stripe's payload shapes change between versions. Accepting one the code was not written against means
  // parsing a structure that may differ in exactly the field that matters.
  const payload = eventBody({ id: 'evt_e2e_apiversion', api_version: '2015-01-01' })
  const result = await post(payload, sign(payload, SECRET, nowSeconds()))

  expect(result.status).toBe(400)
  expect(JSON.parse(result.body).error).toBe('wrong_api_version')
})

test('the same event delivered twice is recorded once', async () => {
  /**
   * Stripe retries, and at-least-once delivery is its documented contract. Two deliveries of one event must
   * not become two payments — so the inbox is asserted directly rather than trusting both responses to be 200.
   */
  const payload = eventBody({ id: 'evt_e2e_duplicate' })
  const signature = sign(payload, SECRET, nowSeconds())

  const first = await post(payload, signature)
  const second = await post(payload, signature)

  expect(first.status, first.body).toBe(200)
  expect(second.status, `a retry must not error: ${second.body}`).toBe(200)

  /**
   * Keyed on `stripe_event_id`, not `id`. The table's primary key is the product's own row id; Stripe's event
   * id lives in its own column — which is the right shape, because the deduplication key belongs to the
   * sender and the row identity belongs to us. Querying `id` returned zero and briefly looked like the inbox
   * had recorded nothing at all.
   */
  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_webhook_events
    where stripe_event_id = 'evt_e2e_duplicate'
  `
  expect(rows[0]?.count, 'a retried event was recorded twice').toBe('1')
})

test('a refusal never echoes the payload or the signature', async () => {
  // The body of a rejected webhook is attacker-controlled and the header is a secret-derived value. A route
  // that reflected either into its response — or into a log a support engineer pastes somewhere — leaks both.
  const payload = eventBody({ id: 'evt_e2e_secretleak', marker: 'CANARY_PAYLOAD_VALUE' })
  const signature = sign(payload, SECRET, nowSeconds() - 60 * 60 * 24)
  const result = await post(payload, signature)

  expect(result.body).not.toContain('CANARY_PAYLOAD_VALUE')
  expect(result.body).not.toContain(signature)
  expect(result.body).not.toContain(SECRET)
})
