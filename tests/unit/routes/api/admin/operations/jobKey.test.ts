import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  requireRecentPlatformAdminAuthentication: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  setScheduleEnabled: vi.fn(),
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
  return { ...actual, setScheduleEnabled: mocks.setScheduleEnabled }
})

const { Route } = await import('~/routes/api/admin/operations/$jobKey')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function patchRequest(jobKey: string, body: unknown): Request {
  return new Request(`https://app.test/api/admin/operations/${jobKey}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPatch(jobKey: string, body: unknown = {}): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { PATCH: (args: { request: Request; params: { jobKey: string } }) => Promise<Response> } } }
  }).options.server.handlers.PATCH
  return handler({ request: patchRequest(jobKey, body), params: { jobKey } })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
})

describe('PATCH /api/admin/operations/$jobKey', () => {
  it('rejects an unknown job key before touching the database — no traversal, no arbitrary keys', async () => {
    const response = await callPatch('../../etc/passwd', { enabled: false, expectedVersion: 1 })

    expect(response.status).toBe(404)
    expect(mocks.setScheduleEnabled).not.toHaveBeenCalled()
    expect(mocks.auditPlatformAdminAction).not.toHaveBeenCalled()
  })

  it('rejects a non-admin caller before touching the database', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callPatch('alerts.evaluate', { enabled: false, expectedVersion: 1 })

    expect(response.status).toBe(403)
    expect(mocks.setScheduleEnabled).not.toHaveBeenCalled()
  })

  it('requires recent authentication before pausing a job', async () => {
    mocks.requireRecentPlatformAdminAuthentication.mockImplementation(() => {
      throw new PlatformAdminAuthorizationError('Recent re-authentication required', 401)
    })

    const response = await callPatch('alerts.evaluate', { enabled: false, expectedVersion: 1 })

    expect(response.status).toBe(401)
    expect(mocks.setScheduleEnabled).not.toHaveBeenCalled()
  })

  it('rejects a malformed body', async () => {
    const response = await callPatch('alerts.evaluate', { enabled: 'nope' })
    expect(response.status).toBe(400)
    expect(mocks.setScheduleEnabled).not.toHaveBeenCalled()
  })

  it('pauses a job and audits the mutation', async () => {
    mocks.setScheduleEnabled.mockResolvedValue({ outcome: 'updated', jobKey: 'alerts.evaluate', enabled: false, version: 2 })

    const response = await callPatch('alerts.evaluate', { enabled: false, expectedVersion: 1 })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ jobKey: 'alerts.evaluate', enabled: false, version: 2 })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.operations.pause', targetId: 'alerts.evaluate' }),
    )
  })

  it('resumes a job and audits it under the resume action name', async () => {
    mocks.setScheduleEnabled.mockResolvedValue({ outcome: 'updated', jobKey: 'alerts.evaluate', enabled: true, version: 3 })

    await callPatch('alerts.evaluate', { enabled: true, expectedVersion: 2 })

    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.operations.resume' }),
    )
  })

  it('returns 409 with the current version on a version conflict, distinct from not-found', async () => {
    mocks.setScheduleEnabled.mockResolvedValue({ outcome: 'version_conflict', currentVersion: 5 })

    const response = await callPatch('alerts.evaluate', { enabled: false, expectedVersion: 1 })
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({ error: 'version_conflict', currentVersion: 5 })
    expect(mocks.auditPlatformAdminAction).not.toHaveBeenCalled()
  })

  it('returns 404 when the job has never been synced into the registry', async () => {
    mocks.setScheduleEnabled.mockResolvedValue({ outcome: 'not_found' })

    const response = await callPatch('alerts.evaluate', { enabled: false, expectedVersion: 1 })

    expect(response.status).toBe(404)
    expect(mocks.auditPlatformAdminAction).not.toHaveBeenCalled()
  })
})
