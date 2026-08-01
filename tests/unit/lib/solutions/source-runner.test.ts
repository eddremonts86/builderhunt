/**
 * plans/phase-1/43-solutions-intelligence Phase 4 — the adapter runner's gates, and the crawl
 * adapter's safety envelope.
 *
 * The runner holds every gate so no adapter has to remember one. These tests are what stop a future
 * adapter from quietly bypassing the register, the kill switch or the host allowlist.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn(), isPathAllowedByRobots: vi.fn() }))

vi.mock('~/lib/enrichment/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/enrichment/network')>()
  return { ...actual, safeFetch: mocks.safeFetch }
})
vi.mock('~/lib/enrichment/robots', () => ({ isPathAllowedByRobots: mocks.isPathAllowedByRobots }))

const { solutionSources } = await import('~/shared/lib/db/schema')
const { assertAdapterFieldsAreRegistered, filterToAllowedFields, runSolutionSourceAdapter } = await import('~/lib/solutions/sources/runner')
const { createDocumentationCrawlAdapter } = await import('~/lib/solutions/sources/documentation-crawl')
const { huggingFaceModelsAdapter } = await import('~/lib/solutions/sources/huggingface')
type SolutionSourceAdapter = import('~/lib/solutions/sources/types').SolutionSourceAdapter

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_source_runner')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.isPathAllowedByRobots.mockResolvedValue('allowed')
  await db.execute(sql`
    truncate solution_component_capabilities, solution_compatibility_edges, solution_evidence,
             solution_component_versions, solution_components, solution_capabilities, solution_sources cascade
  `)
  await db.execute(sql`insert into solution_capabilities (key, label) values ('translation', 'Translation')`)
  await db.insert(solutionSources).values({
    key: 'probe',
    kind: 'official_api',
    label: 'Probe',
    homepageUrl: 'https://probe.test',
    enabled: true,
    allowedFields: ['title', 'summary'],
  })
})

/** A deterministic adapter, so the tests exercise the runner rather than any real upstream. */
function fakeAdapter(overrides: Partial<SolutionSourceAdapter> = {}, components: unknown[] = []): SolutionSourceAdapter {
  return {
    sourceKey: 'probe',
    acquisitionMode: 'official_api',
    requiredHosts: ['probe.test'],
    metadataKeys: ['title', 'summary'],
    collect: vi.fn().mockResolvedValue({ kind: 'components', components }),
    ...overrides,
  } as SolutionSourceAdapter
}

const oneComponent = [{
  kind: 'tool' as const,
  slug: 'thing',
  displayName: 'Thing',
  metadata: { title: 'Thing', summary: 'Does things', secret: 'must not be stored' },
  capabilities: [{ capabilityKey: 'translation', evidenceLevel: 'claimed' as const }],
  sourceUrl: 'https://probe.test/thing',
}]

const run = (adapter: SolutionSourceAdapter) =>
  runSolutionSourceAdapter(adapter, { readDb: db, writeDb: db })

