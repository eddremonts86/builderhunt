// Regression coverage for the 2026-07-31 phase-1 audit finding: runActivityRetention
// (src/shared/lib/workers/activity-retention.ts) was fully built and unit-tested in isolation, but
// no route ever invoked it — every activity row with a retentionDays value accumulated forever
// instead of expiring. This route is the missing call site.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  tryCronPrincipal: vi.fn(),
  auditPlatformAdminAction: vi.fn(),
  runActivityRetention: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return {
    ...actual,
    requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal,
    auditPlatformAdminAction: mocks.auditPlatformAdminAction,
  }
})

vi.mock('~/shared/lib/auth/cron', () => ({
  tryCronPrincipal: mocks.tryCronPrincipal,
}))

vi.mock('~/shared/lib/workers/activity-retention', () => ({
  runActivityRetention: mocks.runActivityRetention,
}))

const { Route } = await import('~/routes/api/admin/activity/run-retention')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

async function callRoute(): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: new Request('https://app.test/api/admin/activity/run-retention', { method: 'POST' }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tryCronPrincipal.mockReturnValue(null)
})

describe('POST /api/admin/activity/run-retention', () => {
  it('runs the retention pass and audits it for a platform admin', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runActivityRetention.mockResolvedValue({ scannedBatches: 2, deleted: 750, hitLimit: false })

    const response = await callRoute()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ scannedBatches: 2, deleted: 750, hitLimit: false })
    expect(mocks.auditPlatformAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ action: 'admin.worker.run', targetId: 'activity-retention' }),
    )
  })

  it('accepts a cron principal without a platform-admin session', async () => {
    mocks.tryCronPrincipal.mockReturnValue({ userId: 'cron', requestId: 'req-cron' })
    mocks.runActivityRetention.mockResolvedValue({ scannedBatches: 0, deleted: 0, hitLimit: false })

    const response = await callRoute()

    expect(response.status).toBe(200)
    expect(mocks.requirePlatformAdminPrincipal).not.toHaveBeenCalled()
  })

  it('rejects a non-admin with the mapped platform-admin error response', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))

    const response = await callRoute()

    expect(response.status).toBe(403)
    expect(mocks.runActivityRetention).not.toHaveBeenCalled()
  })

  it('maps an unexpected worker error to a generic 500', async () => {
    mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
    mocks.runActivityRetention.mockRejectedValue(new Error('db exploded'))

    const response = await callRoute()

    expect(response.status).toBe(500)
  })
})
