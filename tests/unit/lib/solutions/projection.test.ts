/**
 * Retrieval projections (plan 43 Phase 5, "Build versioned search projections").
 *
 * Two halves. The document builder is pure, so it is tested directly on the shapes real adapters
 * produce — a Hugging Face model card, an npm package, a Danish job posting. The writer is tested against
 * a real migrated database, because the three properties that matter (unchanged rebuild is a no-op, a
 * stale job cannot overwrite newer work, a closed version's projection is removed) are all properties of
 * the upsert rather than of any JavaScript.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  PROJECTION_VERSION,
  buildProjection,
  evidenceRank,
  hashProjection,
  strongestEvidenceLevel,
} from '~/lib/solutions/indexing/projection-doc'
import { countStaleProjections, projectComponents } from '~/lib/solutions/indexing/project-components'

const HF_MODEL = {
  componentId: 'c-model',
  version: 1,
  kind: 'model' as const,
  sourceKey: 'huggingface_models',
  displayName: 'bge-small-en-v1.5',
  metadata: {
    pipelineTag: 'feature-extraction',
    libraryName: 'sentence-transformers',
    downloads: 69732954,
    likes: 520,
    tags: ['sentence-transformers', 'bert', 'arxiv:2401.03462', 'license:mit', 'en'],
  },
  capabilities: [{ capabilityKey: 'embedding', evidenceLevel: 'claimed' as const }],
  observedAt: new Date('2026-08-01T00:00:00Z'),
}

describe('the document is derived prose, not serialized metadata', () => {
  it('keeps the terms a brief would use and drops the ones it would not', () => {
    const projection = buildProjection(HF_MODEL)

    // The words a person types.
    expect(projection.searchDocument).toContain('bge-small-en-v1.5')
    expect(projection.searchDocument).toContain('embedding')
    expect(projection.searchDocument).toContain('Embedding') // the capability's human label
    expect(projection.searchDocument).toContain('sentence-transformers')

    // Numbers nobody searches for. `ts_rank` divides by document length, so every one of these would make
    // real matches score lower.
    expect(projection.searchDocument).not.toContain('69732954')
    expect(projection.searchDocument).not.toContain('520')
    // Machine identifiers dressed as tags.
    expect(projection.searchDocument).not.toContain('arxiv')
    expect(projection.searchDocument).not.toContain('license:mit')
  })

  it('splits a slug-shaped name so its words are searchable', () => {
    const projection = buildProjection(HF_MODEL)
    expect(projection.searchDocument).toContain('bge small en v1 5')
  })

  it('does not give a prose name more weight than a slug name', () => {
    // An already-spaced name splits back to itself. Pushing that copy would give "Automation Engineer"
    // three occurrences to "bge-small-en-v1.5"'s two — rewarding a component for having a readable name,
    // which is not a relevance signal. This caught a real bug: the first version repeated it three times.
    const prose = buildProjection({ ...HF_MODEL, displayName: 'Automation Engineer', metadata: {} })
    const occurrences = prose.searchDocument.split('Automation Engineer').length - 1
    expect(occurrences).toBe(2)
  })

  it('includes the capability label as well as the key, so English matches a snake_case key', () => {
    const projection = buildProjection({
      ...HF_MODEL,
      capabilities: [{ capabilityKey: 'document_understanding', evidenceLevel: 'claimed' }],
    })
    // The key alone tokenises as one term and would never match the two words someone writes.
    expect(projection.searchDocument).toContain('document understanding')
    expect(projection.searchDocument).toContain('Document understanding')
  })

  it('carries a Danish job posting through without mangling it', () => {
    const projection = buildProjection({
      componentId: 'c-role',
      version: 1,
      kind: 'human_role',
      sourceKey: 'jobindex_roles',
      displayName: 'Funktionsleder til Løn og Personale',
      metadata: { roleTitle: 'Funktionsleder til Løn og Personale', companyName: 'Odense Kommune', area: 'Odense SØ' },
      capabilities: [],
      observedAt: new Date('2026-08-01T00:00:00Z'),
    })
    expect(projection.searchDocument).toContain('Løn')
    expect(projection.searchDocument).toContain('Odense SØ')
    expect(projection.capabilityKeys).toEqual([])
  })
})

describe('the content hash decides whether a rebuild writes', () => {
  it('is stable for identical input and blind to a newer observation time', () => {
    const a = buildProjection(HF_MODEL)
    // A source re-serving identical content with a newer timestamp is not a change to what a component is
    // findable by. Including `observedAt` would rewrite the whole catalog on every refresh.
    const b = buildProjection({ ...HF_MODEL, observedAt: new Date('2027-01-01T00:00:00Z') })
    expect(b.contentHash).toBe(a.contentHash)
  })

  it('changes when the document or the capability set changes', () => {
    const base = buildProjection(HF_MODEL)
    expect(buildProjection({ ...HF_MODEL, displayName: 'other' }).contentHash).not.toBe(base.contentHash)
    expect(buildProjection({
      ...HF_MODEL,
      capabilities: [{ capabilityKey: 'translation', evidenceLevel: 'claimed' }],
    }).contentHash).not.toBe(base.contentHash)
  })

  it('changes when the projection version is bumped, even for identical text', () => {
    // The point of a bump is usually that the same text should now be indexed differently, so the version
    // has to be inside the hash or a bump would invalidate nothing.
    const same = { searchDocument: 'x', capabilityKeys: ['embedding'] }
    expect(hashProjection({ ...same, projectionVersion: 1 }))
      .not.toBe(hashProjection({ ...same, projectionVersion: 2 }))
  })

  it('ignores capability order', () => {
    expect(hashProjection({ searchDocument: 'x', capabilityKeys: ['a', 'b'], projectionVersion: 1 }))
      .toBe(hashProjection({ searchDocument: 'x', capabilityKeys: ['b', 'a'], projectionVersion: 1 }))
  })
})

describe('evidence level never overstates what exists', () => {
  it('reports the strongest claim, and `claimed` when there is none', () => {
    expect(strongestEvidenceLevel([{ evidenceLevel: 'claimed' }, { evidenceLevel: 'verified' }])).toBe('verified')
    expect(strongestEvidenceLevel([{ evidenceLevel: 'observed' }])).toBe('observed')
    // No claims is not the same as a strong claim. A component with nothing asserted about it must sort
    // below one with a verified claim, never above.
    expect(strongestEvidenceLevel([])).toBe('claimed')
    expect(evidenceRank('claimed')).toBeLessThan(evidenceRank('production_evidence'))
  })
})

describe('the writer against a real database', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('solutions_projection')
    db = disposable.db
    drop = disposable.drop
  }, 180_000)

  afterAll(async () => { await drop() })

  beforeEach(async () => {
    await db.execute(sql`
      truncate solution_component_projections, solution_component_capabilities, solution_evidence,
               solution_component_versions, solution_components, builder_embeddings cascade
    `)
    await db.execute(sql`
      insert into solution_sources (key, kind, label, homepage_url, enabled, allowed_fields)
      values ('api', 'official_api', 'API', 'https://api.test', true, '["summary"]')
      on conflict (key) do nothing;
      insert into solution_capabilities (key, label) values ('translation', 'Translation')
      on conflict (key) do nothing;
      insert into solution_components (id, kind, slug, display_name, source_key, lifecycle_state)
      values ('c-a', 'model', 'a', 'Alpha Translator', 'api', 'active'),
             ('c-draft', 'model', 'd', 'Draft Model', 'api', 'draft');
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at)
      values ('c-a', 1, '{"summary":"translates documents"}', 'h1', now()),
             ('c-draft', 1, '{"summary":"unreviewed"}', 'h2', now());
      insert into solution_evidence (id, source_key, component_id, kind, content_hash, payload, observed_at)
      values ('ev-1', 'api', 'c-a', 'official_metadata', 'eh1', '{}', now());
      insert into solution_component_capabilities (id, component_id, component_version, capability_key, evidence_level, primary_evidence_id)
      values ('cc-1', 'c-a', 1, 'translation', 'claimed', 'ev-1');
    `)
  })

  const run = () => projectComponents({ readDb: db, writeDb: db })

  it('projects an active component and skips a draft one', async () => {
    const result = await run()
    expect(result).toMatchObject({ scanned: 1, written: 1, unchanged: 0, skippedStale: 0 })

    const rows = await db.execute<{ component_id: string; capability_keys: string[] }>(sql`
      select component_id, capability_keys from solution_component_projections
    `)
    // A draft component must never reach a projection: retrieval reads projections, so projecting a draft
    // would put an unreviewed component into advice through the back door.
    expect(rows.map((row) => row.component_id)).toEqual(['c-a'])
    expect(rows[0].capability_keys).toEqual(['translation'])
  })

  it('writes nothing on an unchanged rebuild', async () => {
    await run()
    expect(await run()).toMatchObject({ written: 0, unchanged: 1, embeddingsEnqueued: 0 })
  })

  it('refuses to overwrite a projection carrying a newer projection version', async () => {
    await run()
    // Simulate a rollout: something wrote a newer document shape, and this projector is the older job.
    await db.execute(sql`
      update solution_component_projections
      set projection_version = ${PROJECTION_VERSION + 1}, search_document = 'newer shape', content_hash = 'newer'
      where component_id = 'c-a'
    `)

    expect(await run()).toMatchObject({ skippedStale: 1, written: 0 })
    const [row] = await db.execute<{ search_document: string }>(sql`
      select search_document from solution_component_projections where component_id = 'c-a'
    `)
    expect(row.search_document).toBe('newer shape')
  })

  it('enqueues a pending embedding without calling any provider', async () => {
    const result = await run()
    expect(result.embeddingsEnqueued).toBe(1)

    const [row] = await db.execute<{ entity_kind: string; embedding: unknown; document: string; profile: { payloadKind?: string } }>(sql`
      select entity_kind, embedding, document, profile from builder_embeddings
    `)
    expect(row.entity_kind).toBe('model')
    // Null vector means pending. The projector must never call a provider, or rebuilding the catalog after
    // a wording change would cost tokens for every component.
    expect(row.embedding).toBeNull()
    // Tagged, so `asEmbeddedProfile` returns null and a person result card cannot be handed a component.
    expect(row.profile.payloadKind).toBe('catalog_component')
  })

  it('keeps an existing vector when the document has not changed', async () => {
    await run()
    await db.execute(sql`
      update builder_embeddings set embedding = array_fill(0.1::real, array[768])::vector, embedded_at = now()
    `)
    await run()

    const [row] = await db.execute<{ embedded_at: Date | null }>(sql`select embedded_at from builder_embeddings`)
    // A rebuild that blanked every vector would take the semantic lane dark until the embed worker caught
    // up — for a change that did not alter a single document.
    expect(row.embedded_at).not.toBeNull()
  })

  it('resets the vector to pending when the document does change', async () => {
    await run()
    await db.execute(sql`update builder_embeddings set embedding = array_fill(0.1::real, array[768])::vector, embedded_at = now()`)

    await db.execute(sql`update solution_components set display_name = 'Alpha Translator Pro' where id = 'c-a'`)
    expect(await run()).toMatchObject({ written: 1, embeddingsEnqueued: 1 })

    const [row] = await db.execute<{ embedded_at: Date | null }>(sql`select embedded_at from builder_embeddings`)
    // The stored vector describes text that no longer exists and must stop answering queries.
    expect(row.embedded_at).toBeNull()
  })

  it('removes the projection of a version that is no longer current', async () => {
    await run()
    // Close version 1 and open version 2, exactly as `ingestComponentVersion` does.
    await db.execute(sql`
      update solution_component_versions set valid_until = now() where component_id = 'c-a' and version = 1;
      insert into solution_component_versions (component_id, version, metadata, content_hash, observed_at)
      values ('c-a', 2, '{"summary":"translates documents and slides"}', 'h3', now());
    `)
    await run()

    const rows = await db.execute<{ version: number }>(sql`
      select version from solution_component_projections where component_id = 'c-a'
    `)
    // A projection for a closed version is the one thing retrieval must never return: citing it would make
    // the run irreproducible, since the evidence behind it has already been superseded.
    expect(rows.map((row) => row.version)).toEqual([2])
  })

  it('reports nothing stale when every projection is current', async () => {
    await run()
    expect(await countStaleProjections(db)).toBe(0)
  })
})
