import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvitationStatus, type InvitationSummary } from '~/modules/scheduling/components/InvitationStatus'

/**
 * `InvitationStatus` — the organizer's per-invitation action row (plans/UI Wave 3 "Build a central
 * invitation management hub" + "Connect booked scheduling to Calendar and Interviews").
 *
 * What matters: every lifecycle state exposes only the actions legal for it (a draft can be sent
 * or revoked but has no calendar/brief/join links yet since nothing is booked; a booked row gets
 * those three links plus a safety-checked meeting link and no revoke; every other non-terminal
 * state — sent/opened — keeps just revoke; terminal states get no action at all), and every mutating
 * action carries the exact version the row was rendered with.
 */

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  fetchMock.mockReset()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

function invitation(overrides: Partial<InvitationSummary> = {}): InvitationSummary {
  return {
    invitationId: 'inv-1',
    status: 'draft',
    version: 3,
    roleTitle: 'Staff engineer',
    durationMinutes: 45,
    organizationBuilderId: 'ob-1',
    ...overrides,
  }
}

async function render(invitations: InvitationSummary[], onChanged: () => void = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<InvitationStatus invitations={invitations} onChanged={onChanged} />)
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
    await Promise.resolve()
  })
}

describe('InvitationStatus — actions match the invitation\'s own lifecycle state', () => {
  it('a draft gets Send, Revoke, and Resume, but none of the booked-only links', async () => {
    await render([invitation({ status: 'draft', candidateEmail: 'ada@example.test' })])
    testId('invitation-status-send')
    testId('invitation-status-resume-draft')
    expect(testId('invitation-status-candidate-email').textContent).toContain('ada@example.test')
    expect(maybeTestId('invitation-status-booked-links')).toBeNull()
    // Revoke is present too (draft is not terminal).
    expect(document.body.querySelector('button')).toBeTruthy()
  })

  it('sent/opened get only Revoke — no Send, no booked links', async () => {
    for (const status of ['sent', 'opened']) {
      await render([invitation({ status })])
      expect(maybeTestId('invitation-status-send')).toBeNull()
      expect(maybeTestId('invitation-status-resume-draft')).toBeNull()
      expect(maybeTestId('invitation-status-booked-links')).toBeNull()
      act(() => root!.unmount())
      container!.remove()
    }
  })

  it('booked gets the three cross-links and no revoke', async () => {
    await render([invitation({ status: 'booked', bookedEventId: 'evt-1', bookedAt: '2027-08-01T10:00:00.000Z' })])
    expect(testId('invitation-status-view-in-calendar').getAttribute('href')).toBe('/calendar?event=evt-1')
    expect(testId('invitation-status-prepare-brief').getAttribute('href')).toBe('/interviews/evt-1')
    expect(testId('invitation-status-join-interview').getAttribute('href')).toBe('/interviews/evt-1/live')
    expect(document.body.textContent).not.toContain('Revoke')
  })

  it('never links an unsafe meeting URL, even on a booked row', async () => {
    await render([invitation({ status: 'booked', bookedEventId: 'evt-1', meetingUrl: 'javascript:alert(1)' })])
    expect(maybeTestId('invitation-status-meeting-link')).toBeNull()
  })

  it('terminal states (revoked/expired/declined) expose no action at all', async () => {
    for (const status of ['revoked', 'expired', 'declined']) {
      await render([invitation({ status })])
      expect(maybeTestId('invitation-status-send')).toBeNull()
      expect(document.body.querySelectorAll('button')).toHaveLength(0)
      act(() => root!.unmount())
      container!.remove()
    }
  })
})

describe('InvitationStatus — Send', () => {
  it('sends the exact version the row was rendered with and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    const onChanged = vi.fn()
    await render([invitation({ status: 'draft', version: 7 })], onChanged)

    await click(testId('invitation-status-send'))

    expect(fetchMock).toHaveBeenCalledWith('/api/scheduling/invitations/inv-1/send', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.version).toBe(7)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('surfaces a send failure without calling onChanged', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: 'Invitation already sent.' }) })
    const onChanged = vi.fn()
    await render([invitation({ status: 'draft' })], onChanged)

    await click(testId('invitation-status-send'))

    expect(onChanged).not.toHaveBeenCalled()
    expect(testId('invitation-status-error').textContent).toContain('already sent')
  })
})
