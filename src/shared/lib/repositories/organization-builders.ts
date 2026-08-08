import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import type { PublicDb, TenantTransaction } from '../db/client'
import { builderIdentityIdFor } from './builder-identity-id'
import { ENTITY_DETAIL_LIMIT } from '../db/read-bounds'
import {
  builderIdentities,
  builderNotes,
  builders,
  humanSourceLinks,
  organizationBuilders,
  savedQueries,
} from '../db/schema'

export interface TrackOrganizationBuilderInput {
  id: string
  organizationId: string
  creatorUserId: string
  source: string
  sourceId: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  followersCount?: number | null
  language?: string | null
  country?: string | null
  topics?: string[]
  score?: number
  metadata?: Record<string, unknown>
}

const privateBuilderFields = {
  id: organizationBuilders.id,
  identityId: builderIdentities.id,
  username: builderIdentities.username,
  displayName: builderIdentities.displayName,
  avatarUrl: builderIdentities.avatarUrl,
  source: builderIdentities.source,
  sourceId: builderIdentities.sourceId,
  bio: builderIdentities.bio,
  profileUrl: builderIdentities.profileUrl,
  followersCount: builderIdentities.followersCount,
  language: builderIdentities.language,
  country: builderIdentities.country,
  privateMetadata: organizationBuilders.privateMetadata,
  lastSeen: builderIdentities.lastSeenAt,
  createdAt: organizationBuilders.createdAt,
  /** Null until the backfill runs, or when the account belongs to no canonical human yet. Additive
   * during the plan 43 Phase 3 cutover — `identityId` above stays authoritative. */
  canonicalHumanId: organizationBuilders.canonicalHumanId,
}

export function trackedKey(source: string, sourceId: string) {
  return `${source}:${sourceId}`
}

export async function getTrackedKeySet(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await trackedRows(transaction, organizationId)
  return new Set(rows.map((row) => trackedKey(row.source, row.sourceId)))
}

export async function getTrackedBuilderIds(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await trackedRows(transaction, organizationId)
  return new Map(rows.map((row) => [trackedKey(row.source, row.sourceId), row.id]))
}

export function listOrganizationBuilders(transaction: TenantTransaction, organizationId: string) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .orderBy(desc(builderIdentities.lastSeenAt))
}

/**
 * Tracked builders this org has attached at least one private note to (plans/UI/tasks.md Wave 6
 * "Build a scoped Export Center" — the "note collection" export scope). `builder_notes.builderId`
 * stores an `organization_builders.id` — the same id space `resolveOrganizationBuilderId` resolves
 * to and `listOrganizationBuilders` selects as `id` above.
 *
 * `trackOrganizationBuilder` below does still write a legacy `builders` row, reusing that same id, so
 * the two id spaces overlap for anything tracked through it. That overlap is a coincidence of one
 * write path, not an invariant — see the correction on `builderNotes.builderId` in schema.ts.
 */
export async function listNotedOrganizationBuilders(transaction: TenantTransaction, organizationId: string) {
  const noted = await transaction.selectDistinct({ builderId: builderNotes.builderId })
    .from(builderNotes)
    .where(eq(builderNotes.organizationId, organizationId))
  if (noted.length === 0) return []
  const ids = noted.map((row) => row.builderId)
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(eq(organizationBuilders.organizationId, organizationId), inArray(organizationBuilders.id, ids)))
    .orderBy(desc(builderIdentities.lastSeenAt))
}

export function listRecentOrganizationBuilders(
  transaction: TenantTransaction,
  organizationId: string,
  limit = 6,
) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .orderBy(desc(builderIdentities.lastSeenAt))
    .limit(limit)
}

/**
 * Plan: team-synergy. "The team" = the recruiter's own org's tracked
 * builders, most-recently-tracked first (not `listOrganizationBuilders`'
 * `lastSeenAt` ordering, which reflects the builder's own activity, not when
 * the org tracked them). Callers should fetch one extra row beyond their
 * intended cap and filter out the candidate being analyzed themselves, since
 * a tracked candidate must never inflate their own team aggregate.
 */
export function listOrganizationBuildersForTeamAggregate(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
    .orderBy(desc(organizationBuilders.createdAt))
    .limit(limit)
}

export async function countOrganizationBuilders(transaction: TenantTransaction, organizationId: string) {
  const [row] = await transaction.select({ value: count() })
    .from(organizationBuilders)
    .where(eq(organizationBuilders.organizationId, organizationId))
  return Number(row?.value ?? 0)
}

