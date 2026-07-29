/**
 * Signed, durable Stripe webhook receipt (plans/phase-1/30-stripe-billing-platform/tasks.md §6 "Implement
 * signed durable Stripe webhook receipt"; spec.md §Webhook and consistency contract). Verifies the
 * raw request body's `Stripe-Signature` header — trying the current signing secret and, during a
 * rotation window, the previous one too — rejects a livemode/API-version mismatch, then inserts one
 * row per unique `(livemode, stripeEventId)` durably. A duplicate delivery (Stripe retries on any
 * non-2xx response, or simply redelivers) is a successful no-op: the caller still returns 2xx, but
 * no second row is created and nothing is queued twice.
 *
 * This module never requires a user session (Stripe cannot hold one) and never parses the body as
 * JSON before `Stripe.webhooks.constructEvent` has verified the signature over the RAW bytes — an
 * unverified body could be anything, including a fully attacker-crafted payload.
 *
 * Processing (turning a stored event into subscription/entitlement/ledger effects) deliberately does
 * NOT happen here — this module only receives and durably records; §6's next two tasks
 * (webhook-handlers.ts, worker.ts) own applying and retrying it. Storing first, processing later, is
 * what makes redelivery and worker crashes safe: the row survives independently of whether handling
 * succeeds.
 */
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import Stripe from 'stripe'
import { encryptWebhookPayload } from '../crypto/webhook-payload'
import { billingWebhookEvents } from '../db/schema'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { env } from '../env'
import { isLiveMode } from './stripe-client'

export type WebhookRejectionCode =
  | 'missing_signature'
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'wrong_api_version'
  | 'wrong_livemode'

/** `message` is safe to log as-is — Stripe's own signature-verification errors never embed request bodies or secrets, only a description like "No signatures found matching the expected signature for payload." Callers should still prefer logging `code` alone where possible. */
export class WebhookRejectedError extends Error {
  constructor(message: string, readonly code: WebhookRejectionCode) {
    super(message)
    this.name = 'WebhookRejectedError'
  }
}

export interface ReceiveStripeWebhookInput {
  rawBody: string
  signatureHeader: string | null
}

export interface StripeWebhookReceipt {
  eventId: string
  eventType: string
  /** True when this exact (livemode, stripeEventId) pair had already been recorded — the caller still returns 2xx, but nothing new was inserted or should be queued. */
  duplicate: boolean
}

/** Matches Stripe's own default tolerance — see https://docs.stripe.com/webhooks#verify-official-libraries. Exported so the E2E harness (`e2e/harness/fakes/webhook.ts`) can sign at exactly the edge of the window instead of duplicating the literal. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/**
 * Wave 1 Task 4 — E2E-only signing-secret channel
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * The harness reads the secrets it should sign test fixtures with from
 * `E2E_STRIPE_WEBHOOK_SECRET` / `E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS`
 * (current first, previous second — the same rotation-order contract as
 * `currentSigningSecrets`). Guarded by `E2E_MODE`; unreachable in
 * production. The receipt path itself is unchanged — this is a typed
 * read-only accessor, never an override of `verifySignature`.
 */
export function __e2eSigningSecrets(): string[] {
  if (process.env.E2E_MODE !== 'true') {
    throw new Error('__e2eSigningSecrets is E2E-only (E2E_MODE=true required)')
  }
  return [process.env.E2E_STRIPE_WEBHOOK_SECRET, process.env.E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS]
    .filter((secret): secret is string => Boolean(secret))
}

function currentSigningSecrets(): string[] {
  return [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS].filter((secret): secret is string => Boolean(secret))
}

/**
 * Tries every currently-valid secret in order (current, then previous during a rotation window) —
 * the first one whose signature checks out wins. Never parses the body as JSON itself:
 * `Stripe.webhooks.constructEvent` only returns a parsed event after the signature over the raw
 * bytes has already been verified.
 */
