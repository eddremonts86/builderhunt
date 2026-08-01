/**
 * Startup assertion that the configured embedding dimension matches the one the database column
 * was actually created with (plan 43 Phase 2, "Unify embedding dimension and entity contracts":
 * "Select one runtime dimension, validate it at startup and write time").
 *
 * Write time was already covered: `embeddings.ts` throws `AIDimensionMismatchError` when the
 * provider returns a vector whose length differs from `AI_EMBEDDING_DIM`. That check compares the
 * *model* against the *config* and never looks at the database — so the one mismatch it cannot
 * see is the one that matters most:
 *
 *   config says N, model returns N, column is M
 *
 * In that state every embed succeeds and every INSERT fails at the Postgres level, or — worse, if
 * M > N — a `vector(M)` column silently accepts nothing and the HNSW index quietly matches
 * nothing, so semantic search returns an empty candidate set and the caller degrades to keyword
 * search forever without a single error in the logs. Failing loudly on first use is the whole
 * point.
 *
 * Deliberately NOT part of `embedding-dim.ts`: that module is imported by `db/schema.ts` to size
 * the column, so importing a database client from it would be circular.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { EMBEDDING_DIM } from './embedding-dim'

export class EmbeddingDimensionMismatchError extends Error {
  constructor(configured: number, actual: number) {
    super(
      `Configured AI_EMBEDDING_DIM=${configured} does not match the builder_embeddings.embedding `
      + `column, which is vector(${actual}). Every embedding write will fail (or every vector `
      + `search will silently match nothing). Fix AI_EMBEDDING_DIM to ${actual}, or migrate the `
      + `column to vector(${configured}) and re-embed every row — see `
      + `scripts/db/reembed-builder-embeddings.mjs.`,
    )
    this.name = 'EmbeddingDimensionMismatchError'
  }
}

/**
 * `atttypmod` on a pgvector column is the declared dimension verbatim (unlike varchar, which
 * offsets by 4). Verified against the live column: `vector(768)` → `atttypmod = 768`.
 * Returns null when the table or column does not exist yet — a fresh database that has not been
 * migrated is not a mismatch, it is simply not ready, and the migrator is what fixes it.
 */
export async function readDatabaseEmbeddingDimension(db: PostgresJsDatabase): Promise<number | null> {
  const rows = await db.execute<{ dimension: number | null }>(sql`
    select a.atttypmod as dimension
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'builder_embeddings'
      and a.attname = 'embedding'
      and a.attnum > 0
      and not a.attisdropped
  `)
  const dimension = rows[0]?.dimension
  // atttypmod is -1 for a bare `vector` with no declared dimension, which is also not something
  // this check can meaningfully compare against.
  return typeof dimension === 'number' && dimension > 0 ? dimension : null
}

let cached: Promise<void> | null = null

/**
 * Runs the check at most once per process. Callers on the vector path (`embed-worker`,
 * `semantic-search`) await this before their first database round trip, which makes it a startup
 * assertion in practice without needing a framework startup hook that a serverless cold start
 * would skip anyway.
 */
export function assertEmbeddingDimensionMatchesDatabase(db: PostgresJsDatabase): Promise<void> {
  cached ??= readDatabaseEmbeddingDimension(db).then((actual) => {
    if (actual !== null && actual !== EMBEDDING_DIM) {
      throw new EmbeddingDimensionMismatchError(EMBEDDING_DIM, actual)
    }
  })
  return cached
}

/** Test seam — lets a suite re-run the assertion against a different disposable database. */
export function resetEmbeddingDimensionCheck(): void {
  cached = null
}
