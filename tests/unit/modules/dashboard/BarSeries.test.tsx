import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BarSeries, utcWeekdayLabel } from '~/modules/dashboard/ui/BarSeries'

/**
 * plans/ui-dashboard Wave 7, "shared visualization" — extracted early because three widgets were
 * about to grow their own copy of the accessible table.
 *
 * Structural problem 9 is "charts omit equivalent data", and the reliable fix is not a rule authors
 * remember. It is a chart that cannot render without its table. These tests pin that property, not
 * the bars.
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

const POINTS = [
  { key: '2027-03-01', label: 'Mon', value: 0 },
  { key: '2027-03-02', label: 'Tue', value: 3 },
  { key: '2027-03-03', label: 'Wed', value: 1 },
]

function render(points = POINTS, generatedAt?: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <BarSeries points={points} caption="Things per day." valueLabel="Things" generatedAt={generatedAt} />,
    )
  })
  return container!
}

describe('BarSeries', () => {
  it('renders one table row per point, with a total', () => {
    const node = render()
    expect(node.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(node.querySelector('tfoot td')?.textContent).toBe('4')
  })

  it('hides the bars from assistive technology so the series is announced once', () => {
    // Without this a screen reader reads every number twice — once off the bars, once off the table.
    const node = render()
    expect(node.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(node.querySelector('table')?.className).toContain('sr-only')
  })

  it('shows every value in the visible layout, not only the peak', () => {
    // A tooltip is one readable number, and there is no hover on a touch device or in a screenshot.
    const node = render()
    const visible = node.querySelector('[aria-hidden="true"]')?.textContent ?? ''
    for (const value of ['0', '3', '1']) expect(visible).toContain(value)
  })

  it('draws a zero as zero', () => {
    // A minimum bar height would make an empty day indistinguishable from a quiet one at a glance.
    const node = render()
    const fills = Array.from(node.querySelectorAll<HTMLElement>('[style*="height"]'))
    expect(fills.some((fill) => fill.style.height === '0%')).toBe(true)
    // …while a day with a single event still paints something.
    expect(fills.some((fill) => fill.style.height !== '0%' && fill.style.height !== '')).toBe(true)
  })

  it('captions the series with an absolute time, never a relative one', () => {
    const node = render(POINTS, '2027-03-03T09:30:00.000Z')
    const caption = node.querySelector('caption')?.textContent ?? ''
    expect(caption).toContain('Things per day.')
    expect(caption).toMatch(/2027/)
    expect(caption).not.toMatch(/ago/)
  })

  it('survives a series that is entirely zero', () => {
    // `max` would be 0 and every height a division by zero without the floor of 1.
    const node = render([{ key: '2027-03-01', label: 'Mon', value: 0 }])
    expect(node.querySelector('tfoot td')?.textContent).toBe('0')
  })
})

describe('utcWeekdayLabel', () => {
  it('labels a bucket key in UTC, matching the boundary the server used', () => {
    // Formatted in the viewer's zone, a key would routinely name the previous or next day.
    expect(utcWeekdayLabel('2027-03-01')).toBe('Mon')
  })

  it('returns the key unchanged when it is not a date', () => {
    expect(utcWeekdayLabel('not-a-date')).toBe('not-a-date')
  })
})
