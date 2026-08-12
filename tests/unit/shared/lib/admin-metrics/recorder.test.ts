import { describe, expect, it } from 'vitest'
import { LATENCY_SLOTS, percentileFrom, slotFor } from '../../../../../src/shared/lib/admin-metrics/history'
import {
  minuteOf,
  ServiceMetricRecorder,
} from '../../../../../src/shared/lib/admin-metrics/recorder'

/**
 * Plan 57, Admin track — "Add truthful historical service-metric storage or adapter".
 *
 * The recorder's job is to be a *delta* accumulator that cannot grow without bound and cannot hand over a
 * partial minute. Each block below is one of those three properties, plus the two double-count shapes that
 * would silently corrupt a rate.
 */

const at = (iso: string) => new Date(iso)

describe('bucketing', () => {
  it('truncates to the minute in UTC, so two instances agree on the bucket', () => {
    // Local-time truncation would put two instances in different zones in different buckets for the same
    // second, and the additive upsert would then never merge them.
    expect(minuteOf(at('2026-08-11T10:17:42.913Z')).toISOString()).toBe('2026-08-11T10:17:00.000Z')
  })

  it('normalizes the path to a family, so no raw path ever enters the buffer', () => {
    const recorder = new ServiceMetricRecorder()
    recorder.record({ pathname: '/api/sprints/spr_secret123/results', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })
    const [delta] = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(delta.routeFamily).toBe('api.sprints')
    expect(JSON.stringify(delta)).not.toContain('spr_secret123')
  })
})

describe('take() hands over deltas, never totals', () => {
  it('leaves the current minute behind so nothing partial is written', () => {
    /**
     * The property the storage depends on. Writing the in-progress minute is arithmetically fine under the
     * additive upsert, but a read landing between the two writes sees a minute that is real and incomplete
     * — a dip in the chart that never happened.
     */
    const recorder = new ServiceMetricRecorder()
    recorder.record({ pathname: '/api/search/x', status: 200, durationMs: 5, at: at('2026-08-11T10:00:30Z') })
    recorder.record({ pathname: '/api/search/x', status: 200, durationMs: 5, at: at('2026-08-11T10:01:10Z') })

    const first = recorder.take(at('2026-08-11T10:01:20Z'))
    expect(first).toHaveLength(1)
    expect(first[0].bucketStart.toISOString()).toBe('2026-08-11T10:00:00.000Z')

    const second = recorder.take(at('2026-08-11T10:02:00Z'))
    expect(second).toHaveLength(1)
    expect(second[0].bucketStart.toISOString()).toBe('2026-08-11T10:01:00.000Z')
  })

  it('clears what it hands over, so the next take is not the same numbers again', () => {
    // If take() did not clear, every flush would re-add the previous minute and the additive upsert would
    // multiply it — the one failure mode a cumulative counter and an additive write combine into.
    const recorder = new ServiceMetricRecorder()
    recorder.record({ pathname: '/api/builders/1', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })
    expect(recorder.take(at('2026-08-11T10:01:00Z'))).toHaveLength(1)
    expect(recorder.take(at('2026-08-11T10:01:00Z'))).toHaveLength(0)
  })

  it('returns nothing at all when nothing was recorded', () => {
    expect(new ServiceMetricRecorder().take(at('2026-08-11T10:01:00Z'))).toEqual([])
  })
})

