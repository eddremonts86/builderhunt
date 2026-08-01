/**
 * Market rate bands from job postings (plan 43 Phase 5, supporting "calculate estimate intervals").
 *
 * `summarizeBand` is the part that decides what number a user is shown, so it is tested directly and
 * without a database. Every rule here exists because the alternative produces a figure that looks
 * authoritative and is wrong.
 */
import { describe, expect, it } from 'vitest'
import { MIN_SAMPLE_SIZE, summarizeBand } from '~/lib/solutions/retrieval/market-rates'

const row = (overrides: Partial<Parameters<typeof summarizeBand>[0][number]> = {}) => ({
  sourceKey: 'jobicy_jobs',
  salaryMin: 100000,
  salaryMax: 120000,
  currency: 'USD',
  period: 'annual',
  ...overrides,
})

const many = (count: number, overrides: Partial<Parameters<typeof summarizeBand>[0][number]> = {}) =>
  Array.from({ length: count }, () => row(overrides))

describe('a band needs enough postings to describe a market', () => {
  it('declines below the sample floor rather than returning a wide range', () => {
    // "We don't know" is usable; a fabricated range with a confident face on it is not.
    const outcome = summarizeBand(many(MIN_SAMPLE_SIZE - 1))
    expect(outcome).toEqual({ status: 'insufficient_data', sampleSize: MIN_SAMPLE_SIZE - 1 })
  })

  it('produces a band at the floor', () => {
    const outcome = summarizeBand(many(MIN_SAMPLE_SIZE))
    expect(outcome.status).toBe('ok')
  })

  it('reports zero samples for an empty set', () => {
    expect(summarizeBand([])).toEqual({ status: 'insufficient_data', sampleSize: 0 })
  })
})

describe('one outlier must not move the answer', () => {
  it('uses the median, not the mean', () => {
    const outcome = summarizeBand([
      ...many(9, { salaryMin: 60000, salaryMax: 60000 }),
      // One executive posting in a set of junior ones. The mean would be ~124k; the median moves by one
      // position and stays where the market actually is.
      row({ salaryMin: 700000, salaryMax: 700000 }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.median).toBe(60000)
    expect(outcome.band.p75).toBe(60000)
  })

  it('reports percentiles that a real posting actually advertised', () => {
    // Nearest-rank, not interpolated: an interpolated percentile invents a figure no employer offered, and
    // every number in a band shown to a user should be one someone was willing to pay.
    const outcome = summarizeBand([
      row({ salaryMin: 50000, salaryMax: 50000 }),
      row({ salaryMin: 60000, salaryMax: 60000 }),
      row({ salaryMin: 70000, salaryMax: 70000 }),
      row({ salaryMin: 80000, salaryMax: 80000 }),
      row({ salaryMin: 90000, salaryMax: 90000 }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    for (const value of [outcome.band.p25, outcome.band.median, outcome.band.p75]) {
      expect([50000, 60000, 70000, 80000, 90000]).toContain(value)
    }
  })
})

describe('currencies are never mixed', () => {
  it('keeps the largest currency group and counts the rest', () => {
    const outcome = summarizeBand([
      ...many(6, { currency: 'EUR', salaryMin: 60000, salaryMax: 60000 }),
      ...many(2, { currency: 'USD', salaryMin: 200000, salaryMax: 200000 }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    // Averaging 60,000 EUR with 200,000 USD yields a number that is not a salary in any currency.
    expect(outcome.band.currency).toBe('EUR')
    expect(outcome.band.median).toBe(60000)
    // Reported, so a caller can see the market it asked about was split.
    expect(outcome.band.otherCurrencySamples).toBe(2)
  })

  it('breaks a tie deterministically by currency code', () => {
    // An estimate that changed currency between two runs of one brief would be indefensible.
    const rows = [
      ...many(5, { currency: 'USD', salaryMin: 100000, salaryMax: 100000 }),
      ...many(5, { currency: 'EUR', salaryMin: 90000, salaryMax: 90000 }),
    ]
    const first = summarizeBand(rows)
    const second = summarizeBand([...rows].reverse())
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected bands')
    expect(first.band.currency).toBe('EUR')
    expect(second.band.currency).toBe('EUR')
  })

  it('excludes a figure with no currency', () => {
    // Remote OK publishes salary without a currency. Counting it as whatever the majority happened to be
    // would silently reprice it.
    const outcome = summarizeBand([
      ...many(5, { currency: 'EUR', salaryMin: 60000, salaryMax: 60000 }),
      row({ currency: null, salaryMin: 999999, salaryMax: 999999 }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.sampleSize).toBe(5)
    // Not counted as "other currency" either: it has no currency to be other than.
    expect(outcome.band.otherCurrencySamples).toBe(0)
  })
})

describe('periods are excluded, never converted', () => {
  it('drops a monthly figure rather than multiplying it', () => {
    // A monthly and an annual figure differ by 12×, and these feeds' period labels are not reliable enough
    // to normalise on. Converting a mislabelled figure produces an error an order of magnitude wide.
    const outcome = summarizeBand([
      ...many(5, { period: 'annual', salaryMin: 60000, salaryMax: 60000 }),
      ...many(3, { period: 'monthly', salaryMin: 5000, salaryMax: 5000 }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.sampleSize).toBe(5)
    expect(outcome.band.median).toBe(60000)
  })

  it('accepts a posting with no period stated', () => {
    // Absent is not the same as non-annual, and these feeds usually mean annual when they say nothing.
    const outcome = summarizeBand(many(5, { period: null }))
    expect(outcome.status).toBe('ok')
  })
})

describe('bounds and provenance', () => {
  it('uses the midpoint of an advertised band', () => {
    const outcome = summarizeBand(many(5, { salaryMin: 80000, salaryMax: 120000 }))
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.median).toBe(100000)
  })

  it('uses a lone bound as-is rather than inventing the other half', () => {
    const outcome = summarizeBand(many(5, { salaryMin: 90000, salaryMax: null }))
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.median).toBe(90000)
  })

  it('ignores zero and negative figures', () => {
    const outcome = summarizeBand([
      ...many(5, { salaryMin: 70000, salaryMax: 70000 }),
      row({ salaryMin: 0, salaryMax: 0 }),
      row({ salaryMin: -5, salaryMax: null }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.sampleSize).toBe(5)
  })

  it('records which sources the band drew on', () => {
    // An estimate has to be able to say where its numbers came from.
    const outcome = summarizeBand([
      ...many(3, { sourceKey: 'jobicy_jobs' }),
      ...many(3, { sourceKey: 'himalayas_jobs' }),
    ])
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.sourceKeys).toEqual(['himalayas_jobs', 'jobicy_jobs'])
  })

  it('parses numeric strings, which is how postgres returns a numeric cast', () => {
    const outcome = summarizeBand(many(5, { salaryMin: '75000' as unknown as number, salaryMax: '85000' as unknown as number }))
    if (outcome.status !== 'ok') throw new Error('expected a band')
    expect(outcome.band.median).toBe(80000)
  })
})
