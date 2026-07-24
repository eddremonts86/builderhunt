/**
 * Wave 1 Task 4 — external-service fakes, end-to-end harness
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md §Step 6).
 *
 * One file that exercises every fake in sequence under a single worker,
 * with the egress guard installed for the whole run so ANY attempt to
 * reach a live third-party host fails the test loudly:
 *
 *   1. email    — the outbox captures the critical senders, zero Resend.
 *   2. billing  — `E2E_BILLING_SCENARIO` drives the provider seam
 *                 (sca_required => non-terminal/incomplete states).
 *   3. webhook  — a REAL signed POST to the running app's
 *                 `/api/webhooks/stripe`: fresh signature accepted, stale
 *                 rejected with the structured `code`, unsigned rejected.
 *   4. discovery/AI — deterministic stubs answer with zero live HTTP.
 *   5. egress   — the guard blocks a live Resend URL.
 *
 * Node-only spec (no browser page): it talks to the app over HTTP the way
 * Stripe does, and drives the in-process seams the way the app server
 * does. Serial mode keeps the env-var scenario switches race-free.
 */
import { test, expect } from 'playwright/test'
import { config as loadEnv } from 'dotenv'

// `.env` first, `.env.local` layered on top — the same precedence the app
// under test uses, so the runner signs webhooks with the exact secret the
// server verifies against.
loadEnv({ path: '.env' })
loadEnv({ path: '.env.local', override: true })

import { e2eEnv } from './env'
import { uniqueId } from './ids'
import { installEgressGuard, uninstallEgressGuard, EgressBlockedError } from './fakes/egress'
import { installEmailFake, readOutbox, resetEmailFake, uninstallEmailFake } from './fakes/email'
import { resetBillingScenario, setBillingScenario } from './fakes/billing'
import { resetDiscoveryFakes, setEmbeddingsScenario, setEnrichmentScenario } from './fakes/discovery'
import { resetAITaskScenario, setAITaskScenario } from './fakes/ai'
import { postUnsignedWebhook, postWebhook, stripeEventFixture } from './fakes/webhook'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  // The strict env parser proves the harness seams are unreachable in
  // production mode before any fake is installed.
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  installEgressGuard()
  installEmailFake()
})

test.afterAll(() => {
  resetBillingScenario()
  resetDiscoveryFakes()
  resetAITaskScenario()
  uninstallEmailFake()
  uninstallEgressGuard()
})

test.beforeEach(() => {
  resetEmailFake()
  resetBillingScenario()
  resetDiscoveryFakes()
  resetAITaskScenario()
})

test('email outbox captures the five critical senders with zero Resend egress', async () => {
  const email = await import('../../src/shared/lib/email')

  const claim = await email.sendClaimEmail('claim@e2e.local', 'http://localhost:3000/claim/tok')
  await email.sendResetPasswordEmail('reset@e2e.local', 'http://localhost:3000/reset/tok')
  await email.sendOrganizationInvitationEmail('invite@e2e.local', 'Acme', 'http://localhost:3000/inv/tok')
  await email.sendDeletionScheduledEmail('privacy@e2e.local', new Date('2026-08-23T00:00:00.000Z'))
  await email.sendExportReadyEmail('privacy@e2e.local')

  // The egress guard is installed for this whole file — if any sender had
  // tried Resend, it would have rejected with EgressBlockedError above.
  expect(claim.ok).toBe(true)
  expect(claim.devLink).toBe('http://localhost:3000/claim/tok')

  const entries = readOutbox()
  expect(entries).toHaveLength(5)
  expect(entries.map((entry) => ({ to: entry.to, subject: entry.subject }))).toEqual([
    { to: 'claim@e2e.local', subject: 'Verify your BuilderHunt profile' },
    { to: 'reset@e2e.local', subject: 'Reset your BuilderHunt password' },
    { to: 'invite@e2e.local', subject: 'Invitation to join Acme on BuilderHunt' },
    { to: 'privacy@e2e.local', subject: 'Your BuilderHunt account deletion is scheduled' },
    { to: 'privacy@e2e.local', subject: 'Your BuilderHunt data export is ready' },
  ])
})