function verifySignature(rawBody: string, signatureHeader: string | null, secrets: string[]): Stripe.Event {
  if (!signatureHeader) {
    throw new WebhookRejectedError('Missing Stripe-Signature header', 'missing_signature')
  }
  if (secrets.length === 0) {
    throw new WebhookRejectedError('No webhook signing secret is configured', 'invalid_signature')
  }

  let lastError: unknown
  for (const secret of secrets) {
    try {
      return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret, SIGNATURE_TOLERANCE_SECONDS)
    } catch (error) {
      lastError = error
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Signature verification failed'
  const code: WebhookRejectionCode = /timestamp/i.test(message) ? 'stale_timestamp' : 'invalid_signature'
  throw new WebhookRejectedError(message, code)
}

/**
 * Keeps only what an operator needs to identify "what happened" — event id/type/timestamps and the
 * affected object's id/type — never card numbers, addresses, names, or any other embedded PII the
 * full Stripe object would carry. Handlers re-fetch current provider state rather than trusting this
 * stored payload as their source of truth (spec.md: "Handlers retrieve current provider objects
 * where needed").
 */
function minimizeForStorage(event: Stripe.Event): string {
  const object = event.data.object as { id?: string; object?: string }
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
    apiVersion: event.api_version,
    requestId: event.request?.id ?? null,
    objectId: object.id ?? null,
    objectType: object.object ?? null,
  })
}

export interface ReceiveStripeWebhookOptions {
  /** Defaults to the real `workerDb` singleton — tests inject a disposable database, the same DI pattern used throughout this codebase (`seller-profile.ts`, `checkout.ts`'s `sellerProfileDb`). */
  db?: PostgresJsDatabase | WorkerTransaction
  /** Defaults to `[env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS]` — overridable so tests can sign fixtures with a secret independent of this process's real (possibly unset) env config. */
  signingSecrets?: string[]
  /** Defaults to `env.STRIPE_API_VERSION`. */
  expectedApiVersion?: string
  /** Defaults to `isLiveMode()`. */
  expectedLivemode?: boolean
  /** Defaults to `env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY` (via `encryptWebhookPayload`'s own default). */
  encryptionKey?: Buffer
}

export async function receiveStripeWebhook(
  input: ReceiveStripeWebhookInput,
  options: ReceiveStripeWebhookOptions = {},
): Promise<StripeWebhookReceipt> {
  const db = options.db ?? workerDb
  const secrets = options.signingSecrets ?? currentSigningSecrets()
  const expectedApiVersion = options.expectedApiVersion ?? env.STRIPE_API_VERSION
  const expectedLivemode = options.expectedLivemode ?? isLiveMode()

  const event = verifySignature(input.rawBody, input.signatureHeader, secrets)

  if (event.api_version !== expectedApiVersion) {
    throw new WebhookRejectedError(`Unexpected API version: ${event.api_version}`, 'wrong_api_version')
  }
  if (event.livemode !== expectedLivemode) {
    throw new WebhookRejectedError(`Livemode mismatch — event.livemode=${event.livemode}`, 'wrong_livemode')
  }

  const objectType = (event.data.object as { object?: string }).object ?? 'unknown'
  const payloadEncrypted = options.encryptionKey
    ? encryptWebhookPayload(minimizeForStorage(event), options.encryptionKey)
    : encryptWebhookPayload(minimizeForStorage(event))

  const inserted = await db
    .insert(billingWebhookEvents)
    .values({
      id: randomUUID(),
      livemode: event.livemode,
      stripeEventId: event.id,
      apiVersion: event.api_version ?? 'unknown',
      objectType,
      eventType: event.type,
      payloadEncrypted,
    })
    .onConflictDoNothing({ target: [billingWebhookEvents.livemode, billingWebhookEvents.stripeEventId] })
    .returning({ id: billingWebhookEvents.id })

  return { eventId: event.id, eventType: event.type, duplicate: inserted.length === 0 }
}
