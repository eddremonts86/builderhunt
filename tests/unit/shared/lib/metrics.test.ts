import { describe, expect, it } from 'vitest'
import { interviewOperatorCounters, metrics } from '~/shared/lib/metrics'

/**
 * `interviewOperatorCounters` feeds `GET /api/admin/metrics` → `interviews.counters`, which the admin
 * page renders (plans/phase-1/44-calendar-scheduling-interview-intelligence, "Add redacted metrics and
 * operator dashboards").
 *
 * The first case is the one worth having. This module already carries a comment about `reset()` having
 * listed its keys by hand, so a counter added later "would have survived every reset" — and the first
 * version of the dashboard mapping made the identical mistake one layer up: nineteen keys written out
 * in the route, where a twentieth counter would increment correctly, reset correctly, and never reach
 * the page an operator looks at. A test that asserts the *set* is complete is the only kind that fails
 * when someone adds a counter and forgets the surface.
 */
describe('interviewOperatorCounters', () => {
  it('carries every interview counter the module reports, so a new one cannot miss the dashboard', () => {
    const snapshot = metrics.get()
    const declared = Object.keys(snapshot).filter((key) => key.startsWith('interview'))
    expect(declared.length, 'the module should report interview counters at all').toBeGreaterThan(0)

    const mapped = interviewOperatorCounters(snapshot)
    expect(Object.keys(mapped)).toHaveLength(declared.length)

    for (const key of declared) {
      const withoutPrefix = key.slice('interview'.length)
      const expected = withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1)
      expect(mapped, `${key} should reach the dashboard as ${expected}`).toHaveProperty(expected)
    }
  })

  it('drops the redundant prefix and keeps the value', () => {
    metrics.reset()
    metrics.increment('interviewBookingConflicts', 3)

    const mapped = interviewOperatorCounters(metrics.get())

    expect(mapped.bookingConflicts).toBe(3)
    expect(mapped).not.toHaveProperty('interviewBookingConflicts')
  })

  it('emits numbers only — nothing here may ever carry content', () => {
    const mapped = interviewOperatorCounters(metrics.get())

    for (const [key, value] of Object.entries(mapped)) {
      expect(typeof value, `${key} must be a number`).toBe('number')
    }
  })

  it('excludes the uptime fields the snapshot adds, which are not interview counters', () => {
    const mapped = interviewOperatorCounters(metrics.get())

    expect(mapped).not.toHaveProperty('uptimeMs')
    expect(mapped).not.toHaveProperty('uptimeSeconds')
  })

  it('excludes counters belonging to other subsystems', () => {
    metrics.reset()
    metrics.increment('searches', 7)

    const mapped = interviewOperatorCounters(metrics.get())

    expect(mapped).not.toHaveProperty('searches')
    expect(Object.values(mapped).every((value) => value === 0)).toBe(true)
  })
})
