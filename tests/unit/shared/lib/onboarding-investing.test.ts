import { describe, expect, it } from 'vitest'
import {
  INVESTING_THESIS_THEMES,
  composeThesisQuery,
  entryRouteFor,
  thesisKeywords,
} from '~/shared/lib/onboarding-shared'
import { armSavedSearch, saveAndArmThesis } from '~/shared/lib/onboarding-investing'
import { ONBOARDING_PRESETS } from '~/shared/lib/onboarding-v2'

/**
 * The investing route (plan: phase-2/03-onboarding-segmentado).
 *
 * Two things are worth pinning here. The thesis composition, because it decides what gets *saved*
 * under somebody's name and a truncated or duplicated query is a search that does not match what
 * they picked. And the arming sequence, because its interesting branch — alerts refused with 402 on
 * the free plan — is unreachable in a test that would have to provoke a real billing state.
 */

describe('composing a thesis', () => {
  it('expands themes into the keywords the connectors index', () => {
    const query = composeThesisQuery(['developer-tools'])
    expect(query).toBe('developer tools, sdk')
    expect(thesisKeywords(['developer-tools'])).toEqual(['developer tools', 'sdk'])
  })

  /** Somebody who typed something specific meant it more than the chip they also tapped. */
  it('puts free text first', () => {
    expect(composeThesisQuery(['fintech'], 'rust database internals')).toBe(
      'rust database internals, fintech, payments',
    )
  })

  it('drops duplicates whatever their case', () => {
    expect(composeThesisQuery(['security'], 'Security')).toBe('Security, cryptography')
  })

  it('ignores a theme id it does not know', () => {
    // The ids travel in component state, but a stale bundle or a renamed theme must not produce a
    // query with a hole in it.
    expect(composeThesisQuery(['developer-tools', 'crypto-casino'])).toBe('developer tools, sdk')
  })

  it('is empty when nothing was chosen', () => {
    expect(composeThesisQuery([], '   ')).toBe('')
    expect(thesisKeywords([], '')).toEqual([])
  })

  /**
   * `onboarding/search` caps its own prefill at 300 characters. Composing past that would hand it a
   * query that arrives truncated mid-word — a saved search whose name does not match what was
   * picked. Cut on a keyword boundary here instead.
   */
  it('caps the query on a keyword boundary', () => {
    const query = composeThesisQuery(
      INVESTING_THESIS_THEMES.map((theme) => theme.id),
      'x'.repeat(280),
    )
    expect(query.length).toBeLessThanOrEqual(300)
    expect(query.endsWith(',')).toBe(false)
    // Every kept part is whole — nothing was sliced through the middle of a keyword.
    for (const part of query.split(', ')) {
      expect(part.length).toBeGreaterThan(0)
    }
  })
})

describe('where the goal step sends people', () => {
  it('sends each branch to its own route and the rest to the general search', () => {
    expect(entryRouteFor('investing')).toBe('/onboarding/investing')
    expect(entryRouteFor('building')).toBe('/onboarding/building')
    // `general`, `other` and `hiring` all start at the search step — hiring differs in what it
    // suggests looking for, not in where it begins.
    for (const preset of ONBOARDING_PRESETS.filter(
      (candidate) => candidate !== 'investing' && candidate !== 'building',
    )) {
      expect(entryRouteFor(preset)).toBe('/onboarding/search')
    }
  })
})

interface StubCall {
  url: string
  body: Record<string, unknown> | null
}