export async function findOrganizationBuilderBySource(
  transaction: TenantTransaction,
  organizationId: string,
  source: string,
  sourceId: string,
) {
  const [row] = await transaction.select({ id: organizationBuilders.id })
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(builderIdentities.source, source),
      eq(builderIdentities.sourceId, sourceId),
    ))
    .limit(1)
  return row ?? null
}

export async function findOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const [row] = await transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
    .limit(1)
  return row ?? null
}

/**
 * Looks up a tracked builder by the org's own membership, keyed by the
 * global `builderIdentities.id` (not `organizationBuilders.id`). Used by
 * `GET /api/builders/:id` so an authenticated recruiter can open the
 * profile page for any builder they've tracked, without requiring the
 * builder to have gone through the separate claim/publish flow that backs
 * `findPublishedBuilderProfile` (the anonymous-safe public path).
 */
export async function findOrganizationBuilderByIdentity(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
) {
  const [row] = await transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(organizationBuilders.builderIdentityId, builderIdentityId),
    ))
    .limit(1)
  return row ?? null
}

/**
 * Two id spaces exist for a tracked builder: `organizationBuilders.id`
 * (== legacy `builders.id`, generated together — see `trackOrganizationBuilder`)
 * and the global `builderIdentities.id`. Different call sites historically
 * picked one or the other (GET /api/builders/:id resolves by identity id;
 * PATCH/DELETE and the notes sub-routes resolve by organizationBuilders.id),
 * so a value that works for one silently 404s on another. This tries both,
 * identity id first since that's what the one working navigation path
 * (Dashboard "Recent builders" -> builder profile) actually passes.
 */
export async function findOrganizationBuilderByEitherId(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const byIdentity = await findOrganizationBuilderByIdentity(transaction, organizationId, id)
  if (byIdentity) return byIdentity
  return findOrganizationBuilder(transaction, organizationId, id)
}

/**
 * Resolves either id space down to the canonical `organizationBuilders.id`
 * (the id `builders`/`builderNotes` rows are actually keyed on). See
 * `findOrganizationBuilderByEitherId` for why both spaces need supporting.
 */
export async function resolveOrganizationBuilderId(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
): Promise<string | null> {
  const row = await findOrganizationBuilderByEitherId(transaction, organizationId, id)
  return row?.id ?? null
}

/**
 * Persists an AI enrichment artifact (plan: ai-profile-enrichment) into the
 * tracked builder's `privateMetadata.aiEnrichment` key, alongside any
 * existing topics/language/country overrides already stored there. Never
 * overwrites the whole `privateMetadata` column. Returns the stored
 * artifact, or `null` if the builder isn't tracked in this org.
 */
export async function setOrganizationBuilderEnrichment(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
  enrichment: Record<string, unknown>,
) {
  const existing = await findOrganizationBuilderByIdentity(transaction, organizationId, builderIdentityId)
  if (!existing) return null
  const privateMetadata = { ...existing.privateMetadata, aiEnrichment: enrichment }
  await transaction.update(organizationBuilders)
    .set({ privateMetadata, updatedAt: new Date() })
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, existing.id)))
  return enrichment
}

/**
 * The one enrichment artifact a public portfolio is allowed to surface (plans/UI/tasks.md Wave 7
 * "Add opt-in AI persona to public portfolios").
 *
 * `organization_builders.privateMetadata.aiEnrichment` is org-scoped — any number of organizations
 * can independently track and enrich the same `builder_identities` row, each with its own private
 * AI-generated judgment of that person. A public portfolio has no "canonical" or "owning"
 * organization to pick from, and showing a stranger org's private research about someone (even with
 * the claimant's own `showAiPersona` opt-in) would surface a third party's assessment, not the
 * claimant's own. So this deliberately narrows to the ONE case that's actually the claimant's own
 * artifact: an `organization_builders` row for this identity that the claimant (`subjectUserId`)
 * themselves created — e.g. tracking themselves in their own personal workspace. Any other org's
 * enrichment of this identity is invisible here, by design.
 *
 * Calls the `public_claimant_owned_ai_enrichment` SECURITY DEFINER function (migration 0119) rather
 * than a plain `.select()` — `organization_builders`'s SELECT RLS policy requires
 * `organization_id = app.organization_id`, which is never set for the anonymous, cross-org read the
 * public portfolio page does (confirmed empirically: a real matching row was invisible to a plain
 * `builderhunt_app` connection with no tenant context — same structural gap 0111 fixed for
 * `builder_claims`). The function runs as its owner regardless of the caller's own privileges, so
 * this is safe to call from either a tenant transaction or `publicDb`.
 */
