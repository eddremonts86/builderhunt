import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRouter, createRootRoute, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import type { OrganizationMemberDto, OrganizationRole } from '~/shared/lib/organizations/contracts'
import { OrganizationDangerZone, type OrganizationDangerZoneProps } from './OrganizationDangerZone'

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

const MEMBERS: OrganizationMemberDto[] = [
  { userId: 'user-owner', name: 'Owen Owner', email: 'owen@acme.test', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
  { userId: 'user-admin', name: 'Ada Admin', email: 'ada@acme.test', role: 'admin', joinedAt: '2026-01-02T00:00:00.000Z' },
  { userId: 'user-member', name: 'Mel Member', email: 'mel@acme.test', role: 'member', joinedAt: '2026-01-03T00:00:00.000Z' },
]

function baseProps(viewerRole: OrganizationRole, viewerUserId: string): OrganizationDangerZoneProps {
  return {
    organizationName: 'Acme',
    isPersonal: false,
    viewerRole,
    viewerUserId,
    members: MEMBERS,
    pendingDeletion: null,
  }
}

async function render(props: OrganizationDangerZoneProps) {
  const rootRoute = createRootRoute({
    component: () => <OrganizationDangerZone {...props} />,
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
}

function testIds(): string[] {
  return Array.from(container!.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')!)
}

// React tracks the native input value setter to detect real user input —
// setting `.value` directly leaves its internal tracker out of sync, so the
// change handler never fires. This bypasses the tracker the same way
// @testing-library/react's `fireEvent` does under the hood.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('OrganizationDangerZone — authorization matrix', () => {
  it('owner sees transfer and delete controls but never leave (must transfer first)', async () => {
    await render(baseProps('owner', 'user-owner'))
    const ids = testIds()

    expect(ids).toContain('transfer-target-select')
    expect(ids).toContain('delete-organization-btn')
    expect(ids).not.toContain('leave-organization-btn')
  })

  it('admin sees leave but never transfer/delete', async () => {
    await render(baseProps('admin', 'user-admin'))
    const ids = testIds()

    expect(ids).toContain('leave-organization-btn')
    expect(ids).not.toContain('transfer-target-select')
    expect(ids).not.toContain('delete-organization-btn')
  })

  it('member sees only leave', async () => {
    await render(baseProps('member', 'user-member'))
    const ids = testIds()

    expect(ids).toContain('leave-organization-btn')
    expect(ids).not.toContain('transfer-target-select')
    expect(ids).not.toContain('delete-organization-btn')
  })

  it('hides delete even for the owner on a personal organization', async () => {
    const props = baseProps('owner', 'user-owner')
    props.isPersonal = true
    await render(props)

    expect(testIds()).not.toContain('delete-organization-btn')
  })
})

describe('OrganizationDangerZone — deletion request challenge', () => {
  it('requires typing the exact organization name before the delete button is enabled', async () => {
    await render(baseProps('owner', 'user-owner'))
    const deleteBtn = container!.querySelector('[data-testid="delete-organization-btn"]') as HTMLButtonElement
    await act(async () => deleteBtn.click())

    const confirmBtn = () => container!.querySelector('[data-testid="confirm-delete-organization-btn"]') as HTMLButtonElement
    expect(confirmBtn().disabled).toBe(true)

    const input = container!.querySelector('[data-testid="confirm-organization-name-input"]') as HTMLInputElement
    await act(async () => typeInto(input, 'not the name'))
    expect(confirmBtn().disabled).toBe(true)

    await act(async () => typeInto(input, 'Acme'))
    expect(confirmBtn().disabled).toBe(false)
  })
})

describe('OrganizationDangerZone — pending deletion', () => {
  it('shows the grace-period banner and cancel control, and hides the delete button, once a deletion is pending', async () => {
    const props = baseProps('owner', 'user-owner')
    props.pendingDeletion = { id: 'del-req-1', gracePeriodEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() }
    await render(props)
    const ids = testIds()

    expect(ids).toContain('organization-deletion-warning')
    expect(ids).toContain('cancel-organization-deletion-btn')
    expect(ids).not.toContain('delete-organization-btn')
  })
})

describe('OrganizationDangerZone — recent-auth and reference id', () => {
  it('shows a sign-in-again CTA, not a generic error string, for a stale-session error', async () => {
    const props = baseProps('owner', 'user-owner')
    props.error = 'Please sign in again to continue'
    await render(props)
    const ids = testIds()

    expect(ids).toContain('stale-session-banner')
    expect(ids).toContain('reauth-link')
    expect(ids).not.toContain('team-danger-error')
  })

  it('renders a plain generic error unchanged when it is not the stale-session message', async () => {
    const props = baseProps('owner', 'user-owner')
    props.error = 'Something else went wrong'
    await render(props)
    expect(testIds()).not.toContain('stale-session-banner')
  })

  it('displays a reference id when provided, without needing any specific action to have run', async () => {
    const props = baseProps('owner', 'user-owner')
    props.referenceId = 'audit-ref-123'
    await render(props)

    const el = container!.querySelector('[data-testid="danger-zone-reference-id"]')
    expect(el?.textContent).toContain('audit-ref-123')
  })
})

describe('OrganizationDangerZone — DTO contamination', () => {
  it('never renders fields beyond the DTO shape', async () => {
    const props = baseProps('owner', 'user-owner')
    // @ts-expect-error deliberately contaminating the fixture with a field the DTO doesn't declare
    props.members[0].password = 'super-secret-hash'
    await render(props)
    expect(container!.innerHTML).not.toContain('super-secret-hash')
  })
})
