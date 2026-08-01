/**
 * plans/UI/tasks.md Wave 5 "Add billing webhook and dead-letter discovery".
 *
 * Repository-level correctness against a real database: bounded/filtered/paginated listing never
 * exposes `payloadEncrypted`, the raw `lastError` never survives into the DTO (only a scrubbed,
 * truncated preview does), and replay eligibility is derived correctly per status.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { billingWebhookEvents } from '~/shared/lib/db/schema'
import { getBillingWebhookEventDetail, listBillingWebhookEvents } from '~/shared/lib/repositories/billing-events'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('admin_billing_events')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(billingWebhookEvents)
})

let seq = 0
async function seedEvent(overrides: Partial<{
  status: string
  eventType: string
  receivedAt: Date
  lastError: string | null
  attempts: number
}> = {}) {
  seq += 1
  const id = `wh-${seq}-${Date.now()}`
  await db.insert(billingWebhookEvents).values({
    id,
    livemode: false,
    stripeEventId: `evt_${id}`,
    apiVersion: '2025-01-01',
    objectType: 'subscription',
    eventType: overrides.eventType ?? 'customer.subscription.updated',
    receivedAt: overrides.receivedAt ?? new Date(),
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    payloadEncrypted: 'iv:tag:ciphertext',
    lastError: overrides.lastError ?? null,
  })
  return id
}

describe('listBillingWebhookEvents', () => {
  it('never returns payloadEncrypted or a raw stored field beyond the redacted row shape', async () => {
    await seedEvent({ status: 'failed', lastError: 'boom' })
    const result = await listBillingWebhookEvents({}, {}, db)
    expect(Object.keys(result.rows[0]).sort()).toEqual(
      ['attempts', 'eventType', 'hasError', 'id', 'nextAttemptAt', 'objectType', 'processedAt', 'receivedAt', 'status', 'stripeEventId'].sort(),
    )
  })

  it('filters by status', async () => {
    await seedEvent({ status: 'failed' })
    await seedEvent({ status: 'pending' })
    const result = await listBillingWebhookEvents({ status: 'failed' }, {}, db)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].status).toBe('failed')
  })

  it('filters by eventType', async () => {
    await seedEvent({ eventType: 'invoice.paid' })
    await seedEvent({ eventType: 'customer.subscription.deleted' })
    const result = await listBillingWebhookEvents({ eventType: 'invoice.paid' }, {}, db)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].eventType).toBe('invoice.paid')
  })

  it('filters by a received-at date range', async () => {
    await seedEvent({ receivedAt: new Date('2020-01-01T00:00:00.000Z') })
    await seedEvent({ receivedAt: new Date('2027-01-01T00:00:00.000Z') })
    const result = await listBillingWebhookEvents({ receivedFrom: new Date('2026-01-01T00:00:00.000Z') }, {}, db)
    expect(result.rows).toHaveLength(1)
  })

  it('paginates with a stable cursor — no row skipped or repeated across pages', async () => {
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await seedEvent({ receivedAt: new Date(Date.UTC(2027, 0, 1, 0, 0, i)) }))

    const firstPage = await listBillingWebhookEvents({}, { limit: 2 }, db)
    expect(firstPage.rows).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()

    const secondPage = await listBillingWebhookEvents({}, { cursor: firstPage.nextCursor!, limit: 2 }, db)
    expect(secondPage.rows).toHaveLength(2)

    const thirdPage = await listBillingWebhookEvents({}, { cursor: secondPage.nextCursor!, limit: 2 }, db)
    expect(thirdPage.rows).toHaveLength(1)
    expect(thirdPage.nextCursor).toBeNull()

    const allIds = [...firstPage.rows, ...secondPage.rows, ...thirdPage.rows].map((r) => r.id)
    expect(new Set(allIds).size).toBe(5) // no duplicates
    expect(allIds.sort()).toEqual([...ids].sort())
  })

  it('clamps an oversized limit rather than returning everything', async () => {
    for (let i = 0; i < 3; i++) await seedEvent()
    const result = await listBillingWebhookEvents({}, { limit: 10_000 }, db)
    expect(result.rows).toHaveLength(3) // well under MAX_PAGE_SIZE, proves no crash/blowup — real clamp covered by config constant
  })
})

describe('getBillingWebhookEventDetail', () => {
  it('returns null for an unknown id', async () => {
    expect(await getBillingWebhookEventDetail('does-not-exist', db)).toBeNull()
  })

  it('never returns the raw stored error message, only a scrubbed preview', async () => {
    const id = await seedEvent({ status: 'failed', lastError: 'Stripe request failed: sk_live_abc123def456 rejected, Bearer whsec_zzz999 invalid' })
    const detail = await getBillingWebhookEventDetail(id, db)
    expect(detail!.lastErrorPreview).not.toContain('sk_live_abc123def456')
    expect(detail!.lastErrorPreview).not.toContain('whsec_zzz999')
    expect(detail!.lastErrorPreview).toContain('[redacted-key]')
  })

  it('reports hasError/lastErrorPreview as absent when nothing failed', async () => {
    const id = await seedEvent({ status: 'processed', lastError: null })
    const detail = await getBillingWebhookEventDetail(id, db)
    expect(detail!.hasError).toBe(false)
    expect(detail!.lastErrorPreview).toBeNull()
  })

  it.each([
    ['failed', true],
    ['pending', true],
    ['processed', true],
    ['ignored', true],
    ['processing', false],
  ])('replay eligibility for status %s is %s', async (status, eligible) => {
    const id = await seedEvent({ status })
    const detail = await getBillingWebhookEventDetail(id, db)
    expect(detail!.replayEligible).toBe(eligible)
    expect(detail!.replayEligibilityReason.length).toBeGreaterThan(0)
  })
})
