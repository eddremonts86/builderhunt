import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EventEditor,
  type EventEditorProps,
} from '~/modules/calendar/components/EventEditor'

/**
 * `EventEditor` — the create/edit form for calendar events (plans/UI Wave 3 "Build complete event
 * create, detail, and edit UI").
 *
 * The behaviour worth pinning is not that inputs render — it is that the emitted payload matches the
 * `/api/calendar/events` create/patch contract exactly, and that every server error the route can
 * return (`overlap_warning`, `state_changed`, `not_implemented`, `slot_unavailable`) reaches the
 * user as a distinct, actionable message rather than a generic failure. Uses the codebase's raw
 * `react-dom/client` + `act` style; there is no testing-library here, and every control is a native
 * element so it is reachable without a portal-aware harness.
 */

type SubmitFn = EventEditorProps['onSubmit']

function submitOk() {
  return vi.fn<SubmitFn>(async () => ({ ok: true }))
}

function submitErr(error: string) {
  return vi.fn<SubmitFn>(async () => ({ ok: false, error }))
}

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

const DEFAULT_DATE = new Date('2027-07-15T00:00:00.000Z')

function renderEditor(props: Partial<EventEditorProps> = {}) {
  const onSubmit = props.onSubmit ?? submitOk()
  const onCancel = props.onCancel ?? vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <EventEditor
        mode={props.mode ?? 'create'}
        defaultTimezone={props.defaultTimezone ?? 'UTC'}
        timezoneOptions={props.timezoneOptions ?? ['UTC', 'America/New_York']}
        defaultDate={props.defaultDate ?? DEFAULT_DATE}
        initial={props.initial}
        isRecurring={props.isRecurring}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )
  })
  return { onSubmit, onCancel }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
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

async function setValue(id: string, value: string) {
  const el = testId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  const proto = el instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

async function click(id: string) {
  await act(async () => {
    testId(id).click()
  })
  await flush()
}

async function submit() {
  const form = testId('event-editor') as HTMLFormElement
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

describe('EventEditor — create mode', () => {
  it('renders the core scheduling fields and both primary actions', () => {
    renderEditor({ mode: 'create' })
    testId('event-editor-type')
    testId('event-editor-title')
    testId('event-editor-all-day')
    testId('event-editor-date')
    testId('event-editor-start')
    testId('event-editor-end')
    testId('event-editor-timezone')
    testId('event-editor-location')
    testId('event-editor-meeting-url')
    testId('event-editor-busy')
    testId('event-editor-description')
    testId('event-editor-add-reminder')
    testId('event-editor-add-participant')
    testId('event-editor-repeat')
    testId('event-editor-submit')
    testId('event-editor-cancel')
  })

  it('emits a create payload matching the timed-event contract', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Weekly sync')
    await submit()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [value, meta] = onSubmit.mock.calls[0]
    expect(value.type).toBe('personal')
    expect(value.title).toBe('Weekly sync')
    expect(value.startsAt).toBe('2027-07-15T09:00:00.000Z')
    expect(value.endsAt).toBe('2027-07-15T09:30:00.000Z')
    expect(value.timezone).toBe('UTC')
    expect(value.allDay).toBe(false)
    expect(value.busy).toBe(true)
    expect(value.reminders).toEqual([{ channel: 'in_app', offsetMinutes: 30 }])
    expect(value.participants).toEqual([])
    expect(value.rrule).toBeNull()
    expect(value.recurrenceUntil).toBeNull()
    expect(meta.acknowledgeOverlapWarning).toBe(false)
  })

  it('collapses the time inputs and spans the whole day when All day is checked', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Conference')
    await click('event-editor-all-day')

    expect(maybeTestId('event-editor-start')).toBeNull()
    expect(maybeTestId('event-editor-end')).toBeNull()

    await submit()
    const [value] = onSubmit.mock.calls[0]
    expect(value.allDay).toBe(true)
    expect(value.startsAt).toBe('2027-07-15T00:00:00.000Z')
    expect(value.endsAt).toBe('2027-07-16T00:00:00.000Z')
  })

  it('carries a free/busy choice and a private note into the payload', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Focus block')
    await setValue('event-editor-busy', 'free')
    await setValue('event-editor-description', 'no meetings')
    await setValue('event-editor-meeting-url', 'https://meet.example.com/x')
    await setValue('event-editor-location', 'Room 4')
    await submit()

    const [value] = onSubmit.mock.calls[0]
    expect(value.busy).toBe(false)
    expect(value.description).toBe('no meetings')
    expect(value.meetingUrl).toBe('https://meet.example.com/x')
    expect(value.location).toBe('Room 4')
  })

  it('lets the user replace the default reminder with an email channel', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Interview')
    await setValue('event-editor-reminder-channel-0', 'email')
    await setValue('event-editor-reminder-offset-0', '60')
    await submit()

    const [value] = onSubmit.mock.calls[0]
    expect(value.reminders).toEqual([{ channel: 'email', offsetMinutes: 60 }])
  })

  it('drops a reminder row when removed, emitting no reminders', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Quiet event')
    await click('event-editor-reminder-remove-0')
    await submit()

    const [value] = onSubmit.mock.calls[0]
    expect(value.reminders).toEqual([])
  })

  it('adds a participant with an external email and role', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Panel')
    await click('event-editor-add-participant')
    await setValue('event-editor-participant-name-0', 'Dana')
    await setValue('event-editor-participant-email-0', 'dana@example.com')
    await setValue('event-editor-participant-role-0', 'organizer')
    await submit()

    const [value] = onSubmit.mock.calls[0]
    expect(value.participants).toEqual([
      { displayName: 'Dana', externalEmail: 'dana@example.com', role: 'organizer' },
    ])
  })

  it('builds a bounded recurrence rule with interval and until', async () => {
    const onSubmit = submitOk()
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Standup')
    await setValue('event-editor-repeat', 'weekly')
    await setValue('event-editor-interval', '2')
    await setValue('event-editor-until', '2027-09-01')
    await submit()

    const [value] = onSubmit.mock.calls[0]
    expect(value.rrule).toBe('FREQ=WEEKLY;INTERVAL=2')
    expect(value.recurrenceUntil).toBe('2027-09-01T23:59:59.000Z')
  })
})

