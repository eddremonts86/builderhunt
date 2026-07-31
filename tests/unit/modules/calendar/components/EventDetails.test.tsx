import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EventDetails,
  type EventDetailsProps,
  type EventDetailView,
} from '~/modules/calendar/components/EventDetails'
import type { CalendarEventDto } from '~/modules/calendar/components/CalendarView'

/**
 * `EventDetails` — the read view and action hub for a selected editable event (plans/UI Wave 3
 * "Build complete event create, detail, and edit UI").
 *
 * What matters: a meeting link is only clickable when it is a real `http(s)` URL (rows predating the
 * URL-safety tightening are still in the database), the cancel action disappears once an event is
 * already cancelled, and deleting a recurring event forces a scope choice rather than guessing.
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
  vi.restoreAllMocks()
})

function eventDto(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    kind: 'event',
    editable: true,
    id: 'evt-1',
    title: 'Sync',
    startsAt: '2027-07-15T09:00:00.000Z',
    endsAt: '2027-07-15T09:30:00.000Z',
    type: 'personal',
    status: 'scheduled',
    allDay: false,
    busy: true,
    version: 2,
    location: null,
    meetingUrl: null,
    description: null,
    ...overrides,
  }
}

function render(props: Partial<EventDetailsProps> & { event: CalendarEventDto }) {
  const merged: EventDetailsProps = {
    event: props.event,
    detail: props.detail,
    loadingDetail: props.loadingDetail,
    actionError: props.actionError,
    busy: props.busy,
    onEdit: props.onEdit ?? vi.fn(),
    onCancelEvent: props.onCancelEvent ?? vi.fn(),
    onDelete: props.onDelete ?? vi.fn(),
    onClose: props.onClose ?? vi.fn(),
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<EventDetails {...merged} />)
  })
  return merged
}

function testId(id: string): HTMLElement {
  const node = container!.querySelector(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing [data-testid="${id}"]`)
  return node as HTMLElement
}

function maybeTestId(id: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
}

function click(id: string) {
  act(() => {
    testId(id).click()
  })
}

async function setSelect(id: string, value: string) {
  const el = testId(id) as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('EventDetails — read view', () => {
  it('shows the title, time, status, busy state, location and notes', () => {
    render({ event: eventDto({ location: 'Room 1', description: 'bring the deck' }) })
    expect(testId('event-details-title').textContent).toContain('Sync')
    expect(testId('event-details-when').textContent).toContain('2027')
    expect(testId('event-details-status').textContent?.toLowerCase()).toContain('scheduled')
    expect(testId('event-details-busy').textContent?.toLowerCase()).toContain('busy')
    expect(testId('event-details-location').textContent).toContain('Room 1')
    expect(testId('event-details-description').textContent).toContain('bring the deck')
  })

  it('labels an all-day event without a time range', () => {
    render({ event: eventDto({ allDay: true }) })
    expect(testId('event-details-when').textContent?.toLowerCase()).toContain('all day')
  })

  it('renders a safe meeting link and refuses an unsafe one', () => {
    render({ event: eventDto({ meetingUrl: 'https://meet.example.com/a' }) })
    expect(testId('event-details-meeting-link').getAttribute('href')).toBe('https://meet.example.com/a')

    if (root) act(() => root!.unmount())
    container?.remove()
    render({ event: eventDto({ meetingUrl: 'javascript:alert(1)' }) })
    expect(maybeTestId('event-details-meeting-link')).toBeNull()
  })

  it('lists participants with their role and response from the loaded detail', () => {
    const detail: EventDetailView = {
      participants: [
        { id: 'p1', displayName: 'Dana', externalEmail: null, role: 'organizer', response: 'accepted', materialAccessGranted: true },
      ],
      rrule: null,
      recurrenceUntil: null,
    }
    render({ event: eventDto(), detail })
    const participant = testId('event-details-participant-p1')
    expect(participant.textContent).toContain('Dana')
    expect(participant.textContent?.toLowerCase()).toContain('organizer')
    expect(participant.textContent?.toLowerCase()).toContain('accepted')
  })

  it('shows a loading placeholder while the detail is still being fetched', () => {
    render({ event: eventDto(), loadingDetail: true })
    expect(testId('event-details-loading')).toBeTruthy()
  })
})

describe('EventDetails — actions', () => {
  it('wires edit, cancel, delete and close to their callbacks', () => {
    const onEdit = vi.fn()
    const onCancelEvent = vi.fn()
    const onDelete = vi.fn()
    const onClose = vi.fn()
    render({ event: eventDto(), onEdit, onCancelEvent, onDelete, onClose })

    click('event-details-edit')
    expect(onEdit).toHaveBeenCalledTimes(1)
    click('event-details-cancel-event')
    expect(onCancelEvent).toHaveBeenCalledTimes(1)
    click('event-details-delete')
    // A non-recurring event needs no scope.
    expect(onDelete).toHaveBeenCalledWith(undefined)
    click('event-details-close')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides the cancel action once the event is already cancelled', () => {
    render({ event: eventDto({ status: 'cancelled' }) })
    expect(maybeTestId('event-details-cancel-event')).toBeNull()
  })

  it('forces a scope choice when deleting a recurring event', async () => {
    const onDelete = vi.fn()
    const detail: EventDetailView = { participants: [], rrule: 'FREQ=WEEKLY;INTERVAL=1', recurrenceUntil: null }
    render({ event: eventDto(), detail, onDelete })

    expect(testId('event-details-recurrence')).toBeTruthy()
    await setSelect('event-details-delete-scope', 'following')
    click('event-details-delete')
    expect(onDelete).toHaveBeenCalledWith('following')
  })

  it('surfaces an action error such as a version conflict', () => {
    render({ event: eventDto(), actionError: 'This event changed since you opened it.' })
    expect(testId('event-details-error').textContent).toContain('changed since you opened it')
  })
})