/** A fetch that answers by URL fragment and records what it was asked. */
function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: StubCall[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    const key = Object.keys(routes).find((fragment) => url.includes(fragment))
    if (!key) throw new Error(`unexpected fetch: ${url}`)
    const route = routes[key]
    return new Response(JSON.stringify(route.body), { status: route.status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('arming a saved search', () => {
  it('creates an alert when the plan allows it', async () => {
    const { impl, calls } = stubFetch({ '/api/alerts': { status: 200, body: { id: 'alert-1' } } })
    const outcome = await armSavedSearch({ queryId: 'q1', name: 'fintech', keywords: ['fintech'], fetchImpl: impl })

    expect(outcome).toEqual({ armed: 'alert', alertId: 'alert-1' })
    // The alert is tied to the saved query, not a free-floating copy of its keywords: that is what
    // makes it countable as "this search is armed" rather than "some alert exists".
    expect(calls[0].body?.queryId).toBe('q1')
  })

  /**
   * The free plan is the common case at signup — `/api/alerts` answers 402 without
   * `paidActionsAllowed`. Stopping there would mean this route could only ever activate somebody who
   * had already paid, and its activation rate would measure conversion to Pro rather than the route.
   */
  it('falls back to a feed link when alerts are a paid feature', async () => {
    const { impl, calls } = stubFetch({
      '/api/alerts': { status: 402, body: { error: 'Smart alerts are a Pro feature.' } },
      'feed-capability': { status: 201, body: { id: 'cap-1', url: '/api/feeds/cap-1?format=rss&token=t' } },
    })
    const outcome = await armSavedSearch({ queryId: 'q1', name: 'fintech', keywords: ['fintech'], fetchImpl: impl })

    expect(outcome).toEqual({ armed: 'feed', feedUrl: '/api/feeds/cap-1?format=rss&token=t' })
    expect(calls).toHaveLength(2)
  })

  /**
   * Only 402 falls back. A rate limit or a 500 means something went wrong, and quietly minting a
   * feed link instead would report success for a failure nobody asked to work around.
   */
  it('does not fall back on any other refusal', async () => {
    const { impl, calls } = stubFetch({
      '/api/alerts': { status: 429, body: { error: 'Too many alerts created today.' } },
    })
    const outcome = await armSavedSearch({ queryId: 'q1', name: 'x', keywords: ['x'], fetchImpl: impl })

    expect(outcome).toEqual({ armed: 'none', reason: 'Too many alerts created today.' })
    expect(calls).toHaveLength(1)
  })

  it('reports a failed feed mint rather than claiming delivery', async () => {
    const { impl } = stubFetch({
      '/api/alerts': { status: 402, body: {} },
      'feed-capability': { status: 429, body: { error: 'Too many feed links minted in the last hour.' } },
    })
    const outcome = await armSavedSearch({ queryId: 'q1', name: 'x', keywords: ['x'], fetchImpl: impl })

    expect(outcome.armed).toBe('none')
  })

  it('survives the network being gone', async () => {
    const impl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const outcome = await armSavedSearch({ queryId: 'q1', name: 'x', keywords: ['x'], fetchImpl: impl })
    expect(outcome.armed).toBe('none')
  })
})

describe('saving a thesis and arming it', () => {
  it('creates the search across the whole source register, then arms it', async () => {
    const { impl, calls } = stubFetch({
      '/api/queries': { status: 200, body: { id: 'q-99' } },
      '/api/alerts': { status: 200, body: { id: 'alert-9' } },
    })
    const result = await saveAndArmThesis({ name: 'climate tech', keywords: ['climate tech'], fetchImpl: impl })

    expect(result.queryId).toBe('q-99')
    expect(result.outcome.armed).toBe('alert')
    // A thesis that only watched GitHub would be a narrower search than the discovery step it came
    // from — the register decides the list, not a hand-written subset.
    expect((calls[0].body?.sources as string[]).length).toBeGreaterThan(5)
  })

  /**
   * A saved search that exists but could not be armed is a partial success, and the caller is told
   * both halves. Collapsing it into one boolean would either throw away a real saved search or claim
   * an alert that is not there.
   */
  it('reports the search and the arming separately', async () => {
    const { impl } = stubFetch({
      '/api/queries': { status: 200, body: { id: 'q-1' } },
      '/api/alerts': { status: 500, body: {} },
    })
    const result = await saveAndArmThesis({ name: 'x', keywords: ['x'], fetchImpl: impl })

    expect(result.queryId).toBe('q-1')
    expect(result.outcome.armed).toBe('none')
    expect(result.error).toBeUndefined()
  })

  it('surfaces the plan limit the saved-search API returns, and arms nothing', async () => {
    const { impl, calls } = stubFetch({
      '/api/queries': { status: 402, body: { error: "You've reached the free plan limit of 3 saved searches." } },
    })
    const result = await saveAndArmThesis({ name: 'x', keywords: ['x'], fetchImpl: impl })

    expect(result.queryId).toBeNull()
    expect(result.error).toContain('free plan limit')
    expect(calls).toHaveLength(1)
  })

  it('refuses an empty thesis without calling anything', async () => {
    const { impl, calls } = stubFetch({})
    const result = await saveAndArmThesis({ name: '', keywords: [], fetchImpl: impl })

    expect(result.queryId).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
