/**
 * plans/phase-1/43-solutions-intelligence Phase 4 — the catalog repository and the per-source kill
 * switch.
 *
 * `solutions-catalog-schema.test.ts` proves the database refuses the wrong writes. This proves the
 * repository behaves correctly for the writes it allows, and — the part the maintainer cares about
 * most — that ingestion physically cannot run from a source that is switched off.
 */
import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, solutionComponentVersions, solutionSources } from '~/shared/lib/db/schema'
import {
  activateCompatibilityEdge,
  attachCapabilityClaim,
  computeComponentContentHash,
  findCandidateComponents,
  ingestComponentVersion,
  listEnabledSourceKeys,
  listSolutionSources,
  listTraversableEdges,
  recordCompatibilityEdge,
  recordEvidence,
  recordSourceTermsReview,
  setSolutionSourceEnabled,
} from '~/shared/lib/repositories/solution-catalog'

let db: PostgresJsDatabase
let drop: () => Promise<void>
const REVIEWER = 'cat-reviewer'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solution_catalog_repo')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: REVIEWER, name: 'R', email: 'cat-reviewer@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.execute(sql`
    truncate solution_component_capabilities, solution_compatibility_edges, solution_evidence,
             solution_component_versions, solution_components, solution_capabilities, solution_sources cascade
  `)
  await db.insert(solutionSources).values([
    { key: 'api', kind: 'official_api', label: 'API', homepageUrl: 'https://api.test', enabled: true, allowedFields: ['name'] },
    { key: 'off', kind: 'official_api', label: 'Off', homepageUrl: 'https://off.test', enabled: false, allowedFields: ['name'] },
    { key: 'scrape', kind: 'public_scrape', label: 'Scrape', homepageUrl: 'https://s.test', enabled: false, allowedFields: ['title'] },
  ])
  await db.execute(sql`insert into solution_capabilities (key, label) values ('translation', 'Translation'), ('qa', 'QA')`)
})

const component = (overrides: Record<string, unknown> = {}) => ({
  kind: 'model' as const,
  slug: 'm1',
  displayName: 'M1',
  sourceKey: 'api',
  metadata: { family: 'x', params: 7 },
  ...overrides,
})

