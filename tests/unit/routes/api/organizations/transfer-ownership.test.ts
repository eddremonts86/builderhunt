import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  getOrganizationLifecycle: vi.fn(),
  transferOwnership: vi.fn(),
  findAccountEmailAndName: vi.fn(),
  findOrganizationName: vi.fn(),
  sendOwnershipTransferredFromEmail: vi.fn(),
  sendOwnershipTransferredToEmail: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/auth/organization-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/organization-lifecycle')>()
  return { ...actual, getOrganizationLifecycle: mocks.getOrganizationLifecycle }
})

vi.mock('~/shared/lib/repositories/account-privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/account-privacy')>()
  return { ...actual, findAccountEmailAndName: mocks.findAccountEmailAndName, findOrganizationName: mocks.findOrganizationName }
})

vi.mock('~/shared/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/email')>()
  return {
    ...actual,
    sendOwnershipTransferredFromEmail: mocks.sendOwnershipTransferredFromEmail,
    sendOwnershipTransferredToEmail: mocks.sendOwnershipTransferredToEmail,
  }
})

const { Route } = await import('~/routes/api/organizations/transfer-ownership')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
const { OrganizationLifecycleError } = await import('~/shared/lib/auth/organization-lifecycle')

function principal(role: TenantPrincipal['role']): TenantPrincipal {
  return { userId: 'user-old-owner', organizationId: 'org-a', role, requestId: 'request-1' }
}

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/organizations/transfer-ownership', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

// The notification send is fire-and-forget (`.catch()`, not `await`ed) so the
// response can return without waiting on email delivery — flush the
// microtask queue once so assertions on the mocked senders are reliable.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getOrganizationLifecycle.mockResolvedValue({ transferOwnership: mocks.transferOwnership })
  mocks.findOrganizationName.mockResolvedValue('Acme Inc')
  mocks.findAccountEmailAndName.mockImplementation(async (userId: string) =>
    userId === 'user-old-owner'
      ? { email: 'old-owner@example.com', name: 'Olivia Owner' }
      : { email: 'new-owner@example.com', name: 'Nate New' },
  )
  mocks.sendOwnershipTransferredFromEmail.mockResolvedValue({ ok: true })
  mocks.sendOwnershipTransferredToEmail.mockResolvedValue({ ok: true })
})

describe('POST /api/organizations/transfer-ownership', () => {
  it('transfers ownership and notifies both the old and new owner by email', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.transferOwnership.mockResolvedValue({ requestId: 'req-123' })

    const response = await callPost({ targetUserId: 'user-new-owner' })
    const body = await response.json()
    await flushMicrotasks()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, requestId: 'req-123' })
    expect(mocks.transferOwnership).toHaveBeenCalledWith(expect.any(Request), 'org-a', 'user-new-owner')
    expect(mocks.sendOwnershipTransferredFromEmail).toHaveBeenCalledWith('old-owner@example.com', 'Acme Inc', 'Nate New')
    expect(mocks.sendOwnershipTransferredToEmail).toHaveBeenCalledWith('new-owner@example.com', 'Acme Inc', 'Olivia Owner')
  })

  it('rejects an invalid body with 400 before touching the lifecycle service', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))

    const response = await callPost({})

    expect(response.status).toBe(400)
    expect(mocks.transferOwnership).not.toHaveBeenCalled()
  })

  it('propagates a 401 for a signed-out caller', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Unauthorized', 401))

    const response = await callPost({ targetUserId: 'user-new-owner' })

    expect(response.status).toBe(401)
  })

  it('propagates a stale-session 401 from the lifecycle service without sending any notification', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.transferOwnership.mockRejectedValue(new OrganizationLifecycleError('Please sign in again to continue', 401))

    const response = await callPost({ targetUserId: 'user-new-owner' })
    await flushMicrotasks()

    expect(response.status).toBe(401)
    expect(mocks.sendOwnershipTransferredFromEmail).not.toHaveBeenCalled()
    expect(mocks.sendOwnershipTransferredToEmail).not.toHaveBeenCalled()
  })

  it('still returns success even if the best-effort notification email fails', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal('owner'))
    mocks.transferOwnership.mockResolvedValue({ requestId: 'req-123' })
    mocks.sendOwnershipTransferredFromEmail.mockRejectedValue(new Error('resend down'))

    const response = await callPost({ targetUserId: 'user-new-owner' })
    const body = await response.json()
    await flushMicrotasks()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, requestId: 'req-123' })
  })
})
