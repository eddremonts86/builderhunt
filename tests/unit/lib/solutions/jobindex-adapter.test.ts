/**
 * The Jobindex feed adapter.
 *
 * Two things it must never do, both asserted here: claim a capability, and turn a job posting into a
 * person. Everything else is parsing, and the parsing tests use the real feed's escaping — Jobindex
 * double-escapes its descriptions, so a naive reader gets literal `&#x3C;div` where markup should be and
 * finds no area or summary at all.
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }))

vi.mock('~/lib/enrichment/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/enrichment/network')>()
  return { ...actual, safeFetch: mocks.safeFetch }
})

const { SafeFetchError } = await import('~/lib/enrichment/network')
const { jobindexRolesAdapter } = await import('~/lib/solutions/sources/jobindex')

function feed(items: string[]): string {
  return `<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel>
    <title>Jobindex</title>${items.join('')}</channel></rss>`
}

/** One item in the feed's real shape: the description body arrives HTML-escaped a second time. */
function item(options: { title: string; id?: string; area?: string; summary?: string; pubDate?: string }): string {
  const inner = [
    options.area ? `&#x3C;span class=&#x22;jix_robotjob--area&#x22;&#x3E;${options.area}&#x3C;/span&#x3E;` : '',
    options.summary ? `&#x3C;p&#x3E;${options.summary}&#x3C;/p&#x3E;` : '',
  ].join('')
  return `<item>
    <title>${options.title}</title>
    <link>https://www.jobindex.dk/vis-job/${options.id ?? 'h100'}</link>
    ${options.pubDate ? `<pubDate>${options.pubDate}</pubDate>` : ''}
    <description>${inner}</description>
  </item>`
}

function respondWith(body: string) {
  mocks.safeFetch.mockResolvedValue({
    status: 200, contentType: 'application/rss+xml', body, finalUrl: 'https://www.jobindex.dk/jobsoegning.rss',
  })
}

async function collect(limit = 50) {
  mocks.safeFetch.mockClear()
  return jobindexRolesAdapter.collect({
    allowedHosts: ['www.jobindex.dk'],
    signal: new AbortController().signal,
    limit,
  })
}

describe('a job posting becomes a role, never a person', () => {
  it('produces human_role components with no capability claims at all', async () => {
    respondWith(feed([item({ title: 'Senior Rust Developer, Nordea', id: 'h1', area: 'København' })]))
    const outcome = await collect()

    expect(outcome.kind).toBe('components')
    if (outcome.kind !== 'components') return
    expect(outcome.components).toHaveLength(1)
    const [component] = outcome.components
    expect(component.kind).toBe('human_role')
    // The whole point. "An employer advertised for a Rust developer" is not evidence that anyone can
    // write Rust, and a claim here would let the composer treat a wish list as a capability.
    expect(component.capabilities).toEqual([])
  })

  it('splits the title on the last comma, so a role containing commas keeps its company', async () => {
    respondWith(feed([item({ title: 'Senior Developer, Backend, Nordea', id: 'h2' })]))
    const outcome = await collect()
    if (outcome.kind !== 'components') throw new Error('expected components')

    expect(outcome.components[0].metadata.roleTitle).toBe('Senior Developer, Backend')
    expect(outcome.components[0].metadata.companyName).toBe('Nordea')
  })

  it('records an unknown company as null rather than guessing one', async () => {
    respondWith(feed([item({ title: 'Software Tester', id: 'h3' })]))
    const outcome = await collect()
    if (outcome.kind !== 'components') throw new Error('expected components')

    expect(outcome.components[0].metadata.roleTitle).toBe('Software Tester')
    // A wrong employer name is worse than a missing one — it is a false statement about a company.
    expect(outcome.components[0].metadata.companyName).toBeNull()
  })

  it('reads the area and summary out of the double-escaped description', async () => {
    respondWith(feed([item({
      title: 'Data Engineer, Maersk',
      id: 'h4',
      area: 'Gørlev',
      summary: 'You will build pipelines &#x26; own the warehouse.',
    })]))
    const outcome = await collect()
    if (outcome.kind !== 'components') throw new Error('expected components')

    expect(outcome.components[0].metadata.area).toBe('Gørlev')
    expect(outcome.components[0].metadata.summary).toBe('You will build pipelines & own the warehouse.')
  })

  it('keys the component on the posting id, so a reworded title does not mint a second one', async () => {
    respondWith(feed([item({ title: 'Developer, Acme', id: 'h777' })]))
    const first = await collect()
    respondWith(feed([item({ title: 'Senior Developer (Remote), Acme', id: 'h777' })]))
    const second = await collect()
    if (first.kind !== 'components' || second.kind !== 'components') throw new Error('expected components')

    expect(first.components[0].slug).toBe('jobindex-h777')
    expect(second.components[0].slug).toBe('jobindex-h777')
    expect(second.components[0].externalId).toBe('h777')
  })

  it('skips an item with no posting id in its link, keeping the rest of the batch', async () => {
    respondWith(feed([
      '<item><title>Sponsored banner, Acme</title><link>https://www.jobindex.dk/kampagne/banner</link></item>',
      item({ title: 'Real Job, Acme', id: 'h5' }),
    ]))
    const outcome = await collect()
    if (outcome.kind !== 'components') throw new Error('expected components')

    expect(outcome.components.map((c) => c.slug)).toEqual(['jobindex-h5'])
  })

  it('deduplicates a posting that appears under more than one query', async () => {
    // "developer" and "software engineer" overlap heavily in the real feed. Without dedup the same
    // posting races itself on the components unique index.
    respondWith(feed([item({ title: 'Developer, Acme', id: 'hdup' })]))
    const outcome = await collect()
    if (outcome.kind !== 'components') throw new Error('expected components')

    // Every query returned the same posting; one component came out.
    expect(mocks.safeFetch.mock.calls.length).toBeGreaterThan(1)
    expect(outcome.components).toHaveLength(1)
  })
})

