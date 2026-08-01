/**
 * The four public job-feed adapters (Arbeitnow, Remote OK, Jobicy, Himalayas).
 *
 * Fixtures use the exact field names and quirks the live APIs returned when probed on 2026-08-01, because
 * every defect these tests lock down was found by running against the real endpoints and not by reading
 * their documentation: double-escaped HTML descriptions, double-encoded UTF-8 titles, a placeholder company
 * name served for every posting in a response, and Remote OK's legal notice occupying array position zero.
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }))

vi.mock('~/lib/enrichment/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/enrichment/network')>()
  return { ...actual, safeFetch: mocks.safeFetch }
})

const { SafeFetchError } = await import('~/lib/enrichment/network')
const {
  arbeitnowJobsAdapter, himalayasJobsAdapter, jobicyJobsAdapter, remoteOkJobsAdapter,
  JOB_FEED_ADAPTERS, repairDoubleEncodedUtf8,
} = await import('~/lib/solutions/sources/job-feeds')
type SolutionSourceAdapter = import('~/lib/solutions/sources/types').SolutionSourceAdapter

function respondWith(body: unknown) {
  mocks.safeFetch.mockClear()
  mocks.safeFetch.mockResolvedValue({
    status: 200, contentType: 'application/json', body: JSON.stringify(body), finalUrl: 'https://feed.test',
  })
}

async function collect(adapter: SolutionSourceAdapter, limit = 50) {
  const outcome = await adapter.collect({
    allowedHosts: adapter.requiredHosts,
    signal: new AbortController().signal,
    limit,
  })
  if (outcome.kind !== 'components') throw new Error(`expected components, got ${outcome.kind}`)
  return outcome.components
}

describe('a posting becomes a role and never a claim', () => {
  it('produces human_role components with no capabilities from any feed', async () => {
    respondWith({ data: [{ slug: 's1', title: 'Rust Developer', url: 'https://www.arbeitnow.com/jobs/s1', company_name: 'Acme' }] })
    const [component] = await collect(arbeitnowJobsAdapter)

    expect(component.kind).toBe('human_role')
    // A job ad states what an employer wants; it says nothing about what anyone can do. A claim here would
    // let the composer read "someone advertised for a Rust developer" as evidence one exists and is free.
    expect(component.capabilities).toEqual([])
  })

  it('declares the same metadata keys for every feed, because they share one adapter', () => {
    // The register's `allowed_fields` is written from this list. When the four had narrower lists,
    // `assertAdapterFieldsAreRegistered` reported keys the register would silently drop — which is exactly
    // what that check exists to catch.
    const keys = JOB_FEED_ADAPTERS.map((adapter) => [...adapter.metadataKeys].sort().join(','))
    expect(new Set(keys).size).toBe(1)
    expect(JOB_FEED_ADAPTERS).toHaveLength(4)
  })
})

describe('descriptions become prose, not markup', () => {
  it('decodes entities before stripping tags', async () => {
    // Arbeitnow double-escapes: the body arrives as `&lt;p&gt;`. Stripping first and decoding second left
    // `<p><strong>Location: </strong>Munich</p>` as literal text in the catalog — markup as content, in a
    // field the composer quotes to a user.
    respondWith({ data: [{
      slug: 's1', title: 'Role', url: 'https://www.arbeitnow.com/jobs/s1',
      description: '&lt;p&gt;&lt;strong&gt;Location: &lt;/strong&gt;Munich&lt;/p&gt;',
    }] })
    const [component] = await collect(arbeitnowJobsAdapter)

    expect(component.metadata.summary).toBe('Location: Munich')
    expect(component.metadata.summary).not.toContain('<')
  })

  it('strips ordinary HTML too', async () => {
    respondWith({ data: [{
      slug: 's1', title: 'Role', url: 'https://www.arbeitnow.com/jobs/s1',
      description: '<p>Jobbeschreibung</p>\n<p>Finance Leadership f&uuml;r eine Wachstumsgeschichte</p>',
    }] })
    const [component] = await collect(arbeitnowJobsAdapter)
    // `&uuml;` decodes rather than surviving as literal text or being replaced with a gap. The first
    // version of this replaced every numeric entity with a space, so `&#x26;` became a hole in the prose.
    expect(component.metadata.summary).toBe('Jobbeschreibung Finance Leadership f\u00fcr eine Wachstumsgeschichte')
  })

  it('decodes entities in tags, so an index term matches what a person types', async () => {
    respondWith({ jobs: [{
      id: 1, jobTitle: 'PM', url: 'https://jobicy.com/jobs/1', jobIndustry: ['Product &amp; Operations'],
    }] })
    const [component] = await collect(jobicyJobsAdapter)
    expect(component.metadata.tags).toEqual(['Product & Operations'])
  })
})

describe('a company we cannot name is null, not a placeholder', () => {
  it('rejects the placeholder Himalayas served for every posting', async () => {
    // Observed live: `"companyName": "name"` for all eight postings in a response, twenty minutes after the
    // same endpoint returned real names. Their bug, but storing it would be a false statement about a company
    // and would land in the lexical index.
    respondWith({ jobs: [{ guid: 'g1', title: 'Engineer', applicationLink: 'https://himalayas.app/jobs/g1', companyName: 'name' }] })
    const [component] = await collect(himalayasJobsAdapter)
    expect(component.metadata.companyName).toBeNull()
  })

  it('keeps a real company name', async () => {
    respondWith({ jobs: [{ guid: 'g1', title: 'Engineer', applicationLink: 'https://himalayas.app/jobs/g1', companyName: 'Kojo' }] })
    const [component] = await collect(himalayasJobsAdapter)
    expect(component.metadata.companyName).toBe('Kojo')
  })
})

describe('Remote OK', () => {
  it('skips the legal notice at array position zero', async () => {
    respondWith([
      { last_updated: 1785600013, legal: 'API Terms of Service: Please link back ...' },
      { id: '1', position: 'Backend Engineer', url: 'https://remoteok.com/remote-jobs/1', company: 'Acme' },
    ])
    const components = await collect(remoteOkJobsAdapter)
    expect(components).toHaveLength(1)
    expect(components[0].displayName).toBe('Backend Engineer')
  })

  it('repairs double-encoded titles', async () => {
    // "Thực Tập Sinh" arrives as UTF-8 bytes that were decoded as latin-1 and re-encoded. Storing it would
    // put permanent mojibake in a component's display name *and its slug*.
    respondWith([
      { legal: 'x' },
      // Written as explicit escapes, not as pasted mojibake. The bytes matter: an earlier version of this
      // fixture was typed literally and lost a C1 control character, which made the string genuinely invalid
      // UTF-8 — so the repair correctly declined it and the test failed for the wrong reason.
      { id: '1', position: 'Th\u00e1\u00bb\u00b1c T\u00e1\u00ba\u00adp Sinh', url: 'https://remoteok.com/remote-jobs/1' },
    ])
    const [component] = await collect(remoteOkJobsAdapter)
    expect(component.displayName).toBe('Th\u1ef1c T\u1eadp Sinh')
  })

  it('marks every posting remote and leaves the salary currency unknown', async () => {
    respondWith([
      { legal: 'x' },
      { id: '1', position: 'Engineer', url: 'https://remoteok.com/remote-jobs/1', salary_min: 80000, salary_max: 120000 },
    ])
    const [component] = await collect(remoteOkJobsAdapter)
    expect(component.metadata.remote).toBe(true)
    expect(component.metadata.salaryMin).toBe(80000)
    // Their fields carry no currency. A wrong currency on a cost estimate is worse than a missing one.
    expect(component.metadata.salaryCurrency).toBeNull()
  })
})

describe('the UTF-8 repair is guarded, not blanket', () => {
  it('repairs only what is actually double-encoded', () => {
    expect(repairDoubleEncodedUtf8('Th\u00e1\u00bb\u00b1c T\u00e1\u00ba\u00adp')).toBe('Th\u1ef1c T\u1eadp')
    expect(repairDoubleEncodedUtf8('T\u00c3\u00a9l\u00c3\u00a9travail')).toBe('T\u00e9l\u00e9travail')
  })

  it('leaves correct text alone, including legitimately accented text', () => {
    // The counter-case that makes a blanket round-trip wrong: "København" is valid latin-1-range text whose
    // bytes are not valid UTF-8, so the repair must decline it.
    expect(repairDoubleEncodedUtf8('København')).toBe('København')
    expect(repairDoubleEncodedUtf8('Kojo')).toBe('Kojo')
    expect(repairDoubleEncodedUtf8('bge-small-en-v1.5')).toBe('bge-small-en-v1.5')
    // Already-correct text above the latin-1 range proves the mis-encoding did not happen.
    expect(repairDoubleEncodedUtf8('日本語')).toBe('日本語')
  })
})

describe('bounds and failure reporting', () => {
  it('respects the runner limit', async () => {
    respondWith({ data: Array.from({ length: 40 }, (_, i) => ({ slug: `s${i}`, title: `Role ${i}`, url: `https://www.arbeitnow.com/jobs/s${i}` })) })
    expect(await collect(arbeitnowJobsAdapter, 5)).toHaveLength(5)
  })

  it('deduplicates a posting that appears twice', async () => {
    respondWith({ data: [
      { slug: 'same', title: 'Role', url: 'https://www.arbeitnow.com/jobs/same' },
      { slug: 'same', title: 'Role again', url: 'https://www.arbeitnow.com/jobs/same' },
    ] })
    expect(await collect(arbeitnowJobsAdapter)).toHaveLength(1)
  })

  it('skips a posting with no stable id rather than minting one', async () => {
    // Without the source's own id, a reworded title would create a second component for the same posting on
    // every refresh.
    respondWith({ data: [
      { title: 'No slug', url: 'https://www.arbeitnow.com/jobs/x' },
      { slug: 'ok', title: 'Has slug', url: 'https://www.arbeitnow.com/jobs/ok' },
    ] })
    const components = await collect(arbeitnowJobsAdapter)
    expect(components.map((c) => c.externalId)).toEqual(['ok'])
  })

  it('reports an unrecognised shape as failed, not as an empty batch', async () => {
    // A silent empty result looks identical to a source with no data, and the catalog would go stale with
    // nobody noticing.
    respondWith({ unexpected: true })
    const outcome = await arbeitnowJobsAdapter.collect({
      allowedHosts: ['www.arbeitnow.com'], signal: new AbortController().signal, limit: 10,
    })
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'unexpected_response_shape' })
  })

  it('reports a rate limit as retry', async () => {
    mocks.safeFetch.mockClear()
    mocks.safeFetch.mockRejectedValue(new SafeFetchError('rate_limited', 'slow down'))
    const outcome = await jobicyJobsAdapter.collect({
      allowedHosts: ['jobicy.com'], signal: new AbortController().signal, limit: 10,
    })
    expect(outcome).toMatchObject({ kind: 'retry', reason: 'rate_limited' })
  })

  it('allows the www host Arbeitnow redirects to', () => {
    // The documented host 301s to www. `safeFetch` revalidates every redirect hop against the allowlist, so
    // omitting www kills the request on its first hop.
    expect(arbeitnowJobsAdapter.requiredHosts).toContain('arbeitnow.com')
    expect(arbeitnowJobsAdapter.requiredHosts).toContain('www.arbeitnow.com')
  })

  it('never contacts a host outside the allowlist it was given', async () => {
    respondWith({ jobs: [{ guid: 'g1', title: 'Engineer', applicationLink: 'https://himalayas.app/jobs/g1' }] })
    await collect(himalayasJobsAdapter, 5)
    for (const [url] of mocks.safeFetch.mock.calls as Array<[string]>) {
      expect(himalayasJobsAdapter.requiredHosts).toContain(new URL(url).hostname)
    }
  })
})
