import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Plan 57, Admin track — the flush half of "Add truthful historical service-metric storage or adapter".
 *
 * The repository is mocked because what is under test is the *failure policy*, not the SQL: a failed flush
 * must hand the minutes back rather than retry, and a lost minute must be preferred to an unbounded buffer.
 * The SQL is exercised by the e2e route coverage; a mocked upsert here would only assert the mock.
 */

const mocks = vi.hoisted(() => ({ flushServiceMetrics: vi.fn() }))

vi.mock('../../../../../src/shared/lib/repositories/service-metrics', () => ({
  flushServiceMetrics: mocks.flushServiceMetrics,
}))

const { flushOnce, stopServiceMetricFlush, startServiceMetricFlush } = await import(
  '../../../../../src/shared/lib/admin-metrics/flush'
)
const { serviceMetricRecorder } = await import('../../../../../src/shared/lib/admin-metrics/recorder')

const at = (iso: string) => new Date(iso)

beforeEach(() => {
  mocks.flushServiceMetrics.mockReset()
  mocks.flushServiceMetrics.mockResolvedValue({ written: 1 })
  // Drain anything a previous case left behind: the recorder is a process-wide singleton by design.
  serviceMetricRecorder.take(new Date(Date.now() + 86_400_000))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('flushOnce', () => {
  it('writes nothing and touches no connection when there is nothing to write', async () => {
    // An idle instance must not produce a write a minute. The timer fires regardless of traffic.
    await expect(flushOnce(at('2026-08-11T10:01:00Z'))).resolves.toEqual({ written: 0 })
    expect(mocks.flushServiceMetrics).not.toHaveBeenCalled()
  })

  it('passes the instance and deployment identity with the deltas', async () => {
    serviceMetricRecorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })
    await flushOnce(at('2026-08-11T10:01:00Z'))

    const [deltas, identity] = mocks.flushServiceMetrics.mock.calls[0]
    expect(deltas).toHaveLength(1)
    expect(deltas[0].routeFamily).toBe('api.search')
    // Both non-empty: without an instance the rows of two containers collide on the primary key, and
    // without a deployment a change in a rate cannot be attributed to a release.
    expect(identity.instance.length).toBeGreaterThan(0)
    expect(identity.deployment.length).toBeGreaterThan(0)
  })

  it('hands the minutes back to the recorder when the write fails', async () => {
    /**
     * The policy this module exists to state.
     *
     * Retrying in place would either block the next tick or double-write, and the upsert is additive so a
     * double-write is wrong. Restoring puts the bound back in one place — the recorder's own eviction — so
     * a long outage drops the oldest minutes instead of growing a buffer until the process dies.
     */
    mocks.flushServiceMetrics.mockRejectedValue(new Error('53300: too many connections'))
    serviceMetricRecorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })

    await expect(flushOnce(at('2026-08-11T10:01:00Z'))).resolves.toEqual({ written: 0 })

    // Not swallowed into nothing: the next attempt still has them.
    mocks.flushServiceMetrics.mockResolvedValue({ written: 1 })
    await flushOnce(at('2026-08-11T10:01:00Z'))
    expect(mocks.flushServiceMetrics.mock.calls[1][0][0].requests).toBe(1)
  })

  it('does not reject, because its caller is a timer', async () => {
    // An unhandled rejection inside setInterval takes the process down. A metrics bug must never be able to
    // stop the server it is measuring.
    mocks.flushServiceMetrics.mockRejectedValue(new Error('boom'))
    serviceMetricRecorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })
    await expect(flushOnce(at('2026-08-11T10:01:00Z'))).resolves.toBeDefined()
  })
})

describe('the timer', () => {
  it('starts once however many requests call it', () => {
    /**
     * It is started from the request middleware, so "once per process" is a real requirement rather than
     * tidiness: without the guard every request would add another interval and a busy instance would be
     * flushing thousands of times a minute.
     */
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setInterval')
    startServiceMetricFlush()
    startServiceMetricFlush()
    startServiceMetricFlush()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('flushes the minute in progress on the way out', async () => {
    // A deploy stops the process mid-minute. Discarding that minute would leave a hole at every release,
    // which is precisely when somebody is looking at the chart.
    vi.useFakeTimers()
    startServiceMetricFlush()
    serviceMetricRecorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5 })
    await stopServiceMetricFlush()
    expect(mocks.flushServiceMetrics).toHaveBeenCalledTimes(1)
  })
})
