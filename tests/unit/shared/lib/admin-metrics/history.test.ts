import { describe, expect, it } from 'vitest'
import {
  emptyHistogram,
  isKnownFamily,
  LATENCY_BOUNDARIES_MS,
  LATENCY_SLOTS,
  observe,
  percentileFrom,
  routeFamilyFor,
  slotFor,
  sumHistograms,
} from '../../../../../src/shared/lib/admin-metrics/history'

/**
 * Plan 57, Admin track — "Add truthful historical service-metric storage or adapter".
 *
 * The Verify line asks for three things, and each has its own block: percentiles that reconcile across a
 * process restart and across instances, high-cardinality URLs normalized or rejected, and bounded
 * retention (the last one is the migration's index and the worker's delete, not this module).
 */

describe('latency slots', () => {
  it('puts a duration equal to a boundary in that boundary, not the next one', () => {
    /**
     * `<=`, not `<`. A boundary of 100 means "100 ms or faster", and getting this backwards biases every
     * percentile in the slow direction — which is the direction that looks like a regression and sends
     * somebody hunting a query that is fine.
     */
    expect(slotFor(100)).toBe(LATENCY_BOUNDARIES_MS.indexOf(100))
    expect(slotFor(101)).toBe(LATENCY_BOUNDARIES_MS.indexOf(250))
    expect(slotFor(0)).toBe(0)
  })

  it('puts anything past the last boundary in the overflow slot', () => {
    expect(slotFor(10_001)).toBe(LATENCY_SLOTS - 1)
    expect(slotFor(999_999)).toBe(LATENCY_SLOTS - 1)
  })

  it('drops a negative or non-finite duration instead of calling it fast', () => {
    // Folding a bug in the caller into slot 0 would make the fastest bucket a dumping ground and pull
    // every percentile down.
    const histogram = emptyHistogram()
    observe(histogram, -5)
    observe(histogram, Number.NaN)
    observe(histogram, Number.POSITIVE_INFINITY)
    expect(histogram.reduce((sum, count) => sum + count, 0)).toBe(0)
  })
})

describe('percentiles from bucketed counts', () => {
  it('reports the boundary rather than inventing a number inside it', () => {
    /**
     * With a thousand observations in the 100 ms bucket there is no information about where inside it the
     * 95th sits. Interpolating would produce something like `173 ms`, which reads as a measurement and is
     * not one. The loss of precision is the honest half of the trade the storage shape makes.
     */
    const histogram = emptyHistogram()
    for (let i = 0; i < 1_000; i += 1) observe(histogram, 80)
    expect(percentileFrom(histogram, 0.95).atMostMs).toBe(100)
  })

  it('returns null for an empty histogram rather than zero', () => {
    // Zero would read as "instant". No observations is not a latency.
    const result = percentileFrom(emptyHistogram(), 0.95)
    expect(result.atMostMs).toBeNull()
    expect(result.samples).toBe(0)
    expect(result.overflow).toBe(false)
  })

  it('says overflow rather than naming a number past the last boundary', () => {
    const histogram = emptyHistogram()
    observe(histogram, 30_000)
    const result = percentileFrom(histogram, 0.99)
    expect(result.overflow).toBe(true)
    expect(result.atMostMs).toBeNull()
  })

  it('is nearest-rank, so a p50 with a skewed distribution lands where the mass is', () => {
    const histogram = emptyHistogram()
    for (let i = 0; i < 90; i += 1) observe(histogram, 8)
    for (let i = 0; i < 10; i += 1) observe(histogram, 4_000)
    expect(percentileFrom(histogram, 0.5).atMostMs).toBe(10)
    expect(percentileFrom(histogram, 0.95).atMostMs).toBe(5_000)
  })

  it('rejects a quantile outside (0, 1]', () => {
    for (const q of [0, -0.1, 1.01, 2]) expect(() => percentileFrom(emptyHistogram(), q)).toThrow(RangeError)
  })
})

