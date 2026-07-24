import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  runReconciliation: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal, auditPlatformAdminAction: mocks.auditPlatformAdminAction }
})

vi.mock('~/shared/lib/billing/reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/reconciliation')>()
  return { ...actual, runReconciliation: mocks.runReconciliation }
})

const { Route } = await import('./reconcile')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/admin/billing/reconcile', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown = {}): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

const SAMPLE_SUMMARY = {
  id: 'run-1',
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-01T00:01:00.000Z',
  countsChecked: { customers: 3, subscriptions: 2, payment_intents: 1, refunds: 0 },
  mismatches: [],
  repairs: [],
  result: 'clean',
  resumeCursor: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/admin/billing/reconcile', () => {
  it('runs a reconciliation pass for a platform admin and audits it', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runReconciliation.mockResolvedValue(SAMPLE_SUMMARY)

    const response = await callPost({})
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(SAMPLE_SUMMARY)
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.billing.reconcile', targetId: 'run-1' }),
    )
  })

  it('rejects a non-admin caller before running any reconciliation', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callPost({})

    expect(response.status).toBe(403)
    expect(mocks.runReconciliation).not.toHaveBeenCalled()
  })

  it('passes a resume cursor from the request body through to runReconciliation', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runReconciliation.mockResolvedValue(SAMPLE_SUMMARY)

    await callPost({ resumeFrom: { objectType: 'refunds' } })

    expect(mocks.runReconciliation).toHaveBeenCalledWith(expect.objectContaining({ resumeFrom: { objectType: 'refunds' } }))
  })

  it('returns 500 without leaking the raw error when the reconciliation run throws unexpectedly', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runReconciliation.mockRejectedValue(new Error('connection refused at 10.0.4.9:5432'))

    const response = await callPost({})
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('10.0.4.9')
  })
})
