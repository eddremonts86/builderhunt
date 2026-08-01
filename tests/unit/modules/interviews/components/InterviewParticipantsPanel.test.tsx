import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InterviewParticipantsPanel, type ParticipantView } from '~/modules/interviews/components/InterviewParticipantsPanel'

/**
 * `InterviewParticipantsPanel` — owner-only material-access controls (plans/UI Wave 3 "Add
 * interview participant material-access controls").
 *
 * What matters: sharing (granting) always asks for confirmation before the PATCH fires, since it is
 * the direction that hands a candidate's material to someone new; revoking never does, since
 * restricting access needs no extra friction. Every state the panel can land in — 403 from the list
 * endpoint (not the owner), 404 (a participant removed since the page loaded), 429 (rate limited) —
 * has to fail closed: the local list never optimistically flips before the server confirms it.
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

function participant(overrides: Partial<ParticipantView> = {}): ParticipantView {
  return {
    id: 'p-1',
    displayName: 'Ada Lovelace',
    externalEmail: null,
    role: 'attendee',
    response: 'accepted',
    accessGranted: true,
    materialAccessGranted: false,
    ...overrides,
  }
}

async function render(props: Partial<Parameters<typeof InterviewParticipantsPanel>[0]> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <InterviewParticipantsPanel
        interviewId="evt-1"
        loadParticipants={props.loadParticipants ?? (async () => ({ ok: true, participants: [] }))}
        setMaterialAccess={props.setMaterialAccess}
      />,
    )
  })
  await flush()
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
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
  await flush()
}

describe('InterviewParticipantsPanel — loading', () => {
  it('shows a fail-closed error for a non-owner (403), never the participant list', async () => {
    await render({ loadParticipants: async () => ({ ok: false, status: 403 }) })
    expect(testId('participants-panel-error').textContent).toContain('interview owner')
    expect(maybeTestId('participants-panel')).toBeNull()
  })

  it('shows a not-found error rather than leaking that some interview exists at this id', async () => {
    await render({ loadParticipants: async () => ({ ok: false, status: 404 }) })
    expect(testId('participants-panel-error').textContent).toContain('could not be found')
  })

  it('renders each participant\'s calendar-invite and material-access state independently', async () => {
    await render({
      loadParticipants: async () => ({
        ok: true,
        participants: [
          participant({ id: 'p-1', accessGranted: true, materialAccessGranted: false }),
          participant({ id: 'p-2', displayName: 'Grace Hopper', accessGranted: false, materialAccessGranted: true }),
        ],
      }),
    })
    expect(testId('participant-material-status-p-1').textContent).toContain('not shared')
    expect(testId('participant-material-status-p-2').textContent).toContain('Material shared')
    expect(testId('participant-row-p-1').textContent).toContain('On the calendar invite')
    expect(testId('participant-row-p-2').textContent).toContain('Not on the calendar invite')
  })
})

describe('InterviewParticipantsPanel — sharing asks for confirmation, revoking does not', () => {
  it('sharing requires an explicit confirm click before the PATCH fires', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: true as const, participant: participant({ materialAccessGranted: true }) }))
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: false })] }),
      setMaterialAccess,
    })

    await click(testId('participant-toggle-p-1'))
    expect(setMaterialAccess).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('Share the brief, report, and transcript?')

    await click(testId('participant-confirm-share-p-1'))
    expect(setMaterialAccess).toHaveBeenCalledWith('evt-1', 'p-1', true)
  })

  it('cancelling the confirmation never calls the network', async () => {
    const setMaterialAccess = vi.fn()
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: false })] }),
      setMaterialAccess,
    })
    await click(testId('participant-toggle-p-1'))
    await click(Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!)
    expect(setMaterialAccess).not.toHaveBeenCalled()
    expect(maybeTestId('participant-confirm-share-p-1')).toBeNull()
  })

  it('revoking fires immediately, with no confirmation step', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: true as const, participant: participant({ materialAccessGranted: false }) }))
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: true })] }),
      setMaterialAccess,
    })

    await click(testId('participant-toggle-p-1'))
    expect(setMaterialAccess).toHaveBeenCalledWith('evt-1', 'p-1', false)
  })
})

describe('InterviewParticipantsPanel — every mutation failure fails closed', () => {
  it('a 403 on the PATCH leaves the row exactly as it was loaded', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: false as const, status: 403 }))
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: true })] }),
      setMaterialAccess,
    })
    await click(testId('participant-toggle-p-1'))
    expect(testId('participants-panel-action-error').textContent).toContain('interview owner')
    expect(testId('participant-material-status-p-1').textContent).toContain('Material shared')
  })

  it('a 404 on the PATCH (participant removed since load) reports it without crashing', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: false as const, status: 404 }))
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: true })] }),
      setMaterialAccess,
    })
    await click(testId('participant-toggle-p-1'))
    expect(testId('participants-panel-action-error').textContent).toContain('no longer on the interview')
  })

  it('a 429 rate-limit response is reported and the row is unchanged', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: false as const, status: 429 }))
    await render({
      loadParticipants: async () => ({ ok: true, participants: [participant({ materialAccessGranted: false })] }),
      setMaterialAccess,
    })
    await click(testId('participant-toggle-p-1'))
    await click(testId('participant-confirm-share-p-1'))
    expect(testId('participants-panel-action-error').textContent).toContain('Too many changes')
    expect(testId('participant-material-status-p-1').textContent).toContain('not shared')
  })

  it('a real success updates only the affected row and shows a confirmation', async () => {
    const setMaterialAccess = vi.fn(async () => ({ ok: true as const, participant: participant({ id: 'p-1', materialAccessGranted: true }) }))
    await render({
      loadParticipants: async () => ({
        ok: true,
        participants: [participant({ id: 'p-1', materialAccessGranted: false }), participant({ id: 'p-2', displayName: 'Other', materialAccessGranted: false })],
      }),
      setMaterialAccess,
    })
    await click(testId('participant-toggle-p-1'))
    await click(testId('participant-confirm-share-p-1'))

    expect(testId('participant-material-status-p-1').textContent).toContain('Material shared')
    expect(testId('participant-material-status-p-2').textContent).toContain('not shared')
    expect(testId('participant-confirmed-p-1')).toBeTruthy()
  })
})
