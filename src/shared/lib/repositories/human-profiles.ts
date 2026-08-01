/**
 * Canonical human profiles and their evidence-bearing source links
 * (plan 43 — solutions-intelligence Phase 3, "Implement reversible identity linking").
 *
 * The decision of *whether* evidence justifies a link lives in `human-identity/link-policy.ts`, and
 * the database enforces the same rule as constraints. This module is the transactional layer: it
 * applies decisions, works the review queue, and performs merges that can be undone.
 *
 * "Reversible" is the whole design constraint, and it is not free. An unmerge has to restore the
 * absorbed human, every link that moved, and every projected field the merge overwrote. That is why
 * withdrawal sets `valid_until` instead of deleting, why the active-link unique index is partial,
 * and why `human_merge_events.restore_snapshot` captures the pre-merge state rather than trusting
 * that it can be recomputed. A merge whose inputs are gone cannot be reversed no matter how good the
 * code is.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { canonicalHumans, humanMergeEvents, humanSourceLinks } from '../db/schema'
import { chooseFieldValue, decideLink, isActiveState, type LinkMethod, type LinkSignal } from '~/shared/lib/human-identity/link-policy'
import { randomId } from '~/lib/utils'

/** The canonical fields a merge can carry across, and that an unmerge must be able to put back. */
const PROJECTED_FIELDS = ['displayName', 'headline', 'country', 'language'] as const
type ProjectedField = (typeof PROJECTED_FIELDS)[number]

export interface FieldProvenance {
  sourceLinkId: string
  observedAt: string
}

export interface LinkSourceAccountInput {
  builderIdentityId: string
  signal: LinkSignal
  /** Attach to this human, or create a new one when omitted. */
  canonicalHumanId?: string
  /** Values this account contributes to the canonical projection, if it wins them. */
  projected?: Partial<Record<ProjectedField, string | null>>
  observedAt?: Date
}

export interface LinkSourceAccountResult {
  canonicalHumanId: string
  sourceLinkId: string
  reviewState: 'auto_approved' | 'pending_review'
  /** True when the account is now attached; false when it is only queued for a human to decide. */
  active: boolean
}

/**
 * Applies one linking signal.
 *
 * A probabilistic signal always lands as `pending_review` and never touches the projection — a
 * queued proposal must not change what the public sees about a person before anyone has agreed it
 * is the same person.
 */
export async function linkSourceAccount(
  input: LinkSourceAccountInput,
  db: PostgresJsDatabase = publicDb,
): Promise<LinkSourceAccountResult> {
  const decision = decideLink(input.signal)
  const observedAt = input.observedAt ?? new Date()

  return db.transaction(async (tx) => {
    const canonicalHumanId = input.canonicalHumanId ?? randomId()
    if (!input.canonicalHumanId) {
      await tx.insert(canonicalHumans).values({ id: canonicalHumanId, createdAt: observedAt, updatedAt: observedAt })
    }

    const sourceLinkId = randomId()
    const [link] = await tx
      .insert(humanSourceLinks)
      .values({
        id: sourceLinkId,
        canonicalHumanId,
        builderIdentityId: input.builderIdentityId,
        linkMethod: decision.method,
        reviewState: decision.reviewState,
        confidenceBps: decision.confidenceBps,
        evidence: { ...decision.evidence, rationale: decision.rationale },
        validFrom: observedAt,
        createdAt: observedAt,
        updatedAt: observedAt,
      })
      // Re-signalling the same (human, account) pair revalidates the existing row instead of
      // stacking duplicates that would then disagree about review state.
      .onConflictDoUpdate({
        target: [humanSourceLinks.canonicalHumanId, humanSourceLinks.builderIdentityId],
        set: {
          linkMethod: decision.method,
          reviewState: decision.reviewState,
          confidenceBps: decision.confidenceBps,
          evidence: { ...decision.evidence, rationale: decision.rationale },
          validUntil: null,
          updatedAt: observedAt,
        },
      })
      .returning({ id: humanSourceLinks.id, reviewState: humanSourceLinks.reviewState })

    const active = isActiveState(link.reviewState as 'auto_approved' | 'pending_review' | 'approved' | 'rejected')
    if (active && input.projected) {
      await applyProjection(tx, canonicalHumanId, link.id, decision.method, input.projected, observedAt)
    }

    return {
      canonicalHumanId,
      sourceLinkId: link.id,
      reviewState: decision.reviewState as 'auto_approved' | 'pending_review',
      active,
    }
  })
}

