/**
 * `MetricWidget` — the first tests this component has ever had.
 *
 * ## Why it had none, and why that mattered
 *
 * `value` was a non-nullable `number` and the page fed it `stats?.totalBuilders ?? 0`, so a tile with nothing loaded
 * rendered a confident **0** in the largest type on the dashboard. Nothing caught it because nothing referenced this
 * component, its classes or its labels from any suite — a comment inside it even claimed `.text-3xl` was asserted by
 * `dashboard-and-navigation.spec.ts`, which never mentioned it.
 *
 * That combination is the interesting part: an untested component plus a type that cannot express "not known yet"
 * plus a `??` at the call site. Any one of the three alone is survivable. The cases below pin the first two, and the
 * page's own `statsData` supplies `null` rather than `0` for the counts it has not read.
 *
 * Uses the project's react-dom/client + act pattern (see `AbuseWarningBanner.test.tsx` for the reference).
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { MetricWidget, type MetricWidgetProps } from '~/modules/dashboard/ui/home/MetricWidget'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

/** A minimal icon, because the real ones are lucide components and none of these cases is about the glyph. */
const Icon = ({ className }: { className?: string }) => <svg className={className} />

function props(overrides: Partial<MetricWidgetProps> = {}): MetricWidgetProps {
  return {
    label: 'Builders tracked',
    value: 1234,
    hint: 'People saved to your lists',
    icon: Icon,
    tone: 'accent',
    ...overrides,
  }
}

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

describe('<MetricWidget />', () => {
  it('renders a known count, grouped', () => {
    const c = render(<MetricWidget {...props({ value: 1234 })} />)
    expect(c.textContent).toContain((1234).toLocaleString())
    expect(c.querySelector('[data-metric-state="ready"]')).not.toBeNull()
  })

  it('renders zero as zero, because zero is an answer', () => {
    /**
     * The counterpart to the case below, and the reason `null` had to be a separate value rather than a sentinel.
     * A workspace really can track no builders, and that tile must say `0` — so "unknown" could not be encoded as
     * a falsy number without collapsing the two.
     */
    const c = render(<MetricWidget {...props({ value: 0 })} />)
    expect(c.querySelector('[data-metric-state="ready"]')).not.toBeNull()
    expect(c.textContent).toContain('0')
  })

  it('never renders a number when the value is not known', () => {
    /**
     * The regression case for the defect. Asserted as "no digit anywhere in the tile" rather than "not 0", because
     * the failure mode is a *plausible* number: `?? 0` produced `0`, and a future `?? -1` or a stale cached count
     * would be just as wrong and would pass a check that only looked for zero.
     */
    const c = render(<MetricWidget {...props({ value: null })} />)
    expect(c.querySelector('[data-metric-state="loading"]')).not.toBeNull()
    expect(c.textContent ?? '').not.toMatch(/[0-9]/)
  })

  it('tells a screen reader it is loading, exactly once', () => {
    /**
     * `sr-only` text rather than `role="status"`, and the count matters: three of these tiles mount together, so
     * three live regions would announce themselves over each other. One quiet label per tile leaves the reading
     * order intact — "Builders tracked, Loading".
     */
    const c = render(<MetricWidget {...props({ value: null })} />)
    const announcements = c.querySelectorAll('.sr-only')
    expect(announcements).toHaveLength(1)
    expect(announcements[0]!.textContent).toBe('Loading')
    expect(c.querySelectorAll('[role="status"]')).toHaveLength(0)
    // The bar itself carries no meaning, so it must not be read out alongside the label.
    expect(c.querySelector('.animate-pulse')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the label and hint while the value is unknown', () => {
    // A tile that drops its label during loading is a grey box: the reader cannot tell which number is coming, so
    // the skeleton has to sit inside an otherwise complete tile.
    const c = render(<MetricWidget {...props({ value: null })} />)
    expect(c.textContent).toContain('Builders tracked')
    expect(c.textContent).toContain('People saved to your lists')
  })

  it('drops a badge that carries a number the value contradicts', () => {
    // Not a behaviour of this component — a note that the *caller* owns it. `statsData` builds every badge from
    // `stats`, so when `value` is null the badge is undefined by construction rather than by a guard here.
    const c = render(<MetricWidget {...props({ value: null, badge: undefined })} />)
    expect(c.textContent ?? '').not.toMatch(/[0-9]/)
  })
})
