import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CalendarPage } from '~/modules/calendar/components/CalendarPage'

/**
 * Calendar layer UI (plan: calendar-scheduling-interview-intelligence, Phase 4 "Add calendar layer
 * UI").
 *
 * The behaviour worth testing here is not that items render — it is that a projection cannot be
 * mistaken for something editable, and that toggling a layer actually changes what is requested
 * rather than only filtering client-side (which would keep paying for data the user turned off).
 */

const TODAY = new Date('2027-07-15T00:00:00.000Z')

function eventItem(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'event' as const,
    editable: true as const,
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Standup',
    startsAt: '2027-07-16T09:00:00.000Z',
    endsAt: '2027-07-16T09:30:00.000Z',
    type: 'personal',
    status: 'scheduled',
    allDay: false,
    busy: true,
    version: 1,
    location: null,
    meetingUrl: null,
    description: null,
    ...overrides,
  }
}

function jobProjection(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'job_projection' as const,
    editable: false as const,
    estimateOnly: true,
    title: 'Calendar reminder delivery',
    startsAt: '2027-07-17T10:00:00.000Z',
    endsAt: '2027-07-17T10:01:00.000Z',
    sourceType: 'operational_schedule',
    sourceId: 'calendar.reminder-delivery',
    safeSourceRoute: '/api/admin/calendar/run-reminders',
    ...overrides,
  }
}

function jobRun(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'job_run' as const,
    editable: false as const,
    estimateOnly: false,
    state: 'succeeded',
    title: 'Sprint execution',
    startsAt: '2027-07-14T08:00:00.000Z',
    endsAt: '2027-07-14T08:02:00.000Z',
    sourceType: 'job_run',
    sourceId: 'run-1',
    safeSourceRoute: '/api/admin/sprints/run-worker',
    ...overrides,
  }
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

/** Matches the codebase's raw `react-dom/client` + `act` style; there is no testing-library here. */
async function renderPage(items: unknown[], staleSources: string[] = []) {
  // Typed with the real signature so the layer-argument assertions below are checked, not `any`.
  const fetchFeed = vi.fn(
    async (_range: { from: string; to: string }, _layers: string[]) => ({ items: items as never, staleSources }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<CalendarPage today={TODAY} fetchFeed={fetchFeed} />)
  })
  await flush()
  return { fetchFeed }
}

/** Lets the fetch promise chain and React's scheduler settle before assertions run. */
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

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
  await flush()
}

describe('CalendarPage — projections are visibly not editable', () => {
  it('gives an event a delete control and a projection none', async () => {
    await renderPage([eventItem(), jobProjection()])

    testId('calendar-event-11111111-1111-4111-8111-111111111111')

    // The event can be removed from the grid.
    expect(testId('calendar-delete-11111111-1111-4111-8111-111111111111')).toBeTruthy()
    // The projection has no destructive control at all — not a disabled one, which would invite the
    // user to wonder what unlocks it.
    const projection = testId('calendar-projection-job_projection')
    expect(projection.querySelectorAll('button')).toHaveLength(0)
  })

  it('names the read-only constraint in text, not only in styling', async () => {
    await renderPage([jobProjection()])

    const projection = testId('calendar-projection-job_projection')

    // Readable by a screen reader and in a printout, where a dashed border conveys nothing.
    expect(projection.getAttribute('aria-label')).toContain('read-only')
    expect(projection.textContent).toContain('(estimate)')
  })

  it('labels a completed run without the estimate qualifier', async () => {
    await renderPage([jobRun()])

    const run = testId('calendar-projection-job_run')
    expect(run.textContent).not.toContain('(estimate)')
  })

  it('opens a read-only detail panel that offers no edit affordance', async () => {
    await renderPage([jobProjection()])

    await click(testId('calendar-projection-job_projection'))

    const panel = testId('projection-details')
    expect(testId('projection-readonly-note').textContent).toContain('cannot move or edit')
    expect(testId('projection-source-link').getAttribute('href')).toBe('/api/admin/calendar/run-reminders')
    // "Expected at", not "Happened at" — the label carries the estimate/record distinction.
    expect(panel.textContent).toContain('Expected at')
    expect(testId('projection-estimate-note').textContent).toContain('not a promise')
  })

  it('shows a completed run as a record, not an estimate', async () => {
    await renderPage([jobRun()])

    await click(testId('calendar-projection-job_run'))

    const panel = testId('projection-details')
    expect(panel.textContent).toContain('Happened at')
    expect(maybeTestId('projection-estimate-note')).toBeNull()
    expect(testId('projection-state').textContent).toBe('succeeded')
  })
})