/**
 * Folds one account's values into the canonical projection, recording where each surviving value
 * came from. Stronger evidence wins; ties go to the newer observation (`chooseFieldValue`).
 */
async function applyProjection(
  tx: PostgresJsDatabase,
  canonicalHumanId: string,
  sourceLinkId: string,
  method: LinkMethod,
  projected: Partial<Record<ProjectedField, string | null>>,
  observedAt: Date,
): Promise<void> {
  const [human] = await tx.select().from(canonicalHumans).where(eq(canonicalHumans.id, canonicalHumanId)).limit(1)
  if (!human) return

  const provenance = { ...(human.fieldProvenance ?? {}) } as Record<string, FieldProvenance>
  const updates: Partial<Record<ProjectedField, string | null>> = {}

  for (const field of PROJECTED_FIELDS) {
    const candidateValue = projected[field]
    if (candidateValue === undefined) continue

    const existingProvenance = provenance[field]
    const currentValue = human[field] as string | null
    // A field with a value but no provenance predates this system; treat it as the weakest possible
    // claim so real evidence can take it over rather than being blocked by it.
    const current = currentValue === null && !existingProvenance
      ? null
      : {
          value: currentValue,
          sourceLinkId: existingProvenance?.sourceLinkId ?? '',
          method: existingProvenance ? await methodOfLink(tx, existingProvenance.sourceLinkId) : 'probabilistic_candidate' as LinkMethod,
          observedAt: existingProvenance ? new Date(existingProvenance.observedAt) : new Date(0),
        }

    const winner = chooseFieldValue(current, { value: candidateValue, sourceLinkId, method, observedAt })
    if (winner.replaced) {
      updates[field] = winner.value
      provenance[field] = { sourceLinkId: winner.sourceLinkId, observedAt: winner.observedAt.toISOString() }
    }
  }

  if (Object.keys(updates).length > 0) {
    await tx
      .update(canonicalHumans)
      .set({ ...updates, fieldProvenance: provenance, updatedAt: observedAt })
      .where(eq(canonicalHumans.id, canonicalHumanId))
  }
}

async function methodOfLink(tx: PostgresJsDatabase, sourceLinkId: string): Promise<LinkMethod> {
  if (!sourceLinkId) return 'probabilistic_candidate'
  const [row] = await tx.select({ linkMethod: humanSourceLinks.linkMethod }).from(humanSourceLinks).where(eq(humanSourceLinks.id, sourceLinkId)).limit(1)
  return (row?.linkMethod as LinkMethod) ?? 'probabilistic_candidate'
}

export interface ReviewQueueEntry {
  sourceLinkId: string
  canonicalHumanId: string
  builderIdentityId: string
  linkMethod: string
  confidenceBps: number
  evidence: Record<string, unknown>
  createdAt: Date
}

/**
 * Proposals awaiting a human decision, most likely first, oldest breaking ties so nothing starves.
 * Bounded — this is an admin surface, not a batch export.
 */
