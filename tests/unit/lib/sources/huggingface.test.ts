/**
 * Top-author enrichment in the Hugging Face connector
 * (plans/phase-1/13-huggingface-integration/tasks.md — "Enrich top authors with avatar + real followers").
 *
 * The connector's own contract is that enrichment is *decoration*: it upgrades the top authors when Hugging
 * Face answers, and produces byte-identical output when it does not. Both halves are asserted here, because
 * only one of them is checkable by looking at a working search — the degraded path is invisible until the
 * endpoint is down, which is precisely when it matters.
 *
 * Everything is against a stubbed `fetch`. The live behaviour was verified separately (recorded in the plan),
 * and pinning real usernames here would make the suite fail the day someone gains a follower.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HF_ENRICH_LIMIT, searchHuggingFace } from '~/lib/sources/huggingface'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** One model per author, with descending downloads so author order is deterministic. */
function modelsFor(authors: string[]) {
  return authors.map((author, index) => ({
    _id: `id-${author}`,
    id: `${author}/model`,
    likes: 10 + index,
    private: false,
    downloads: 10_000 - index * 100,
    tags: ['text-generation'],
    pipeline_tag: 'text-generation',
    library_name: 'transformers',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelId: `${author}/model`,
    author,
  }))
}

/**
 * Routes a stubbed fetch by URL shape.
 *
 * `users` and `orgs` are separate maps on purpose — the split between the two endpoints is the thing under
 * test, so a stub that answered both from one map could not tell the two paths apart.
 */
function stubHuggingFace(options: {
  authors: string[]
  users?: Record<string, { avatarUrl?: string; numFollowers?: number }>
  orgs?: Record<string, { avatarUrl?: string }>
}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/api/models')) return jsonResponse(modelsFor(options.authors))

    const userMatch = /\/api\/users\/([^/]+)\/overview/.exec(url)
    if (userMatch) {
      const found = options.users?.[decodeURIComponent(userMatch[1]!)]
      return found ? jsonResponse(found) : jsonResponse({ error: 'This user does not exist' }, 404)
    }

    const orgMatch = /\/api\/organizations\/([^/]+)\/overview/.exec(url)
    if (orgMatch) {
      const found = options.orgs?.[decodeURIComponent(orgMatch[1]!)]
      return found ? jsonResponse(found) : jsonResponse({ error: 'not found' }, 404)
    }

    throw new Error(`unexpected fetch: ${url}`)
  }))
  return calls
}

function peopleOf(results: Awaited<ReturnType<typeof searchHuggingFace>>) {
  return results.filter((result) => result.kind === 'person')
}

