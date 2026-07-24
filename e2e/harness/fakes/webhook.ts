/**
 * Wave 1 Task 4 — Stripe webhook signer for E2E fixtures
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * Uses the real Stripe SDK's `Stripe.webhooks.generateTestHeaderString` —
 * never hand-rolled HMAC — so the header is accepted by the exact
 * production verifier (`receiveStripeWebhook`'s
 * `Stripe.webhooks.constructEvent` call) with zero test-only verification
 * code paths.
 */
import Stripe from 'stripe'

export interface SignStripeWebhookOptions {
  /**
   * Shift the signed timestamp by this many seconds (negative = older).
   * A delta below `-SIGNATURE_TOLERANCE_SECONDS` produces a stale header
   * the production verifier must reject.
   */
  timestampDeltaSec?: number
}

export function signStripeWebhook(payload: string, secret: string, options: SignStripeWebhookOptions = {}): string {
  if (!secret) {
    throw new Error('signStripeWebhook requires a non-empty signing secret')
  }
  const timestamp = Math.floor(Date.now() / 1000) + (options.timestampDeltaSec ?? 0)
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp })
}

export interface PostWebhookInput {
  /** Base URL of the app under test, e.g. `http://localhost:3130`. */
  baseUrl: string
  /** RAW request body — signed over these exact bytes. */
  payload: string
  secret: string
  timestampDeltaSec?: number
  /** Extra/override headers. Set `'stripe-signature': null` upstream by omitting `secret`? No — pass `headers` to override the computed ones. */
  headers?: Record<string, string>
}

/** POSTs a signed payload to the real `/api/webhooks/stripe` route. */
export async function postWebhook(input: PostWebhookInput): Promise<Response> {
  const signature = signStripeWebhook(input.payload, input.secret, { timestampDeltaSec: input.timestampDeltaSec })
  return fetch(new URL('/api/webhooks/stripe', input.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
      ...input.headers,
    },
    body: input.payload,
  })
}

/** POSTs an UNSIGNED payload — for asserting the `missing_signature` rejection. */
export async function postUnsignedWebhook(baseUrl: string, payload: string): Promise<Response> {
  return fetch(new URL('/api/webhooks/stripe', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
}

/** Minimal Stripe-event-shaped fixture the inbox accepts (id/type/api_version/livemode are what receipt validates). */
export function stripeEventFixture(overrides: Partial<{
  id: string
  type: string
  apiVersion: string | undefined
  livemode: boolean
  objectId: string
  objectType: string
}> = {}): string {
  const id = overrides.id ?? `evt_e2e_${Math.random().toString(36).slice(2)}`
  return JSON.stringify({
    id,
    object: 'event',
    api_version: overrides.apiVersion,
    created: Math.floor(Date.now() / 1000),
    livemode: overrides.livemode ?? false,
    pending_webhooks: 1,
    request: { id: `req_e2e_${id}`, idempotency_key: null },
    type: overrides.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: overrides.objectId ?? `cs_e2e_${id}`,
        object: overrides.objectType ?? 'checkout.session',
      },
    },
  })
}
