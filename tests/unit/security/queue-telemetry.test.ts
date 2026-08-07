/**
 * Wave 2 task 5 — privacy-safe queue telemetry tests.
 *
 * Pins:
 *   - the closed event-kind set
 *   - the field shape (no resource id, no email, no title)
 *   - the strict-mode rejection of extra fields
 *   - the 16 forbidden literal markers
 *   - the helper never throws on telemetry failure
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  QUEUE_TELEMETRY_KINDS,
  FORBIDDEN_TELEMETRY_MARKERS,
  buildQueueTelemetryEvent,
  queueTelemetryEventSchema,
  sendQueueTelemetry,
} from '~/shared/lib/dashboard/queue-telemetry'

const validInput = () => ({
  kind: 'action-queue.render' as const,
  position: 0,
  ruleId: 'onboarding-incomplete',
  actionKind: 'open-onboarding' as const,
  now: new Date('2026-08-07T12:00:00.000Z'),
})

describe('queue telemetry — privacy contract', () => {
  it('declares a closed event-kind set', () => {
    expect(QUEUE_TELEMETRY_KINDS).toEqual([
      'action-queue.render',
      'action-queue.continuation',
      'action-queue.dismiss',
      'action-queue.resolved',
      'action-queue.unknown',
    ])
  })

  it('lists 16 forbidden literal markers', () => {
    expect(FORBIDDEN_TELEMETRY_MARKERS).toHaveLength(16)
    expect(FORBIDDEN_TELEMETRY_MARKERS).toContain('memberEmail')
    expect(FORBIDDEN_TELEMETRY_MARKERS).toContain('resourceId')
    expect(FORBIDDEN_TELEMETRY_MARKERS).toContain('userId')
    expect(FORBIDDEN_TELEMETRY_MARKERS).toContain('title')
  })

  it('builds a valid event for a well-formed input', () => {
    const event = buildQueueTelemetryEvent(validInput())
    expect(event).not.toBeNull()
    expect(event?.kind).toBe('action-queue.render')
    expect(event?.ruleId).toBe('onboarding-incomplete')
    expect(event?.actionKind).toBe('open-onboarding')
    expect(event?.position).toBe(0)
  })

  it('rejects inputs that smuggle forbidden markers in any field', () => {
    // Even though the schema's field names are clean, a string field
    // could carry "title": "leak" — defence in depth catches it.
    const input = validInput()
    // The cleanest way to test this is to use a ruleId that contains
    // the substring `memberEmail`. Strict-mode then refuses the
    // smuggling attempt at the JSON level (the helper runs the marker
    // scan after schema parse).
    const event = buildQueueTelemetryEvent({ ...input, ruleId: 'memberEmail' })
    expect(event).toBeNull()
  })

  it('rejects unknown event kind', () => {
    const input = validInput()
    const event = buildQueueTelemetryEvent({
      ...input,
      kind: 'action-queue.steal' as never,
    })
    expect(event).toBeNull()
  })

  it('rejects position outside the queue cap', () => {
    expect(buildQueueTelemetryEvent({ ...validInput(), position: 51 })).toBeNull()
    expect(buildQueueTelemetryEvent({ ...validInput(), position: -1 })).toBeNull()
  })

  it('rejects unknown action kind', () => {
    const input = validInput()
    const event = buildQueueTelemetryEvent({
      ...input,
      actionKind: 'steal' as never,
    })
    expect(event).toBeNull()
  })

  it('strict-mode schema rejects extra fields', () => {
    const result = queueTelemetryEventSchema.safeParse({
      kind: 'action-queue.render',
      position: 0,
      ruleId: 'unread-high-value-alert',
      actionKind: 'open-alert',
      at: '2026-08-07T12:00:00.000Z',
      extra: 'leak',
    })
    expect(result.success).toBe(false)
  })

  it('ruleId regex requires kebab-case', () => {
    expect(buildQueueTelemetryEvent({ ...validInput(), ruleId: 'Not kebab' })).toBeNull()
    expect(buildQueueTelemetryEvent({ ...validInput(), ruleId: 'has space' })).toBeNull()
    expect(buildQueueTelemetryEvent({ ...validInput(), ruleId: 'OnboardingBad' })).toBeNull()
  })
})

describe('queue telemetry — fire-and-forget sender', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when the network fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down')
    })
    await expect(
      sendQueueTelemetry('/api/telemetry/queue', {
        kind: 'action-queue.render',
        position: 0,
        ruleId: 'onboarding-incomplete',
        actionKind: 'open-onboarding',
        at: '2026-08-07T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
  })

  it('does not throw when the server responds with non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('rate limited', { status: 429 }))
    await expect(
      sendQueueTelemetry('/api/telemetry/queue', {
        kind: 'action-queue.render',
        position: 0,
        ruleId: 'onboarding-incomplete',
        actionKind: 'open-onboarding',
        at: '2026-08-07T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
  })
})
