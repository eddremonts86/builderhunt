/**
 * Server-only lazy Stripe client. Never import this from a route component,
 * a `src/modules/**` UI file, or anything else that reaches the browser
 * bundle — see client-route-boundary.test.ts's billing-module sweep. Route
 * *server* handlers (`src/routes/api/**`) and other `src/shared/lib/billing/**`
 * modules are the only intended callers.
 */
import Stripe from 'stripe'
import { env } from '../env'

export class StripeBillingDisabledError extends Error {
  constructor(reason: string) {
    super(`Stripe billing is disabled: ${reason}`)
    this.name = 'StripeBillingDisabledError'
  }
}

export interface StripeClientConfigInput {
  billingEnabled: string
  secretKey: string | undefined
  apiVersion: string | undefined
}

export interface StripeClientConfig {
  secretKey: string
  apiVersion: Stripe.LatestApiVersion
  live: boolean
}

/**
 * Pure resolver — the actual fail-closed decision, kept separate from the
 * real `env` singleton (frozen at process start, so not swappable per test)
 * so every misconfiguration is directly unit-testable with arbitrary input,
 * mirroring `resolveTenantPrincipal`/`resolveEntitlementPolicy`'s shape.
 * Never returns a partial/stub config — throws on anything short of fully
 * valid.
 */
export function resolveStripeClientConfig(input: StripeClientConfigInput): StripeClientConfig {
  if (input.billingEnabled !== 'true') {
    throw new StripeBillingDisabledError('STRIPE_BILLING_ENABLED is not "true"')
  }
  if (!input.secretKey) {
    throw new StripeBillingDisabledError('STRIPE_SECRET_KEY is unset')
  }
  if (!/^sk_(test|live)_/.test(input.secretKey)) {
    throw new StripeBillingDisabledError('STRIPE_SECRET_KEY is malformed (must start with sk_test_ or sk_live_)')
  }
  if (!input.apiVersion) {
    throw new StripeBillingDisabledError('STRIPE_API_VERSION is unset')
  }
  return {
    secretKey: input.secretKey,
    apiVersion: input.apiVersion as Stripe.LatestApiVersion,
    live: input.secretKey.startsWith('sk_live_'),
  }
}

let client: Stripe | null = null

/**
 * Fails closed on every misconfiguration: disabled, missing key/version, or
 * (defense in depth — `env.ts`'s schema already rejects this at process
 * startup) an enabled flag with an unset key/version. Never falls back to
 * a stub client silently.
 */
export function getStripeClient(): Stripe {
  const config = resolveStripeClientConfig({
    billingEnabled: env.STRIPE_BILLING_ENABLED,
    secretKey: env.STRIPE_SECRET_KEY,
    apiVersion: env.STRIPE_API_VERSION,
  })
  if (client) return client

  client = new Stripe(config.secretKey, {
    apiVersion: config.apiVersion,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'BuilderHunt', version: '1.0.0' },
  })
  return client
}

/** Test-only: forces the next `getStripeClient()` call to construct a fresh client. */
export function resetStripeClientForTests(): void {
  client = null
}

export function isLiveMode(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))
}

export interface RedactedStripeError {
  message: string
  type?: string
  code?: string
  requestId?: string
}

/** Never log a raw Stripe error object — it can carry request/response bodies with customer data. */
export function redactStripeError(error: unknown): RedactedStripeError {
  if (error instanceof Stripe.errors.StripeError) {
    return {
      message: error.message,
      // `error.type` is the SDK's own subclass name (e.g. "StripeCardError");
      // `error.rawType` is Stripe's API-level error type (e.g. "card_error")
      // — the latter is what's documented and portable across SDKs/logs.
      type: error.rawType,
      code: error.code,
      requestId: error.requestId,
    }
  }
  return { message: error instanceof Error ? error.message : 'Unknown Stripe error' }
}

/**
 * Stable idempotency key for a logical billing operation — pass to every
 * mutating Stripe call's `idempotencyKey` option so a retried request (ours
 * or Stripe's) never double-charges or double-creates. Callers own picking
 * parts that are unique per attempt (e.g. organizationId + action + a
 * caller-generated attempt id), not per retry.
 */
export function idempotencyKeyFor(...parts: string[]): string {
  return parts.filter(Boolean).join(':')
}

/**
 * Guards every Checkout/Portal return URL this app hands to Stripe (`billing/checkout.ts`,
 * `billing/portal.ts`) — Stripe redirects the customer's browser straight to whatever URL we
 * supply, so an open redirect here is a real phishing vector. Compares the full parsed origin
 * (`protocol://host:port`), never a string prefix: a naive `url.startsWith(env.APP_URL)` check
 * would wrongly accept a lookalike domain like `https://app.test.evil.com` when `env.APP_URL` is
 * `https://app.test`, since the attacker's host merely starts with our own. `URL.origin` doesn't
 * have that ambiguity — two origins are equal only when protocol, host, and port all match exactly.
 */
export function isAllowedReturnUrl(url: string): boolean {
  let candidate: URL
  let appOrigin: URL
  try {
    candidate = new URL(url)
    appOrigin = new URL(env.APP_URL)
  } catch {
    return false
  }
  return candidate.origin === appOrigin.origin
}
