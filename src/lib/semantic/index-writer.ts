// Write-through indexing for the semantic-search plan. Called fire-and-forget
// from the search and track routes — never awaited on the request's response
// path, so a slow/failed DB write never affects search latency. No AI call
// happens here: rows are inserted/updated as "pending" (embedding = NULL)
// and picked up later by the run-worker (src/routes/api/admin/embeddings/run-worker.ts).
import { buildEmbeddingDoc, contentHashOf, toEmbeddedProfile, type EmbeddableSource } from './embedding-doc'
import { upsertBuilderEmbeddingStub } from '~/shared/lib/repositories/public-builder-embeddings'
import { log } from '~/shared/lib/log'

/**
 * Upserts a `builder_embeddings` stub row per profile. Safe to call with
 * federated search results or a single freshly-tracked builder. Never
 * throws — failures are logged and skipped so callers can fire-and-forget
 * (`.catch(log)` per the spec would be redundant; this already swallows).
 *
 * Sums the `contentChanged` count returned by each `upsertBuilderEmbeddingStub`
 * call and emits one structured log line per batch so a downstream
 * consumer can see write-through churn without re-reading the row.
 * Fresh inserts and content edits both count as `changed = true`; an
 * identical re-index is `changed = false`.
 */
export async function upsertEmbeddingStubs(profiles: EmbeddableSource[]): Promise<void> {
  let seen = 0
  let changed = 0
  await Promise.all(profiles.map(async (profile) => {
    try {
      const document = buildEmbeddingDoc(profile)
      const contentHash = contentHashOf(document)
      const isChanged = await upsertBuilderEmbeddingStub({
        source: profile.source,
        sourceId: profile.sourceId,
        document,
        contentHash,
        profile: toEmbeddedProfile(profile),
      })
      seen += 1
      if (isChanged) changed += 1
    } catch (error) {
      log.error('embedding_stub_upsert_error', {
        source: profile.source,
        sourceId: profile.sourceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }))
  if (seen > 0) {
    log.info('semantic_index_write_through', { seen, changed })
  }
}
