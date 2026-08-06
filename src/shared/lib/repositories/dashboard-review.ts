import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import {
  alertTriggers,
  builderIdentities,
  builderListItems,
  builderLists,
  builders,
  organizationBuilders,
  sourcingSprints,
  sprintResults,
} from '../db/schema'

/**
 * Candidates to review — the dashboard's answer to "who should I look at next?"
 * (plans/ui-dashboard Wave 4, "Build Candidates to Review as a unified projection").
 *
 * ## What is in it, and the one thing that is deliberately not
 *
 * Two cheap, indexed sources:
 *
 * - **Unread alert matches.** Someone this workspace already tracks did something an alert was
 *   watching for. The most actionable row on the page: the person is known, the signal is fresh, and
 *   the decision is "look now or dismiss".
 * - **Sprint results.** People a completed sourcing sprint found and nobody has tracked yet, ranked
 *   by the score the sprint itself computed.
 *
 * **Live recommendations are not here, and that is a cost decision with a number behind it.**
 * `GET /api/recommendations` re-runs the organization's saved queries through the real federated
 * search pipeline — thirteen connectors, an 8-second per-connector budget, its own rate limit. The
 * overview projection is cached for 30 seconds and read on every dashboard load; folding a federated
 * search into it would put that pipeline behind every page view, for a section whose rows change on
 * the timescale of a saved search, not of a request. Recommendations stay their own lazy widget.
 *
 * The honest consequence, stated because it is the thing this projection was supposed to fix: a
 * person can still appear once here and once in the recommendations widget. Deduplicating across the
 * two needs recommendations to become a cached projection of its own, which is its own task.
 * Everything *within* this projection is deduplicated by identity below.
 *
 * ## Ranking is a product rule, not a model
 *
 * Provenance first, then the source's own signal: an alert match outranks any sprint result, and
 * sprint results order by the score the sprint computed. Both are explainable in one sentence to the
 * person reading the row, which is the bar the spec sets ("deterministic product rules, not
 * unexplained generated prose"). Ties break on identity so the order is total.
 */

export type ReviewProvenance = 'alert-match' | 'sprint-result'

export interface ReviewCandidate {
  /** `<source>:<sourceId>` — the identity key this projection deduplicates on. */
  key: string
  source: string
  sourceId: string
  username: string
  displayName: string | null
  provenance: ReviewProvenance
  /** One short sentence saying why this row is here. Never generated prose. */
  reason: string
  /** Present for a sprint result: the score that sprint computed. */
  score: number | null
  /** Whether the workspace already tracks this person — decides where the row continues to. */
  tracked: boolean
  /** `organization_builders.id` when tracked, so the row can link into the builder workspace. */
  organizationBuilderId: string | null
}

/**
 * Unread alert triggers that name a builder, newest first.
 *
 * ## `alert_triggers.builder_id` points at `builders`, not at `organization_builders`
 *
 * Two tables in this schema hold a person, and they are not the same id space. `builders` is the
 * older per-organization row an alert fires against; `organization_builders` + `builder_identities`
 * is the tracked-roster pair everything newer uses. The foreign key says so —
 * `alert_triggers_builder_id_builders_id_fk` — and the first version of this query joined to
 * `organization_builders.id` anyway.
 *
 * That join matched **nothing**, ever. Not an error: an inner join across two id spaces returns zero
 * rows, so the section would have reported `empty` on every workspace forever — a review queue that
 * silently omits its most actionable half, which is exactly the failure this whole plan exists to
 * remove. Caught by the e2e's foreign-key violation while seeding, not by anything a reader or the
 * type system could have seen.
 *
 * `builder_id` is nullable — a trigger can fire for something that is not a person — and those are
 * skipped rather than rendered without a subject.
 */
async function alertMatches(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
): Promise<ReviewCandidate[]> {
  const rows = await transaction
    .select({
      source: builders.source,
      sourceId: builders.sourceId,
      username: builders.username,
      displayName: builders.displayName,
      matchedAt: alertTriggers.matchedAt,
      // Left-joined: an alert can fire for someone this workspace has *not* added to its tracked
      // roster, and that person still belongs in a review queue — they just continue to their public
      // profile instead of to the internal workspace.
      organizationBuilderId: organizationBuilders.id,
    })
    .from(alertTriggers)
    .innerJoin(builders, and(
      eq(builders.organizationId, alertTriggers.organizationId),
      eq(builders.id, alertTriggers.builderId),
    ))
    .leftJoin(builderIdentities, and(
      eq(builderIdentities.source, builders.source),
      eq(builderIdentities.sourceId, builders.sourceId),
    ))
    .leftJoin(organizationBuilders, and(
      eq(organizationBuilders.organizationId, alertTriggers.organizationId),
      eq(organizationBuilders.builderIdentityId, builderIdentities.id),
    ))
    .where(and(
      eq(alertTriggers.organizationId, organizationId),
      isNull(alertTriggers.readAt),
    ))
    // Total order: two triggers can share a timestamp, and a tie the plan picks reshuffles between
    // requests.
    .orderBy(desc(alertTriggers.matchedAt), desc(alertTriggers.id))
    .limit(limit)

  return rows.map((row) => ({
    key: `${row.source}:${row.sourceId}`,
    source: row.source,
    sourceId: row.sourceId,
    username: row.username,
    displayName: row.displayName,
    provenance: 'alert-match' as const,
    reason: 'An alert you set matched this person',
    score: null,
    tracked: row.organizationBuilderId !== null,
    organizationBuilderId: row.organizationBuilderId,
  }))
}

