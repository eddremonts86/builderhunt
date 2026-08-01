/**
 * Persisting public source observations (plan 43 — solutions-intelligence Phase 3, "Persist
 * approved source observations").
 *
 * Two tables already existed for this and one of them was dead: `builder_source_snapshots` has had
 * a schema, a migration, and a `(builder_identity_id, content_hash)` unique index since it was
 * created, but **nothing in the codebase ever inserted a row** — confirmed 2026-08-01, the live dev
 * table holds 0 rows. So the content-hash dedup the index promises was never exercised, and there
 * was no path by which an approved ingestion could record what a source actually said at a point in
 * time. Phase 5 needs exactly that: a projection is only reproducible from evidence if the
 * observation behind it was stored.
 *
 * This module is the single write path. Three properties it has to hold, in this order:
 *
 *   1. **Deletion and restriction win over ingestion.** A suppressed identity (the subject asked to
 *      be removed) or a processing-restricted one is never written, and never has its freshness
 *      bumped — a `last_seen_at` update is itself processing. Checked before any write.
 *   2. **Unchanged content creates nothing.** Re-observing an identical profile must not append a
 *      second snapshot, or the table grows without bound on every refresh cycle and "what changed
 *      and when" becomes unanswerable.
 *   3. **Freshness is idempotent.** Bumping `last_seen_at` on an unchanged observation is correct and
 *      must not be confused with a content change.
 */
import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { canonicalJson } from '~/shared/lib/ai/cache'
import { publicDb } from '../db/client'
import { builderIdentities, builderSourceSnapshots } from '../db/schema'
import { isSuppressed } from '../profile-suppression'
import { randomId } from '~/lib/utils'

/** The minimized public facts one observation carries. Never a raw upstream response body. */
export interface SourceObservation {
  source: string
  sourceId: string
  username: string
  profileUrl: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  followersCount?: number
  language?: string | null
  country?: string | null
  /**
   * The already-minimized payload to snapshot. Hashed canonically, so key order and whitespace
   * cannot make an unchanged observation look changed — the same failure mode
   * `computeEvidenceContentHash` guards against for enrichment evidence.
   */
  payload: Record<string, unknown>
  observedAt?: Date
}

export type SourceObservationOutcome =
  /** New content: a snapshot row was appended and the identity refreshed. */
  | { status: 'recorded'; builderIdentityId: string; contentHash: string; identityCreated: boolean }
  /** Same content as an existing snapshot: only freshness moved. */
  | { status: 'unchanged'; builderIdentityId: string; contentHash: string }
  /** Nothing was written at all, and nothing may be. */
  | { status: 'skipped'; reason: 'suppressed' | 'processing_restricted' }

/**
 * Hash over the canonical payload plus the account it describes.
 *
 * The (source, sourceId) pair is part of the hash on purpose: without it, two accounts that happen
 * to publish byte-identical minimal payloads — trivially possible for a sparse profile with only a
 * username — would collide, and the second one's snapshot would be silently dropped by the unique
 * index as a "duplicate".
 */
export function computeObservationContentHash(input: Pick<SourceObservation, 'source' | 'sourceId' | 'payload'>): string {
  return createHash('sha256')
    .update(canonicalJson({ source: input.source, sourceId: input.sourceId, payload: input.payload }))
    .digest('hex')
}

async function isProcessingRestricted(db: PostgresJsDatabase, builderIdentityId: string): Promise<boolean> {
  // The SQL function, not a direct read of `builder_processing_restrictions`: that table is
  // platform-role-owned and app/worker are expected to consult the effective boolean instead — the
  // same call `enrichment.ts:187` and `enrichment-worker.ts:266` already make.
  const rows = await db.execute<{ restricted: boolean }>(
    sql`select is_builder_processing_restricted(${builderIdentityId}) as restricted`,
  )
  return rows[0]?.restricted === true
}

/**
 * Records one approved observation. Safe to call repeatedly with the same input: the second call
 * returns `unchanged` and appends nothing.
 *
 * Runs in a transaction so a snapshot can never be committed without the identity refresh that
 * accompanies it, and so two concurrent observations of the same account cannot interleave into a
 * state where the identity says it was seen but no snapshot exists.
 */
