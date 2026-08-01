import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { builderEmbeddings } from '~/shared/lib/db/schema'
import { searchBuilderEmbeddings, similarBuilderEmbeddingsQuery } from '~/shared/lib/repositories/public-builder-embeddings'

/**
 * Regression test for the ORDER BY shape of the semantic-search query.
 *
 * `findSimilarBuilderEmbeddings` used to sort by `1 - (embedding <=> $vec)`
 * DESC. That is the same sequence as `embedding <=> $vec` ASC, but pgvector's
 * HNSW index can only answer an ordering expressed as the bare distance
 * operator — the planner cannot match a monotonic transform of it back to the
 * index — so every semantic query fell back to `Seq Scan + Sort` over the
 * whole table while the doc comment (and plans/phase-1/22-semantic-search/spec.md's
 * "warm-index semantic query p95 < 100 ms (local HNSW)" target) claimed an
 * index scan.
 *
 * A string match on the emitted SQL would not catch a future regression that
 * is textually different but still unindexable, so this EXPLAINs the SQL the
 * repository actually emits and asserts on the plan. `enable_seqscan = off`
 * removes the row-count/cost variable: with a handful of test rows a seq scan
 * is genuinely cheaper, and the point under test is whether the index *can*
 * serve the ordering at all, not which plan the cost model prefers today.
 */