/**
 * Results from completed sprints that nobody has tracked yet.
 *
 * The `not exists` is what makes this a *review* queue rather than a list: a candidate the workspace
 * already tracks has been decided on, and repeating them here would bury the ones that have not.
 * Matched on `(source, source_id)` against the tracked identity, which is the same pair
 * `builder_identities` is unique on.
 */
async function untrackedSprintResults(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
): Promise<ReviewCandidate[]> {
  const rows = await transaction
    .select({
      source: sprintResults.source,
      sourceId: sprintResults.sourceId,
      profile: sprintResults.profile,
      score: sprintResults.score,
      sprintName: sourcingSprints.name,
    })
    .from(sprintResults)
    .innerJoin(sourcingSprints, and(
      eq(sourcingSprints.organizationId, sprintResults.organizationId),
      eq(sourcingSprints.id, sprintResults.sprintId),
    ))
    .where(and(
      eq(sprintResults.organizationId, organizationId),
      eq(sourcingSprints.status, 'completed'),
      sql`not exists (
        select 1 from ${organizationBuilders} ob
        join ${builderIdentities} bi on bi.id = ob.builder_identity_id
        where ob.organization_id = ${organizationId}
          and bi.source = ${sprintResults.source}
          and bi.source_id = ${sprintResults.sourceId}
      )`,
    ))
    .orderBy(desc(sprintResults.score), desc(sprintResults.sourceId))
    .limit(limit)

  return rows.map((row) => ({
    key: `${row.source}:${row.sourceId}`,
    source: row.source,
    sourceId: row.sourceId,
    username: row.profile.username,
    displayName: row.profile.displayName ?? null,
    provenance: 'sprint-result' as const,
    // Names the sprint, so the reason is checkable rather than an assertion.
    reason: `Found by your "${row.sprintName}" sprint`,
    score: row.score,
    tracked: false,
    organizationBuilderId: null,
  }))
}

/**
 * The merged, deduplicated, ordered queue.
 *
 * Each source is queried at the full limit and the merge trims — a candidate can legitimately appear
 * in both, and querying each at half the limit would let a duplicate cost a slot that a distinct
 * person should have had.
 */
export async function listReviewCandidates(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
): Promise<ReviewCandidate[]> {
  const [matches, results] = await Promise.all([
    alertMatches(transaction, organizationId, limit),
    untrackedSprintResults(transaction, organizationId, limit),
  ])

  // Alert matches first, so a person appearing in both keeps the more actionable provenance and its
  // reason. `Map` insertion order does the deduplication and the precedence in one pass.
  const byKey = new Map<string, ReviewCandidate>()
  for (const candidate of [...matches, ...results]) {
    if (!byKey.has(candidate.key)) byKey.set(candidate.key, candidate)
  }

  return [...byKey.values()].slice(0, limit)
}

/**
 * Shortlists this principal may see, with their sizes (plans/ui-dashboard Wave 4, "Build the
 * Shortlists summary").
 *
 * ## Visibility is the whole difficulty
 *
 * A list is visible when the principal created it **or** it is shared with the organization — the
 * same `or` `listVisibleBuilderLists` applies, repeated here rather than reused because that helper
 * returns whole rows with no counts and this needs one query, not one plus N.
 *
 * Getting it wrong in either direction is bad in a different way: too narrow and a shared list the
 * team works from is invisible on the dashboard; too wide and a colleague's private shortlist —
 * which is a list of *people they are considering* — appears on someone else's screen.
 *
 * Ordered by most recently updated, which is what "what am I working on" means for a list. `id`
 * breaks ties so the order is total.
 */
export interface ShortlistSummary {
  id: string
  name: string
  visibility: string
  itemCount: number
  updatedAt: Date
}

export async function listShortlistSummaries(
  transaction: TenantTransaction,
  organizationId: string,
  userId: string,
  limit: number,
): Promise<ShortlistSummary[]> {
  const rows = await transaction
    .select({
      id: builderLists.id,
      name: builderLists.name,
      visibility: builderLists.visibility,
      updatedAt: builderLists.updatedAt,
      // `count(item.id)`, not `count(*)`: with a left join `count(*)` counts the synthetic row an
      // empty list produces and reports it as holding one builder.
      itemCount: sql<number>`count(${builderListItems.id})::int`,
    })
    .from(builderLists)
    .leftJoin(builderListItems, and(
      eq(builderListItems.organizationId, builderLists.organizationId),
      eq(builderListItems.listId, builderLists.id),
    ))
    .where(and(
      eq(builderLists.organizationId, organizationId),
      or(
        eq(builderLists.createdByUserId, userId),
        eq(builderLists.visibility, 'organization'),
      ),
    ))
    .groupBy(builderLists.id, builderLists.name, builderLists.visibility, builderLists.updatedAt)
    .orderBy(desc(builderLists.updatedAt), desc(builderLists.id))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    itemCount: Number(row.itemCount),
    updatedAt: row.updatedAt,
  }))
}