describe('counting', () => {
  it('counts a 5xx as an error and a 4xx as a served request', () => {
    /**
     * A 404 or a 401 is the application working. Folding them in makes a crawler probing for `/wp-admin`
     * look like an incident, and an error rate that spikes for that reason is one an operator learns to
     * ignore — which is worse than not having it.
     */
    const recorder = new ServiceMetricRecorder()
    const when = at('2026-08-11T10:00:00Z')
    for (const status of [200, 401, 404, 429, 499]) {
      recorder.record({ pathname: '/api/admin/x', status, durationMs: 1, at: when })
    }
    recorder.record({ pathname: '/api/admin/x', status: 500, durationMs: 1, at: when })
    recorder.record({ pathname: '/api/admin/x', status: 503, durationMs: 1, at: when })

    const [delta] = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(delta.requests).toBe(7)
    expect(delta.errors).toBe(2)
  })

  it('separates families in the same minute instead of summing them', () => {
    const recorder = new ServiceMetricRecorder()
    const when = at('2026-08-11T10:00:00Z')
    recorder.record({ pathname: '/api/search/a', status: 200, durationMs: 1, at: when })
    recorder.record({ pathname: '/api/billing/b', status: 200, durationMs: 1, at: when })
    const deltas = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(deltas.map((d) => d.routeFamily).sort()).toEqual(['api.billing', 'api.search'])
  })

  it('records the duration in the slot the boundaries dictate', () => {
    const recorder = new ServiceMetricRecorder()
    recorder.record({ pathname: '/api/search/a', status: 200, durationMs: 300, at: at('2026-08-11T10:00:00Z') })
    const [delta] = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(delta.latencyBuckets).toHaveLength(LATENCY_SLOTS)
    expect(delta.latencyBuckets[slotFor(300)]).toBe(1)
    expect(percentileFrom(delta.latencyBuckets, 0.95).atMostMs).toBe(500)
  })

  it('counts a cache hit without counting a second search', () => {
    /**
     * The double-count this API's two-method shape exists to prevent.
     *
     * `lib/search.ts` counts the search on entry and discovers the cache hit later, in one of two early
     * returns. A single `recordSearch({ cacheHit })` would be called twice on a hit and the rate would come
     * out at 50 % when it should be 100 % — or above 100 % under a different call order. Both calls look
     * correct in review, which is why this is asserted rather than argued.
     */
    const recorder = new ServiceMetricRecorder()
    const when = at('2026-08-11T10:00:00Z')
    recorder.recordSearch(when)
    recorder.recordSearchCacheHit(when)
    const [delta] = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(delta.searches).toBe(1)
    expect(delta.searchCacheHits).toBe(1)
    expect(delta.searchCacheHits / delta.searches).toBe(1)
  })

  it('attributes every search to api.search whatever carried it', () => {
    // Splitting the hit rate across the surfaces that happened to call the search would make it move for a
    // reason that has nothing to do with the cache.
    const recorder = new ServiceMetricRecorder()
    recorder.recordSearch(at('2026-08-11T10:00:00Z'))
    const [delta] = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(delta.routeFamily).toBe('api.search')
  })
})

describe('bounded buffer', () => {
  it('drops the oldest minute rather than growing without limit', () => {
    /**
     * The case this bound is for is a database outage, which is exactly when a metrics buffer is tempting to
     * grow. An observability buffer that can exhaust memory turns somebody else's outage into ours, and the
     * metrics are the least important thing in the process at that moment.
     */
    const recorder = new ServiceMetricRecorder()
    for (let minute = 0; minute < 400; minute += 1) {
      const when = new Date(Date.UTC(2026, 7, 11, 0, minute, 0))
      recorder.record({ pathname: '/api/search/a', status: 200, durationMs: 1, at: when })
      recorder.record({ pathname: '/api/billing/b', status: 200, durationMs: 1, at: when })
    }
    // Ten minutes × fourteen families is the stated bound; 800 entries were offered.
    expect(recorder.bufferedMinutes).toBeLessThanOrEqual(140)

    // And the newest minute survived, because that is the one a reader wants.
    const kept = recorder.take(new Date(Date.UTC(2026, 7, 11, 7, 0, 0)))
    expect(kept.some((d) => d.bucketStart.toISOString() === '2026-08-11T06:39:00.000Z')).toBe(true)
  })
})

describe('restore() after a failed flush', () => {
  it('merges rather than replaces, because traffic kept arriving', () => {
    // Replacing would discard whatever was recorded while the flush was in flight — the counts most likely
    // to matter, since the flush failing means something was going wrong at that moment.
    const recorder = new ServiceMetricRecorder()
    const when = at('2026-08-11T10:00:00Z')
    recorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5, at: when })
    const taken = recorder.take(at('2026-08-11T10:01:00Z'))

    recorder.record({ pathname: '/api/search/a', status: 500, durationMs: 5, at: when })
    recorder.restore(taken)

    const merged = recorder.take(at('2026-08-11T10:01:00Z'))
    expect(merged).toHaveLength(1)
    expect(merged[0].requests).toBe(2)
    expect(merged[0].errors).toBe(1)
    expect(merged[0].latencyBuckets[slotFor(5)]).toBe(2)
  })

  it('re-takes a restored minute, so a recovered flush writes it', () => {
    const recorder = new ServiceMetricRecorder()
    recorder.record({ pathname: '/api/search/a', status: 200, durationMs: 5, at: at('2026-08-11T10:00:00Z') })
    const taken = recorder.take(at('2026-08-11T10:01:00Z'))
    recorder.restore(taken)
    expect(recorder.take(at('2026-08-11T10:01:00Z'))).toHaveLength(1)
  })
})