describe('the adapter is bounded and honest about upstream trouble', () => {
  it('stops at the runner\'s limit rather than draining every query', async () => {
    respondWith(feed(Array.from({ length: 20 }, (_, i) => item({ title: `Job ${i}, Acme`, id: `h${i}` }))))
    const outcome = await collect(5)
    if (outcome.kind !== 'components') throw new Error('expected components')

    expect(outcome.components).toHaveLength(5)
  })

  it('reports a rate limit as retry, not as an empty result', async () => {
    // An empty result would look identical to "Denmark has no open roles", and the catalog would go
    // stale with nobody noticing.
    mocks.safeFetch.mockRejectedValue(new SafeFetchError('rate_limited', 'slow down'))
    const outcome = await collect()
    expect(outcome).toMatchObject({ kind: 'retry', reason: 'rate_limited' })
  })

  it('reports a 5xx as retry', async () => {
    mocks.safeFetch.mockResolvedValue({ status: 503, contentType: 'application/rss+xml', body: '', finalUrl: 'x' })
    const outcome = await collect()
    expect(outcome).toMatchObject({ kind: 'retry', reason: 'upstream_unavailable' })
  })

  it('skips one refused URL and keeps going', async () => {
    mocks.safeFetch
      .mockRejectedValueOnce(new SafeFetchError('host_not_allowed', 'nope'))
      .mockResolvedValue({
        status: 200, contentType: 'application/rss+xml',
        body: feed([item({ title: 'Developer, Acme', id: 'h9' })]), finalUrl: 'x',
      })
    const outcome = await jobindexRolesAdapter.collect({
      allowedHosts: ['www.jobindex.dk'], signal: new AbortController().signal, limit: 50,
    })
    if (outcome.kind !== 'components') throw new Error('expected components')
    expect(outcome.components).toHaveLength(1)
  })

  it('asks safeFetch to accept the feed content type and to decode ISO-8859-1', async () => {
    respondWith(feed([item({ title: 'Developer, Acme', id: 'h10' })]))
    await collect()

    const [, options] = mocks.safeFetch.mock.calls[0] as [string, Record<string, unknown>]
    // Both are load-bearing: without the first, safeFetch rejects every response as an unsupported
    // content type; without the second, every Danish job title decodes to replacement characters.
    expect(options.additionalContentTypes).toContain('application/rss+xml')
    expect(options.fallbackCharset).toBe('iso-8859-1')
  })

  it('never contacts a host outside the allowlist it was given', async () => {
    respondWith(feed([item({ title: 'Developer, Acme', id: 'h11' })]))
    await collect()

    for (const [url, options] of mocks.safeFetch.mock.calls as Array<[string, { allowedHosts: string[] }]>) {
      expect(new URL(url).hostname).toBe('www.jobindex.dk')
      expect(options.allowedHosts).toEqual(['www.jobindex.dk'])
    }
  })
})