export async function recordSourceObservation(
  observation: SourceObservation,
  db: PostgresJsDatabase = publicDb,
): Promise<SourceObservationOutcome> {
  // Removal first, and outside the transaction: a suppressed identity must not even be looked up in
  // a way that could create it.
  if (await isSuppressed(observation.source, observation.sourceId)) {
    return { status: 'skipped', reason: 'suppressed' }
  }

  const contentHash = computeObservationContentHash(observation)
  const observedAt = observation.observedAt ?? new Date()

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: builderIdentities.id })
      .from(builderIdentities)
      .where(and(eq(builderIdentities.source, observation.source), eq(builderIdentities.sourceId, observation.sourceId)))
      .limit(1)

    // A restriction is keyed by identity id, so it can only exist for an account already known.
    // Checking here — after the lookup, before any write — is what keeps a restricted subject's row
    // from having its freshness bumped, which is itself processing.
    if (existing && await isProcessingRestricted(tx as unknown as PostgresJsDatabase, existing.id)) {
      return { status: 'skipped', reason: 'processing_restricted' } as const
    }

    const builderIdentityId = existing?.id ?? randomId()
    if (existing) {
      await tx
        .update(builderIdentities)
        .set({
          username: observation.username,
          profileUrl: observation.profileUrl,
          displayName: observation.displayName ?? null,
          avatarUrl: observation.avatarUrl ?? null,
          bio: observation.bio ?? null,
          followersCount: observation.followersCount ?? 0,
          language: observation.language ?? null,
          country: observation.country ?? null,
          lastSeenAt: observedAt,
          updatedAt: new Date(),
        })
        .where(eq(builderIdentities.id, builderIdentityId))
    } else {
      await tx.insert(builderIdentities).values({
        id: builderIdentityId,
        source: observation.source,
        sourceId: observation.sourceId,
        username: observation.username,
        profileUrl: observation.profileUrl,
        displayName: observation.displayName ?? null,
        avatarUrl: observation.avatarUrl ?? null,
        bio: observation.bio ?? null,
        followersCount: observation.followersCount ?? 0,
        language: observation.language ?? null,
        country: observation.country ?? null,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      })
    }

    // `onConflictDoNothing` against the existing (identity, content_hash) unique index is what makes
    // re-observation free: an unchanged profile returns no row, so `unchanged` is measured rather
    // than guessed by comparing payloads in JS.
    const inserted = await tx
      .insert(builderSourceSnapshots)
      .values({ builderIdentityId, contentHash, payload: observation.payload, observedAt })
      .onConflictDoNothing({ target: [builderSourceSnapshots.builderIdentityId, builderSourceSnapshots.contentHash] })
      .returning({ id: builderSourceSnapshots.id })

    return inserted.length > 0
      ? { status: 'recorded', builderIdentityId, contentHash, identityCreated: !existing } as const
      : { status: 'unchanged', builderIdentityId, contentHash } as const
  })
}

export interface SourceObservationHistoryEntry {
  contentHash: string
  payload: Record<string, unknown>
  observedAt: Date
}

/**
 * Observation history for one account, newest first — the evidence trail behind a projection.
 * Bounded by `limit` because this is read on request paths and an account observed for years has an
 * unbounded number of snapshots.
 */
export async function listSourceObservations(
  builderIdentityId: string,
  limit = 20,
  db: PostgresJsDatabase = publicDb,
): Promise<SourceObservationHistoryEntry[]> {
  const rows = await db
    .select({
      contentHash: builderSourceSnapshots.contentHash,
      payload: builderSourceSnapshots.payload,
      observedAt: builderSourceSnapshots.observedAt,
    })
    .from(builderSourceSnapshots)
    .where(eq(builderSourceSnapshots.builderIdentityId, builderIdentityId))
    .orderBy(sql`${builderSourceSnapshots.observedAt} desc`)
    .limit(limit)
  return rows.map((row) => ({ ...row, payload: row.payload as Record<string, unknown> }))
}