export async function findClaimantOwnedAiEnrichment(
  transaction: TenantTransaction | PublicDb,
  builderIdentityId: string,
  subjectUserId: string,
): Promise<unknown> {
  const [row] = await transaction.execute<{ public_claimant_owned_ai_enrichment: unknown }>(
    sql`select public_claimant_owned_ai_enrichment(${builderIdentityId}, ${subjectUserId})`,
  )
  return row?.public_claimant_owned_ai_enrichment ?? null
}

/**
 * Same shape as `setOrganizationBuilderEnrichment`, for the project-hygiene
 * plan's `projectHygiene` envelope (real-GitHub-signals gauge on the profile
 * page). Kept as a separate function/key rather than generalizing the two —
 * they're independent features with independent freshness windows.
 */
export async function setOrganizationBuilderHygiene(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
  projectHygiene: Record<string, unknown>,
) {
  const existing = await findOrganizationBuilderByIdentity(transaction, organizationId, builderIdentityId)
  if (!existing) return null
  const privateMetadata = { ...existing.privateMetadata, projectHygiene }
  await transaction.update(organizationBuilders)
    .set({ privateMetadata, updatedAt: new Date() })
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, existing.id)))
  return projectHygiene
}

/**
 * Third sibling of the two above, for `code-fingerprinting`'s v2 envelope.
 *
 * Note the key lives on `organization_builders.privateMetadata`, not
 * `builders.metadata` as that plan's spec text says — the spec predates the
 * tenant migration, and `privateMetadata` is both where the other two AI
 * artifacts live and where `synergy.ts` already reads
 * `codeStyleFingerprint` from.
 */
export async function setOrganizationBuilderFingerprint(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
  codeStyleFingerprint: Record<string, unknown>,
) {
  const existing = await findOrganizationBuilderByIdentity(transaction, organizationId, builderIdentityId)
  if (!existing) return null
  const privateMetadata = { ...existing.privateMetadata, codeStyleFingerprint }
  await transaction.update(organizationBuilders)
    .set({ privateMetadata, updatedAt: new Date() })
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, existing.id)))
  return codeStyleFingerprint
}

export async function trackOrganizationBuilder(
  transaction: TenantTransaction,
  input: TrackOrganizationBuilderInput,
) {
  /**
   * The row's own id if it already exists, and only then the derived one.
   *
   * The upsert below conflicts on `(source, source_id)`, so when a row is already there it updates
   * *that* row and leaves its primary key alone. Assuming the derived id afterwards is what produced
   * the foreign-key violation described in `builder-identity-id.ts`: discovery had already written the
   * identity under a random id, and `organization_builders` was then pointed at an id no row has.
   */
  const [known] = await transaction.select({ id: builderIdentities.id })
    .from(builderIdentities)
    .where(and(
      eq(builderIdentities.source, input.source),
      eq(builderIdentities.sourceId, input.sourceId),
    ))
    .limit(1)
  const identityId = known?.id ?? builderIdentityIdFor(input.source, input.sourceId)

  await transaction.insert(builderIdentities).values({
    id: identityId,
    source: input.source,
    sourceId: input.sourceId,
    username: input.username,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    profileUrl: input.profileUrl,
    followersCount: input.followersCount ?? 0,
    language: input.language ?? null,
    country: input.country ?? null,
  }).onConflictDoUpdate({
    target: [builderIdentities.source, builderIdentities.sourceId],
    set: {
      username: input.username,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      bio: input.bio ?? null,
      profileUrl: input.profileUrl,
      followersCount: input.followersCount ?? 0,
      language: input.language ?? null,
      country: input.country ?? null,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    },
  })

  const [existing] = await transaction.select({ id: organizationBuilders.id })
    .from(organizationBuilders)
    .where(and(
      eq(organizationBuilders.organizationId, input.organizationId),
      eq(organizationBuilders.builderIdentityId, identityId),
    ))
    .limit(1)
  const trackingId = existing?.id ?? input.id
  const privateMetadata = {
    ...(input.metadata ?? {}),
    topics: input.topics ?? [],
    score: input.score ?? null,
  }

  await transaction.insert(builders).values({
    id: trackingId,
    organizationId: input.organizationId,
    userId: input.creatorUserId,
    source: input.source,
    sourceId: input.sourceId,
    username: input.username,
    displayName: input.displayName ?? null,
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    profileUrl: input.profileUrl,
    followersCount: input.followersCount ?? 0,
    language: input.language ?? null,
    country: input.country ?? null,
    topics: input.topics ?? [],
    metadata: { ...(input.metadata ?? {}), score: input.score ?? null },
  }).onConflictDoNothing()

  // Dual-write leg (plan 43 Phase 3): record which canonical human this account currently resolves
  // to, alongside the authoritative `builderIdentityId`. Read through the same transaction so it
  // sees any link written earlier in this request.
  //
  // Only ACTIVE links count — a queued probabilistic proposal must not attach a tenant's tracking to
  // a person nobody has confirmed. Null is a normal value here, not a failure: an account with no
  // canonical human yet simply has none, and every read still works.
  const canonicalHumanId = await resolveActiveCanonicalHumanId(transaction, identityId)

  await transaction.insert(organizationBuilders).values({
    id: trackingId,
    organizationId: input.organizationId,
    builderIdentityId: identityId,
    canonicalHumanId,
    creatorUserId: input.creatorUserId,
    privateMetadata,
  }).onConflictDoUpdate({
    target: [organizationBuilders.organizationId, organizationBuilders.builderIdentityId],
    // `privateMetadata` and `canonicalHumanId` only. Status and visibility are the tenant's own
    // decisions and re-tracking must never reset them.
    set: { privateMetadata, canonicalHumanId, updatedAt: new Date() },
  })

  return { id: trackingId, identityId, canonicalHumanId, tracked: true as const, existed: Boolean(existing) }
}

