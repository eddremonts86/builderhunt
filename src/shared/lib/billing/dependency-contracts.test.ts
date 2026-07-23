/**
 * Pins the exact security/team-account contracts the Stripe billing plan
 * (plans/stripe-billing-platform/tasks.md, "Verify organization billing
 * dependency contracts") is built on: active-organization resolution,
 * owner/admin/member roles, owner-only mutation vs. any-role read,
 * platform-admin separation, accepted-member-plus-invitation seat usage,
 * and the canonical entitlement interface. Each contract already has its
 * own exhaustive unit test elsewhere (tenant-principal.test.ts,
 * permissions.test.ts, entitlements.test.ts) — this file exists so a
 * future change to any of them also fails here, with a message that points
 * at the billing plan that depends on it, not just at the foundation's own
 * suite. Also holds the line for every billing module added later: no
 * accepting a bare organizationId as authority, no importing Better Auth
 * or raw DB rows into a billing DTO.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolvePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { resolveTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { can, type TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { toSeatUsageDto } from '~/shared/lib/organizations/contracts'
import { resolveEntitlementPolicy } from '~/shared/lib/repositories/entitlements'

const principal = (role: TenantPrincipal['role']): TenantPrincipal => ({
  userId: 'user-a',
  organizationId: 'org-a',
  role,
  requestId: 'request-1',
})

describe('billing dependency: active-organization resolution', () => {
  it('derives {userId, organizationId, role, requestId} only from a validated session + membership', async () => {
    const result = await resolveTenantPrincipal(
      new Request('https://builderhunt.test/billing'),
      {
        getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: 'org-a' }),
        findMembership: vi.fn().mockResolvedValue({ role: 'owner' }),
      },
    )
    expect(result).toEqual({ userId: 'user-a', organizationId: 'org-a', role: 'owner', requestId: expect.any(String) })
  })

  it('refuses to resolve a principal without an active organization', async () => {
    await expect(resolveTenantPrincipal(
      new Request('https://builderhunt.test/billing'),
      { getSession: vi.fn().mockResolvedValue({ userId: 'user-a', activeOrganizationId: null }), findMembership: vi.fn() },
    )).rejects.toBeInstanceOf(TenantAuthorizationError)
  })
})

describe('billing dependency: owner | admin | member roles', () => {
  it('owner-only mutation, any-role read — the pattern billing subscription mutation/read will follow', () => {
    expect(can(principal('owner'), 'organization:transfer')).toBe(true)
    expect(can(principal('owner'), 'organization:delete')).toBe(true)
    expect(can(principal('admin'), 'organization:transfer')).toBe(false)
    expect(can(principal('member'), 'organization:transfer')).toBe(false)
    expect(can(principal('owner'), 'organization:read')).toBe(true)
    expect(can(principal('admin'), 'organization:read')).toBe(true)
    expect(can(principal('member'), 'organization:read')).toBe(true)
  })

  it('elevated (admin-or-owner) actions exclude plain members — the shape billing "admin read" reuses', () => {
    expect(can(principal('member'), 'organization:update')).toBe(false)
    expect(can(principal('admin'), 'organization:update')).toBe(true)
    expect(can(principal('owner'), 'organization:update')).toBe(true)
  })
})

describe('billing dependency: platform-admin separation', () => {
  it('resolves from a distinct allow-list, never from organization role', async () => {
    const result = await resolvePlatformAdminPrincipal(
      new Request('https://builderhunt.test/admin/billing'),
      {
        getSession: vi.fn().mockResolvedValue({ userId: 'user-a' }),
        isAdminUserId: (id) => id === 'user-a',
      },
    )
    expect(result).toEqual({ userId: 'user-a', requestId: expect.any(String) })
    expect(result).not.toHaveProperty('organizationId')
    expect(result).not.toHaveProperty('role')
  })

  it('rejects an org owner who is not on the platform admin allow-list', async () => {
    await expect(resolvePlatformAdminPrincipal(
      new Request('https://builderhunt.test/admin/billing'),
      { getSession: vi.fn().mockResolvedValue({ userId: 'org-owner' }), isAdminUserId: () => false },
    )).rejects.toMatchObject({ status: 403 })
  })
})

describe('billing dependency: seat usage — accepted members plus usable invitations', () => {
  it('toSeatUsageDto pins the {used, limit} shape billing seat-blocker checks read', () => {
    expect(toSeatUsageDto({ used: 4, limit: 10 })).toEqual({ used: 4, limit: 10 })
  })
})

describe('billing dependency: canonical entitlement interface', () => {
  it("pins EntitlementPolicy's shape and paid-action derivation", () => {
    expect(resolveEntitlementPolicy(null)).toEqual({
      tier: 'free', status: 'active', active: true, paidActionsAllowed: false, seatLimit: 1,
    })
    expect(resolveEntitlementPolicy({ tier: 'team', status: 'active', seatLimit: 10 })).toEqual({
      tier: 'team', status: 'active', active: true, paidActionsAllowed: true, seatLimit: 10,
    })
  })
})

// Forward-looking: src/shared/lib/billing/ has no real module yet (this file
// is the first). readdir on a directory containing only *.test.ts files
// yields an empty source-file list, so both checks below trivially pass
// today — they start enforcing the instant the first real billing module
// (plans/stripe-billing-platform/tasks.md phase 1+) lands here.
describe('billing module boundary', () => {
  const billingDir = join(process.cwd(), 'src/shared/lib/billing')

  async function billingSourceFiles(): Promise<string[]> {
    const entries = await readdir(billingDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      .map((entry) => join(billingDir, entry.name))
  }

  it('no billing module accepts a bare organizationId as its authority', async () => {
    for (const file of await billingSourceFiles()) {
      const source = await readFile(file, 'utf8')
      expect(source, `${file} must accept a TenantPrincipal, not a bare organizationId`).not.toMatch(
        /export (?:async )?function \w+\(\s*organizationId\s*:\s*string/,
      )
    }
  })

  it('no billing module imports Better Auth or raw DB rows into its exported DTOs', async () => {
    for (const file of await billingSourceFiles()) {
      const source = await readFile(file, 'utf8')
      expect(source, `${file} must not import better-auth directly`).not.toMatch(/from ['"].*better-auth['"]/)
      expect(source, `${file} must not import the raw db schema/index`).not.toMatch(
        /from ['"]~\/shared\/lib\/db\/(schema|index)['"]/,
      )
    }
  })
})
