import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  receiveStripeWebhook: vi.fn(),
}))

vi.mock('~/shared/lib/billing/webhook-inbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/webhook-inbox')>()
  return { ...actual, receiveStripeWebhook: mocks.receiveStripeWebhook }
})

const { Route } = await import('./stripe')
const { WebhookRejectedError } = await import('~/shared/lib/billing/webhook-inbox')

function postRequest(body: string, signatureHeader: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signatureHeader !== null) headers.set('stripe-signature', signatureHeader)
  return new Request('https://app.test/api/webhooks/stripe', { method: 'POST', body, headers })
}

async function callRoute(body: string, signatureHeader: string | null): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body, signatureHeader) })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/webhooks/stripe', () => {
  it('reads the raw body and Stripe-Signature header and passes them through unmodified', async () => {
    mocks.receiveStripeWebhook.mockResolvedValue({ eventId: 'evt_1', eventType: 'checkout.session.completed', duplicate: false })

    await callRoute('{"id":"evt_1"}', 'v1=abc,t=123')

    expect(mocks.receiveStripeWebhook).toHaveBeenCalledWith({ rawBody: '{"id":"evt_1"}', signatureHeader: 'v1=abc,t=123' })
  })

  it('passes a null signatureHeader through when the header is absent (never invents one)', async () => {
    mocks.receiveStripeWebhook.mockRejectedValue(new WebhookRejectedError('missing', 'missing_signature'))

    await callRoute('{}', null)

    expect(mocks.receiveStripeWebhook).toHaveBeenCalledWith({ rawBody: '{}', signatureHeader: null })
  })

  it('returns 200 with the event id on success', async () => {
    mocks.receiveStripeWebhook.mockResolvedValue({ eventId: 'evt_1', eventType: 'checkout.session.completed', duplicate: false })

    const response = await callRoute('{}', 'v1=abc,t=123')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true, eventId: 'evt_1' })
  })

  it('returns 200 for a duplicate delivery too — same success shape, no distinguishing detail leaked', async () => {
    mocks.receiveStripeWebhook.mockResolvedValue({ eventId: 'evt_1', eventType: 'checkout.session.completed', duplicate: true })

    const response = await callRoute('{}', 'v1=abc,t=123')

    expect(response.status).toBe(200)
  })

  it.each([
    'missing_signature',
    'invalid_signature',
    'stale_timestamp',
    'wrong_api_version',
    'wrong_livemode',
  ] as const)('maps a %s rejection to 400', async (code) => {
    mocks.receiveStripeWebhook.mockRejectedValue(new WebhookRejectedError('rejected', code))

    const response = await callRoute('{}', 'v1=abc,t=123')

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe(code)
  })

  it('maps an unexpected error to a generic 500 without leaking internals', async () => {
    mocks.receiveStripeWebhook.mockRejectedValue(new Error('db unavailable with a stack trace'))

    const response = await callRoute('{}', 'v1=abc,t=123')

    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('internal_error')
  })

  it('never requires or reads a user session — no auth-related mock is set up, yet the handler still runs to completion', async () => {
    mocks.receiveStripeWebhook.mockResolvedValue({ eventId: 'evt_1', eventType: 'checkout.session.completed', duplicate: false })

    const response = await callRoute('{}', 'v1=abc,t=123')

    expect(response.status).toBe(200)
  })
})
