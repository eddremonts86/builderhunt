/**
 * Wave 5 admin-track contracts — schema-snapshot test.
 *
 * Verifies the org-admin and platform-admin contracts are not
 * interchangeable: each has its own schemaVersion literal, its own root
 * name, its own action-kind set, and its own forbidden markers. A bug
 * that lets either schema pass for the other would be a privacy leak:
 * the org-admin schema does not contain per-tenant revenue figures that
 * platform-admin does, and the platform-admin schema does not contain
 * per-org members that org-admin does.
 */
import { describe, expect, it } from 'vitest'
import {
  ORG_ADMIN_SCHEMA_VERSION,
  PLATFORM_ADMIN_SCHEMA_VERSION,
  forbiddenMemberDataMarkers,
  orgAdminActionKinds,
  orgAdminOverviewSchema,
  platformAdminActionKinds,
  platformAdminOverviewSchema,
} from '~/shared/lib/dashboard/admin-contracts'

describe('admin-track contracts are not interchangeable', () => {
  it('declares two distinct schema-version literals', () => {
    expect(ORG_ADMIN_SCHEMA_VERSION).toBe(1)
    expect(PLATFORM_ADMIN_SCHEMA_VERSION).toBe(2)
    expect(ORG_ADMIN_SCHEMA_VERSION).not.toBe(PLATFORM_ADMIN_SCHEMA_VERSION)
  })

  it('uses disjoint action-kind sets', () => {
    const org = new Set<string>(orgAdminActionKinds)
    const platform = new Set<string>(platformAdminActionKinds)
    for (const kind of org) {
      expect(platform.has(kind)).toBe(false)
    }
    for (const kind of platform) {
      expect(org.has(kind)).toBe(false)
    }
  })

  it('org-admin schema rejects platform-admin-shaped payloads', () => {
    const platformShaped = {
      schemaVersion: PLATFORM_ADMIN_SCHEMA_VERSION,
      range: '7d' as const,
      generatedAt: '2026-08-07T12:00:00.000Z',
      sections: {
        incidents: { state: 'loading' },
        operations: { state: 'loading' },
        billing: { state: 'loading' },
        abuseTrust: { state: 'loading' },
        userAnomalies: { state: 'loading' },
        growth: { state: 'loading' },
        publicContent: { state: 'loading' },
      },
    }
    const result = orgAdminOverviewSchema.safeParse(platformShaped)
    expect(result.success).toBe(false)
  })

  it('platform-admin schema rejects org-admin-shaped payloads', () => {
    const orgShaped = {
      schemaVersion: ORG_ADMIN_SCHEMA_VERSION,
      organizationId: '11111111-1111-1111-1111-111111111111',
      range: '7d' as const,
      generatedAt: '2026-08-07T12:00:00.000Z',
      sections: {
        members: { state: 'loading' },
        billing: { state: 'loading' },
        blockedWorkflows: { state: 'loading' },
        featureAdoption: { state: 'loading' },
        securityPosture: { state: 'loading' },
        privacyRequests: { state: 'loading' },
      },
    }
    const result = platformAdminOverviewSchema.safeParse(orgShaped)
    expect(result.success).toBe(false)
  })

  it('rejects action URLs that escape the in-app path space', () => {
    const result = orgAdminOverviewSchema.safeParse({
      schemaVersion: ORG_ADMIN_SCHEMA_VERSION,
      organizationId: '11111111-1111-1111-1111-111111111111',
      range: '7d',
      generatedAt: '2026-08-07T12:00:00.000Z',
      sections: {
        members: {
          state: 'ready',
          data: { totalMembers: 0, activeSeats: 0, pendingInvitations: 0, byRole: { owner: 0, admin: 0, member: 0 } },
          generatedAt: '2026-08-07T12:00:00.000Z',
          actions: [
            { kind: 'open-billing', label: 'Open billing', url: 'https://evil.example.com/steal' },
          ],
        },
        billing: { state: 'loading' },
        blockedWorkflows: { state: 'loading' },
        featureAdoption: { state: 'loading' },
        securityPosture: { state: 'loading' },
        privacyRequests: { state: 'loading' },
      },
    })
    expect(result.success).toBe(false)
  })

  it('forbids 8 member-data markers by name (compile-time + grep target)', () => {
    expect(forbiddenMemberDataMarkers).toEqual([
      'memberEmail',
      'candidateEmail',
      'productivityScore',
      'rank',
      'sessionDetail',
      'individualAdoption',
      'searchContent',
      'noteContent',
    ])
  })
})
