import { describe, expect, it, vi } from 'vitest'
import { resolveTenantPrincipal, TenantAuthorizationError } from './tenant-principal'

const request = new Request('https://builderhunt.test/private', {
  headers: { 'x-request-id': 'req-123', 'x-organization-id': 'spoofed-org' },
})

describe('resolveTenantPrincipal', () => {
  it('rejects an unauthenticated request', async () => {
    await expect(resolveTenantPrincipal(request, {
      getSession: vi.fn().mockResolvedValue(null),
      findMembership: vi.fn(),
    })).rejects.toMatchObject({ status: 401 })
  })

  it('rejects a session without an active organization', async () => {
    await expect(resolveTenantPrincipal(request, {
      getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: null }),
      findMembership: vi.fn(),
    })).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a stale or unsupported membership', async () => {
    for (const membership of [null, { role: 'platform-admin' }]) {
      await expect(resolveTenantPrincipal(request, {
        getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
        findMembership: vi.fn().mockResolvedValue(membership),
      })).rejects.toBeInstanceOf(TenantAuthorizationError)
    }
  })

  it('derives tenant scope only from the validated session membership', async () => {
    const principal = await resolveTenantPrincipal(request, {
      getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
      findMembership: vi.fn().mockResolvedValue({ role: 'admin' }),
    })

    expect(principal).toEqual({
      userId: 'user-a',
      organizationId: 'org-a',
      role: 'admin',
      requestId: 'req-123',
    })
    expect(principal.organizationId).not.toBe('spoofed-org')
  })
})
