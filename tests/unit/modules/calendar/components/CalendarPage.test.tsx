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
