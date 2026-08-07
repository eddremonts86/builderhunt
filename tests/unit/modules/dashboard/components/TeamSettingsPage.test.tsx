import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TeamSnapshotDto } from '~/shared/lib/organizations/contracts'
import { TeamSettingsPage, type InvitationRow, type MemberRow } from '~/modules/dashboard/components/TeamSettingsPage'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import type { PageResult } from '~/shared/lib/table/types'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

/**
 * The roster and the invitations are keyset pages now, passed in beside the snapshot rather than
 * inside it (plans/phase-3/10). The snapshot keeps only what is not a list — plus the bounded
 * `transferCandidates`, which feed the danger zone's `<select>`.
 */
const MEMBERS: MemberRow[] = [
  { userId: 'user-owner', name: 'Owen Owner', email: 'owen@acme.test', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
  { userId: 'user-admin', name: 'Ada Admin', email: 'ada@acme.test', role: 'admin', joinedAt: '2026-01-02T00:00:00.000Z' },
  { userId: 'user-member', name: 'Mel Member', email: 'mel@acme.test', role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' },
]

const INVITATIONS: InvitationRow[] = [
  { id: 'invite-1', email: 'pending@acme.test', role: 'member', status: 'pending', expiresAt: '2026-08-01T00:00:00.000Z' },
]

function pageOf<Row>(rows: Row[]): PageResult<Row> {
  return { rows, nextCursor: null, total: rows.length, facets: {} }
}

function baseSnapshot(viewerRole: TeamSnapshotDto['viewerRole']): TeamSnapshotDto {
  return {
    organization: { id: 'org-a', name: 'Acme', slug: 'acme', role: viewerRole, isPersonal: false },
    viewerRole,
    seatUsage: { used: 4, limit: 10 },
    transferCandidates: MEMBERS.filter((member) => member.role !== 'owner'),
    transferCandidatesTruncated: false,
    pendingDeletion: null,
  }
}

async function render(
  snapshot: TeamSnapshotDto,
  viewerUserId: string,
  pages: { members?: MemberRow[]; invitations?: InvitationRow[] } = {},
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <TeamSettingsPage
        snapshot={snapshot}
        viewerUserId={viewerUserId}
        membersPage={pageOf(pages.members ?? MEMBERS)}
        membersSearch={emptyTableSearch()}
        onMembersSearchChange={() => {}}
        invitationsPage={pageOf(pages.invitations ?? INVITATIONS)}
        invitationsSearch={emptyTableSearch()}
        onInvitationsSearchChange={() => {}}
      />,
    )
  })
}

function testIds(): string[] {
  return Array.from(container!.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')!)
}

describe('TeamSettingsPage — authorization matrix', () => {
  it('owner sees invite form, role controls, member removal, transfer, and delete', async () => {
    await render(baseSnapshot('owner'), 'user-owner')
    const ids = testIds()

    expect(ids).toContain('invite-form')
    expect(ids).toContain('role-select-user-admin')
    expect(ids).toContain('role-select-user-member')
    expect(ids).toContain('remove-member-user-admin')
    expect(ids).toContain('remove-member-user-member')
    expect(ids).toContain('transfer-target-select')
    expect(ids).toContain('delete-organization-btn')
    expect(ids).toContain('resend-invitation-invite-1')
    expect(ids).toContain('cancel-invitation-invite-1')

    // Owner never removes themselves via this control, and can't leave without transferring first.
    expect(ids).not.toContain('remove-member-user-owner')
    expect(ids).not.toContain('leave-organization-btn')
    // Owner can't transfer to themselves.
    const transferSelect = container!.querySelector('[data-testid="transfer-target-select"]')
    expect(transferSelect?.textContent).not.toContain('Owen Owner')
  })

  it('admin sees invite form and can remove members/themselves, but never another admin, and has no role/transfer/delete controls', async () => {
    await render(baseSnapshot('admin'), 'user-admin')
    const ids = testIds()

    expect(ids).toContain('invite-form')
    expect(ids).toContain('remove-member-user-member')
    expect(ids).toContain('remove-member-user-admin') // self
    expect(ids).toContain('leave-organization-btn')

    expect(ids).not.toContain('role-select-user-admin')
    expect(ids).not.toContain('role-select-user-member')
    expect(ids).not.toContain('remove-member-user-owner')
    expect(ids).not.toContain('transfer-target-select')
    expect(ids).not.toContain('delete-organization-btn')
  })

  it('member sees no admin/owner actions at all beyond leaving', async () => {
    await render(baseSnapshot('member'), 'user-member')
    const ids = testIds()

    expect(ids).toContain('leave-organization-btn')

    expect(ids).not.toContain('invite-form')
    expect(ids).not.toContain('invitations-section')
    expect(ids).not.toContain('role-select-user-admin')
    expect(ids).not.toContain('role-select-user-member')
    expect(ids).not.toContain('remove-member-user-admin')
    expect(ids).not.toContain('remove-member-user-member')
    expect(ids).not.toContain('transfer-target-select')
    expect(ids).not.toContain('delete-organization-btn')
  })

  it('still renders the invite form on a personal-flagged org that has real seats (e.g. an admin-granted Team plan)', async () => {
    const personalWithSeats = baseSnapshot('owner')
    personalWithSeats.organization.isPersonal = true
    personalWithSeats.transferCandidates = []
    personalWithSeats.seatUsage = { used: 1, limit: 10 }

    await render(personalWithSeats, 'user-owner', { members: [MEMBERS[0]], invitations: [] })
    const ids = testIds()

    // `isPersonal` is a structural label (the auto-created default org), not
    // a capacity rule — a personal org can legitimately have real seats, and
    // must be invitable exactly like any team once it does.
    expect(ids).toContain('invite-form')
    const submitButton = container!.querySelector('[data-testid="invite-submit-btn"]') as HTMLButtonElement
    expect(submitButton.disabled).toBe(false)
  })

  it('disables inviting once the real seat limit is reached, regardless of isPersonal', async () => {
    const seatsFull = baseSnapshot('owner')
    seatsFull.seatUsage = { used: 1, limit: 1 }

    await render(seatsFull, 'user-owner')
    const submitButton = container!.querySelector('[data-testid="invite-submit-btn"]') as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)
    expect(submitButton.textContent).toContain('Seat limit reached')
  })

  it('never renders fields beyond the DTO shape, even when a fixture is contaminated with extra auth-shaped data', async () => {
    const members: MemberRow[] = [{ ...MEMBERS[0], password: 'super-secret-hash' }]
    const invitations: InvitationRow[] = [{ ...INVITATIONS[0], token: 'invite-secret-token' }]

    await render(baseSnapshot('owner'), 'user-owner', { members, invitations })
    expect(container!.innerHTML).not.toContain('super-secret-hash')
    expect(container!.innerHTML).not.toContain('invite-secret-token')
  })

  /** A roster larger than the ownership picker's bound says so, rather than ending silently. */
  it('warns when the transfer-candidate list was truncated', async () => {
    const truncated = baseSnapshot('owner')
    truncated.transferCandidatesTruncated = true

    await render(truncated, 'user-owner')
    expect(testIds()).toContain('transfer-candidates-truncated')
  })
})