describe('CalendarPage — layer toggles', () => {
  it('requests only the layers that are on', async () => {
    const { fetchFeed } = await renderPage([eventItem(), jobProjection()])

    expect(fetchFeed).toHaveBeenCalled()
    expect(fetchFeed.mock.calls[0]?.[1]).toEqual(['events', 'jobs', 'alerts'])

    await click(testId('calendar-layer-jobs'))

    // Refetched without `jobs`, rather than filtered client-side: filtering locally would keep
    // paying for data the user explicitly turned off.
    expect(fetchFeed.mock.calls.length).toBeGreaterThan(1)
    expect(fetchFeed.mock.calls.at(-1)?.[1]).toEqual(['events', 'alerts'])
  })

  it('announces each toggle\'s pressed state on the control itself', async () => {
    await renderPage([])

    const jobsToggle = testId('calendar-layer-jobs')
    expect(jobsToggle.getAttribute('aria-pressed')).toBe('true')

    await click(jobsToggle)
    expect(testId('calendar-layer-jobs').getAttribute('aria-pressed')).toBe('false')
  })

  it('does not rely on colour alone for toggle state', async () => {
    await renderPage([])

    const jobsToggle = testId('calendar-layer-jobs')
    // A visible glyph as well as a colour change, so the state survives greyscale.
    expect(jobsToggle.textContent).toContain('✓')

    await click(jobsToggle)
    expect(testId('calendar-layer-jobs').textContent).toContain('+')
  })

  it('closes an open detail panel when the layers change', async () => {
    await renderPage([jobProjection()])

    await click(testId('calendar-projection-job_projection'))
    expect(testId('projection-details')).toBeTruthy()

    await click(testId('calendar-layer-alerts'))

    // A panel describing an item the new filter no longer includes reads as a bug.
    expect(maybeTestId('projection-details')).toBeNull()
  })

  it('distinguishes "no layers on" from "nothing scheduled"', async () => {
    await renderPage([])

    for (const layer of ['events', 'jobs', 'alerts']) {
      await click(testId(`calendar-layer-${layer}`))
    }

    // Saying "nothing scheduled" here would look like the user's data had disappeared.
    expect(testId('calendar-empty').textContent).toContain('No layers selected')
  })
})

describe('CalendarPage — multi-view shell (plans/UI Wave 3)', () => {
  it('defaults to month view and fetches a bounded range spanning the whole 6-week grid', async () => {
    const { fetchFeed } = await renderPage([])
    const [range] = fetchFeed.mock.calls[0]
    // The 6-week grid for July 2027 starts Mon 2027-06-28 and ends Sun 2027-08-08 (exclusive).
    expect(range.from.slice(0, 10)).toBe('2027-06-28')
    expect(range.to.slice(0, 10)).toBe('2027-08-09')
  })

  it('switching to week view requests a 7-day range containing the active date', async () => {
    const { fetchFeed } = await renderPage([])
    await click(testId('calendar-view-week'))
    const range = fetchFeed.mock.calls.at(-1)![0]
    const spanDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / (24 * 60 * 60 * 1000)
    expect(spanDays).toBe(7)
    // 2027-07-15 is a Thursday; the week starts Monday 2027-07-12.
    expect(range.from.slice(0, 10)).toBe('2027-07-12')
  })

  it('switching to day view requests exactly one day', async () => {
    const { fetchFeed } = await renderPage([])
    await click(testId('calendar-view-day'))
    const range = fetchFeed.mock.calls.at(-1)![0]
    expect(range.from.slice(0, 10)).toBe('2027-07-15')
    expect(range.to.slice(0, 10)).toBe('2027-07-16')
  })

  it('switching to list view requests a bounded rolling window, not an unbounded one', async () => {
    const { fetchFeed } = await renderPage([])
    await click(testId('calendar-view-list'))
    const range = fetchFeed.mock.calls.at(-1)![0]
    const spanDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / (24 * 60 * 60 * 1000)
    expect(spanDays).toBe(30)
  })

  it('"Today" returns the active date to the fixed `today` regardless of how far navigation moved', async () => {
    const { fetchFeed } = await renderPage([])
    await click(testId('calendar-next'))
    await click(testId('calendar-next'))
    await click(testId('calendar-today'))
    const range = fetchFeed.mock.calls.at(-1)![0]
    expect(range.from.slice(0, 10)).toBe('2027-06-28') // back to July 2027's own grid start
  })

  it('filters visible items by title client-side without re-fetching', async () => {
    const { fetchFeed } = await renderPage([eventItem({ title: 'Rust standup' }), eventItem({ id: 'evt-2', title: 'Design review' })])
    const callsBeforeSearch = fetchFeed.mock.calls.length

    const search = testId('calendar-search-input') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(search, 'rust')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    expect(fetchFeed.mock.calls.length).toBe(callsBeforeSearch) // no network cost for a client-side filter
    expect(testId('calendar-event-11111111-1111-4111-8111-111111111111')).toBeTruthy()
    expect(maybeTestId('calendar-event-evt-2')).toBeNull()
  })

  it('is controllable: an external view/date/query prop drives rendering and onChange fires instead of internal state', async () => {
    const fetchFeed = vi.fn(async () => ({ items: [], staleSources: [] }))
    const onViewChange = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <CalendarPage today={TODAY} fetchFeed={fetchFeed} view="week" onViewChange={onViewChange} />,
      )
    })
    await flush()

    expect(testId('calendar-view-week').getAttribute('aria-selected')).toBe('true')
    await click(testId('calendar-view-day'))
    expect(onViewChange).toHaveBeenCalledWith('day')
    // Controlled: clicking did not flip the rendered tab locally, since the parent owns `view`.
    expect(testId('calendar-view-week').getAttribute('aria-selected')).toBe('true')
  })
})