describe('EventEditor — server error branches', () => {
  it('surfaces an overlap warning and re-submits with acknowledgement on Save anyway', async () => {
    const onSubmit = vi
      .fn<SubmitFn>()
      .mockResolvedValueOnce({ ok: false, error: 'overlap_warning' })
      .mockResolvedValueOnce({ ok: true })
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Overlapping')
    await submit()

    expect(testId('event-editor-overlap-warning').textContent).toContain('overlaps')
    expect(onSubmit.mock.calls[0][1].acknowledgeOverlapWarning).toBe(false)

    await click('event-editor-save-anyway')
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1][1].acknowledgeOverlapWarning).toBe(true)
  })

  it('explains a version conflict distinctly from a plain failure', async () => {
    const onSubmit = submitErr('state_changed')
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Stale')
    await submit()

    expect(testId('event-editor-error').textContent).toContain('changed since you opened it')
  })

  it('names a hard booking conflict as a time conflict', async () => {
    const onSubmit = submitErr('slot_unavailable')
    renderEditor({ mode: 'create', onSubmit })
    await setValue('event-editor-title', 'Clash')
    await submit()

    expect(testId('event-editor-error').textContent).toContain('conflicts with an existing booking')
  })
})

describe('EventEditor — edit mode', () => {
  it('prefills from the event and hides create-only sections', () => {
    renderEditor({
      mode: 'edit',
      initial: {
        title: 'Existing',
        startsAt: '2027-07-20T14:00:00.000Z',
        endsAt: '2027-07-20T15:00:00.000Z',
        timezone: 'America/New_York',
        busy: false,
        version: 3,
      },
    })
    expect((testId('event-editor-title') as HTMLInputElement).value).toBe('Existing')
    expect((testId('event-editor-date') as HTMLInputElement).value).toBe('2027-07-20')
    expect((testId('event-editor-start') as HTMLInputElement).value).toBe('14:00')
    // Reminders, participants, recurrence, and the type selector are create-only: the PATCH route
    // has no field for them, so exposing an editable control would silently discard the input.
    expect(maybeTestId('event-editor-add-reminder')).toBeNull()
    expect(maybeTestId('event-editor-add-participant')).toBeNull()
    expect(maybeTestId('event-editor-repeat')).toBeNull()
    expect(maybeTestId('event-editor-type')).toBeNull()
  })

  it('applies a recurring edit to the whole series, the only supported scope', async () => {
    const onSubmit = submitOk()
    renderEditor({
      mode: 'edit',
      isRecurring: true,
      initial: {
        title: 'Series',
        startsAt: '2027-07-20T14:00:00.000Z',
        endsAt: '2027-07-20T15:00:00.000Z',
        version: 2,
      },
      onSubmit,
    })
    expect(testId('event-editor-series-note').textContent).toContain('whole series')

    await setValue('event-editor-title', 'Series renamed')
    await submit()
    expect(onSubmit.mock.calls[0][1].recurrenceScope).toBe('series')
  })

  it('explains that editing a single occurrence is not supported yet', async () => {
    const onSubmit = submitErr('not_implemented')
    renderEditor({
      mode: 'edit',
      isRecurring: true,
      initial: { title: 'Series', startsAt: '2027-07-20T14:00:00.000Z', endsAt: '2027-07-20T15:00:00.000Z', version: 2 },
      onSubmit,
    })
    await submit()
    expect(testId('event-editor-error').textContent).toContain('single occurrence')
  })
})