describe('huggingface top-author enrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the likes proxy with the real follower count for a user account', async () => {
    /**
     * The point of the feature. Before enrichment an author's `followersCount` is total *likes* — a proxy
     * standing in for a number Hugging Face will actually tell us. `totalLikes` must survive in `metadata`, so
     * the proxy stays visible next to what replaced it rather than being overwritten and lost.
     */
    stubHuggingFace({
      authors: ['solo-dev'],
      users: { 'solo-dev': { avatarUrl: 'https://cdn.hf.test/solo.png', numFollowers: 4242 } },
    })

    const [person] = peopleOf(await searchHuggingFace(['llama']))
    expect(person!.followersCount).toBe(4242)
    expect(person!.avatarUrl).toBe('https://cdn.hf.test/solo.png')
    expect(person!.metadata.followersSource).toBe('huggingface_profile')
    expect(person!.metadata.totalLikes, 'the aggregate must survive the replacement').toBe(10)
  })

  it('falls back to the organizations endpoint, which supplies an avatar but never followers', async () => {
    /**
     * The reason this is two endpoints. Checked live: the highest-download authors on Hugging Face are mostly
     * organizations, and every one of them 404s on `/api/users/…`. Enriching only through the users endpoint
     * would have left exactly the authors this feature exists for with no avatar.
     *
     * An organization reports `numUsers`/`numModels` and no follower count at all, so it keeps the likes proxy
     * — calling `numUsers` a follower count would be inventing a metric. `followersSource` stays absent, which
     * is what tells a reader the number is still a proxy.
     */
    const calls = stubHuggingFace({
      authors: ['big-lab'],
      orgs: { 'big-lab': { avatarUrl: 'https://cdn.hf.test/lab.png' } },
    })

    const [person] = peopleOf(await searchHuggingFace(['llama']))
    expect(person!.avatarUrl).toBe('https://cdn.hf.test/lab.png')
    expect(person!.followersCount, 'an organization has no follower count to borrow').toBe(10)
    expect(person!.metadata.followersSource).toBeUndefined()

    // Users first, organizations only after that 404 — the order is what makes a real follower count reachable.
    expect(calls.some((url) => url.includes('/api/users/big-lab/overview'))).toBe(true)
    expect(calls.some((url) => url.includes('/api/organizations/big-lab/overview'))).toBe(true)
  })

  it('produces the same result as no enrichment when both endpoints fail', async () => {
    /**
     * The degradation contract, and the half that is invisible in a working search. A search must not become
     * emptier or differently shaped because a decoration endpoint is unavailable — so this compares the whole
     * result set against a run where the overview endpoints answer nothing at all.
     */
    stubHuggingFace({ authors: ['a-dev', 'b-dev'] })
    const degraded = await searchHuggingFace(['llama'])
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/api/models')) return jsonResponse(modelsFor(['a-dev', 'b-dev']))
      throw new Error('network down')
    }))
    const thrown = await searchHuggingFace(['llama'])

    expect(thrown).toEqual(degraded)
    expect(peopleOf(thrown).every((person) => person.avatarUrl === undefined)).toBe(true)
  })

  it(`enriches at most ${HF_ENRICH_LIMIT} authors, and the rest are untouched`, async () => {
    /**
     * The bound is what keeps the added latency to one parallel burst. Asserting it from the *outside* — the
     * sixth author has no avatar even though the stub would happily have given it one — is stronger than
     * counting calls, because it pins the observable consequence rather than the implementation.
     */
    const authors = Array.from({ length: HF_ENRICH_LIMIT + 2 }, (_, index) => `dev-${index}`)
    stubHuggingFace({
      authors,
      users: Object.fromEntries(
        authors.map((author, index) => [author, { avatarUrl: `https://cdn.hf.test/${author}.png`, numFollowers: 100 + index }]),
      ),
    })

    const people = peopleOf(await searchHuggingFace(['llama'], { perPage: 50 }))
    expect(people).toHaveLength(authors.length)
    for (const person of people.slice(0, HF_ENRICH_LIMIT)) {
      expect(person.avatarUrl, `${person.username} should have been enriched`).toBeTruthy()
    }
    for (const person of people.slice(HF_ENRICH_LIMIT)) {
      expect(person.avatarUrl, `${person.username} is past the limit and must be untouched`).toBeUndefined()
    }
  })

  it('never gives an author another author\'s avatar', async () => {
    /**
     * The zip between the lookup results and the author list is positional, so a reordering bug would attach
     * the wrong avatar to the wrong person — a defect that produces a perfectly plausible-looking page. Only
     * the middle author gets a distinctive avatar, so a shift by one is immediately visible.
     */
    stubHuggingFace({
      authors: ['first', 'second', 'third'],
      users: { second: { avatarUrl: 'https://cdn.hf.test/second-only.png', numFollowers: 7 } },
    })

    const people = peopleOf(await searchHuggingFace(['llama']))
    expect(people.map((person) => [person.username, person.avatarUrl])).toEqual([
      ['first', undefined],
      ['second', 'https://cdn.hf.test/second-only.png'],
      ['third', undefined],
    ])
    expect(people[1]!.followersCount).toBe(7)
  })
})