describe('CalendarPage — deep-link an event (plans/UI Wave 3 "Connect booked scheduling to Calendar and Interviews")', () => {
  it('fetches the event directly, jumps the active date to where it lives, opens its detail panel, and reports it consumed exactly once', async () => {
    const fetchFeed = vi.fn(async () => ({ items: [], staleSources: [] }))
    const loadEventById = vi.fn(async (id: string) => ({
      event: eventItem({ id, title: 'Booked interview', startsAt: '2027-09-03T14:00:00.000Z', endsAt: '2027-09-03T15:00:00.000Z', type: 'interview' }),
      detail: { rrule: null, recurrenceUntil: null, participants: [] },
    }))
    const onEventConsumed = vi.fn()
    const onDateChange = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <CalendarPage
          today={TODAY}
          fetchFeed={fetchFeed}
          eventId="deep-linked-event"
          loadEventById={loadEventById}
          onEventConsumed={onEventConsumed}
          onDateChange={onDateChange}
        />,
      )
    })
    await flush()

    expect(loadEventById).toHaveBeenCalledWith('deep-linked-event')
    expect(onDateChange).toHaveBeenCalledWith(new Date('2027-09-03T00:00:00.000Z'))
    expect(testId('event-details-title').textContent).toBe('Booked interview')
    expect(onEventConsumed).toHaveBeenCalledTimes(1)

    // Re-rendering with the same eventId (the route hasn't cleared it from the URL yet, say) must
    // not fetch or report consumption a second time.
    await act(async () => {
      root!.render(
        <CalendarPage
          today={TODAY}
          fetchFeed={fetchFeed}
          eventId="deep-linked-event"
          loadEventById={loadEventById}
          onEventConsumed={onEventConsumed}
          onDateChange={onDateChange}
        />,
      )
    })
    await flush()
    expect(loadEventById).toHaveBeenCalledTimes(1)
    expect(onEventConsumed).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the deep-linked event no longer exists or is not visible to the caller', async () => {
    const fetchFeed = vi.fn(async () => ({ items: [], staleSources: [] }))
    const loadEventById = vi.fn(async () => null)
    const onEventConsumed = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <CalendarPage today={TODAY} fetchFeed={fetchFeed} eventId="gone" loadEventById={loadEventById} onEventConsumed={onEventConsumed} />,
      )
    })
    await flush()

    expect(onEventConsumed).toHaveBeenCalledTimes(1)
    expect(maybeTestId('event-details')).toBeNull()
  })
})

describe('CalendarPage — stale sources', () => {
  it('warns in plain language and names the source', async () => {
    await renderPage([], ['calendar.reminder-delivery'])

    const warning = testId('calendar-stale-warning')
    expect(warning.textContent).toContain('may be wrong')
    // The raw key is shown because it is what an operator would search for.
    expect(warning.textContent).toContain('calendar.reminder-delivery')
  })

  it('says nothing when every source is current', async () => {
    await renderPage([eventItem()])

    testId('calendar-layers')
    expect(maybeTestId('calendar-stale-warning')).toBeNull()
  })
})