describe('a disabled source cannot be ingested from', () => {
  it('refuses ingestion when the source is off', async () => {
    const outcome = await ingestComponentVersion(component({ sourceKey: 'off' }), db)

    // The check lives in the only write path rather than in each adapter: an adapter that forgot it
    // would keep ingesting from a source the operator had just switched off, which is precisely what
    // the kill switch exists to prevent.
    expect(outcome).toEqual({ status: 'source_disabled' })
    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from solution_components`)
    expect(rows[0].count).toBe(0)
  })

  it('refuses a scraping source that has not been enabled', async () => {
    expect(await ingestComponentVersion(component({ sourceKey: 'scrape' }), db)).toEqual({ status: 'source_disabled' })
  })

  it('lists only enabled keys for ingestion to consult', async () => {
    expect(await listEnabledSourceKeys(db)).toEqual(['api'])
  })

  it('stops ingesting as soon as the switch flips, with no deploy', async () => {
    expect((await ingestComponentVersion(component(), db)).status).toBe('created')
    await db.update(solutionSources).set({ enabled: false }).where(eq(solutionSources.key, 'api'))
    // The kill switch is a database column exactly so this takes effect immediately.
    expect(await ingestComponentVersion(component({ metadata: { changed: true } }), db)).toEqual({ status: 'source_disabled' })
  })
})

describe('the kill switch and its review gate', () => {
  it('enables an official API without a review', async () => {
    await db.update(solutionSources).set({ enabled: false }).where(eq(solutionSources.key, 'api'))
    expect(await setSolutionSourceEnabled({ key: 'api', enabled: true }, db)).toEqual({ status: 'updated', enabled: true })
  })

  it('refuses to enable a scrape with no recorded review, as an answer rather than a crash', async () => {
    // The database would refuse this too; returning a status means the operator sees what to do next
    // instead of a 500.
    expect(await setSolutionSourceEnabled({ key: 'scrape', enabled: true }, db)).toEqual({ status: 'review_required' })
    const [row] = await db.select().from(solutionSources).where(eq(solutionSources.key, 'scrape'))
    expect(row.enabled).toBe(false)
  })

  it('enables the scrape once a review is recorded', async () => {
    expect(await recordSourceTermsReview({ key: 'scrape', reviewerUserId: REVIEWER, notes: 'robots allows /docs' }, db)).toBe(true)
    expect(await setSolutionSourceEnabled({ key: 'scrape', enabled: true }, db)).toEqual({ status: 'updated', enabled: true })
  })

  it('keeps reviewing and enabling as two separate decisions', async () => {
    await recordSourceTermsReview({ key: 'scrape', reviewerUserId: REVIEWER, notes: 'reviewed' }, db)
    const [row] = await db.select().from(solutionSources).where(eq(solutionSources.key, 'scrape'))
    // Recording a review must not switch anything on by itself — otherwise one click both approves
    // and starts a crawl.
    expect(row.enabled).toBe(false)
    expect(row.termsReviewedBy).toBe(REVIEWER)
  })

  it('records who reviewed it, not just that someone did', async () => {
    await recordSourceTermsReview({ key: 'scrape', reviewerUserId: REVIEWER, notes: 'checked' }, db)
    const [row] = await db.select().from(solutionSources).where(eq(solutionSources.key, 'scrape'))
    expect(row.termsReviewedBy).toBe(REVIEWER)
    expect(row.termsReviewedAt).not.toBeNull()
    expect(row.registerNotes).toBe('checked')
  })

  it('reports a redundant toggle as unchanged rather than pretending to act', async () => {
    expect(await setSolutionSourceEnabled({ key: 'api', enabled: true }, db)).toEqual({ status: 'unchanged', enabled: true })
  })

  it('reports an unknown key as not_found', async () => {
    expect(await setSolutionSourceEnabled({ key: 'nope', enabled: true }, db)).toEqual({ status: 'not_found' })
  })

  it('lists the whole register including disabled sources', async () => {
    const sources = await listSolutionSources(db)
    expect(sources.map((s) => s.key).sort()).toEqual(['api', 'off', 'scrape'])
    expect(sources.filter((s) => s.enabled).map((s) => s.key)).toEqual(['api'])
  })
})

describe('ingestion versions only on real change', () => {
  it('creates the component and its first version', async () => {
    const outcome = await ingestComponentVersion(component(), db)
    expect(outcome).toMatchObject({ status: 'created', version: 1 })
  })

  it('returns unchanged for byte-identical metadata', async () => {
    await ingestComponentVersion(component(), db)
    const second = await ingestComponentVersion(component(), db)
    // A daily refresh of an unchanged model card must not grow the version history without bound.
    expect(second.status).toBe('unchanged')
  })

  it('treats reordered metadata keys as unchanged', async () => {
    await ingestComponentVersion(component({ metadata: { a: 1, b: 2 } }), db)
    const second = await ingestComponentVersion(component({ metadata: { b: 2, a: 1 } }), db)
    expect(second.status).toBe('unchanged')
    expect(computeComponentContentHash({ a: 1, b: 2 })).toBe(computeComponentContentHash({ b: 2, a: 1 }))
  })

  it('closes the previous window before opening the next, since overlap is impossible', async () => {
    await ingestComponentVersion(component(), db)
    const changed = await ingestComponentVersion(component({ metadata: { family: 'y' } }), db)
    expect(changed).toMatchObject({ status: 'versioned', version: 2 })

    const rows = await db.select().from(solutionComponentVersions).orderBy(solutionComponentVersions.version)
    expect(rows).toHaveLength(2)
    // v1 closed, v2 open. Inserting before closing would have failed the exclusion constraint.
    expect(rows[0].validUntil).not.toBeNull()
    expect(rows[1].validUntil).toBeNull()
  })

  it('keeps the old version readable, so a past run stays reproducible', async () => {
    await ingestComponentVersion(component({ metadata: { family: 'original' } }), db)
    await ingestComponentVersion(component({ metadata: { family: 'revised' } }), db)
    const rows = await db.select().from(solutionComponentVersions).orderBy(solutionComponentVersions.version)
    expect(rows[0].metadata).toEqual({ family: 'original' })
  })
})

describe('evidence and claims', () => {
  async function seedEvidence() {
    return recordEvidence({ sourceKey: 'api', kind: 'official_metadata', payload: { note: 'card' } }, db)
  }

  it('dedupes identical evidence instead of duplicating it', async () => {
    const first = await seedEvidence()
    const second = await seedEvidence()
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.evidenceId).toBe(first.evidenceId)
  })

  it('attaches a capability claim to a specific component version', async () => {
    const ingested = await ingestComponentVersion(component(), db)
    if (ingested.status !== 'created') throw new Error('expected created')
    const evidence = await seedEvidence()

    const claim = await attachCapabilityClaim({
      componentId: ingested.componentId,
      componentVersion: ingested.version,
      capabilityKey: 'translation',
      evidenceLevel: 'verified',
      primaryEvidenceId: evidence.evidenceId,
    }, db)
    expect(claim.claimId).toBeTruthy()
  })

  it('surfaces an official-API component to retrieval as soon as it is ingested', async () => {
    const ingested = await ingestComponentVersion(component(), db)
    if (ingested.status !== 'created') throw new Error('expected created')
    const evidence = await seedEvidence()
    await attachCapabilityClaim({
      componentId: ingested.componentId, componentVersion: ingested.version,
      capabilityKey: 'translation', evidenceLevel: 'verified', primaryEvidenceId: evidence.evidenceId,
    }, db)

    /**
     * `active`, without anyone promoting it — a deliberate change, and this test previously asserted the
     * opposite. Everything used to be ingested as `draft`, nothing promoted anything, and the result was
     * that a catalog full of real components answered every brief with nothing. The rule now turns on who
     * asserted the component exists: when Hugging Face's own API says a model exists, that is a publisher
     * describing its own thing, and requiring a human to confirm each of thousands means the catalog stays
     * empty forever.
     *
     * No claim gate weakens. Being listed is not a claim about what a component can do, and the tests below
     * still hold the gates that decide advice: a claim enters at `claimed`, and a similarity-derived edge
     * cannot activate itself.
     */
    const candidates = await findCandidateComponents({ kinds: ['model'], capabilityKeys: ['translation'] }, db)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ slug: 'm1', version: 1 })
    expect(candidates[0].capabilities).toEqual([{ capabilityKey: 'translation', evidenceLevel: 'verified' }])
  })

  it('keeps a scraped component out of retrieval until a human promotes it', async () => {
    // The other half of the same rule. A crawl is *us* asserting a component exists, which is exactly the
    // case that deserves review before it becomes advice.
    await db.update(solutionSources).set({ enabled: true, termsReviewedAt: new Date() })
      .where(eq(solutionSources.key, 'scrape'))
    const ingested = await ingestComponentVersion(component({ sourceKey: 'scrape', slug: 'crawled' }), db)
    if (ingested.status !== 'created') throw new Error('expected created')
    const evidence = await seedEvidence()
    await attachCapabilityClaim({
      componentId: ingested.componentId, componentVersion: ingested.version,
      capabilityKey: 'translation', evidenceLevel: 'claimed', primaryEvidenceId: evidence.evidenceId,
    }, db)

    expect(await findCandidateComponents({ kinds: ['model'], capabilityKeys: ['translation'] }, db)).toEqual([])

    await db.execute(sql`update solution_components set lifecycle_state = 'active' where slug = 'crawled'`)
    expect(await findCandidateComponents({ kinds: ['model'], capabilityKeys: ['translation'] }, db)).toHaveLength(1)
  })

  it('does not match a capability the component never claimed', async () => {
    const ingested = await ingestComponentVersion(component(), db)
    if (ingested.status !== 'created') throw new Error('expected created')
    const evidence = await seedEvidence()
    await attachCapabilityClaim({
      componentId: ingested.componentId, componentVersion: ingested.version,
      capabilityKey: 'translation', evidenceLevel: 'claimed', primaryEvidenceId: evidence.evidenceId,
    }, db)
    expect(await findCandidateComponents({ kinds: ['model'], capabilityKeys: ['qa'] }, db)).toEqual([])
  })
})

describe('edges: similarity proposes, a reviewer activates', () => {
  async function twoComponentsAndEvidence() {
    const a = await ingestComponentVersion(component({ slug: 'a' }), db)
    const b = await ingestComponentVersion(component({ kind: 'tool', slug: 'b' }), db)
    if (a.status === 'source_disabled' || b.status === 'source_disabled') throw new Error('unexpected')
    const evidence = await recordEvidence({ sourceKey: 'api', kind: 'documentation', payload: { doc: 1 } }, db)
    return { a: a.componentId, b: b.componentId, evidenceId: evidence.evidenceId }
  }

  it('records a similarity-derived edge as proposed, never active', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    const edge = await recordCompatibilityEdge({
      edgeType: 'integrates_with', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'semantic_similarity_reviewed', primaryEvidenceId: evidenceId, confidenceBps: 9_900,
    }, db)

    // 9900 bps and it still only proposes — the same rule link-policy.ts applies to identity.
    expect(edge.status).toBe('proposed')
    expect(await listTraversableEdges(a, undefined, db)).toEqual([])
  })

  it('lets an officially-documented edge go straight to active', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    const edge = await recordCompatibilityEdge({
      edgeType: 'hosted_by', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'official_metadata', primaryEvidenceId: evidenceId,
    }, db)
    expect(edge.status).toBe('active')
    expect(await listTraversableEdges(a, undefined, db)).toHaveLength(1)
  })

  it('makes a proposal traversable only after a reviewer activates it', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    const edge = await recordCompatibilityEdge({
      edgeType: 'integrates_with', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'semantic_similarity_reviewed', primaryEvidenceId: evidenceId,
    }, db)

    expect(await activateCompatibilityEdge({ edgeId: edge.edgeId, reviewerUserId: REVIEWER }, db)).toBe(true)
    const traversable = await listTraversableEdges(a, undefined, db)
    expect(traversable).toHaveLength(1)
    expect(traversable[0].edgeId).toBe(edge.edgeId)
  })

  it('refuses a second activation, so one reviewer cannot overwrite another', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    const edge = await recordCompatibilityEdge({
      edgeType: 'integrates_with', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'semantic_similarity_reviewed', primaryEvidenceId: evidenceId,
    }, db)
    expect(await activateCompatibilityEdge({ edgeId: edge.edgeId, reviewerUserId: REVIEWER }, db)).toBe(true)
    expect(await activateCompatibilityEdge({ edgeId: edge.edgeId, reviewerUserId: REVIEWER }, db)).toBe(false)
  })

  it('excludes a withdrawn edge from traversal', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    await recordCompatibilityEdge({
      edgeType: 'hosted_by', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'official_metadata', primaryEvidenceId: evidenceId,
    }, db)
    await db.execute(sql`update solution_compatibility_edges set valid_until = now()`)
    // Filtered in SQL, not by the caller — a withdrawn edge reaching the composer would put a
    // retracted combination into a recommendation.
    expect(await listTraversableEdges(a, undefined, db)).toEqual([])
  })

  it('filters traversal by edge type', async () => {
    const { a, b, evidenceId } = await twoComponentsAndEvidence()
    await recordCompatibilityEdge({
      edgeType: 'hosted_by', fromComponentId: a, toComponentId: b,
      discoveryMethod: 'official_metadata', primaryEvidenceId: evidenceId,
    }, db)
    expect(await listTraversableEdges(a, ['requires'], db)).toEqual([])
    expect(await listTraversableEdges(a, ['hosted_by'], db)).toHaveLength(1)
  })
})
