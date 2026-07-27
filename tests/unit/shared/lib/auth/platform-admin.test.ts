import { describe, expect, it, vi } from 'vitest'
import {
  parseAdminUserIds,
  platformAdminErrorResponse,
  PlatformAdminAuthorizationError,
  resolvePlatformAdminPrincipal,
} from '~/shared/lib/auth/platform-admin'

const request = new Request('https://builderhunt.test/api/admin/users', {
  headers: { 'x-request-id': 'req-1' },
})

describe('parseAdminUserIds', () => {
  it('trims, dedupes, and drops empty entries', () => {
    const ids = parseAdminUserIds(' user-a, user-b ,,user-a')
    expect(ids).toEqual(new Set(['user-a', 'user-b']))
  })

  it('is empty for undefined or blank input', () => {
    expect(parseAdminUserIds(undefined)).toEqual(new Set())
    expect(parseAdminUserIds('')).toEqual(new Set())
  })
})

describe('resolvePlatformAdminPrincipal', () => {
  it('rejects an unauthenticated request', async () => {
    await expect(
      resolvePlatformAdminPrincipal(request, {
        getSession: vi.fn().mockResolvedValue(null),
        isAdminUserId: vi.fn().mockReturnValue(true),
      }),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('rejects an authenticated user who is not in the admin allow-list', async () => {
    await expect(
      resolvePlatformAdminPrincipal(request, {
        getSession: vi.fn().mockResolvedValue({ userId: 'user-a' }),
        isAdminUserId: vi.fn().mockReturnValue(false),
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('returns a principal for a verified admin', async () => {
    const principal = await resolvePlatformAdminPrincipal(request, {
      getSession: vi.fn().mockResolvedValue({ userId: 'user-a' }),
      isAdminUserId: vi.fn().mockReturnValue(true),
    })
    expect(principal).toEqual({ userId: 'user-a', requestId: 'req-1' })
  })
})

describe('platformAdminErrorResponse', () => {
  it('maps a PlatformAdminAuthorizationError to its status', async () => {
    const response = platformAdminErrorResponse(new PlatformAdminAuthorizationError('Forbidden', 403))
    expect(response?.status).toBe(403)
  })

  it('returns null for an unrelated error', () => {
    expect(platformAdminErrorResponse(new Error('boom'))).toBeNull()
  })
})