test('billing scenario=sca_required forces non-terminal states end to end', async () => {
  const { getBillingProvider, resetBillingProviderForTests } = await import('../../src/shared/lib/billing/stripe-provider')
  resetBillingProviderForTests()
  setBillingScenario('sca_required')

  const provider = getBillingProvider()

  const session = await provider.createCheckoutSession({
    customerId: 'cus_fakes_e2e',
    mode: 'subscription',
    priceId: 'price_fakes_e2e',
    successUrl: 'http://localhost:3000/billing/success',
    cancelUrl: 'http://localhost:3000/billing/cancel',
    idempotencyKey: uniqueId('fakes-checkout'),
  })
  // sca_required never silently succeeds: the session stays non-terminal.
  expect(session.status).toBe('open')
  // The response payload maps to the fake's deterministic checkout URL —
  // never a live Stripe domain.
  expect(new URL(session.url).hostname).toBe('checkout.stripe.test')

  const subscription = await provider.changeSubscription({
    subscriptionId: uniqueId('sub-fakes'),
    newPriceId: 'price_fakes_e2e_up',
    idempotencyKey: uniqueId('fakes-change'),
  })
  expect(subscription.status).toBe('incomplete')

  resetBillingProviderForTests()
})

test('signed webhook receipt accepts a fresh signature and rejects a stale one', async ({ baseURL }) => {
  test.skip(!process.env.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET is not configured in .env/.env.local')
  const appUrl = baseURL ?? 'http://localhost:3130'
  const secret = process.env.STRIPE_WEBHOOK_SECRET!
  const { SIGNATURE_TOLERANCE_SECONDS } = await import('../../src/shared/lib/billing/webhook-inbox')

  // Fresh signature -> 200 with the eventId echoed back.
  const freshPayload = stripeEventFixture({
    id: `evt_${uniqueId('fresh').replace(/[^a-zA-Z0-9]/g, '')}`,
    apiVersion: process.env.STRIPE_API_VERSION,
  })
  const fresh = await postWebhook({ baseUrl: appUrl, payload: freshPayload, secret })
  expect(fresh.status).toBe(200)
  const freshBody = (await fresh.json()) as { received: boolean; eventId: string }
  expect(freshBody.received).toBe(true)
  expect(freshBody.eventId).toBe((JSON.parse(freshPayload) as { id: string }).id)

  // Stale signature (tolerance + 60s) -> 400 with the structured code.
  const stalePayload = stripeEventFixture({
    id: `evt_${uniqueId('stale').replace(/[^a-zA-Z0-9]/g, '')}`,
    apiVersion: process.env.STRIPE_API_VERSION,
  })
  const stale = await postWebhook({
    baseUrl: appUrl,
    payload: stalePayload,
    secret,
    timestampDeltaSec: -(SIGNATURE_TOLERANCE_SECONDS + 60),
  })
  expect(stale.status).toBe(400)
  expect(((await stale.json()) as { error: string }).error).toBe('stale_timestamp')

  // Missing signature -> 400 missing_signature.
  const unsigned = await postUnsignedWebhook(appUrl, stripeEventFixture({ apiVersion: process.env.STRIPE_API_VERSION }))
  expect(unsigned.status).toBe(400)
  expect(((await unsigned.json()) as { error: string }).error).toBe('missing_signature')
})

test('discovery/AI stubs answer deterministically and never hit live networks', async () => {
  const { embedTexts } = await import('../../src/shared/lib/ai/embeddings')
  const { e2eEnrichmentStub, builderAIEnrichmentModelSchema } = await import('../../src/shared/lib/ai/enrichment')
  const { isTaskDisabled } = await import('../../src/shared/lib/ai/tasks')
  const { env } = await import('../../src/shared/lib/env')

  // Embeddings: success scenario answers in-process (the guard would have
  // rejected any real HTTP to the configured endpoint's host if it were
  // non-local — and no request is made at all).
  setEmbeddingsScenario('success')
  const vectors = await embedTexts(['builderhunt e2e determinism'])
  expect(vectors).toHaveLength(1)
  expect(vectors[0]).toHaveLength(env.AI_EMBEDDING_DIM)

  // Enrichment: the stub is schema-valid under `success`.
  setEnrichmentScenario('success')
  const persona = e2eEnrichmentStub({ username: 'octocat', source: 'github' })
  expect(builderAIEnrichmentModelSchema.safeParse(persona).success).toBe(true)

  // AI tasks: the `disabled` scenario flips the registry's kill switch.
  setAITaskScenario('disabled')
  expect(isTaskDisabled('profile-enrich', { AI_DISABLED: 'false', AI_DISABLED_TASKS: '' })).toBe(true)
})

test('egress shim blocks a live Resend URL', async () => {
  const error = await fetch('https://api.resend.com/emails', { method: 'POST' }).then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(EgressBlockedError)
  expect((error as EgressBlockedError).reason).toBe('host: api.resend.com')
})