export async function listLinkReviewQueue(limit = 50, db: PostgresJsDatabase = publicDb): Promise<ReviewQueueEntry[]> {
  const rows = await db
    .select({
      sourceLinkId: humanSourceLinks.id,
      canonicalHumanId: humanSourceLinks.canonicalHumanId,
      builderIdentityId: humanSourceLinks.builderIdentityId,
      linkMethod: humanSourceLinks.linkMethod,
      confidenceBps: humanSourceLinks.confidenceBps,
      evidence: humanSourceLinks.evidence,
      createdAt: humanSourceLinks.createdAt,
    })
    .from(humanSourceLinks)
    .where(eq(humanSourceLinks.reviewState, 'pending_review'))
    .orderBy(desc(humanSourceLinks.confidenceBps), asc(humanSourceLinks.createdAt))
    .limit(limit)
  return rows.map((row) => ({ ...row, evidence: row.evidence as Record<string, unknown> }))
}

/**
 * A reviewer's verdict on a queued proposal. Approving is the only route by which a similarity
 * signal ever becomes an active link.
 *
 * Returns false when the proposal is no longer pending — another reviewer got there first, or the
 * account was linked elsewhere in the meantime. Callers surface that rather than retrying, because a
 * silent overwrite of someone else's decision is exactly what a review queue must not do.
 */
export async function resolveLinkReview(
  input: { sourceLinkId: string; verdict: 'approved' | 'rejected'; reviewerUserId: string; at?: Date },
  db: PostgresJsDatabase = publicDb,
): Promise<boolean> {
  const at = input.at ?? new Date()
  const updated = await db
    .update(humanSourceLinks)
    .set({ reviewState: input.verdict, reviewedByUserId: input.reviewerUserId, reviewedAt: at, updatedAt: at })
    .where(and(eq(humanSourceLinks.id, input.sourceLinkId), eq(humanSourceLinks.reviewState, 'pending_review')))
    .returning({ id: humanSourceLinks.id })
  return updated.length > 0
}

/**
 * Detaches an account from a human without erasing that it was ever attached.
 *
 * `valid_until` rather than DELETE: the active-link unique index is partial on `valid_until IS NULL`,
 * so this both frees the account to be linked correctly elsewhere and keeps the record that it was
 * once linked here — which is what makes "why was this person shown as that account last week"
 * answerable, and what an unmerge reads to put things back.
 */
export async function withdrawSourceLink(
  input: { sourceLinkId: string; at?: Date },
  db: PostgresJsDatabase = publicDb,
): Promise<boolean> {
  const at = input.at ?? new Date()
  const updated = await db
    .update(humanSourceLinks)
    .set({ validUntil: at, updatedAt: at })
    .where(and(eq(humanSourceLinks.id, input.sourceLinkId), isNull(humanSourceLinks.validUntil)))
    .returning({ id: humanSourceLinks.id })
  return updated.length > 0
}

export interface MergeResult {
  mergeEventId: string
  movedSourceLinkIds: string[]
}

/**
 * Merges `sourceCanonicalHumanId` into `targetCanonicalHumanId`.
 *
 * Records everything needed to reverse it *before* changing anything: the absorbed human's own
 * fields, its provenance map, the target's pre-merge fields and provenance, and which links moved.
 * The absorbed row is left in place rather than deleted — an unmerge needs somewhere to put the links
 * back, and re-creating a row with the same id later is not the same thing as never having removed
 * it (foreign keys elsewhere may already point at it).
 */
