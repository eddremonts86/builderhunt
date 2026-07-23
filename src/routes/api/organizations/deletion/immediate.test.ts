import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getSession: vi.fn(),
  findOrganizationName: vi.fn(),
  requestImmediateDeletion: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))

vi.mock('~/shared/lib/repositories/account-privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/account-privacy')>()
  return { ...actual, findOrganizationName: mocks.findOrganizationName }
})

vi.mock('~/shared/lib/organizations/deletion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/organizations/deletion')>()
  return { ...actual, requestImmediateDeletion: mocks.requestImmediateDeletion }
})

const { Route } = await import('./immediate')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
const { OrganizationDeletionError } = await import('~/shared/lib/organizations/deletion')

function principal(role: TenantPrincipal['role'] = 'owner'): TenantPrincipal {
  return { userId: 'user-a', organizationId: 'org-a', role, requestId: 'request-1' }
}

const RECENT_SESSION = { session: { createdAt: new Date().toISOString() } }

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/organizations/deletion/immediate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue(RECENT_SESSION)
  mocks.findOrganizationName.mockResolvedValue('Acme Inc')
})

describe('POST /api/organizations/deletion/immediate', () => {
  it('deletes the organization when the typed name matches and the service call succeeds', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.requestImmediateDeletion.mockResolvedValue({ requestId: 'req-1' })

    const response = await callPost({ confirmOrganizationName: 'Acme Inc' })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, requestId: 'req-1' })
  })

  it('rejects when the typed name does not match, before calling the service at all', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))

    const response = await callPost({ confirmOrganizationName: 'wrong name' })

    expect(response.status).toBe(400)
    expect(mocks.requestImmediateDeletion).not.toHaveBeenCalled()
  })

  it('rejects an invalid body with 400', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))

    const response = await callPost({})

    expect(response.status).toBe(400)
    expect(mocks.requestImmediateDeletion).not.toHaveBeenCalled()
  })

  it('propagates a 401 for a signed-out caller', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Unauthorized', 401))

    const response = await callPost({ confirmOrganizationName: 'Acme Inc' })

    expect(response.status).toBe(401)
  })

  it('propagates a 403 when the underlying service rejects a non-owner', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('admin'))
    mocks.requestImmediateDeletion.mockRejectedValue(new OrganizationDeletionError('Forbidden', 403))

    const response = await callPost({ confirmOrganizationName: 'Acme Inc' })

    expect(response.status).toBe(403)
  })

  it('propagates a stale-session 401 from the underlying service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.requestImmediateDeletion.mockRejectedValue(new OrganizationDeletionError('Please sign in again to continue', 401))

    const response = await callPost({ confirmOrganizationName: 'Acme Inc' })

    expect(response.status).toBe(401)
  })
})