describe('the runner holds the gates', () => {
  it('refuses an adapter with no register row', async () => {
    const adapter = fakeAdapter({ sourceKey: 'unregistered' })
    expect(await run(adapter)).toMatchObject({ status: 'skipped', reason: 'source_not_registered' })
    // Nothing recorded what this source is, who reviewed it, or what it may store.
    expect(adapter.collect).not.toHaveBeenCalled()
  })

  it('refuses a disabled source without calling the adapter at all', async () => {
    await db.execute(sql`update solution_sources set enabled = false where key = 'probe'`)
    const adapter = fakeAdapter({}, oneComponent)

    expect(await run(adapter)).toMatchObject({ status: 'skipped', reason: 'source_disabled' })
    // The kill switch has to prevent the fetch, not just the write — otherwise a disabled source is
    // still being contacted.
    expect(adapter.collect).not.toHaveBeenCalled()
  })

  it('refuses when the adapter and the register disagree about acquisition mode', async () => {
    // An adapter claiming official_api against a register entry marked public_scrape is a mismatch to
    // refuse, not to reconcile: one of the two is wrong about what this source is.
    const adapter = fakeAdapter({ acquisitionMode: 'public_scrape' })
    expect(await run(adapter)).toMatchObject({ status: 'skipped', reason: 'mode_mismatch' })
  })

  it('passes only the intersection of adapter-requested and register-permitted hosts', async () => {
    const adapter = fakeAdapter({ requiredHosts: ['probe.test', 'evil.example.com'] }, oneComponent)
    await run(adapter)

    const context = (adapter.collect as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // An adapter cannot widen its own allowlist by asking for another host.
    expect(context.allowedHosts).toEqual(['probe.test'])
  })

  it('fails when no requested host is permitted, rather than fetching with an empty allowlist', async () => {
    const adapter = fakeAdapter({ requiredHosts: ['elsewhere.example.com'] })
    expect(await run(adapter)).toMatchObject({ status: 'failed', reason: 'no_permitted_host' })
    expect(adapter.collect).not.toHaveBeenCalled()
  })

  it('allows a subdomain of the registered homepage host', async () => {
    const adapter = fakeAdapter({ requiredHosts: ['api.probe.test'] }, [])
    await run(adapter)
    const context = (adapter.collect as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(context.allowedHosts).toContain('api.probe.test')
  })

  it('surfaces a retryable upstream as retry, not failure', async () => {
    const adapter = fakeAdapter({ collect: vi.fn().mockResolvedValue({ kind: 'retry', reason: 'rate_limited' }) })
    expect(await run(adapter)).toMatchObject({ status: 'retry', reason: 'rate_limited' })
  })

  it('does not let an adapter throw take the run down', async () => {
    const adapter = fakeAdapter({ collect: vi.fn().mockRejectedValue(new Error('boom')) })
    expect(await run(adapter)).toMatchObject({ status: 'failed', reason: 'boom' })
  })

  it('stops mid-batch when the source is switched off during the run', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      ...oneComponent[0], slug: `thing-${i}`, displayName: `Thing ${i}`,
    }))
    const adapter = fakeAdapter({
      collect: vi.fn().mockImplementation(async () => {
        // The operator flips the switch while the adapter is fetching.
        await db.execute(sql`update solution_sources set enabled = false where key = 'probe'`)
        return { kind: 'components', components: many }
      }),
    })

    const result = await run(adapter)
    // An immediate kill switch must not wait for the current batch to drain.
    expect(result).toMatchObject({ status: 'completed', created: 0 })
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_components`)
    expect(rows[0].count).toBe(0)
  })
})

describe('the register decides what gets stored', () => {
  it('drops metadata keys the register does not list', async () => {
    await run(fakeAdapter({}, oneComponent))

    const rows = await db.execute<{ metadata: Record<string, unknown> }>(sql`select metadata from solution_component_versions`)
    // This is where the source register stops being paperwork: widening what a source contributes
    // requires editing the register, not the adapter.
    expect(rows[0].metadata).toEqual({ title: 'Thing', summary: 'Does things' })
    expect(JSON.stringify(rows[0].metadata)).not.toContain('must not be stored')
  })

  it('counts a component left empty by the filter instead of storing a blank one', async () => {
    const mismatched = [{ ...oneComponent[0], metadata: { unlisted: 'x', alsoUnlisted: 'y' } }]
    const result = await run(fakeAdapter({}, mismatched))

    // A non-zero count means the adapter and its register entry disagree about what this source
    // publishes — the exact mismatch that would otherwise look like "the source has no data".
    expect(result).toMatchObject({ status: 'completed', created: 0, emptyAfterFieldFilter: 1 })
  })

  it('stores nothing at all for a source whose allowed_fields is empty', async () => {
    await db.execute(sql`update solution_sources set allowed_fields = '[]'::jsonb where key = 'probe'`)
    const result = await run(fakeAdapter({}, oneComponent))
    // external_link_only sources are constrained to this shape, so it must genuinely store nothing.
    expect(result).toMatchObject({ emptyAfterFieldFilter: 1, created: 0 })
    expect(filterToAllowedFields({ a: 1 }, [])).toEqual({})
  })

  it('drops null values rather than versioning them as content', async () => {
    expect(filterToAllowedFields({ title: 'x', summary: null }, ['title', 'summary'])).toEqual({ title: 'x' })
  })

  it('attaches capability claims with the evidence that supports them', async () => {
    await run(fakeAdapter({}, oneComponent))
    const rows = await db.execute<{ level: string; evidence: string }>(sql`
      select evidence_level as level, primary_evidence_id as evidence from solution_component_capabilities
    `)
    expect(rows).toHaveLength(1)
    // An adapter's own read of a vendor label is `claimed`, never promoted.
    expect(rows[0].level).toBe('claimed')
    expect(rows[0].evidence).toBeTruthy()
  })

  it('does not re-attach claims on an unchanged refresh', async () => {
    await run(fakeAdapter({}, oneComponent))
    const first = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_evidence`)
    await run(fakeAdapter({}, oneComponent))
    const second = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_evidence`)
    expect(second[0].count).toBe(first[0].count)
  })

  it('versions on a real metadata change', async () => {
    await run(fakeAdapter({}, oneComponent))
    const changed = [{ ...oneComponent[0], metadata: { title: 'Thing', summary: 'Does other things' } }]
    expect(await run(fakeAdapter({}, changed))).toMatchObject({ versioned: 1 })
  })
})

describe('the crawl adapter cannot be talked into fetching', () => {
  const target = {
    sourceKey: 'probe',
    host: 'probe.test',
    paths: ['/docs/a'],
    componentKind: 'tool' as const,
    allowedCapabilityKeys: ['translation'],
  }

  beforeEach(async () => {
    await db.execute(sql`
      update solution_sources set kind = 'public_scrape', terms_reviewed_at = now() where key = 'probe'
    `)
  })

  it('does not fetch a path robots.txt disallows', async () => {
    mocks.isPathAllowedByRobots.mockResolvedValue('disallowed')
    await run(createDocumentationCrawlAdapter(target))
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('treats an unreadable robots.txt as disallowed', async () => {
    mocks.isPathAllowedByRobots.mockResolvedValue('unavailable')
    await run(createDocumentationCrawlAdapter(target))
    // "We could not check whether we were allowed" is not permission. The enrichment path can afford
    // to proceed here; a catalog crawl cannot.
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('checks robots per path, not once per host', async () => {
    mocks.isPathAllowedByRobots.mockImplementation(async (_o: string, path: string) =>
      path === '/docs/allowed' ? 'allowed' : 'disallowed')
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'text/html', finalUrl: 'https://probe.test/docs/allowed',
      body: '<title>Allowed</title><meta name="description" content="ok">',
    })

    await run(createDocumentationCrawlAdapter({ ...target, paths: ['/docs/allowed', '/internal/secret'] }))

    // robots.txt can allow /docs and forbid /internal; a host-level check would miss that.
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1)
    expect(mocks.safeFetch.mock.calls[0][0]).toBe('https://probe.test/docs/allowed')
  })

  it('fetches through safeFetch with the register-permitted allowlist and an honest user agent', async () => {
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'text/html', finalUrl: 'https://probe.test/docs/a',
      body: '<title>Doc A</title><meta name="description" content="Summary A">',
    })
    await run(createDocumentationCrawlAdapter(target))

    const [, options] = mocks.safeFetch.mock.calls[0]
    expect(options.allowedHosts).toEqual(['probe.test'])
    expect(options.userAgent).toContain('BuilderHuntBot')
  })

  it('extracts only the title and description, and claims no capabilities', async () => {
    await db.execute(sql`update solution_sources set allowed_fields = '["summary","crawledPath"]'::jsonb where key='probe'`)
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'text/html', finalUrl: 'https://probe.test/docs/a',
      body: '<title>Doc &amp; A</title><meta name="description" content="Summary A"><p>Author: Jane Doe</p>',
    })

    await run(createDocumentationCrawlAdapter(target))

    const rows = await db.execute<{ display: string; metadata: Record<string, unknown> }>(sql`
      select c.display_name as display, v.metadata
      from solution_components c join solution_component_versions v on v.component_id = c.id
    `)
    expect(rows[0].display).toBe('Doc & A')
    expect(rows[0].metadata).toMatchObject({ summary: 'Summary A' })
    // A byline is a person who did not ask to be catalogued.
    expect(JSON.stringify(rows[0])).not.toContain('Jane Doe')

    const claims = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_component_capabilities`)
    // "The docs mention translation" is not "this tool translates". Crawled capabilities need a reviewer.
    expect(claims[0].count).toBe(0)
  })

  it('yields no component for an untitled page', async () => {
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'text/html', finalUrl: 'https://probe.test/docs/a', body: '<p>no title here</p>',
    })
    const result = await run(createDocumentationCrawlAdapter(target))
    // A catalog entry called "Untitled" is worse than an absent one.
    expect(result).toMatchObject({ created: 0 })
  })

  it('skips a page the safety envelope refuses and keeps going', async () => {
    const { SafeFetchError } = await import('~/lib/enrichment/network')
    mocks.safeFetch
      .mockRejectedValueOnce(new SafeFetchError('private_network', 'blocked'))
      .mockResolvedValueOnce({
        status: 200, contentType: 'text/html', finalUrl: 'https://probe.test/docs/b',
        body: '<title>Doc B</title><meta name="description" content="B">',
      })

    const result = await run(createDocumentationCrawlAdapter({ ...target, paths: ['/docs/a', '/docs/b'] }))
    // One refused page does not condemn the whole target.
    expect(result).toMatchObject({ status: 'completed', created: 1 })
  })
})

