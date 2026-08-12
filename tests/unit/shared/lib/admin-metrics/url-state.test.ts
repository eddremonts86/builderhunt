import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ADMIN_METRICS_SEARCH,
  landingRedirectTarget,
  normalizeAdminMetricsSearch,
  searchNeedsRewrite,
} from '~/shared/lib/admin-metrics/url-state'
import { variantsFor } from '~/shared/lib/admin-metrics/contracts'

/**
 * The URL state of `/admin/metrics` — the first tests this module has ever had.
 *
 * It governs what the whole page displays: `validateSearch` runs `normalizeAdminMetricsSearch` on every
 * navigation, and `beforeLoad` decides from `searchNeedsRewrite` whether to correct the address bar. Both shipped
 * untested, which is the same gap that let `MetricWidget`'s `?? 0` survive — a module nothing imports from a test
 * is a module whose rules are asserted only by the code that has them.
 *
 * The cases below are the ones where being wrong is invisible rather than loud: a silent fallback that leaves the
 * URL disagreeing with the page, and a variant carried onto a section that has no such view.
 */
describe('normalizeAdminMetricsSearch', () => {
  it('falls back to the overview for a section that does not exist', () => {
    const result = normalizeAdminMetricsSearch({ section: 'nonsense', range: '24h' })
    expect(result.section).toBe('overview')
  })

  it('resolves the variant against the resolved section, not the requested one', () => {
    /**
     * The case with a real failure behind it. `?section=nonsense&variant=latency` normalizes the section to
     * `overview`, and `latency` is a *traffic* variant — carrying it across would produce a URL the page itself
     * generated and the API then refuses with a 400, because `/api/admin/metrics/sections` enumerates variants
     * per section and does not fall back.
     */
    const result = normalizeAdminMetricsSearch({ section: 'nonsense', variant: 'latency' })
    expect(result.section).toBe('overview')
    expect(variantsFor('overview')).toContain(result.variant)
    expect(result.variant).not.toBe('latency')
  })

  it('keeps a variant that is valid for the section it was asked with', () => {
    const result = normalizeAdminMetricsSearch({ section: 'traffic', variant: 'latency' })
    expect(result).toMatchObject({ section: 'traffic', variant: 'latency' })
  })

  it('treats only the string `true` as compare-on', () => {
    // A URL is hand-edited, so `?compare=0` and `?compare=false` have to mean off rather than "present".
    expect(normalizeAdminMetricsSearch({ compare: 'true' }).compare).toBe(true)
    expect(normalizeAdminMetricsSearch({ compare: true }).compare).toBe(true)
    for (const value of ['false', '0', '', 'yes', 1, null, undefined]) {
      expect(normalizeAdminMetricsSearch({ compare: value }).compare, String(value)).toBe(false)
    }
  })
})

describe('searchNeedsRewrite', () => {
  it('rewrites when the URL named something the normalizer changed', () => {
    const raw = { section: 'nonsense' }
    expect(searchNeedsRewrite(raw, normalizeAdminMetricsSearch(raw))).toBe(true)
  })

  it('leaves a URL alone when it named nothing', () => {
    // A bare URL has nothing to disagree with, and rewriting it would fight the landing-view redirect below.
    expect(searchNeedsRewrite({}, DEFAULT_ADMIN_METRICS_SEARCH)).toBe(false)
  })

  it('does not rewrite `compare=false` away', () => {
    /**
     * `?compare=false` normalizes to `false`, which is also the default — so a rewrite triggered by comparing
     * against the defaults would strip a parameter the operator typed deliberately. This is why the predicate
     * compares the *inputs* rather than re-normalizing twice.
     */
    const raw = { section: 'traffic', range: '24h', variant: variantsFor('traffic')[0], compare: 'false' }
    expect(searchNeedsRewrite(raw, normalizeAdminMetricsSearch(raw))).toBe(false)
  })
})

describe('landingRedirectTarget', () => {
  it('is null when there is no saved view', () => {
    expect(landingRedirectTarget(null, DEFAULT_ADMIN_METRICS_SEARCH)).toBeNull()
  })

  it('is null when the saved view is where a bare URL already lands', () => {
    /**
     * The case that keeps the redirect off every page load. An admin who has never saved anything reads the
     * defaults back from the store, and firing a redirect to arrive at the page already being rendered would add
     * a history entry and a second render for no visible change.
     */
    const same = {
      section: DEFAULT_ADMIN_METRICS_SEARCH.section,
      range: DEFAULT_ADMIN_METRICS_SEARCH.range,
      variant: DEFAULT_ADMIN_METRICS_SEARCH.variant,
    }
    expect(landingRedirectTarget(same, DEFAULT_ADMIN_METRICS_SEARCH)).toBeNull()
  })

  it('returns the fully-normalized search for a genuinely different saved view', () => {
    const target = landingRedirectTarget(
      { section: 'reliability', range: '7d', variant: variantsFor('reliability')[0] },
      DEFAULT_ADMIN_METRICS_SEARCH,
    )
    expect(target).toEqual({
      section: 'reliability',
      range: '7d',
      variant: variantsFor('reliability')[0],
      compare: false,
    })
  })

  it('is null for a saved section this build no longer has', () => {
    /**
     * A stored preference can name a section a later build removed. Normalizing it lands on the overview, which
     * equals the defaults, so the answer is "no redirect" — the alternative is a redirect to a dead section that
     * `validateSearch` bounces back to the overview, i.e. a visible flicker on every load for a preference
     * nobody can act on.
     */
    expect(
      landingRedirectTarget({ section: 'retired-section', range: '24h', variant: 'summary' }, DEFAULT_ADMIN_METRICS_SEARCH),
    ).toBeNull()
  })

  it('never carries `compare` from the preference', () => {
    // The store does not hold it, and an admin who saved it on would open every session fetching two windows.
    const target = landingRedirectTarget(
      { section: 'traffic', range: '1h', variant: variantsFor('traffic')[0] },
      DEFAULT_ADMIN_METRICS_SEARCH,
    )
    expect(target?.compare).toBe(false)
  })
})
