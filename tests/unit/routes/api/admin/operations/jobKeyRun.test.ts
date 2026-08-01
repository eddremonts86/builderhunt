import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  requireRecentPlatformAdminAuthentication: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  findRunningJobRun: vi.fn(),
  withJobRun: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) => operation()),
  runAlertsWorker: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    requireRecentPlatformAdminAuthentication: mocks.requireRecentPlatformAdminAuthentication,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

vi.mock('~/shared/lib/repositories/platform-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/platform-operations')>()
  return { ...actual, findRunningJobRun: mocks.findRunningJobRun, withJobRun: mocks.withJobRun }
})

vi.mock('~/lib/alerts/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/alerts/worker')>()
  return { ...actual, runAlertsWorker: mocks.runAlertsWorker }
})

const { Route } = await import('~/routes/api/admin/operations/$jobKey/run')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRun(jobKey: string): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { POST: (args: { request: Request; params: { jobKey: string } }) => Promise<Response> } } }
  }).options.server.handlers.POST
  return handler({
    request: new Request(`https://app.test/api/admin/operations/${jobKey}/run`, { method: 'POST' }),
    params: { jobKey },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  mocks.findRunningJobRun.mockResolvedValue(null)
  mocks.withJobRun.mockImplementation(async (_input: unknown, operation: () => Promise<unknown>) => operation())
})

describe('POST /api/admin/operations/$jobKey/run', () => {
  it('rejects an unknown/traversal job key before checking for an in-flight run', async () => {
    const response = await callRun('../../etc/passwd')

    expect(response.status).toBe(404)
    expect(mocks.findRunningJobRun).not.toHaveBeenCalled()
    expect(mocks.auditPlatformAdminAction).not.toHaveBeenCalled()
  })

  it('rejects a non-admin caller', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRun('alerts.evaluate')

    expect(response.status).toBe(403)
    expect(mocks.findRunningJobRun).not.toHaveBeenCalled()
  })

  it('requires recent authentication', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })

    const response = await callRun('alerts.evaluate')

    expect(response.status).toBe(401)
    expect(mocks.findRunningJobRun).not.toHaveBeenCalled()
  })

  it('does not duplicate work when the job is already running — a second manual click 409s', async () => {
    mocks.findRunningJobRun.mockResolvedValue({ id: 'run-1', startedAt: new Date('2027-01-01T00:00:00.000Z') })

    const response = await callRun('alerts.evaluate')
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'already_running', startedAt: '2027-01-01T00:00:00.000Z' })
    expect(mocks.runAlertsWorker).not.toHaveBeenCalled()
    expect(mocks.auditPlatformAdminAction).not.toHaveBeenCalled()
  })

  it('dispatches the worker for a known job key and audits the run', async () => {
    mocks.runAlertsWorker.mockResolvedValue({ alertsEvaluated: 4, triggersCreated: 1, usersEmailed: 1, errors: [] })

    const response = await callRun('alerts.evaluate')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, jobKey: 'alerts.evaluate', alertsEvaluated: 4 })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.operations.run', targetId: 'alerts.evaluate' }),
    )
  })

  it('maps an undefined_table error to a distinguishable 503 without leaking the raw error', async () => {
    mocks.runAlertsWorker.mockRejectedValue(Object.assign(new Error('relation "builder_embeddings" does not exist'), { code: '42P01' }))

    const response = await callRun('alerts.evaluate')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({ error: 'embeddings_store_missing' })
  })
})
