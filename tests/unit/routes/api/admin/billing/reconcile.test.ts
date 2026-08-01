import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  runReconciliation: vi.fn(),
  withJobRun: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) => operation()),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal, auditPlatformAdminAction: mocks.auditPlatformAdminAction }
})

vi.mock('~/shared/lib/billing/reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing/reconciliation')>()
  return { ...actual, runReconciliation: mocks.runReconciliation }
})

// The route wraps the reconciliation call in `withJobRun` to record `job_runs` history — bypass
// its real DB-backed bookkeeping here and just run the operation, same as every other mocked
// admin-worker route test.
vi.mock('~/shared/lib/repositories/platform-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/platform-operations')>()
  return { ...actual, withJobRun: mocks.withJobRun }
})

const { Route } = await import('~/routes/api/admin/billing/reconcile')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.test/api/admin/billing/reconcile', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function callPost(body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body, headers) })
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

  // Regression: billing_reconciliation_runs.actor_user_id has a real FK to auth_users.
  // tryCronPrincipal's synthetic { userId: 'cron' } isn't a row there — passing it straight
  // through as actorUserId 500'd with a foreign-key violation the first time this path was ever
  // actually exercised (it's never called by anything with a browser session). Never regress to
  // forwarding the sentinel userId as-is.
  it('passes actorUserId null (never the "cron" sentinel) when authenticated via CRON_SECRET', async () => {
    const previous = process.env.CRON_SECRET
    process.env.CRON_SECRET = 'test-cron-secret'
    try {
      mocks.runReconciliation.mockResolvedValue(SAMPLE_SUMMARY)

      const response = await callPost({}, { authorization: 'Bearer test-cron-secret' })

      expect(response.status).toBe(200)
      expect(mocks.requirePlatformAdminPrincipal).not.toHaveBeenCalled()
      expect(mocks.runReconciliation).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }))
    } finally {
      process.env.CRON_SECRET = previous
    }
  })
})
