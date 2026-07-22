import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TeamSnapshotDto } from '~/shared/lib/organizations/contracts'
import { TeamSettingsPage } from './TeamSettingsPage'

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

function baseSnapshot(viewerRole: TeamSnapshotDto['viewerRole']): TeamSnapshotDto {
  return {
    organization: { id: 'org-a', name: 'Acme', slug: 'acme', role: viewerRole, isPersonal: false },
    viewerRole,
    members: [
      { userId: 'user-owner', name: 'Owen Owner', email: 'owen@acme.test', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
      { userId: 'user-admin', name: 'Ada Admin', email: 'ada@acme.test', role: 'admin', joinedAt: '2026-01-02T00:00:00.000Z' },
      { userId: 'user-member', name: 'Mel Member', email: 'mel@acme.test', role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' },
    ],
    pendingInvitations: [
      { id: 'invite-1', email: 'pending@acme.test', role: 'member', status: 'pending', expiresAt: '2026-08-01T00:00:00.000Z' },
    ],
    seatUsage: { used: 4, limit: 10 },
  }
}

async function render(snapshot: TeamSnapshotDto, viewerUserId: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<TeamSettingsPage snapshot={snapshot} viewerUserId={viewerUserId} />)
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

  it('hides the invite form on a personal workspace even for its sole owner, and explains why', async () => {
    const personal = baseSnapshot('owner')
    personal.organization.isPersonal = true
    personal.members = [personal.members[0]]
    personal.pendingInvitations = []
    personal.seatUsage = { used: 1, limit: 1 }

    await render(personal, 'user-owner')
    const ids = testIds()

    expect(ids).toContain('personal-org-invite-note')
    expect(ids).not.toContain('invite-form')
  })

  it('never renders fields beyond the DTO shape, even when a fixture is contaminated with extra auth-shaped data', async () => {
    const contaminated = baseSnapshot('owner')
    // @ts-expect-error deliberately contaminating the fixture with fields the DTO doesn't declare
    contaminated.members[0].password = 'super-secret-hash'
    // @ts-expect-error same, on the invitation
    contaminated.pendingInvitations[0].token = 'invite-secret-token'

    await render(contaminated, 'user-owner')
    expect(container!.innerHTML).not.toContain('super-secret-hash')
    expect(container!.innerHTML).not.toContain('invite-secret-token')
  })
})