describe('the Hugging Face adapter maps rather than guesses', () => {
  beforeEach(async () => {
    await db.execute(sql`
      update solution_sources
      set key = 'huggingface_models', homepage_url = 'https://huggingface.co',
          allowed_fields = '["pipelineTag","downloads","tags"]'::jsonb
      where key = 'probe'
    `)
    await db.execute(sql`insert into solution_capabilities (key, label) values ('summarization','Summarization') on conflict do nothing`)
  })

  it('claims a capability only for a mapped pipeline tag', async () => {
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'application/json', finalUrl: 'https://huggingface.co/api/models',
      body: JSON.stringify([
        { id: 'org/summariser', pipeline_tag: 'summarization', downloads: 10, tags: ['x'] },
        { id: 'org/mystery', pipeline_tag: 'some-brand-new-task', downloads: 5, tags: [] },
      ]),
    })

    await runSolutionSourceAdapter(huggingFaceModelsAdapter, { readDb: db, writeDb: db })

    const claims = await db.execute<{ slug: string; capability: string }>(sql`
      select c.slug, cap.capability_key as capability
      from solution_components c
      left join solution_component_capabilities cap on cap.component_id = c.id
      order by c.slug
    `)
    // An unmapped tag yields no claim rather than a guessed one — a wrong capability is what makes the
    // composer recommend a model for work it cannot do.
    expect(claims.find((r) => r.slug === 'org/mystery')?.capability).toBeNull()
    expect(claims.find((r) => r.slug === 'org/summariser')?.capability).toBe('summarization')
  })

  it('reports a changed upstream shape as failed rather than as an empty source', async () => {
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'application/json', finalUrl: 'https://huggingface.co/api/models',
      body: JSON.stringify({ models: [] }),
    })
    // An adapter that silently returns nothing on a schema change looks identical to a source with no
    // data, and the catalog would go stale unnoticed.
    expect(await runSolutionSourceAdapter(huggingFaceModelsAdapter, { readDb: db, writeDb: db }))
      .toMatchObject({ status: 'failed', reason: 'expected_array' })
  })

  it('treats a 429 as retryable', async () => {
    mocks.safeFetch.mockResolvedValue({ status: 429, contentType: 'application/json', finalUrl: 'x', body: '' })
    expect(await runSolutionSourceAdapter(huggingFaceModelsAdapter, { readDb: db, writeDb: db }))
      .toMatchObject({ status: 'retry', reason: 'rate_limited' })
  })

  it('skips a malformed entry without discarding the batch', async () => {
    mocks.safeFetch.mockResolvedValue({
      status: 200, contentType: 'application/json', finalUrl: 'x',
      body: JSON.stringify([{ id: 'org/good', pipeline_tag: 'summarization', downloads: 1 }, { id: 42 }, null]),
    })
    expect(await runSolutionSourceAdapter(huggingFaceModelsAdapter, { readDb: db, writeDb: db }))
      .toMatchObject({ status: 'completed', created: 1 })
  })
})