/**
 * The canonical human an account is currently attached to, or null.
 *
 * Duplicated as a narrow query rather than calling `human-profiles.ts`'s reader because this runs
 * inside a tenant transaction: that module takes a `PostgresJsDatabase` and would open its own
 * connection, which would not see uncommitted work from this one.
 */
async function resolveActiveCanonicalHumanId(
  transaction: TenantTransaction,
  builderIdentityId: string,
): Promise<string | null> {
  const [link] = await transaction
    .select({ canonicalHumanId: humanSourceLinks.canonicalHumanId })
    .from(humanSourceLinks)
    .where(and(
      eq(humanSourceLinks.builderIdentityId, builderIdentityId),
      isNull(humanSourceLinks.validUntil),
      inArray(humanSourceLinks.reviewState, ['auto_approved', 'approved']),
    ))
    .limit(1)
  return link?.canonicalHumanId ?? null
}

export interface CanonicalHumanParityRow {
  organizationBuilderId: string
  builderIdentityId: string
  /** What the dual-write leg stored. */
  storedCanonicalHumanId: string | null
  /** What the link table says right now. */
  liveCanonicalHumanId: string | null
}

export interface CanonicalHumanParityReport {
  total: number
  /** Rows where the stored pointer matches the live link — including both-null. */
  matching: number
  /** Stored is null but a link now exists: the row predates the link, so the backfill has work. */
  missingBackfill: number
  /** Stored and live disagree, or stored points somewhere the link no longer does. A cutover must
   * not happen while this is non-zero — reading by canonical human would return a different set than
   * reading by identity. */
  divergent: CanonicalHumanParityRow[]
}

/**
 * Compares the old read (by `builder_identity_id`) against the new one (by `canonical_human_id`) for
 * one organization — the "compare old/new reads, then cut over only after parity" step.
 *
 * Deliberately a read-only report rather than a self-healing pass. A cutover decision needs evidence
 * that the two agree, and a function that quietly repaired disagreements as it found them would
 * destroy exactly the signal the decision depends on. `backfillCanonicalHumanIds` does the writing.
 */
export async function compareCanonicalHumanParity(
  transaction: TenantTransaction,
  organizationId: string,
  limit = 500,
): Promise<CanonicalHumanParityReport> {
  const rows = await transaction
    .select({
      organizationBuilderId: organizationBuilders.id,
      builderIdentityId: organizationBuilders.builderIdentityId,
      storedCanonicalHumanId: organizationBuilders.canonicalHumanId,
      liveCanonicalHumanId: humanSourceLinks.canonicalHumanId,
    })
    .from(organizationBuilders)
    .leftJoin(
      humanSourceLinks,
      and(
        eq(humanSourceLinks.builderIdentityId, organizationBuilders.builderIdentityId),
        isNull(humanSourceLinks.validUntil),
        inArray(humanSourceLinks.reviewState, ['auto_approved', 'approved']),
      ),
    )
    .where(eq(organizationBuilders.organizationId, organizationId))
    .limit(limit)

  const report: CanonicalHumanParityReport = { total: rows.length, matching: 0, missingBackfill: 0, divergent: [] }
  for (const row of rows) {
    if (row.storedCanonicalHumanId === row.liveCanonicalHumanId) report.matching += 1
    else if (row.storedCanonicalHumanId === null) report.missingBackfill += 1
    else report.divergent.push(row)
  }
  return report
}

