// Embeddings run-worker: selects pending `builder_embeddings` rows
// (embedding IS NULL) and embeds them via the configured provider
// (src/shared/lib/ai/embeddings.ts). No AI call happens on the search/track
// request path (see index-writer.ts) — this worker is what actually
// populates vectors, meant to be hit by an external scheduler every 5–15 min
// (see src/routes/api/admin/embeddings/run-worker.ts).
import { embedTexts } from '~/shared/lib/ai/embeddings'
import { log } from '~/shared/lib/log'
import {
  findPendingBuilderEmbeddings,
  markBuilderEmbeddingsEmbedded,
} from '~/shared/lib/repositories/public-builder-embeddings'

const MAX_ROWS_PER_RUN = 256
const EMBED_BATCH_SIZE = 64

export interface EmbeddingsWorkerResult {
  pending: number
  embedded: number
  failed: number
}

/**
 * Runs one pass: fetch up to `MAX_ROWS_PER_RUN` pending rows, embed them in
 * batches of `EMBED_BATCH_SIZE`, and mark each batch embedded. Idempotent —
 * a rerun only ever re-selects rows still `embedding IS NULL`; a batch that
 * fails is skipped (left pending) rather than partially written, so a
 * concurrent/overlapping run just re-processes the same rows (last write
 * wins on identical content, per spec.md).
 */
export async function runEmbeddingsWorker(): Promise<EmbeddingsWorkerResult> {
  const rows = await findPendingBuilderEmbeddings(MAX_ROWS_PER_RUN)
  const result: EmbeddingsWorkerResult = { pending: rows.length, embedded: 0, failed: 0 }

  for (let start = 0; start < rows.length; start += EMBED_BATCH_SIZE) {
    const batch = rows.slice(start, start + EMBED_BATCH_SIZE)
    try {
      const vectors = await embedTexts(batch.map((row) => row.document))
      await markBuilderEmbeddingsEmbedded(
        batch.map((row, i) => ({ id: row.id, embedding: vectors[i] })),
      )
      result.embedded += batch.length
    } catch (error) {
      result.failed += batch.length
      log.error('embeddings_worker_batch_error', {
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}