describe('every adapter reads only fields its register entry approved', () => {
  /**
   * The regression this locks down cost a whole catalog. `filterToAllowedFields` drops what the register
   * does not name — that is what makes the register load-bearing — so a snake_case/camelCase mismatch is
   * invisible unless *every* key is dropped. The Hugging Face register said `pipeline_tag` while the
   * adapter emitted `pipelineTag`; `downloads` matched, so the runner reported a clean run and stored
   * nothing but download counts.
   *
   * Run against the seeded register (migrations 0126 and 0127), which is the register a deploy actually
   * gets — asserting against a fixture would have missed the original bug entirely, because the fixture
   * would have been written from the adapter.
   */
  it('agrees with the seeded register in both directions', async () => {
    const { huggingFaceModelsAdapter } = await import('~/lib/solutions/sources/huggingface')
    const { npmRegistryAdapter } = await import('~/lib/solutions/sources/npm')
    const { jobindexRolesAdapter } = await import('~/lib/solutions/sources/jobindex')

    // The seeded register lives in migrations, and this disposable database has them applied — but
    // `beforeEach` truncates solution_sources to build the runner fixtures, so re-apply the three rows
    // the real seed inserts.
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, allowed_fields) values
        ('huggingface_models', 'official_api', 'HF', 'https://huggingface.co',
         '["pipelineTag","libraryName","downloads","likes","tags"]'),
        ('npm_registry', 'official_api', 'npm', 'https://registry.npmjs.org',
         '["description","version","keywords"]'),
        ('jobindex_roles', 'feed', 'Jobindex', 'https://www.jobindex.dk',
         '["roleTitle","companyName","area","summary","postingUrl","publishedAt"]')
    `)

    const problems = await assertAdapterFieldsAreRegistered(
      [huggingFaceModelsAdapter, npmRegistryAdapter, jobindexRolesAdapter],
      db,
    )
    expect(problems, JSON.stringify(problems)).toEqual([])
  })

  it('reports a field the register would silently drop', async () => {
    // The check has to be load-bearing, so prove it catches the exact original mistake: a register
    // naming the snake_case spelling of a key the adapter emits in camelCase.
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, allowed_fields)
      values ('huggingface_models', 'official_api', 'HF', 'https://huggingface.co',
              '["name","pipeline_tag","license","downloads"]')
    `)
    const { huggingFaceModelsAdapter } = await import('~/lib/solutions/sources/huggingface')
    const problems = await assertAdapterFieldsAreRegistered([huggingFaceModelsAdapter], db)

    expect(problems).toHaveLength(1)
    expect(problems[0].droppedByRegister).toEqual(['pipelineTag', 'libraryName', 'likes', 'tags'])
    expect(problems[0].registeredButNeverEmitted).toEqual(['name', 'pipeline_tag', 'license'])
  })
})


