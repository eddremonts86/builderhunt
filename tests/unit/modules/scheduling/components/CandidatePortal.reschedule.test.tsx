import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CandidatePortal } from '~/modules/scheduling/components/CandidatePortal'

/**
 * `CandidatePortal` — atomic rescheduling (plans/UI Wave 3 "Implement atomic candidate
 * rescheduling").
 *
 * What matters is not that the new-time picker renders — it is that `booking` in this component's
 * own state is never cleared until `/reschedule` has actually returned 200. The old flow cancelled
 * first and booked second, so any failure of the second request left the candidate holding nothing;
 * these tests exist to prove a 409, a validation failure, and a generic server error all leave the
 * original confirmed time exactly as it was, on screen and in state, and that only a real success
 * moves it — exactly once.
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

const ORIGINAL_BOOKING = {
  eventId: 'evt-original',
  startsAt: '2027-08-10T14:00:00.000Z',
  endsAt: '2027-08-10T14:45:00.000Z',
  timezone: 'UTC',
}

const INVITATION_DTO = {
  id: 'inv-1',
  roleTitle: 'Staff engineer',
  roleContext: 'Backend platform team',
  durationMinutes: 45,
  timezone: 'UTC',
  modality: 'remote',
  meetingUrl: null,
  location: null,
  status: 'booked',
  policyVersion: 'v1',
  noticeVersion: 'v1',
  requiredPurposes: [],
  consents: [],
}

const SLOT_A = { slotId: 'slot-a', startsAt: '2027-08-12T10:00:00.000Z', endsAt: '2027-08-12T10:45:00.000Z' }
const SLOT_B = { slotId: 'slot-b', startsAt: '2027-08-13T11:00:00.000Z', endsAt: '2027-08-13T11:45:00.000Z' }

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Routes each call by path suffix + method, matching the base URL `/api/public/scheduling/inv-1`. */
function makeFetcher(overrides: { reschedule?: () => Response | Promise<Response> } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.endsWith('/inv-1') && method === 'GET') return jsonResponse(200, INVITATION_DTO)
    if (url.includes('/slots') && method === 'GET') return jsonResponse(200, { slots: [SLOT_A, SLOT_B] })
    if (url.endsWith('/reschedule') && method === 'POST') {
      return overrides.reschedule ? overrides.reschedule() : jsonResponse(200, { ...ORIGINAL_BOOKING, eventId: 'evt-new' })
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  }) as unknown as typeof fetch
}

async function render(fetcher: typeof fetch) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<CandidatePortal invitationId="inv-1" fetcher={fetcher} initialSecret={null} />)
  })
  await flush()
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function pickFirstSlot(): HTMLElement {
  // SlotPicker renders one <ul> of slot buttons; nothing else on this screen uses a <ul>.
  const slotButton = container!.querySelector('ul button')
  if (!slotButton) throw new Error('no slot button found')
  return slotButton as HTMLElement
}

function textButton(label: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`missing button "${label}"`)
  return button as HTMLButtonElement
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
  await flush()
}

describe('CandidatePortal — atomic reschedule', () => {
  it('opens the new-time picker without cancelling the existing booking', async () => {
    const fetcher = makeFetcher()
    await render(fetcher)

    expect(container!.textContent).toContain('Your interview is confirmed')
    await click(textButton('Choose a different time'))

    // No /cancel call was ever made — only invitation, then slots.
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining('/cancel'), expect.anything())
    expect(container!.textContent).toContain('Choose a new time')
    expect(container!.textContent).toContain('current time stays booked')
  })

  it('moves the booking exactly once on a real success', async () => {
    const fetcher = makeFetcher()
    await render(fetcher)
    await click(textButton('Choose a different time'))

    await click(pickFirstSlot())
    await click(textButton('Confirm new time'))

    const rescheduleCalls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => {
        const [url, init] = call as [string, RequestInit | undefined]
        return url.endsWith('/reschedule') && init?.method === 'POST'
      })
    expect(rescheduleCalls).toHaveLength(1)
    expect(container!.textContent).toContain('Your interview is confirmed')
  })

  it('a 409 conflict preserves the original booking and shows the refreshed alternatives', async () => {
    const fetcher = makeFetcher({
      reschedule: () => jsonResponse(409, { alternatives: [SLOT_B] }),
    })
    await render(fetcher)
    await click(textButton('Choose a different time'))
    await click(pickFirstSlot())
    await click(textButton('Confirm new time'))

    // Still on the reschedule screen — the original time was never touched.
    expect(container!.textContent).toContain('That time was just taken')
    expect(container!.textContent).not.toContain('Your interview is confirmed')

    // Backing out must still show the untouched original booking.
    await click(textButton('Keep my current time'))
    expect(container!.textContent).toContain('Your interview is confirmed')
  })

  it('a generic server failure (offline/rate-limited/5xx) leaves the original booking intact and never calls /cancel', async () => {
    const fetcher = makeFetcher({ reschedule: () => jsonResponse(500, {}) })
    await render(fetcher)
    await click(textButton('Choose a different time'))
    await click(pickFirstSlot())
    await click(textButton('Confirm new time'))

    expect(container!.textContent).toContain('Your original time is still booked')
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining('/cancel'), expect.anything())

    await click(textButton('Keep my current time'))
    expect(container!.textContent).toContain('Your interview is confirmed')
  })

  it('a stale-token failure (422) is reported without silently discarding the booking', async () => {
    const fetcher = makeFetcher({ reschedule: () => jsonResponse(422, {}) })
    await render(fetcher)
    await click(textButton('Choose a different time'))
    await click(pickFirstSlot())
    await click(textButton('Confirm new time'))

    expect(container!.textContent).toContain('agreement is missing')
    await click(textButton('Keep my current time'))
    expect(container!.textContent).toContain('Your interview is confirmed')
  })
})
