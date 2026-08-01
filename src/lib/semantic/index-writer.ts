// Write-through indexing for the semantic-search plan. Called fire-and-forget
// from the search and track routes — never awaited on the request's response
// path, so a slow/failed DB write never affects search latency. No AI call
// happens here: rows are inserted/updated as "pending" (embedding = NULL)
// and picked up later by the run-worker (src/routes/api/admin/embeddings/run-worker.ts).
import { buildEmbeddingDoc, contentHashOf, toEmbeddedProfile, type EmbeddableSource } from './embedding-doc'
import { upsertBuilderEmbeddingStub } from '~/shared/lib/repositories/public-builder-embeddings'
import { recordSourceObservation } from '~/shared/lib/repositories/source-observations'
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

/**
 * Records each profile as a public source observation (plan 43 Phase 3, "Persist approved source
 * observations" — spec.md: "Search ingestion may persist approved public source accounts and
 * snapshots before tracking").
 *
 * Deliberately a separate function rather than folded into `upsertEmbeddingStubs`: these are two
 * different writes with different failure meanings, and a snapshot failure must not stop the
 * embedding index from being maintained (or vice versa). Callers fire both.
 *
 * Cost note: this roughly doubles the write-through work per ingested profile. It is bounded in
 * practice because `recordSourceObservation` dedupes on a content hash, so a profile that has not
 * changed since the last observation resolves to an `ON CONFLICT DO NOTHING` and a `last_seen_at`
 * bump — steady state is cheap, and only genuinely changed profiles append a row. Both writes are
 * fire-and-forget off the request path for the same reason.
 *
 * Never throws: identical contract to `upsertEmbeddingStubs`, so callers can `.catch()` and move on.
 */
export async function recordIngestedSourceObservations(profiles: EmbeddableSource[]): Promise<void> {
  let recorded = 0
  let unchanged = 0
  let skipped = 0
  await Promise.all(profiles.map(async (profile) => {
    try {
      const outcome = await recordSourceObservation({
        source: profile.source,
        sourceId: profile.sourceId,
        username: profile.username,
        kind: profile.kind ?? 'person',
        profileUrl: profile.profileUrl,
        displayName: profile.displayName ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        bio: profile.bio ?? null,
        followersCount: profile.followersCount ?? 0,
        language: profile.language ?? null,
        country: profile.country ?? null,
        // The same minimized public projection the embedding document is built from — never a raw
        // upstream response body.
        payload: toEmbeddedProfile(profile) as unknown as Record<string, unknown>,
        // The connector's metadata, which is where a profile's self-declared links live. Not snapshotted;
        // read once to record what this account says about its other accounts.
        declaredLinkFields: profile.metadata ?? null,
      })
      if (outcome.status === 'recorded') recorded += 1
      else if (outcome.status === 'unchanged') unchanged += 1
      else skipped += 1
    } catch (error) {
      log.error('source_observation_write_error', {
        source: profile.source,
        sourceId: profile.sourceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }))
  if (recorded + unchanged + skipped > 0) {
    // `skipped` counts suppressed and processing-restricted identities. A non-zero value is the
    // expected, correct outcome for a subject who asked to be removed — not an error.
    log.info('source_observation_write_through', { recorded, unchanged, skipped })
  }
}