describe('every capability an adapter can emit exists in the vocabulary', () => {
  /**
   * The third seeding gap, and the one that failed loudest once the other two were fixed:
   * `solution_capabilities` was empty on every fresh database, and
   * `solution_component_capabilities.capability_key` is a foreign key into it. The first real ingestion
   * run died on `23503 ... Key (capability_key)=(embedding) is not present`.
   *
   * The unit tests had not caught it because their fixture inserts the one capability they need
   * (`translation`), which satisfies the FK for that key and leaves the other ten untested. So this test
   * asserts against the *migration-seeded* rows, not a fixture.
   */
  it('seeds exactly the keys and labels the typed vocabulary declares', async () => {
    const { SOLUTION_CAPABILITIES } = await import('~/shared/lib/solutions/contracts')
    const { readFile } = await import('node:fs/promises')

    // Read the migration itself rather than the table. `beforeEach` truncates solution_capabilities to
    // build the runner fixtures, so querying it here would prove nothing — and an earlier draft of this
    // test papered over that by UNIONing a hardcoded key list, which passes whether or not the migration
    // seeds anything. The migration file is the artifact a deploy actually applies, so that is what gets
    // compared.
    const sqlText = await readFile('drizzle/0129_seed_solution_capabilities.sql', 'utf8')
    const seeded = new Map<string, string>()
    for (const [, key, label] of sqlText.matchAll(/^\s*\('([a-z_]+)',\s*'([^']+)'/gm)) {
      seeded.set(key, label)
    }

    expect([...seeded.keys()].sort()).toEqual(SOLUTION_CAPABILITIES.map((c) => c.key).sort())
    for (const capability of SOLUTION_CAPABILITIES) {
      // Labels too: the UI renders the row from the database, so a constant and a migration that agree
      // on keys but disagree on wording still show the wrong thing.
      expect(seeded.get(capability.key)).toBe(capability.label)
    }
  })

  it('maps every adapter capability to a key the vocabulary declares', async () => {
    const { SOLUTION_CAPABILITY_KEYS } = await import('~/shared/lib/solutions/contracts')
    const vocabulary = new Set<string>(SOLUTION_CAPABILITY_KEYS)

    // Reads the adapters' own mapping tables through their public behaviour: feed each adapter a
    // response exercising every branch of its map and check what it claims. Typing the maps as
    // Record<string, SolutionCapabilityKey> makes a typo a compile error; this catches the other
    // direction, a key that type-checks because someone widened the vocabulary and then removed it.
    const { huggingFaceModelsAdapter } = await import('~/lib/solutions/sources/huggingface')
    const pipelineTags = [
      'translation', 'summarization', 'automatic-speech-recognition', 'text-generation',
      'text2text-generation', 'feature-extraction', 'sentence-similarity', 'token-classification',
      'text-classification', 'zero-shot-classification', 'image-to-text',
      'document-question-answering', 'not-a-real-tag',
    ]
    mocks.safeFetch.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pipelineTags.map((tag, i) => ({ id: `org/model-${i}`, pipeline_tag: tag }))),
      finalUrl: 'https://huggingface.co/api/models',
    })
    const outcome = await huggingFaceModelsAdapter.collect({
      allowedHosts: ['huggingface.co'], signal: new AbortController().signal, limit: 50,
    })
    if (outcome.kind !== 'components') throw new Error('expected components')

    const claimed = outcome.components.flatMap((c) => c.capabilities.map((cap) => cap.capabilityKey))
    expect(claimed.length).toBeGreaterThan(0)
    for (const key of claimed) {
      expect(vocabulary.has(key), `adapter claims "${key}", which the vocabulary does not declare`).toBe(true)
    }
    // The unmapped tag must have yielded no claim at all rather than a guess.
    expect(claimed).toHaveLength(pipelineTags.length - 1)
  })
})