describe('reconciling across restarts and instances', () => {
  it('sums two instances in the same minute into one distribution', () => {
    /**
     * The property the whole storage shape exists for.
     *
     * Two instances each serving half the traffic must produce the same p95 as one instance serving all of
     * it. Storing means could not do this — averaging two averages weights them equally regardless of
     * volume — and this is the case a naive implementation gets wrong precisely when it matters, under
     * load, with more than one instance.
     */
    const together = emptyHistogram()
    const instanceA = emptyHistogram()
    const instanceB = emptyHistogram()
    for (let i = 0; i < 190; i += 1) {
      observe(together, 8)
      observe(i % 2 === 0 ? instanceA : instanceB, 8)
    }
    for (let i = 0; i < 10; i += 1) {
      observe(together, 4_000)
      observe(i % 2 === 0 ? instanceA : instanceB, 4_000)
    }

    const summed = sumHistograms([instanceA, instanceB])
    expect(summed).toEqual(together)
    expect(percentileFrom(summed, 0.95).atMostMs).toBe(percentileFrom(together, 0.95).atMostMs)
  })

  it('sums across a restart, because a restart is just another row', () => {
    // The case a cumulative counter cannot survive: subtracting across the reset gives a negative delta.
    const beforeDeploy = emptyHistogram()
    const afterDeploy = emptyHistogram()
    for (let i = 0; i < 50; i += 1) observe(beforeDeploy, 8)
    for (let i = 0; i < 50; i += 1) observe(afterDeploy, 300)

    const summed = sumHistograms([beforeDeploy, afterDeploy])
    expect(summed.reduce((sum, count) => sum + count, 0)).toBe(100)
    // Half fast, half at 300 ms: the median sits at the boundary between them, not at either extreme.
    expect(percentileFrom(summed, 0.5).atMostMs).toBe(10)
    expect(percentileFrom(summed, 0.9).atMostMs).toBe(500)
  })

  it('refuses a row written under a different boundary list instead of padding it', () => {
    /**
     * Padding would silently attribute the missing slots to "fast", so a boundary change would show up as
     * a latency improvement. Refusing makes the incompatibility loud, which is the only way anybody would
     * notice it was a data migration.
     */
    expect(() => sumHistograms([emptyHistogram(), [1, 2, 3]])).toThrow(/different boundary list/)
  })
})

describe('route families', () => {
  it('maps an API path to its family and never keeps the identifier', () => {
    expect(routeFamilyFor('/api/sprints/abc123/results')).toBe('api.sprints')
    expect(routeFamilyFor('/api/dashboard/overview')).toBe('api.dashboard')
    expect(routeFamilyFor('/api/admin/metrics/sections')).toBe('api.admin')
  })

  it('strips query and fragment, which carry the most identifiers of anything in a URL', () => {
    expect(routeFamilyFor('/api/search/builders?q=someone%40example.com')).toBe('api.search')
    expect(routeFamilyFor('/api/builders/gh_12345#profile')).toBe('api.builders')
  })

  it('counts an unrecognised path as `other` rather than dropping it', () => {
    /**
     * Dropping would understate total traffic, and the total is what every rate is computed from. `other`
     * is the one label that says "counted, not attributed" — it keeps the arithmetic honest while carrying
     * no identifier.
     */
    expect(routeFamilyFor('/api/something-new/xyz')).toBe('other')
    expect(routeFamilyFor('/totally-unknown-root/page')).toBe('other')
    expect(routeFamilyFor('not-a-path')).toBe('other')
  })

  it('never returns a value outside the allowlist, for any input', () => {
    // The property that matters: whatever arrives, what gets stored is one of fourteen known labels.
    const hostile = [
      '/api/sprints/' + 'a'.repeat(500),
      '/builders/gh_1/../../etc/passwd',
      '/api/../api/admin',
      '//api//search//',
      '/',
      '',
      '/api/',
      '/api/public/scheduling/probe-invitation/slots',
    ]
    for (const path of hostile) {
      const family = routeFamilyFor(path)
      expect(isKnownFamily(family), `${path} produced ${family}`).toBe(true)
    }
  })

  it('keeps the public API under one family even when its second segment varies', () => {
    expect(routeFamilyFor('/api/public/scheduling/x')).toBe('api.public')
    expect(routeFamilyFor('/api/public/anything-else')).toBe('api.public')
  })

  it('separates the authenticated shell from public pages', () => {
    // The distinction an operator actually reads: authenticated traffic versus anonymous.
    expect(routeFamilyFor('/dashboard')).toBe('page.dashboard')
    expect(routeFamilyFor('/settings/team')).toBe('page.dashboard')
    expect(routeFamilyFor('/pricing')).toBe('page.public')
    expect(routeFamilyFor('/builders/gh_1')).toBe('page.public')
  })
})