/**
 * Fills `canonical_human_id` for rows the dual-write missed — everything tracked before the column
 * existed, plus anything whose link arrived after it was tracked.
 *
 * Only ever writes that one column, never `private_metadata`, `status` or `visibility`: the backfill
 * must be invisible to the tenant's own decisions about a builder. Batched and resumable by the WHERE
 * clause alone (rows already carrying the right value are skipped), so an interruption is continued
 * by running it again.
 */
export async function backfillCanonicalHumanIds(
  transaction: TenantTransaction,
  organizationId: string,
  batchSize = 500,
): Promise<{ updated: number }> {
  const pending = await transaction
    .select({
      organizationBuilderId: organizationBuilders.id,
      canonicalHumanId: humanSourceLinks.canonicalHumanId,
    })
    .from(organizationBuilders)
    .innerJoin(
      humanSourceLinks,
      and(
        eq(humanSourceLinks.builderIdentityId, organizationBuilders.builderIdentityId),
        isNull(humanSourceLinks.validUntil),
        inArray(humanSourceLinks.reviewState, ['auto_approved', 'approved']),
      ),
    )
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      isNull(organizationBuilders.canonicalHumanId),
    ))
    .limit(batchSize)

  let updated = 0
  for (const row of pending) {
    await transaction
      .update(organizationBuilders)
      .set({ canonicalHumanId: row.canonicalHumanId, updatedAt: new Date() })
      .where(and(
        eq(organizationBuilders.id, row.organizationBuilderId),
        eq(organizationBuilders.organizationId, organizationId),
      ))
    updated += 1
  }
  return { updated }
}

/**
 * Every account this organization tracks that belongs to the given canonical human — the new read
 * shape, which is only meaningful once parity holds.
 *
 * Reads the stored column rather than joining the link table, on purpose: after cutover this is the
 * path in use, so `compareCanonicalHumanParity` has to be comparing the thing that will actually be
 * read, not a join that happens to agree with it today.
 */
export function listOrganizationBuildersByCanonicalHuman(
  transaction: TenantTransaction,
  organizationId: string,
  canonicalHumanId: string,
) {
  return transaction.select(privateBuilderFields)
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(organizationBuilders.canonicalHumanId, canonicalHumanId),
    ))
    .orderBy(desc(builderIdentities.lastSeenAt))
}

export async function updateOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
  update: { topics?: string[]; country?: string | null; language?: string | null },
) {
  const existing = await findOrganizationBuilder(transaction, organizationId, id)
  if (!existing) return null
  const privateMetadata = {
    ...existing.privateMetadata,
    ...(update.topics === undefined ? {} : { topics: update.topics }),
    ...(update.country === undefined ? {} : { country: update.country }),
    ...(update.language === undefined ? {} : { language: update.language }),
  }
  await transaction.update(organizationBuilders)
    .set({ privateMetadata, updatedAt: new Date() })
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
  await transaction.update(builders)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(builders.organizationId, organizationId), eq(builders.id, id)))
  return { ...existing, privateMetadata }
}

export async function deleteOrganizationBuilder(
  transaction: TenantTransaction,
  organizationId: string,
  id: string,
) {
  const existing = await findOrganizationBuilder(transaction, organizationId, id)
  if (!existing) return false
  await transaction.delete(builderNotes)
    .where(and(eq(builderNotes.organizationId, organizationId), eq(builderNotes.builderId, id)))
  await transaction.delete(organizationBuilders)
    .where(and(eq(organizationBuilders.organizationId, organizationId), eq(organizationBuilders.id, id)))
  await transaction.delete(builders)
    .where(and(eq(builders.organizationId, organizationId), eq(builders.id, id)))
  return true
}

export function listOrganizationBuilderNotes(
  transaction: TenantTransaction,
  organizationId: string,
  builderId: string,
) {
  return transaction.select({
    id: builderNotes.id,
    builderId: builderNotes.builderId,
    content: builderNotes.content,
    createdAt: builderNotes.createdAt,
    updatedAt: builderNotes.updatedAt,
  }).from(builderNotes)
    .where(and(eq(builderNotes.organizationId, organizationId), eq(builderNotes.builderId, builderId)))
    .orderBy(builderNotes.createdAt)
    // Notes on one builder, rendered whole on that builder's panel.
    .limit(ENTITY_DETAIL_LIMIT)
}