describe('findSimilarBuilderEmbeddings — HNSW index usage', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>
  /**
   * Read from the migrated column rather than `EMBEDDING_DIM`: vitest runs under happy-dom, so
   * `window` exists and `env.ts` takes its browser-stub branch, which reports the schema default
   * rather than whatever `.env` configured. Since plan 43 Phase 2 that default is 768, which does
   * agree with the column — but reading the column keeps this test correct regardless of which
   * value the stub reports, which is the property that matters for the inserts below.
   */
  let dimensions: number

  /** Deterministic unit-ish vector; exact values are irrelevant to the plan. */
  function vectorFor(seed: number): number[] {
    return Array.from({ length: dimensions }, (_, i) => Math.sin(seed * 7.13 + i * 0.017))
  }

  /** Runs EXPLAIN over `query`'s SQL with seq scans disabled, returning the plan text. */
  async function explain(query: { getSQL: () => ReturnType<typeof sql> }): Promise<string> {
    // SET LOCAL inside a transaction — the pool has several connections, so a
    // plain SET could land on a different one than the EXPLAIN.
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`)
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${query.getSQL()}`)
      return [...rows].map((row) => row['QUERY PLAN']).join('\n')
    })
  }

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('embeddings')
    db = disposable.db
    drop = disposable.drop

    // pgvector stores the declared dimension directly in the column's typmod.
    const [column] = await db.execute<{ atttypmod: number }>(sql`
      select atttypmod from pg_attribute
      where attrelid = 'builder_embeddings'::regclass and attname = 'embedding'
    `)
    dimensions = column.atttypmod

    await db.insert(builderEmbeddings).values(
      Array.from({ length: 8 }, (_, i) => ({
        id: `embedding-${i}`,
        source: 'github',
        sourceId: `user-${i}`,
        contentHash: `hash-${i}`,
        document: `document ${i}`,
        profile: { username: `user-${i}`, profileUrl: `https://github.com/user-${i}`, topics: [] },
        embedding: vectorFor(i),
        embeddedAt: new Date(),
      })),
    )
  }, 120_000)

  afterAll(async () => {
    await drop()
  })

  it('emits an ORDER BY the HNSW index can serve', async () => {
    const plan = await explain(similarBuilderEmbeddingsQuery(db, vectorFor(0), 5))

    expect(plan).toContain('Index Scan using builder_embeddings_hnsw_idx')
    expect(plan).toContain('Order By: (embedding <=>')
    expect(plan).not.toContain('Seq Scan on builder_embeddings')
    // A Sort node means the ordering was computed after retrieval rather than
    // supplied by the index — exactly the regression this test guards.
    expect(plan).not.toContain('Sort Key:')
  })

  it('negative control: ordering by the derived similarity expression cannot use the index', async () => {
    // The pre-fix shape. Kept as a control so the assertions above are known
    // to discriminate between the two orderings rather than passing for any
    // query against this table.
    const distance = sql`${builderEmbeddings.embedding} <=> ${JSON.stringify(vectorFor(0))}`
    const derivedOrder = db
      .select({ similarity: sql<number>`1 - (${distance})` })
      .from(builderEmbeddings)
      .where(sql`${builderEmbeddings.embedding} is not null`)
      .orderBy(sql`1 - (${distance}) desc`)
      .limit(5)

    const plan = await explain(derivedOrder)

    expect(plan).not.toContain('Index Scan using builder_embeddings_hnsw_idx')
    expect(plan).toContain('Sort Key:')
  })

  it('returns similarity descending, matching 1 - cosine distance', async () => {
    const probe = vectorFor(3)
    const rows = await similarBuilderEmbeddingsQuery(db, probe, 5)

    expect(rows.length).toBe(5)
    // The nearest neighbour of a row's own vector is that row, at similarity 1.
    expect(rows[0].sourceId).toBe('user-3')
    expect(rows[0].similarity).toBeCloseTo(1, 5)

    const similarities = rows.map((row) => row.similarity)
    expect([...similarities].sort((a, b) => b - a)).toEqual(similarities)
  })

  /**
   * plans/phase-1/43-solutions-intelligence Phase 2, "Honor semantic filters and pagination".
   *
   * The two defects these pin: the `sources` filter was accepted by `/api/search/semantic` and
   * never applied to local vector matches at all, and `hasMore` was inferred from
   * `rows.length >= limit` — which lies precisely when the final page is exactly full, the case a
   * user notices because the UI offers a next page that turns out to be empty.
   */
  describe('filters and pagination', () => {
    beforeAll(async () => {
      // A second source and a non-person entity kind, so "exact filter" has something to exclude.
      await db.insert(builderEmbeddings).values([
        {
          id: 'embedding-hn-0',
          source: 'hn',
          sourceId: 'hn-user-0',
          contentHash: 'hash-hn-0',
          document: 'document hn 0',
          profile: { username: 'hn-user-0', profileUrl: 'https://news.ycombinator.com/user?id=hn-user-0', topics: [] },
          embedding: vectorFor(0.5),
          embeddedAt: new Date(),
        },
        {
          id: 'embedding-model-0',
          entityKind: 'model',
          source: 'huggingface',
          sourceId: 'model-0',
          contentHash: 'hash-model-0',
          document: 'document model 0',
          profile: { username: 'model-0', profileUrl: 'https://huggingface.co/model-0', topics: [] },
          embedding: vectorFor(0.25),
          embeddedAt: new Date(),
        },
      ])
    })

    it('defaults every pre-Phase-2 row to human_profile', async () => {
      const { matches } = await searchBuilderEmbeddings(vectorFor(3), { limit: 1 }, undefined, db)
      expect(matches[0].entityKind).toBe('human_profile')
    })

    it('excludes every non-matching source when sources is set', async () => {
      const { matches } = await searchBuilderEmbeddings(vectorFor(0.5), { limit: 20 }, { sources: ['github'] }, db)

      expect(matches.length).toBeGreaterThan(0)
      expect(matches.every((m) => m.source === 'github')).toBe(true)
      // The `hn` row is the nearest neighbour of this probe, so an unfiltered query would rank it
      // first — its absence proves the filter ran in SQL rather than being ignored.
      expect(matches.some((m) => m.source === 'hn')).toBe(false)
    })

    it('excludes every non-matching entity kind when entityKinds is set', async () => {
      const { matches } = await searchBuilderEmbeddings(vectorFor(0.25), { limit: 20 }, { entityKinds: ['human_profile'] }, db)

      expect(matches.length).toBeGreaterThan(0)
      expect(matches.every((m) => m.entityKind === 'human_profile')).toBe(true)
      expect(matches.some((m) => m.entityKind === 'model')).toBe(false)
    })

    it('can select the catalog side of the same projection', async () => {
      const { matches } = await searchBuilderEmbeddings(vectorFor(0.25), { limit: 20 }, { entityKinds: ['model'] }, db)

      expect(matches).toHaveLength(1)
      expect(matches[0].sourceId).toBe('model-0')
    })

    it('combines source and kind filters conjunctively', async () => {
      const { matches } = await searchBuilderEmbeddings(
        vectorFor(0),
        { limit: 20 },
        { sources: ['huggingface'], entityKinds: ['human_profile'] },
        db,
      )
      // huggingface holds only the `model` row, so an AND of these two yields nothing. An OR — or a
      // filter applied to only one of the two columns — would return rows here.
      expect(matches).toEqual([])
    })

    it('reports hasMore false on an exactly-full final page', async () => {
      const total = 10 // 8 github + 1 hn + 1 model
      const { matches, hasMore } = await searchBuilderEmbeddings(vectorFor(0), { limit: total }, undefined, db)

      expect(matches).toHaveLength(total)
      // The bug being pinned: `rows.length >= limit` would say true here and offer an empty page 2.
      expect(hasMore).toBe(false)
    })

    it('reports hasMore true while rows remain, and pages without repeating a row', async () => {
      const first = await searchBuilderEmbeddings(vectorFor(0), { limit: 4, offset: 0 }, undefined, db)
      expect(first.matches).toHaveLength(4)
      expect(first.hasMore).toBe(true)

      const second = await searchBuilderEmbeddings(vectorFor(0), { limit: 4, offset: 4 }, undefined, db)
      expect(second.matches).toHaveLength(4)

      const firstIds = first.matches.map((m) => `${m.entityKind}:${m.source}:${m.sourceId}`)
      const secondIds = second.matches.map((m) => `${m.entityKind}:${m.source}:${m.sourceId}`)
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([])
    })

    it('honors the filter while paging, so a filtered page 2 cannot leak an excluded source', async () => {
      const { matches, hasMore } = await searchBuilderEmbeddings(
        vectorFor(0),
        { limit: 4, offset: 4 },
        { sources: ['github'] },
        db,
      )
      expect(matches.every((m) => m.source === 'github')).toBe(true)
      // 8 github rows, 4 consumed by page 1, 4 on this page, nothing beyond.
      expect(matches).toHaveLength(4)
      expect(hasMore).toBe(false)
    })
  })
})