export async function mergeCanonicalHumans(
  input: {
    targetCanonicalHumanId: string
    sourceCanonicalHumanId: string
    reason: string
    performedByUserId?: string
    at?: Date
  },
  db: PostgresJsDatabase = publicDb,
): Promise<MergeResult> {
  if (input.targetCanonicalHumanId === input.sourceCanonicalHumanId) {
    throw new Error('Cannot merge a canonical human into itself')
  }
  const at = input.at ?? new Date()

  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(canonicalHumans).where(eq(canonicalHumans.id, input.targetCanonicalHumanId)).limit(1)
    const [source] = await tx.select().from(canonicalHumans).where(eq(canonicalHumans.id, input.sourceCanonicalHumanId)).limit(1)
    if (!target || !source) throw new Error('Both canonical humans must exist to merge')

    const movable = await tx
      .select({ id: humanSourceLinks.id })
      .from(humanSourceLinks)
      .where(eq(humanSourceLinks.canonicalHumanId, input.sourceCanonicalHumanId))
    const movedSourceLinkIds = movable.map((row) => row.id)

    const mergeEventId = crypto.randomUUID()
    await tx.insert(humanMergeEvents).values({
      id: mergeEventId,
      targetCanonicalHumanId: input.targetCanonicalHumanId,
      sourceCanonicalHumanId: input.sourceCanonicalHumanId,
      performedByUserId: input.performedByUserId ?? null,
      reason: input.reason,
      // Captured, not recomputed: after the merge these values no longer exist anywhere else.
      restoreSnapshot: {
        movedSourceLinkIds,
        source: projectionOf(source),
        target: projectionOf(target),
      },
      createdAt: at,
    })

    if (movedSourceLinkIds.length > 0) {
      await tx
        .update(humanSourceLinks)
        .set({ canonicalHumanId: input.targetCanonicalHumanId, updatedAt: at })
        .where(inArray(humanSourceLinks.id, movedSourceLinkIds))
    }

    // Fill only fields the target is missing. A merge must not silently overwrite the surviving
    // human's established values with the absorbed one's.
    const fills: Partial<Record<ProjectedField, string | null>> = {}
    const provenance = { ...(target.fieldProvenance ?? {}) } as Record<string, FieldProvenance>
    for (const field of PROJECTED_FIELDS) {
      if (target[field] === null && source[field] !== null) {
        fills[field] = source[field] as string | null
        const inherited = (source.fieldProvenance ?? {})[field]
        if (inherited) provenance[field] = inherited
      }
    }
    if (Object.keys(fills).length > 0) {
      await tx.update(canonicalHumans).set({ ...fills, fieldProvenance: provenance, updatedAt: at }).where(eq(canonicalHumans.id, input.targetCanonicalHumanId))
    }

    return { mergeEventId, movedSourceLinkIds }
  })
}

/**
 * Reverses a merge: every moved link goes back to the absorbed human, and both projections return to
 * their captured pre-merge state.
 *
 * Reads the snapshot rather than inferring. Inference would be wrong the moment anything changed
 * after the merge — a link withdrawn, a field re-observed — and "mostly restored" is not reversible.
 *
 * Returns false when the merge was already reverted, so a double-click cannot undo a later,
 * unrelated merge's work.
 */
export async function unmergeCanonicalHumans(
  input: { mergeEventId: string; revertedByUserId?: string; at?: Date },
  db: PostgresJsDatabase = publicDb,
): Promise<boolean> {
  const at = input.at ?? new Date()

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(humanMergeEvents)
      .where(and(eq(humanMergeEvents.id, input.mergeEventId), isNull(humanMergeEvents.revertedAt)))
      .limit(1)
    if (!event) return false

    const snapshot = event.restoreSnapshot as {
      movedSourceLinkIds?: string[]
      source?: Record<string, string | null>
      target?: Record<string, string | null>
    }

    const movedIds = snapshot.movedSourceLinkIds ?? []
    if (movedIds.length > 0) {
      await tx
        .update(humanSourceLinks)
        .set({ canonicalHumanId: event.sourceCanonicalHumanId, updatedAt: at })
        .where(inArray(humanSourceLinks.id, movedIds))
    }

    // Both sides restored from the snapshot, including field provenance — otherwise the surviving
    // human keeps values whose provenance points at links that no longer belong to it.
    if (snapshot.target) await restoreProjection(tx, event.targetCanonicalHumanId, snapshot.target, at)
    if (snapshot.source) await restoreProjection(tx, event.sourceCanonicalHumanId, snapshot.source, at)

    await tx
      .update(humanMergeEvents)
      .set({ revertedAt: at, revertedByUserId: input.revertedByUserId ?? null })
      .where(eq(humanMergeEvents.id, input.mergeEventId))

    return true
  })
}

