import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CalendarView, type CalendarEventDto, type CalendarFeedItemDto } from '~/modules/calendar/components/CalendarView'
import type { ProjectionItem } from '~/modules/calendar/components/ProjectionDetails'

/**
 * `CalendarView` — the grid shared by the month, week, and day views (plans/UI Wave 3 "Extract a
 * route-driven multi-view Calendar shell"). Extracted verbatim from the pre-existing month grid so
 * it can be reused at a different day count/column width without re-deriving its accessibility
 * contract (dashed border + lock icon + `aria-label` for read-only projections, a real delete
 * button for events).
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

function eventItem(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    kind: 'event',
    editable: true,
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

function projectionItem(overrides: Partial<ProjectionItem> = {}): ProjectionItem & { editable: false } {
  return {
    kind: 'job_projection',
    editable: false,
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

function itemsByDay(items: CalendarFeedItemDto[]): Map<string, CalendarFeedItemDto[]> {
  const map = new Map<string, CalendarFeedItemDto[]>()
  for (const item of items) {
    const key = item.startsAt.slice(0, 10)
    map.set(key, [...(map.get(key) ?? []), item])
  }
  return map
}

function days(...isoDays: string[]): Date[] {
  return isoDays.map((d) => new Date(`${d}T00:00:00.000Z`))
}

function render(props: Partial<Parameters<typeof CalendarView>[0]> & { days: Date[] }) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <CalendarView
        columns={props.columns ?? props.days.length}
        weekdayLabels={props.weekdayLabels ?? props.days.map(() => '')}
        itemsByDay={props.itemsByDay ?? new Map()}
        isDimmed={props.isDimmed}
        viewLabel={props.viewLabel ?? 'Test view'}
        onDelete={props.onDelete ?? vi.fn()}
        onSelectProjection={props.onSelectProjection ?? vi.fn()}
        days={props.days}
      />,
    )
  })
}

function testId(id: string): HTMLElement {
  const node = container!.querySelector(`[data-testid="${id}"]`)
  if (!node) throw new Error(`missing [data-testid="${id}"]`)
  return node as HTMLElement
}

describe('CalendarView — reused across month/week/day', () => {
  it('renders one grid cell per day and labels the grid with the view name', () => {
    render({ days: days('2027-07-16', '2027-07-17'), viewLabel: 'Week view' })
    testId('calendar-day-2027-07-16')
    testId('calendar-day-2027-07-17')
    expect(container!.querySelector('[role="grid"]')?.getAttribute('aria-label')).toBe('Week view')
  })

  it('places an item on the day matching its startsAt, regardless of the view', () => {
    const event = eventItem()
    render({ days: days('2027-07-15', '2027-07-16'), itemsByDay: itemsByDay([event]) })
    const cell = testId('calendar-day-2027-07-16')
    expect(cell.querySelector('[data-testid="calendar-event-11111111-1111-4111-8111-111111111111"]')).toBeTruthy()
    expect(testId('calendar-day-2027-07-15').querySelectorAll('li')).toHaveLength(0)
  })

  it('gives an event a delete control that calls back with the event', () => {
    const onDelete = vi.fn()
    const event = eventItem()
    render({ days: days('2027-07-16'), itemsByDay: itemsByDay([event]), onDelete })
    act(() => {
      testId('calendar-delete-11111111-1111-4111-8111-111111111111').click()
    })
    expect(onDelete).toHaveBeenCalledWith(event)
  })

  it('gives a projection no destructive control and calls back on select', () => {
    const onSelectProjection = vi.fn()
    const projection = projectionItem()
    render({ days: days('2027-07-17'), itemsByDay: itemsByDay([projection]), onSelectProjection })
    const chip = testId('calendar-projection-job_projection')
    expect(chip.querySelectorAll('button')).toHaveLength(0)
    expect(chip.getAttribute('aria-label')).toContain('read-only')
    act(() => {
      chip.click()
    })
    expect(onSelectProjection).toHaveBeenCalledWith(projection)
  })

  it('dims only the days the caller marks dimmed — month\'s out-of-month cells, never week/day', () => {
    render({
      days: days('2027-06-30', '2027-07-01'),
      isDimmed: (d) => d.getUTCMonth() !== 6, // July is month index 6
    })
    expect(testId('calendar-day-2027-06-30').className).toContain('opacity-45')
    expect(testId('calendar-day-2027-07-01').className).not.toContain('opacity-45')
  })

  it('renders a single-column day view without dimming any cell', () => {
    render({ days: days('2027-07-16'), columns: 1, weekdayLabels: ['Friday'] })
    expect(testId('calendar-day-2027-07-16').className).not.toContain('opacity-45')
  })
})
