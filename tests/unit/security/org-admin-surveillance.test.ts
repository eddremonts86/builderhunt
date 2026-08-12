/**
 * Wave 5 task 4 — organization-admin surveillance guard.
 *
 * Pins the privacy contract for the org-admin overview projection:
 * the JSON-serialized output must never contain any of the 8 forbidden
 * member-data markers, regardless of input fixtures.
 *
 * This is a structural test against a typed mock fixture rather than
 * a live DB read; the goal is to catch a regression that introduces a
 * field like `memberEmail` or `productivityScore` in a future commit
 * without an ADR override.
 */
import { describe, expect, it } from 'vitest'
import { forbiddenMemberDataMarkers } from '~/shared/lib/dashboard/admin-contracts'
import type { z } from 'zod'
import type { orgAdminOverviewSchema } from '~/shared/lib/dashboard/admin-contracts'

type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>

/** A fully-populated org-admin overview that intentionally stresses
 *  every section so a regression that adds a forbidden field would
 *  surface here. */
function fullyPopulated(): OrgAdminOverview {
  return {
    schemaVersion: 1,
    organizationId: '11111111-1111-1111-1111-111111111111',
    range: '30d',
    generatedAt: '2026-08-07T12:00:00.000Z',
    sections: {
      members: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [
          { kind: 'open-billing', label: 'Open billing', url: '/settings/billing' },
          { kind: 'open-team', label: 'Open team', url: '/settings/team' },
        ],
        data: {
          total: 12,
          byRole: { owner: 1, admin: 2, member: 9 },
          seatLimit: 12,
        },
      },
      billing: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [{ kind: 'open-billing', label: 'Open billing', url: '/settings/billing' }],
        data: { tier: 'team', status: 'active', seatLimit: 12, approachingSeatCap: true, renewalDays: 5 },
      },
      blockedWorkflows: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: {
          blockedCounts: { missing_owner: 1, stale_invitation: 3 },
          total: 4,
        },
      },
      featureAdoption: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { rates: { alerts: 0.8, exports: 0.45, calendar: 0.2 } },
      },
      securityPosture: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: {
          unverifiedAdmins: 1,
          staleAdminDays: {
            '22222222-2222-2222-2222-222222222222': 47,
            '33333333-3333-3333-3333-333333333333': 91,
          },
        },
      },
      privacyRequests: {
        state: 'ready',
        generatedAt: '2026-08-07T12:00:00.000Z',
        actions: [],
        data: { byKind: { deletion: { pending: 3 }, export: { processing: 1 } } },
      },
    },
  }
}

describe('organization-admin surveillance guard', () => {
  it('forbids 8 member-data markers by name', () => {
    // Listed in admin-contracts.ts. Adding a marker is an ADR-level
    // change, not a routine code edit.
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

  it('serialized fully-populated overview contains no forbidden marker', () => {
    const json = JSON.stringify(fullyPopulated())
    for (const marker of forbiddenMemberDataMarkers) {
      expect(json).not.toContain(marker)
    }
  })

  /**
   * The typed envelope refuses a payload carrying a forbidden marker.
   *
   * ## What this test used to assert, and why it was worth rewriting
   *
   * It built exactly this smuggled payload, parsed it, and asserted `success === true` — because the envelope's
   * ready branch declared `data: z.unknown()`, so it accepted anything. Its own comment claimed the gap was
   * covered elsewhere: "the contract test in admin-contracts.test.ts proves the route handler parses the inner
   * `data` against the typed schema". No such parse existed. Nothing between the projection and the component
   * validated a section payload, and on 2026-08-11 that let a field rename ship a dashboard card whose numbers
   * were `undefined` — rendered as empty space inside a finished sentence.
   *
   * So the assertion is inverted now, and it is an assertion rather than a note: the smuggled marker is rejected,
   * because `orgAdminSectionEnvelope` parses the payload against the section's own schema and that schema does not
   * have a `memberEmail` field for a leak to arrive in.
   */
  it('the typed section envelope refuses a payload carrying a forbidden marker', async () => {
    const { orgAdminSectionEnvelope, orgAdminMembersSchema } = await import(
      '~/shared/lib/dashboard/admin-contracts'
    )
    const envelope = orgAdminSectionEnvelope(orgAdminMembersSchema)

    const smuggle = {
      state: 'ready' as const,
      generatedAt: '2026-08-07T12:00:00.000Z',
      actions: [] as const,
      data: {
        total: 1,
        byRole: { owner: 1, admin: 0, member: 0 },
        seatLimit: 3,
        memberEmail: 'leak@example.com',
      },
    }

    const parsed = envelope.safeParse(smuggle)
    expect(parsed.success).toBe(false)

    /**
     * And the valid payload passes, which is the control.
     *
     * Without it the rejection above would also hold if the schema refused everything — the isolation would look
     * perfect and the section would never render. Same reason the preference-store spec has a positive case.
     */
    const clean = { ...smuggle, data: { total: 1, byRole: { owner: 1, admin: 0, member: 0 }, seatLimit: 3 } }
    expect(envelope.safeParse(clean).success).toBe(true)
  })

  /**
   * The renamed fields are gone from the contract, not merely unused.
   *
   * A rename that leaves the old field optional is not a rename — the projection stops emitting it, the component
   * stops reading it, and the schema keeps accepting it, so the next writer has two plausible names and no signal
   * about which one is live. These three could never be produced (`activeSeats` double-counted memberships,
   * `pendingInvitations` needs a table the tenant role is not granted), so accepting them would be accepting a
   * payload no honest projection can build.
   */
  it('refuses the field names the projection could not produce', async () => {
    const { orgAdminMembersSchema } = await import('~/shared/lib/dashboard/admin-contracts')
    const stale = {
      totalMembers: 1,
      activeSeats: 1,
      pendingInvitations: 0,
      byRole: { owner: 1, admin: 0, member: 0 },
    }
    expect(orgAdminMembersSchema.safeParse(stale).success).toBe(false)
  })

  it('action URL regex rejects anything that escapes the in-app path space', async () => {
    const { orgAdminActionSchema } = await import(
      '~/shared/lib/dashboard/admin-contracts'
    )
    expect(
      orgAdminActionSchema.safeParse({
        kind: 'open-billing',
        label: 'Open billing',
        url: 'https://evil.example.com',
      }).success,
    ).toBe(false)
    expect(
      orgAdminActionSchema.safeParse({
        kind: 'open-billing',
        label: 'Open billing',
        url: '/settings/billing',
      }).success,
    ).toBe(true)
  })
})
