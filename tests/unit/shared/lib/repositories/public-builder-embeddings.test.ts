import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { builderEmbeddings } from '~/shared/lib/db/schema'
import { similarBuilderEmbeddingsQuery } from '~/shared/lib/repositories/public-builder-embeddings'

/**
 * Regression test for the ORDER BY shape of the semantic-search query.
 *
 * `findSimilarBuilderEmbeddings` used to sort by `1 - (embedding <=> $vec)`
 * DESC. That is the same sequence as `embedding <=> $vec` ASC, but pgvector's
 * HNSW index can only answer an ordering expressed as the bare distance
 * operator — the planner cannot match a monotonic transform of it back to the
 * index — so every semantic query fell back to `Seq Scan + Sort` over the
 * whole table while the doc comment (and plans/semantic-search/spec.md's
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
   * Read from the migrated column rather than `EMBEDDING_DIM`: vitest runs
   * under happy-dom, so `window` exists and `env.ts` takes its browser-stub
   * branch, which reports the 1536 default instead of the configured value.
   * The column is the only dimension the inserts below have to agree with.
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
})
