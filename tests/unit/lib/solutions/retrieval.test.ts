/**
 * Hybrid retrieval (plan 43 Phase 5, "Implement hybrid retrieval").
 *
 * The plan's verify line asks for four things: filters are exact, one backend can degrade safely, gold-set
 * recall by lane, and warm p95 within budget. The first two are properties of this code and are asserted
 * here against a real migrated database. Recall and latency need a gold set and a warm cache, which is
 * Phase 9's task and `scripts/evaluate-solutions.ts` — asserting them from a nine-row fixture would produce
 * a number that means nothing.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { solutionBriefSchema, type SolutionBrief } from '~/shared/lib/solutions/contracts'
import { buildLexicalQuery, buildRetrievalFilters } from '~/lib/solutions/retrieval/filters'
import { diversify, evidenceFactor, freshnessFactor, fuseAndScore, RRF_K } from '~/lib/solutions/retrieval/fuse'
import { toAnyTermQuery } from '~/lib/solutions/retrieval/lanes'
import { retrieveForBrief } from '~/lib/solutions/retrieval/retrieve'
import { projectComponents } from '~/lib/solutions/indexing/project-components'

const brief = (overrides: Partial<SolutionBrief> = {}): SolutionBrief => solutionBriefSchema.parse({
  deliverable: { description: 'Translate product documentation from English to Danish', domain: 'translation_and_transcription' },
  capabilities: ['translation'],
  ...overrides,
})

describe('a brief becomes exact filters', () => {
  it('turns hard constraints into filters, not into scoring penalties', () => {
    const filters = buildRetrievalFilters(brief({
      capabilities: ['translation'],
      hardConstraints: [
        { type: 'required_capability', capabilityKey: 'document_understanding' },
        { type: 'excluded_component', componentId: 'c-banned' },
        { type: 'required_integration', integrationKey: 'slack' },
        { type: 'disallowed_regulated_domain', domain: 'medical' },
      ],
    }))

    // A required capability joins the retrieval set as well as the required set: narrowing to only the
    // required ones would hide the components covering everything else the brief asked for.
    expect(filters.capabilityKeys.sort()).toEqual(['document_understanding', 'translation'])
    expect(filters.requiredCapabilityKeys).toEqual(['document_understanding'])
    expect(filters.excludedComponentIds).toEqual(['c-banned'])
    expect(filters.requiredIntegrationKeys).toContain('slack')
    expect(filters.disallowedDomains).toEqual(['medical'])
  })

  it('leaves budget and deadline to the composer', () => {
    // A component has no delivery time until it is placed in a route, and a free model plus a paid human
    // reviewer can exceed a budget neither exceeds alone. Filtering candidates on either would reject
    // combinations that fit and accept ones that do not.
    const filters = buildRetrievalFilters(brief({
      hardConstraints: [
        { type: 'max_budget', maxCents: 1, currency: 'EUR' },
        { type: 'deadline_by', byDate: '2020-01-01' },
        { type: 'max_data_sensitivity', level: 'public' },
      ],
    }))
    expect(filters.excludedComponentIds).toEqual([])
    expect(filters.capabilityKeys).toEqual(['translation'])
  })

  it('keeps budget figures and dates out of the lexical query', () => {
    // They are not words that appear in any component document, so including them would add terms matching
    // nothing while diluting the ones that match.
    const text = buildLexicalQuery(brief({ budget: { status: 'known', value: { maxCents: 500000, currency: 'EUR' } } }))
    expect(text).not.toContain('500000')
    expect(text).toContain('Translate product documentation')
    expect(text).toContain('translation')
  })
})

describe('the lexical query matches any term, not every term', () => {
  it('joins terms with or', () => {
    // The bug this locks down returned zero candidates for every brief from a catalog that held matching
    // components: `websearch_to_tsquery` ANDs unquoted words, so an eleven-word description required all
    // eleven in one document.
    expect(toAnyTermQuery('translate documentation quickly')).toBe('translate or documentation or quickly')
  })

  it('strips the operators websearch_to_tsquery would otherwise honour', () => {
    // `-` reads as NOT, so "English-to-Danish" became "English AND NOT to AND NOT Danish" — a brief
    // excluding what it asked for.
    const query = toAnyTermQuery('English-to-Danish "exact phrase" -excluded')
    expect(query).not.toContain('-')
    expect(query).not.toContain('"')
    expect(query.split(' or ')).toContain('danish')
    expect(query.split(' or ')).toContain('excluded')
  })

  it('drops duplicates and one- or two-character tokens, and caps the term count', () => {
    // "the" survives, and should: the 'english' text-search configuration drops stopwords itself, so
    // filtering them here would duplicate Postgres's own list and then drift from it. The length filter is
    // only about tokens carrying no signal at all.
    expect(toAnyTermQuery('a to the translation translation')).toBe('the or translation')
    expect(toAnyTermQuery('alpha beta gamma delta', 2).split(' or ')).toHaveLength(2)
  })

  it('returns an empty query for input with nothing usable, so the lane skips rather than errors', () => {
    expect(toAnyTermQuery('a - " to')).toBe('')
  })
})

describe('fusion compares ranks, never raw scores', () => {
  const candidate = (id: string, extra: Partial<Parameters<typeof fuseAndScore>[0][number]> = {}) => ({
    componentId: id,
    version: 1,
    kind: 'tool',
    sourceKey: 'npm_registry',
    displayName: id,
    capabilityKeys: ['translation'],
    maxEvidenceLevel: 'claimed' as const,
    observedAt: new Date('2026-08-01T00:00:00Z'),
    ...extra,
  })
  const now = new Date('2026-08-01T00:00:00Z')

  it('ranks a component found by both lanes above one found by either', () => {
    const scored = fuseAndScore(
      [candidate('both'), candidate('lexical-only'), candidate('vector-only')],
      {
        lexical: [{ componentId: 'both', version: 1, rank: 2 }, { componentId: 'lexical-only', version: 1, rank: 1 }],
        vector: [{ componentId: 'both', version: 1, rank: 2 }, { componentId: 'vector-only', version: 1, rank: 1 }],
      },
      now,
    )
    expect(scored[0].componentId).toBe('both')
    expect(scored[0].foundBy).toEqual(['lexical', 'vector'])
    expect(scored[0].fusionScore).toBeCloseTo(2 / (RRF_K + 2), 10)
  })

  it('orders deterministically when scores tie', () => {
    // Two runs of the same brief returning a different order would make a solution run irreproducible,
    // and reproducibility is what lets a recommendation be audited against the evidence it cited.
    const lanes = { lexical: [{ componentId: 'b', version: 1, rank: 1 }, { componentId: 'a', version: 1, rank: 1 }] }
    const first = fuseAndScore([candidate('b'), candidate('a')], lanes, now).map((c) => c.componentId)
    const second = fuseAndScore([candidate('a'), candidate('b')], lanes, now).map((c) => c.componentId)
    expect(first).toEqual(second)
    expect(first).toEqual(['a', 'b'])
  })

  it('lets evidence and freshness modulate relevance without replacing it', () => {
    const lanes = {
      lexical: [{ componentId: 'relevant-unverified', version: 1, rank: 1 }, { componentId: 'irrelevant-verified', version: 1, rank: 40 }],
    }
    const scored = fuseAndScore(
      [candidate('relevant-unverified'), candidate('irrelevant-verified', { maxEvidenceLevel: 'production_evidence' })],
      lanes,
      now,
    )
    // A verified but far-less-relevant component must not leapfrog a highly relevant one. A weighted sum
    // would let it; multiplying by bounded factors cannot.
    expect(scored[0].componentId).toBe('relevant-unverified')
  })

  it('never zeroes an unverified or stale component out of the results', () => {
    // A self-declared claim is still information, and a stale entry for a tool that still exists is stale
    // rather than wrong. Zeroing either would mean a perfectly relevant component never appears at all.
    expect(evidenceFactor('claimed')).toBeGreaterThan(0)
    expect(evidenceFactor('production_evidence')).toBeGreaterThan(evidenceFactor('claimed'))
    expect(freshnessFactor(new Date('2020-01-01T00:00:00Z'), now)).toBeGreaterThan(0)
    expect(freshnessFactor(now, now)).toBe(1)
  })

  it('does not reward a component claiming to be from the future', () => {
    // Clock skew on an ingest host, or a source gaming its way to the top.
    expect(freshnessFactor(new Date('2030-01-01T00:00:00Z'), now)).toBe(1)
  })
})

describe('diversity stops the catalog shape from becoming the answer', () => {
  const make = (id: string, sourceKey: string, kind: string) => ({
    componentId: id, version: 1, kind, sourceKey, displayName: id,
    capabilityKeys: ['translation'], maxEvidenceLevel: 'claimed' as const,
    observedAt: new Date(), fusionScore: 1 / (RRF_K + 1), foundBy: ['lexical'],
    evidenceScore: 1, freshnessScore: 1, finalScore: 1,
  })

  it('caps one source and reports what it dropped', () => {
    // npm has millions of packages. Without a cap, "translation" comes back as fifty npm packages and no
    // service — not because that is the best answer but because that is what was ingested most.
    const outcome = diversify(
      [make('a', 'npm', 'tool'), make('b', 'npm', 'tool'), make('c', 'npm', 'tool'), make('d', 'hf', 'model')],
      { maxPerSource: 2, maxPerKind: 10, limit: 10 },
    )
    expect(outcome.results.map((c) => c.componentId)).toEqual(['a', 'b', 'd'])
    // Reported rather than silently discarded: a silent cap reads as "this is all there was".
    expect(outcome.suppressedBySource).toBe(1)
  })

  it('caps one kind independently of source', () => {
    const outcome = diversify(
      [make('a', 'npm', 'tool'), make('b', 'hf', 'tool'), make('c', 'other', 'tool')],
      { maxPerSource: 10, maxPerKind: 2, limit: 10 },
    )
    expect(outcome.results).toHaveLength(2)
    expect(outcome.suppressedByKind).toBe(1)
  })
})

describe('retrieval against a real database', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('solutions_retrieval')
    db = disposable.db
    drop = disposable.drop
  }, 180_000)

  afterAll(async () => { await drop() })

  beforeEach(async () => {
    await db.execute(sql`
      truncate solution_component_projections, solution_component_capabilities, solution_evidence,
               solution_component_versions, solution_components, builder_embeddings cascade
    `)
    // Built through real components and versions rather than by inserting projections directly. The
    // projections table has a foreign key to `(component_id, version)` — bypassing it would test queries
    // against rows the product can never produce, and the FK exists precisely so retrieval cannot return a
    // candidate whose version does not exist.
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, enabled, allowed_fields) values
        ('npm_registry', 'official_api', 'npm', 'https://registry.npmjs.org', true, '["description"]'),
        ('huggingface_models', 'official_api', 'HF', 'https://huggingface.co', true, '["description"]'),
        ('jobindex_roles', 'feed', 'Jobindex', 'https://www.jobindex.dk', true, '["roleTitle"]')
      on conflict (key) do nothing;
      insert into solution_capabilities (key, label) values
        ('translation', 'Translation'), ('image_understanding', 'Image understanding')
      on conflict (key) do nothing;

      insert into solution_components (id, kind, slug, display_name, source_key, lifecycle_state) values
        ('c-tool',  'tool',       'polyglot-cli',   'polyglot-cli',      'npm_registry',       'active'),
        ('c-model', 'model',      'opus-mt-en-da',  'opus-mt-en-da',     'huggingface_models', 'active'),
        ('c-role',  'human_role', 'danish-xl',      'Danish Translator', 'jobindex_roles',     'active'),
        ('c-other', 'tool',       'image-resizer',  'image-resizer',     'npm_registry',       'active');

      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at) values
        ('c-tool',  1, '{"description":"translates documentation between languages"}', 'h1', now()),
        ('c-model', 1, '{"description":"neural translation model"}',                   'h2', now()),
        ('c-role',  1, '{"roleTitle":"translate marketing copy into Danish"}',         'h3', now()),
        ('c-other', 1, '{"description":"resizes images"}',                             'h4', now());

      insert into solution_evidence (id, source_key, component_id, kind, content_hash, payload, observed_at) values
        ('ev-1', 'npm_registry', 'c-tool', 'official_metadata', 'e1', '{}', now()),
        ('ev-2', 'huggingface_models', 'c-model', 'official_metadata', 'e2', '{}', now()),
        ('ev-3', 'jobindex_roles', 'c-role', 'official_metadata', 'e3', '{}', now()),
        ('ev-4', 'npm_registry', 'c-other', 'official_metadata', 'e4', '{}', now());

      insert into solution_component_capabilities
        (id, component_id, component_version, capability_key, evidence_level, primary_evidence_id) values
        ('cc-1', 'c-tool',  1, 'translation',        'claimed',  'ev-1'),
        -- Verified on purpose: the fixture has to contain a strong-evidence candidate for the test that
        -- evidence modulates relevance without replacing it.
        ('cc-2', 'c-model', 1, 'translation',        'verified', 'ev-2'),
        ('cc-3', 'c-role',  1, 'translation',        'claimed',  'ev-3'),
        ('cc-4', 'c-other', 1, 'image_understanding','claimed',  'ev-4');
    `)
    await projectComponents({ readDb: db, writeDb: db })
  })

  const retrieve = (b: SolutionBrief, options = {}) => retrieveForBrief(b, { db, ...options })

  it('retrieves per lane so a human route has real candidates', async () => {
    const result = await retrieve(brief())
    // The human lane finding the Danish translator role while the AI lane finds the model is exactly why
    // lanes are retrieved independently: one flat list ordered by relevance could easily contain no person
    // at all, and the composer would have nothing to build a human route from.
    expect(result.byLane.human.map((c) => c.componentId)).toEqual(['c-role'])
    expect(result.byLane.ai.map((c) => c.componentId)).toEqual(['c-model'])
    expect(result.byLane.tooling.map((c) => c.componentId)).toEqual(['c-tool'])
  })

  it('applies the capability filter exactly', async () => {
    const result = await retrieve(brief())
    const all = Object.values(result.byLane).flat().map((c) => c.componentId)
    // `image-resizer`'s document contains "image understanding" and nothing about translation, and its
    // capability array does not include it. Array containment excludes it; a substring match on the
    // document would not.
    expect(all).not.toContain('c-other')
  })

  it('makes an excluded component absent, not merely lower-ranked', async () => {
    const result = await retrieve(brief({
      hardConstraints: [{ type: 'excluded_component', componentId: 'c-model' }],
    }))
    expect(Object.values(result.byLane).flat().map((c) => c.componentId)).not.toContain('c-model')
  })

  it('degrades to the lexical lane when the embedding provider fails', async () => {
    const result = await retrieve(brief(), { embed: async () => { throw new Error('provider down') } })
    expect(result.trace.vector).toBe('unavailable')
    // A provider blip must not become "we found no way to do this", which is a wrong answer rather than a
    // missing one.
    expect(Object.values(result.byLane).flat().length).toBeGreaterThan(0)
    // Never the raw error: an upstream body can echo anything, including a prompt-injected string.
    expect(result.trace.vectorDetail).toBe('Embedding provider unavailable')
  })

  it('reports the vector lane as skipped, not failed, when no embedder is configured', async () => {
    const result = await retrieve(brief())
    expect(result.trace.vector).toBe('skipped')
    expect(result.trace.vectorDetail).toBeUndefined()
  })

  it('states in the trace that no reranker was applied', async () => {
    // Recorded so a run's trace says which retrieval design produced it, rather than leaving it to be
    // inferred from a date.
    expect((await retrieve(brief())).trace.rerankerApplied).toBe(false)
  })

  it('produces a query hash that is stable and blind to non-retrieval fields', async () => {
    const base = await retrieve(brief())
    const again = await retrieve(brief())
    const withBudget = await retrieve(brief({ budget: { status: 'known', value: { maxCents: 50000, currency: 'EUR' } } }))
    expect(again.trace.queryHash).toBe(base.trace.queryHash)
    // Budget changes which routes the composer offers, not which components retrieval finds. Including it
    // would make two runs over one candidate set look like different retrievals.
    expect(withBudget.trace.queryHash).toBe(base.trace.queryHash)

    const different = await retrieve(brief({ capabilities: ['summarization'] }))
    expect(different.trace.queryHash).not.toBe(base.trace.queryHash)
  })
})
