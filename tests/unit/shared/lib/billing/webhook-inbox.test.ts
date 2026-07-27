import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { billingWebhookEvents } from '~/shared/lib/db/schema'
import { decryptWebhookPayload } from '~/shared/lib/crypto/webhook-payload'
import { receiveStripeWebhook, WebhookRejectedError } from '~/shared/lib/billing/webhook-inbox'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `whi-${label}-${counter}`
}

const SIGNING_SECRET = 'whsec_test_current_secret'
const PREVIOUS_SIGNING_SECRET = 'whsec_test_previous_secret'
const API_VERSION = '2026-06-24.dahlia'
const ENCRYPTION_KEY = Buffer.alloc(32, 7)

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('webhook_inbox')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

function fixtureEvent(overrides: Partial<{ id: string; type: string; apiVersion: string; livemode: boolean; objectId: string; objectType: string }> = {}) {
  const id = overrides.id ?? uniqueId('evt')
  return {
    id,
    object: 'event',
    api_version: overrides.apiVersion ?? API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: overrides.livemode ?? false,
    pending_webhooks: 1,
    request: { id: uniqueId('req'), idempotency_key: null },
    type: overrides.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: overrides.objectId ?? uniqueId('cs'),
        object: overrides.objectType ?? 'checkout.session',
        customer_email: 'should-never-be-stored@example.com',
        card: { number: '4242424242424242' },
      },
    },
  }
}

function sign(payload: string, secret: string, timestamp?: number): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp })
}

async function callReceive(rawBody: string, signatureHeader: string | null, overrides: Partial<Parameters<typeof receiveStripeWebhook>[1]> = {}) {
  return receiveStripeWebhook(
    { rawBody, signatureHeader },
    {
      db,
      signingSecrets: [SIGNING_SECRET],
      expectedApiVersion: API_VERSION,
      expectedLivemode: false,
      encryptionKey: ENCRYPTION_KEY,
      ...overrides,
    },
  )
}

describe('receiveStripeWebhook', () => {
  it('accepts an official signed fixture (Stripe.webhooks.generateTestHeaderString)', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, SIGNING_SECRET)

    const receipt = await callReceive(payload, header)

    expect(receipt.duplicate).toBe(false)
    expect(receipt.eventType).toBe('checkout.session.completed')
  })

  it('inserts exactly one row per event', async () => {
    const event = fixtureEvent()
    const payload = JSON.stringify(event)
    const header = sign(payload, SIGNING_SECRET)

    await callReceive(payload, header)

    const rows = await db.select().from(billingWebhookEvents)
    const matching = rows.filter((row) => row.stripeEventId === event.id)
    expect(matching).toHaveLength(1)
    expect(matching[0].eventType).toBe('checkout.session.completed')
    expect(matching[0].livemode).toBe(false)
  })

  it('duplicate delivery of the same event is a successful no-op — 2xx-equivalent outcome, still exactly one row', async () => {
    const event = fixtureEvent()
    const payload = JSON.stringify(event)
    const header = sign(payload, SIGNING_SECRET)

    const first = await callReceive(payload, header)
    const second = await callReceive(payload, header)

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.eventId).toBe(first.eventId)

    const rows = await db.select().from(billingWebhookEvents)
    expect(rows.filter((row) => row.stripeEventId === event.id)).toHaveLength(1)
  })

  it('rejects a missing Stripe-Signature header', async () => {
    const payload = JSON.stringify(fixtureEvent())

    await expect(callReceive(payload, null)).rejects.toMatchObject({ code: 'missing_signature' })
  })

  it('rejects a tampered body (signature no longer matches)', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, SIGNING_SECRET)
    const tamperedPayload = payload.replace('checkout.session.completed', 'checkout.session.expired')

    await expect(callReceive(tamperedPayload, header)).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('rejects a tampered signature header', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, SIGNING_SECRET)
    const tamperedHeader = header.replace(/v1=[0-9a-f]+/, 'v1=0000000000000000000000000000000000000000000000000000000000000000')

    await expect(callReceive(payload, tamperedHeader)).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('rejects a signature signed with an unknown secret', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, 'whsec_totally_wrong_secret')

    await expect(callReceive(payload, header)).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('rejects a stale timestamp outside the tolerance window', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const staleTimestamp = Math.floor(Date.now() / 1000) - 60 * 60
    const header = sign(payload, SIGNING_SECRET, staleTimestamp)

    await expect(callReceive(payload, header)).rejects.toMatchObject({ code: 'stale_timestamp' })
  })

  it('never stores a row for a rejected (unverified) event', async () => {
    const event = fixtureEvent()
    const payload = JSON.stringify(event)
    const header = sign(payload, 'whsec_totally_wrong_secret')

    await expect(callReceive(payload, header)).rejects.toThrow(WebhookRejectedError)

    const rows = await db.select().from(billingWebhookEvents)
    expect(rows.filter((row) => row.stripeEventId === event.id)).toHaveLength(0)
  })

  it('rejects an event whose api_version does not match the expected pinned version', async () => {
    const payload = JSON.stringify(fixtureEvent({ apiVersion: '2020-01-01.old' }))
    const header = sign(payload, SIGNING_SECRET)

    await expect(callReceive(payload, header)).rejects.toMatchObject({ code: 'wrong_api_version' })
  })

  it('rejects a livemode event delivered to a test-mode expectation', async () => {
    const payload = JSON.stringify(fixtureEvent({ livemode: true }))
    const header = sign(payload, SIGNING_SECRET)

    await expect(callReceive(payload, header)).rejects.toMatchObject({ code: 'wrong_livemode' })
  })

  it('rejects a test-mode event delivered to a live-mode expectation', async () => {
    const payload = JSON.stringify(fixtureEvent({ livemode: false }))
    const header = sign(payload, SIGNING_SECRET)

    await expect(callReceive(payload, header, { expectedLivemode: true })).rejects.toMatchObject({ code: 'wrong_livemode' })
  })

  it('accepts a signature made with the previous secret during a rotation window', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, PREVIOUS_SIGNING_SECRET)

    const receipt = await callReceive(payload, header, { signingSecrets: [SIGNING_SECRET, PREVIOUS_SIGNING_SECRET] })

    expect(receipt.duplicate).toBe(false)
  })

  it('rejects when no signing secret is configured at all', async () => {
    const payload = JSON.stringify(fixtureEvent())
    const header = sign(payload, SIGNING_SECRET)

    await expect(callReceive(payload, header, { signingSecrets: [] })).rejects.toMatchObject({ code: 'invalid_signature' })
  })

  it('stores only a minimized payload — never the customer email or card data embedded in the real Stripe object', async () => {
    const event = fixtureEvent()
    const payload = JSON.stringify(event)
    const header = sign(payload, SIGNING_SECRET)

    await callReceive(payload, header)

    const [row] = await db.select().from(billingWebhookEvents).where((await import('drizzle-orm')).eq(billingWebhookEvents.stripeEventId, event.id))
    const decrypted = JSON.parse(decryptWebhookPayload(row.payloadEncrypted, ENCRYPTION_KEY))

    expect(Object.keys(decrypted).sort()).toEqual(['apiVersion', 'created', 'id', 'livemode', 'objectId', 'objectType', 'requestId', 'type'].sort())
    expect(JSON.stringify(decrypted)).not.toContain('should-never-be-stored@example.com')
    expect(JSON.stringify(decrypted)).not.toContain('4242424242424242')
  })
})
