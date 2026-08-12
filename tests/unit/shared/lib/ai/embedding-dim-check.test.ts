/**
 * plans/implemented/43-solutions-intelligence Phase 2, "Unify embedding dimension and entity
 * contracts": validate the dimension "at startup and write time".
 *
 * Write time was already covered — `embeddings.ts` compares the provider's vector length against
 * `AI_EMBEDDING_DIM`. That check never looks at the database, so the mismatch it structurally
 * cannot see is config-vs-column, and that is the damaging one: every embed succeeds, every insert
 * fails, and if the column is *wider* than the config the HNSW index simply matches nothing and
 * semantic search degrades to keyword search forever without logging an error.
 *
 * The mismatch case here really alters the column rather than stubbing the reader, because the
 * whole value of this check is that it fires against a real divergent schema. A test that only
 * proves the happy path would pass just as well if the assertion were `return`.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { EMBEDDING_DIM } from '~/shared/lib/ai/embedding-dim'
import {
  EmbeddingDimensionMismatchError,
  assertEmbeddingDimensionMatchesDatabase,
  readDatabaseEmbeddingDimension,
  resetEmbeddingDimensionCheck,
} from '~/shared/lib/ai/embedding-dim-check'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('embedding_dim_check')
  db = disposable.db
  drop = disposable.drop
}, 120_000)

afterAll(async () => { await drop() })

beforeEach(() => {
  // The assertion memoises per process so it runs once per cold start; each case needs a fresh one.
  resetEmbeddingDimensionCheck()
})

describe('readDatabaseEmbeddingDimension', () => {
  it('reads the dimension the migration actually created the column with', async () => {
    expect(await readDatabaseEmbeddingDimension(db)).toBe(768)
  })

  it('agrees with the configured dimension, which is the invariant the app depends on', async () => {
    // If this ever fails, either `AI_EMBEDDING_DIM`'s default drifted from the migration literal
    // again (the exact defect Phase 2 fixed: default 1536 vs column 768), or a new migration
    // resized the column without re-embedding.
    expect(await readDatabaseEmbeddingDimension(db)).toBe(EMBEDDING_DIM)
  })
})

describe('assertEmbeddingDimensionMatchesDatabase', () => {
  it('resolves when the column and the configuration agree', async () => {
    await expect(assertEmbeddingDimensionMatchesDatabase(db)).resolves.toBeUndefined()
  })

  it('throws when the column disagrees with the configuration', async () => {
    // The HNSW index is built over the column, so the type change needs it out of the way.
    await db.execute(sql`drop index if exists builder_embeddings_hnsw_idx`)
    await db.execute(sql`alter table builder_embeddings alter column embedding type vector(512) using null`)
    try {
      resetEmbeddingDimensionCheck()
      expect(await readDatabaseEmbeddingDimension(db)).toBe(512)
      await expect(assertEmbeddingDimensionMatchesDatabase(db)).rejects.toThrow(EmbeddingDimensionMismatchError)
      // The message has to name both numbers and the remedy — an operator reading a cold-start
      // stack trace at 3am is the audience.
      await expect(assertEmbeddingDimensionMatchesDatabase(db)).rejects.toThrow(/vector\(512\)/)
      await expect(assertEmbeddingDimensionMatchesDatabase(db)).rejects.toThrow(new RegExp(`AI_EMBEDDING_DIM=${EMBEDDING_DIM}`))
    } finally {
      await db.execute(sql`alter table builder_embeddings alter column embedding type vector(768) using null`)
      resetEmbeddingDimensionCheck()
    }
  })

  it('treats an unmigrated database as not-ready rather than as a mismatch', async () => {
    // A fresh database that has not run migrations yet has no table to compare against. Throwing
    // there would turn "run the migrator" into a confusing dimension error.
    await db.execute(sql`alter table builder_embeddings rename to builder_embeddings_stashed`)
    try {
      resetEmbeddingDimensionCheck()
      expect(await readDatabaseEmbeddingDimension(db)).toBeNull()
      await expect(assertEmbeddingDimensionMatchesDatabase(db)).resolves.toBeUndefined()
    } finally {
      await db.execute(sql`alter table builder_embeddings_stashed rename to builder_embeddings`)
      resetEmbeddingDimensionCheck()
    }
  })

  it('runs the query once per process and reuses the verdict', async () => {
    let queries = 0
    const counting = {
      execute: (...args: Parameters<typeof db.execute>) => {
        queries += 1
        return db.execute(...args)
      },
    } as unknown as PostgresJsDatabase

    await assertEmbeddingDimensionMatchesDatabase(counting)
    await assertEmbeddingDimensionMatchesDatabase(counting)
    await assertEmbeddingDimensionMatchesDatabase(counting)

    // Called on every vector query, so a per-call round trip would be a real cost.
    expect(queries).toBe(1)
  })
})
