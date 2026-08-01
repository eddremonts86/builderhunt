import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InvitationList } from '~/modules/scheduling/components/InvitationList'
import type { InvitationSummary } from '~/modules/scheduling/components/InvitationStatus'

/**
 * `InvitationList` — filter + pagination shell for the invitation hub (plans/UI Wave 3 "Build a
 * central invitation management hub"). `GET /api/scheduling/invitations` has no server-side filter
 * or cursor, so both are done here over the array already fetched — what matters is that filtering
 * and paging stay client-side only (never a network call) and that a draft is never lost off a page
 * boundary just because other invitations exist.
 */

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

function invitation(overrides: Partial<InvitationSummary> = {}): InvitationSummary {
  return {
    invitationId: `inv-${Math.random()}`,
    status: 'sent',
    version: 1,
    roleTitle: 'Role',
    durationMinutes: 30,
    ...overrides,
  }
}

async function render(invitations: InvitationSummary[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<InvitationList invitations={invitations} onChanged={vi.fn()} />)
  })
}

function testId(id: string): HTMLElement {
  const node = container!.querySelector(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing [data-testid="${id}"]`)
  return node as HTMLElement
}

function maybeTestId(id: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
}

describe('InvitationList — filtering', () => {
  it('labels each filter with the count of invitations actually in that status', async () => {
    await render([
      invitation({ invitationId: 'a', status: 'draft' }),
      invitation({ invitationId: 'b', status: 'draft' }),
      invitation({ invitationId: 'c', status: 'booked' }),
    ])
    expect(testId('invitation-filter-draft').textContent).toContain('(2)')
    expect(testId('invitation-filter-booked').textContent).toContain('(1)')
    expect(testId('invitation-filter-all').textContent).toContain('(3)')
  })

  it('filters the visible rows without ever touching the network', async () => {
    await render([
      invitation({ invitationId: 'a', status: 'draft', roleTitle: 'Draft role' }),
      invitation({ invitationId: 'b', status: 'booked', roleTitle: 'Booked role' }),
    ])

    await click(testId('invitation-filter-draft'))

    expect(document.body.textContent).toContain('Draft role')
    expect(document.body.textContent).not.toContain('Booked role')
  })

  it('shows a status-specific empty state rather than the generic one', async () => {
    await render([invitation({ status: 'draft' })])
    await click(testId('invitation-filter-revoked'))
    expect(testId('invitation-list-empty').textContent).toBe('No revoked invitations.')
  })
})

describe('InvitationList — pagination', () => {
  it('does not paginate when everything fits on one page', async () => {
    await render(Array.from({ length: 3 }, (_, i) => invitation({ invitationId: `x${i}` })))
    expect(maybeTestId('invitation-list-page')).toBeNull()
  })

  it('pages a longer list and moves between pages without dropping any row permanently', async () => {
    const invitations = Array.from({ length: 25 }, (_, i) => invitation({ invitationId: `x${i}`, roleTitle: `Role ${i}` }))
    await render(invitations)

    expect(testId('invitation-list-page').textContent).toBe('Page 1 of 3')
    expect(document.body.textContent).toContain('Role 0')
    expect(document.body.textContent).not.toContain('Role 10')

    await click(testId('invitation-list-next'))
    expect(testId('invitation-list-page').textContent).toBe('Page 2 of 3')
    expect(document.body.textContent).toContain('Role 10')

    await click(testId('invitation-list-prev'))
    expect(testId('invitation-list-page').textContent).toBe('Page 1 of 3')
    expect(document.body.textContent).toContain('Role 0')
  })

  it('resets to page 1 when the filter changes, so a filtered-out page number can never strand the view', async () => {
    const invitations = [
      ...Array.from({ length: 15 }, (_, i) => invitation({ invitationId: `s${i}`, status: 'sent' })),
      invitation({ invitationId: 'd1', status: 'draft', roleTitle: 'The draft' }),
    ]
    await render(invitations)
    await click(testId('invitation-list-next')) // page 2 of the 15 sent rows
    expect(testId('invitation-list-page').textContent).toBe('Page 2 of 2')

    await click(testId('invitation-filter-draft'))

    expect(maybeTestId('invitation-list-page')).toBeNull() // only 1 draft — fits on one page
    expect(document.body.textContent).toContain('The draft')
  })
})