export async function createOrganizationBuilderNote(
  transaction: TenantTransaction,
  input: { id: string; organizationId: string; userId: string; builderId: string; content: string },
) {
  const builder = await findOrganizationBuilder(transaction, input.organizationId, input.builderId)
  if (!builder) return null
  const [note] = await transaction.insert(builderNotes).values(input).returning({
    id: builderNotes.id,
    builderId: builderNotes.builderId,
    content: builderNotes.content,
    createdAt: builderNotes.createdAt,
    updatedAt: builderNotes.updatedAt,
  })
  return note
}

export async function getOrganizationDashboardStats(
  transaction: TenantTransaction,
  organizationId: string,
  activeSince: Date,
) {
  const [[total], [active], [queries], [notes], dailyRows] = await Promise.all([
    transaction.select({ value: count() }).from(organizationBuilders)
      .where(eq(organizationBuilders.organizationId, organizationId)),
    transaction.select({ value: count() }).from(organizationBuilders)
      .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
      .where(and(eq(organizationBuilders.organizationId, organizationId), gte(builderIdentities.lastSeenAt, activeSince))),
    transaction.select({ value: count() }).from(savedQueries)
      .where(eq(savedQueries.organizationId, organizationId)),
    transaction.select({ value: count() }).from(builderNotes)
      .where(eq(builderNotes.organizationId, organizationId)),
    /*
     * Tracked builders grouped by the **day we last saw them active**, which is what this is and
     * what the dashboard now says it is.
     *
     * It is a recency histogram, not a time series: `lastSeenAt` is one timestamp per identity, so
     * every builder in the window falls in exactly one bucket and the seven buckets sum to
     * `activeThisWeek`. The chart used to be captioned "Weekly Activity … Builders active per day"
     * with an empty state reading "No tracked builders have **shipped**", all three of which
     * described event volume this data cannot express (plans/ui-dashboard, structural problem 4).
     *
     * `at time zone 'UTC'` is not decoration. `date_trunc` on a `timestamptz` uses the session's
     * TimeZone, while the loop below builds its keys in UTC — so on any server not set to UTC the two
     * disagreed near midnight and a day's count silently landed in no bucket at all.
     */
    transaction.select({
      day: sql<string>`to_char(date_trunc('day', ${builderIdentities.lastSeenAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      value: sql<number>`count(*)::int`,
    }).from(organizationBuilders)
      .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
      .where(and(eq(organizationBuilders.organizationId, organizationId), gte(builderIdentities.lastSeenAt, activeSince)))
      .groupBy(sql`date_trunc('day', ${builderIdentities.lastSeenAt} at time zone 'UTC')`),
  ])

  const dailyCounts = new Map(dailyRows.map((row) => [row.day, row.value]))
  const generatedAt = new Date()
  const lastSeenByDay = Array.from({ length: 7 }, (_, index) => {
    // UTC arithmetic throughout. `setDate` mutates in local time, so a server west of UTC building
    // keys with `toISOString` could produce the same ISO day twice and drop another entirely.
    const date = new Date(Date.UTC(
      generatedAt.getUTCFullYear(),
      generatedAt.getUTCMonth(),
      generatedAt.getUTCDate() - (6 - index),
    ))
    const iso = date.toISOString().slice(0, 10)
    return {
      date: iso,
      label: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      count: dailyCounts.get(iso) ?? 0,
    }
  })

  return {
    totalBuilders: Number(total?.value ?? 0),
    activeThisWeek: Number(active?.value ?? 0),
    savedQueries: Number(queries?.value ?? 0),
    totalNotes: Number(notes?.value ?? 0),
    /**
     * Named for what it holds. The old key was `dailyActivity`, which is how the widget came to be
     * captioned as activity; a field name is a claim like any other.
     */
    lastSeenByDay,
    /** So a widget can caption its numbers rather than implying they are current by omission. */
    generatedAt: generatedAt.toISOString(),
  }
}

function trackedRows(transaction: TenantTransaction, organizationId: string) {
  return transaction.select({
    id: organizationBuilders.id,
    source: builderIdentities.source,
    sourceId: builderIdentities.sourceId,
  }).from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(eq(organizationBuilders.organizationId, organizationId))
}
