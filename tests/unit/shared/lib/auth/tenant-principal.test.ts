import { describe, expect, it, vi } from 'vitest'
import { resolveTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'

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

  it('rejects a request when the enforcement stage resolves to blocked (abuse-and-usage-integrity Phase 5)', async () => {
    const getEnforcementStage = vi.fn().mockResolvedValue('blocked')
    await expect(resolveTenantPrincipal(request, {
      getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
      findMembership: vi.fn().mockResolvedValue({ role: 'admin' }),
      getEnforcementStage,
    })).rejects.toMatchObject({ status: 403 })
    expect(getEnforcementStage).toHaveBeenCalledWith('user-a')
  })

  it.each(['observe', 'warned', 'stepup', 'throttled'] as const)(
    'still resolves a principal when the enforcement stage is %s (only blocked rejects)',
    async (stage) => {
      const principal = await resolveTenantPrincipal(request, {
        getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
        findMembership: vi.fn().mockResolvedValue({ role: 'admin' }),
        getEnforcementStage: vi.fn().mockResolvedValue(stage),
      })
      expect(principal.userId).toBe('user-a')
    },
  )

  it('never calls getEnforcementStage when membership was already denied', async () => {
    const getEnforcementStage = vi.fn().mockResolvedValue('blocked')
    await expect(resolveTenantPrincipal(request, {
      getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
      findMembership: vi.fn().mockResolvedValue(null),
      getEnforcementStage,
    })).rejects.toBeInstanceOf(TenantAuthorizationError)
    expect(getEnforcementStage).not.toHaveBeenCalled()
  })
})
