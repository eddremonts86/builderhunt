import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordConversionEvent: vi.fn(),
  rateLimit: vi.fn(),
  CONVERSION_EVENTS_ENABLED: 'true' as 'true' | 'false',
}))

vi.mock('~/shared/lib/repositories/conversion-events', () => ({
  recordConversionEvent: mocks.recordConversionEvent,
}))

vi.mock('~/shared/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/rate-limit')>()
  return { ...actual, rateLimit: mocks.rateLimit }
})

vi.mock('~/shared/lib/env', () => ({
  get env() {
    return { CONVERSION_EVENTS_ENABLED: mocks.CONVERSION_EVENTS_ENABLED }
  },
}))

const { Route } = await import('./conversion')

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/analytics/conversion', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

const validEvent = {
  name: 'landing_view',
  surface: 'hero',
  sessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  variant: 'baseline',
  occurredAt: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.CONVERSION_EVENTS_ENABLED = 'true'
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 59, resetMs: 1000, limit: 60 })
  mocks.recordConversionEvent.mockResolvedValue(undefined)
})

describe('POST /api/analytics/conversion', () => {
  it('records a valid event', async () => {
    const res = await callPost(validEvent)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, recorded: true })
    expect(mocks.recordConversionEvent).toHaveBeenCalledTimes(1)
  })

  it('no-ops (200, no write) when the feature flag is disabled', async () => {
    mocks.CONVERSION_EVENTS_ENABLED = 'false'
    const res = await callPost(validEvent)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, recorded: false })
    expect(mocks.recordConversionEvent).not.toHaveBeenCalled()
  })

  it('rejects a malformed event with 400', async () => {
    const res = await callPost({ ...validEvent, name: 'not_a_real_event' })
    expect(res.status).toBe(400)
    expect(mocks.recordConversionEvent).not.toHaveBeenCalled()
  })

  it('rejects a timestamp far outside the clock-skew window with 400', async () => {
    const res = await callPost({ ...validEvent, occurredAt: '2020-01-01T00:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(mocks.recordConversionEvent).not.toHaveBeenCalled()
  })

  it('returns 429 when rate-limited', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 5000, limit: 60 })
    const res = await callPost(validEvent)
    expect(res.status).toBe(429)
    expect(mocks.recordConversionEvent).not.toHaveBeenCalled()
  })

  it('degrades to a 200 (never a 500) when the write itself throws', async () => {
    mocks.recordConversionEvent.mockRejectedValue(new Error('db down'))
    const res = await callPost(validEvent)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, recorded: false })
  })
})