function projectionOf(human: typeof canonicalHumans.$inferSelect): Record<string, unknown> {
  return {
    displayName: human.displayName,
    headline: human.headline,
    country: human.country,
    language: human.language,
    fieldProvenance: human.fieldProvenance ?? {},
  }
}

async function restoreProjection(
  tx: PostgresJsDatabase,
  canonicalHumanId: string,
  captured: Record<string, unknown>,
  at: Date,
): Promise<void> {
  await tx
    .update(canonicalHumans)
    .set({
      displayName: (captured.displayName ?? null) as string | null,
      headline: (captured.headline ?? null) as string | null,
      country: (captured.country ?? null) as string | null,
      language: (captured.language ?? null) as string | null,
      fieldProvenance: (captured.fieldProvenance ?? {}) as Record<string, FieldProvenance>,
      updatedAt: at,
    })
    .where(eq(canonicalHumans.id, canonicalHumanId))
}

export interface CanonicalHumanWithAccounts {
  id: string
  displayName: string | null
  headline: string | null
  country: string | null
  language: string | null
  /** Only accounts currently attached — withdrawn and queued links are excluded. */
  activeBuilderIdentityIds: string[]
}

/** The canonical human an account currently belongs to, if any. */
export async function findCanonicalHumanForAccount(
  builderIdentityId: string,
  db: PostgresJsDatabase = publicDb,
): Promise<CanonicalHumanWithAccounts | null> {
  const [link] = await db
    .select({ canonicalHumanId: humanSourceLinks.canonicalHumanId })
    .from(humanSourceLinks)
    .where(and(
      eq(humanSourceLinks.builderIdentityId, builderIdentityId),
      isNull(humanSourceLinks.validUntil),
      inArray(humanSourceLinks.reviewState, ['auto_approved', 'approved']),
    ))
    .limit(1)
  if (!link) return null
  return findCanonicalHuman(link.canonicalHumanId, db)
}

export async function findCanonicalHuman(
  canonicalHumanId: string,
  db: PostgresJsDatabase = publicDb,
): Promise<CanonicalHumanWithAccounts | null> {
  const [human] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, canonicalHumanId)).limit(1)
  if (!human) return null
  const accounts = await db
    .select({ builderIdentityId: humanSourceLinks.builderIdentityId })
    .from(humanSourceLinks)
    .where(and(
      eq(humanSourceLinks.canonicalHumanId, canonicalHumanId),
      isNull(humanSourceLinks.validUntil),
      inArray(humanSourceLinks.reviewState, ['auto_approved', 'approved']),
    ))
    .orderBy(asc(humanSourceLinks.builderIdentityId))
  return {
    id: human.id,
    displayName: human.displayName,
    headline: human.headline,
    country: human.country,
    language: human.language,
    activeBuilderIdentityIds: accounts.map((row) => row.builderIdentityId),
  }
}

/** Merge history for one human, newest first — the audit trail behind its current shape. */
export async function listMergeHistory(
  canonicalHumanId: string,
  limit = 20,
  db: PostgresJsDatabase = publicDb,
): Promise<Array<{ id: string; sourceCanonicalHumanId: string; reason: string; createdAt: Date; revertedAt: Date | null }>> {
  return db
    .select({
      id: humanMergeEvents.id,
      sourceCanonicalHumanId: humanMergeEvents.sourceCanonicalHumanId,
      reason: humanMergeEvents.reason,
      createdAt: humanMergeEvents.createdAt,
      revertedAt: humanMergeEvents.revertedAt,
    })
    .from(humanMergeEvents)
    .where(sql`${humanMergeEvents.targetCanonicalHumanId} = ${canonicalHumanId} or ${humanMergeEvents.sourceCanonicalHumanId} = ${canonicalHumanId}`)
    .orderBy(desc(humanMergeEvents.createdAt))
    .limit(limit)
}
