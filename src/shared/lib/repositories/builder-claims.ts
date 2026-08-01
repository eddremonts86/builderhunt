import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import { authDb } from '../db/auth-db'
import type { TenantTransaction, publicDb } from '../db/client'
import {
  authUsers,
  builderClaims,
  builderIdentities,
  publishedBuilderProfiles,
} from '../db/schema'
import {
  mergePortfolioDraft,
  parsePortfolioSettings,
  publishPortfolio as publishPortfolioSettings,
  unpublishPortfolio as unpublishPortfolioSettings,
  type PortfolioDraftInput,
} from '../portfolio'

/** Builder claims aren't tenant-scoped (no `organizationId` column) — admin routes query them via `publicDb` directly, same as `public-builders.ts`'s reads. */
type ClaimsDb = TenantTransaction | typeof publicDb

export function hashClaimSecret(secret: string) {
  return createHash('sha256').update(`builderhunt:claim:v1:${secret}`).digest('hex')
}

/** Used by the stealth-scraping plan's subject-rights routes (restriction, provenance). */
export async function isVerifiedBuilderClaimant(
  transaction: TenantTransaction,
  subjectUserId: string,
  builderIdentityId: string,
): Promise<boolean> {
  const [claim] = await transaction.select({ id: builderClaims.id }).from(builderClaims)
    .where(and(
      eq(builderClaims.subjectUserId, subjectUserId),
      eq(builderClaims.builderIdentityId, builderIdentityId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  return Boolean(claim)
}

export async function createPendingBuilderClaim(
  transaction: TenantTransaction,
  input: {
    id: string
    builderIdentityId: string
    subjectUserId: string
    evidenceSource: string
    evidenceReference: string
    verificationSecretHash: string | null
    expiresAt: Date
  },
) {
  const [identity] = await transaction.select({ id: builderIdentities.id })
    .from(builderIdentities)
    .where(eq(builderIdentities.id, input.builderIdentityId))
    .limit(1)
  if (!identity) return null
  const [claim] = await transaction.insert(builderClaims).values({
    id: input.id,
    builderIdentityId: input.builderIdentityId,
    subjectUserId: input.subjectUserId,
    evidenceSource: input.evidenceSource,
    evidenceReference: input.evidenceReference,
    verificationSecretHash: input.verificationSecretHash,
    status: 'pending',
    expiresAt: input.expiresAt,
  }).returning({ id: builderClaims.id })
  return claim ?? null
}

/** The identity's source + username — needed to pick a claim-source adapter and fetch its public profile. */
export async function getBuilderIdentitySourceInfo(transaction: TenantTransaction, builderIdentityId: string) {
  const [identity] = await transaction.select({
    source: builderIdentities.source,
    username: builderIdentities.username,
  }).from(builderIdentities).where(eq(builderIdentities.id, builderIdentityId)).limit(1)
  return identity ?? null
}

/** The caller's own pending claim on this identity, if any — the verify route reads the stored challenge/source from here rather than trusting client input. */
export async function findPendingBuilderClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; builderIdentityId: string },
) {
  const [claim] = await transaction.select({
    id: builderClaims.id,
    evidenceSource: builderClaims.evidenceSource,
    evidenceReference: builderClaims.evidenceReference,
    expiresAt: builderClaims.expiresAt,
  }).from(builderClaims).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.builderIdentityId, input.builderIdentityId),
    eq(builderClaims.status, 'pending'),
  )).limit(1)
  return claim ?? null
}

async function publishVerifiedProfile(
  transaction: TenantTransaction,
  input: { builderIdentityId: string; subjectUserId: string },
) {
  const [identity] = await transaction.select({
    displayName: builderIdentities.displayName,
    bio: builderIdentities.bio,
  }).from(builderIdentities)
    .where(eq(builderIdentities.id, input.builderIdentityId))
    .limit(1)
  if (!identity) return false
  await transaction.insert(publishedBuilderProfiles).values({
    builderIdentityId: input.builderIdentityId,
    publishedByUserId: input.subjectUserId,
    displayName: identity.displayName,
    bio: identity.bio,
  }).onConflictDoUpdate({
    target: publishedBuilderProfiles.builderIdentityId,
    set: {
      publishedByUserId: input.subjectUserId,
      updatedAt: new Date(),
    },
  })
  return true
}

/**
 * Legacy email-token verification path. New claims never populate
 * `verificationSecretHash` (source-bound claims below use a public,
 * unhashed challenge instead), so this can only ever match a pre-existing
 * legacy claim — it is kept for that transition, not as an active path for
 * new claims.
 */
export async function verifyPendingBuilderClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; verificationSecretHash: string },
) {
  const [claim] = await transaction.select({
    id: builderClaims.id,
    builderIdentityId: builderClaims.builderIdentityId,
  }).from(builderClaims).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.verificationSecretHash, input.verificationSecretHash),
    eq(builderClaims.status, 'pending'),
    gt(builderClaims.expiresAt, new Date()),
  )).limit(1)
  if (!claim) return null

  await transaction.update(builderClaims).set({
    status: 'verified',
    verifiedAt: new Date(),
    verificationSecretHash: null,
  }).where(and(
    eq(builderClaims.id, claim.id),
    eq(builderClaims.subjectUserId, input.subjectUserId),
  ))
  const published = await publishVerifiedProfile(transaction, {
    builderIdentityId: claim.builderIdentityId,
    subjectUserId: input.subjectUserId,
  })
  if (!published) return null
  return { builderIdentityId: claim.builderIdentityId }
}

/**
 * Source-bound verification: the caller already proved control of the
 * external account (the claim-source adapter confirmed the challenge is
 * live in their public bio) — this just needs to record that atomically.
 * A single conditional UPDATE...RETURNING (rather than the legacy
 * select-then-update above) closes the race where two concurrent requests
 * could both read `status = 'pending'` before either write lands: only the
 * request whose UPDATE actually flips the row can proceed to publish.
 */
export async function verifyBuilderClaimBySourceProof(
  transaction: TenantTransaction,
  input: { subjectUserId: string; builderIdentityId: string },
) {
  const [claim] = await transaction.update(builderClaims).set({
    status: 'verified',
    verifiedAt: new Date(),
  }).where(and(
    eq(builderClaims.subjectUserId, input.subjectUserId),
    eq(builderClaims.builderIdentityId, input.builderIdentityId),
    eq(builderClaims.status, 'pending'),
    gt(builderClaims.expiresAt, new Date()),
  )).returning({ id: builderClaims.id, builderIdentityId: builderClaims.builderIdentityId })
  if (!claim) return null

  const published = await publishVerifiedProfile(transaction, {
    builderIdentityId: claim.builderIdentityId,
    subjectUserId: input.subjectUserId,
  })
  if (!published) return null
  return { builderIdentityId: claim.builderIdentityId }
}

/** Admin-only. Recoverable: revoked claims keep their row (evidence intact) but stop counting as active — `findVerifiedBuilderClaim`/`findPublishedBuilderProfile` readers filter on `status = 'verified'`, so a revoked claim disappears from both immediately. */
export async function revokeBuilderClaim(
  transaction: ClaimsDb,
  input: { claimId: string; adminUserId: string; reason: string },
) {
  const [revoked] = await transaction.update(builderClaims).set({
    status: 'revoked',
    revokedAt: new Date(),
    revokedByUserId: input.adminUserId,
    revocationReason: input.reason,
  }).where(and(
    eq(builderClaims.id, input.claimId),
    eq(builderClaims.status, 'verified'),
  )).returning({ id: builderClaims.id, builderIdentityId: builderClaims.builderIdentityId })
  return revoked ?? null
}

export type BuilderClaimStatus = 'pending' | 'verified' | 'rejected' | 'revoked' | 'expired'

export interface AdminBuilderClaimFilters {
  status?: BuilderClaimStatus[]
  source?: string
  subjectUserId?: string
  verifiedFrom?: Date
  verifiedTo?: Date
  portfolioPublished?: boolean
}

export interface AdminListBuilderClaimsOptions extends AdminBuilderClaimFilters {
  /** Keyset cursor: return rows strictly older than (createdAt, id). */
  before?: { createdAt: Date; id: string }
  limit?: number
}

export interface AdminBuilderClaimDTO {
  id: string
  status: BuilderClaimStatus
  evidenceSource: string
  evidenceReference: string
  subjectUserId: string
  subjectName: string | null
  subjectEmail: string | null
  builderIdentityId: string
  builderSource: string
  builderUsername: string
  builderDisplayName: string | null
  expiresAt: string | null
  verifiedAt: string | null
  revokedAt: string | null
  revokedByUserId: string | null
  revocationReason: string | null
  createdAt: string
  /** `published_builder_profiles` row exists — the directory publication, distinct from the portfolio-builder flag below. */
  directoryPublished: boolean
  /** `builder_claims.metadata.portfolio.published` — the portfolio-builder feature's own, independent publish flag. */
  portfolioPublished: boolean
}

export interface AdminListBuilderClaimsResult {
  rows: AdminBuilderClaimDTO[]
  nextCursor: { createdAt: string; id: string } | null
}

/**
 * Platform-admin claim management projection (plans/UI/tasks.md Wave 4 "Build platform-admin claim
 * management projection"). Bounded cursor pagination, allowlisted filters, and a DTO that excludes
 * `verificationSecretHash` and raw `metadata` entirely — only the derived `portfolioPublished`
 * boolean is read out of metadata, never the jsonb blob itself.
 */
export async function listBuilderClaimsForAdmin(
  db: ClaimsDb,
  options: AdminListBuilderClaimsOptions = {},
  /** Test-only override for the auth-broker read below — defaults to the real `authDb`. */
  authDbOverride?: typeof authDb,
): Promise<AdminListBuilderClaimsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)

  const whereParts = []
  if (options.status && options.status.length > 0) {
    whereParts.push(or(...options.status.map((s) => eq(builderClaims.status, s)))!)
  }
  if (options.source) whereParts.push(eq(builderIdentities.source, options.source))
  if (options.subjectUserId) whereParts.push(eq(builderClaims.subjectUserId, options.subjectUserId))
  if (options.verifiedFrom) whereParts.push(gt(builderClaims.verifiedAt, options.verifiedFrom))
  if (options.verifiedTo) whereParts.push(lt(builderClaims.verifiedAt, options.verifiedTo))
  if (options.portfolioPublished !== undefined) {
    // jsonb predicate, not a post-filter — filtering after LIMIT would make a page report fewer
    // rows than exist and desynchronize `nextCursor` from what was actually filtered.
    whereParts.push(
      options.portfolioPublished
        ? sql`(${builderClaims.metadata}#>>'{portfolio,published}')::boolean is true`
        : sql`coalesce((${builderClaims.metadata}#>>'{portfolio,published}')::boolean, false) is false`,
    )
  }
  // Drizzle has no tuple comparator: (created_at, id) < (cursor.createdAt, cursor.id) built by hand.
  if (options.before) {
    whereParts.push(
      or(
        lt(builderClaims.createdAt, options.before.createdAt),
        and(eq(builderClaims.createdAt, options.before.createdAt), lt(builderClaims.id, options.before.id)),
      )!,
    )
  }

  const rows = await db
    .select({
      id: builderClaims.id,
      status: builderClaims.status,
      evidenceSource: builderClaims.evidenceSource,
      evidenceReference: builderClaims.evidenceReference,
      subjectUserId: builderClaims.subjectUserId,
      builderIdentityId: builderClaims.builderIdentityId,
      builderSource: builderIdentities.source,
      builderUsername: builderIdentities.username,
      builderDisplayName: builderIdentities.displayName,
      expiresAt: builderClaims.expiresAt,
      verifiedAt: builderClaims.verifiedAt,
      revokedAt: builderClaims.revokedAt,
      revokedByUserId: builderClaims.revokedByUserId,
      revocationReason: builderClaims.revocationReason,
      createdAt: builderClaims.createdAt,
      metadata: builderClaims.metadata,
      directoryPublished: publishedBuilderProfiles.builderIdentityId,
    })
    .from(builderClaims)
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderClaims.builderIdentityId))
    .leftJoin(publishedBuilderProfiles, eq(publishedBuilderProfiles.builderIdentityId, builderClaims.builderIdentityId))
    .where(whereParts.length > 0 ? and(...whereParts) : undefined)
    .orderBy(desc(builderClaims.createdAt), desc(builderClaims.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows

  // `auth_users` is auth-broker-owned (drizzle/0007_auth_broker.sql) — `db` (whichever tenant/public
  // connection the caller passed) has no grant on it, so the claimant's name/email is resolved
  // through the dedicated `authDb` connection, same allowlisted exception as
  // `organization-lifecycle.ts`'s `resolveActorDisplayNames`, scoped to only this page's ids.
  const subjectIds = Array.from(new Set(slice.map((r) => r.subjectUserId)))
  const subjects = subjectIds.length > 0
    ? await (authDbOverride ?? authDb).select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers).where(inArray(authUsers.id, subjectIds))
    : []
  const subjectById = new Map(subjects.map((s) => [s.id, s]))

  const dtos: AdminBuilderClaimDTO[] = slice.map((r) => ({
    id: r.id,
    status: r.status as BuilderClaimStatus,
    evidenceSource: r.evidenceSource,
    evidenceReference: r.evidenceReference,
    subjectUserId: r.subjectUserId,
    subjectName: subjectById.get(r.subjectUserId)?.name ?? null,
    subjectEmail: subjectById.get(r.subjectUserId)?.email ?? null,
    builderIdentityId: r.builderIdentityId,
    builderSource: r.builderSource,
    builderUsername: r.builderUsername,
    builderDisplayName: r.builderDisplayName,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokedByUserId: r.revokedByUserId,
    revocationReason: r.revocationReason,
    createdAt: r.createdAt.toISOString(),
    directoryPublished: r.directoryPublished !== null,
    portfolioPublished: parsePortfolioSettings((r.metadata as Record<string, unknown>).portfolio).published,
  }))

  const last = slice[slice.length - 1]
  return {
    rows: dtos,
    nextCursor: hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
  }
}

export function listVerifiedBuilderProfiles(transaction: TenantTransaction, subjectUserId: string) {
  return transaction.select({
    id: builderIdentities.id,
    claimId: builderClaims.id,
    username: builderIdentities.username,
    source: builderIdentities.source,
    avatarUrl: builderIdentities.avatarUrl,
    profileUrl: builderIdentities.profileUrl,
    displayName: publishedBuilderProfiles.displayName,
    bio: publishedBuilderProfiles.bio,
    claimedTopics: publishedBuilderProfiles.topics,
    openToStatus: publishedBuilderProfiles.openToStatus,
    publishedAt: publishedBuilderProfiles.publishedAt,
    updatedAt: publishedBuilderProfiles.updatedAt,
  }).from(builderClaims)
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderClaims.builderIdentityId))
    .innerJoin(publishedBuilderProfiles, eq(publishedBuilderProfiles.builderIdentityId, builderClaims.builderIdentityId))
    .where(and(
      eq(builderClaims.subjectUserId, subjectUserId),
      eq(builderClaims.status, 'verified'),
    ))
}

export async function updateVerifiedBuilderProfile(
  transaction: TenantTransaction,
  input: {
    subjectUserId: string
    builderIdentityId: string
    topics?: string[]
    openToStatus?: string[]
    bio?: string
  },
) {
  const [claim] = await transaction.select({ id: builderClaims.id }).from(builderClaims)
    .where(and(
      eq(builderClaims.subjectUserId, input.subjectUserId),
      eq(builderClaims.builderIdentityId, input.builderIdentityId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  if (!claim) return null
  const [updated] = await transaction.update(publishedBuilderProfiles).set({
    ...(input.topics === undefined ? {} : { topics: input.topics }),
    ...(input.openToStatus === undefined ? {} : { openToStatus: input.openToStatus }),
    ...(input.bio === undefined ? {} : { bio: input.bio }),
    updatedAt: new Date(),
  }).where(and(
    eq(publishedBuilderProfiles.builderIdentityId, input.builderIdentityId),
    eq(publishedBuilderProfiles.publishedByUserId, input.subjectUserId),
  )).returning()
  return updated ?? null
}

// ---------------------------------------------------------------------------
// Portfolio (plan: portfolio-builder) — stored under builder_claims.metadata.portfolio
// ---------------------------------------------------------------------------

interface PortfolioClaimRow {
  claimId: string
  source: string
  sourceId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  profileUrl: string
  metadata: Record<string, unknown>
}

async function findOwnedVerifiedClaimForPortfolio(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string },
): Promise<PortfolioClaimRow | null> {
  const [row] = await transaction.select({
    claimId: builderClaims.id,
    metadata: builderClaims.metadata,
    source: builderIdentities.source,
    sourceId: builderIdentities.sourceId,
    username: builderIdentities.username,
    displayName: builderIdentities.displayName,
    avatarUrl: builderIdentities.avatarUrl,
    profileUrl: builderIdentities.profileUrl,
  }).from(builderClaims)
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderClaims.builderIdentityId))
    .where(and(
      eq(builderClaims.id, input.claimId),
      eq(builderClaims.subjectUserId, input.subjectUserId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  return row ?? null
}

/** Owner's draft read — requires active source-verified ownership; a pending/revoked/other-user's claim reads as not-found, not an error. */
export async function getPortfolioForOwner(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string },
) {
  const row = await findOwnedVerifiedClaimForPortfolio(transaction, input)
  if (!row) return null
  return {
    claimId: row.claimId,
    source: row.source,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    profileUrl: row.profileUrl,
    settings: parsePortfolioSettings((row.metadata as Record<string, unknown>).portfolio),
  }
}

async function writePortfolioMetadata(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string; nextSettings: unknown },
) {
  const [row] = await transaction.select({ metadata: builderClaims.metadata }).from(builderClaims)
    .where(and(
      eq(builderClaims.id, input.claimId),
      eq(builderClaims.subjectUserId, input.subjectUserId),
      eq(builderClaims.status, 'verified'),
    )).limit(1)
  if (!row) return null
  const metadata = { ...(row.metadata as Record<string, unknown>), portfolio: input.nextSettings }
  await transaction.update(builderClaims).set({ metadata })
    .where(and(eq(builderClaims.id, input.claimId), eq(builderClaims.subjectUserId, input.subjectUserId)))
  return input.nextSettings
}

/** PATCH — merges draft input; never touches `published`/`publishedAt` (those only change via the explicit publish/unpublish transition below). */
export async function savePortfolioDraft(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string; draft: PortfolioDraftInput },
) {
  const owned = await findOwnedVerifiedClaimForPortfolio(transaction, input)
  if (!owned) return null
  const existing = parsePortfolioSettings((owned.metadata as Record<string, unknown>).portfolio)
  const merged = mergePortfolioDraft(existing, input.draft, new Date().toISOString())
  return writePortfolioMetadata(transaction, { ...input, nextSettings: merged })
}

export async function publishPortfolioClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string },
) {
  const owned = await findOwnedVerifiedClaimForPortfolio(transaction, input)
  if (!owned) return null
  const existing = parsePortfolioSettings((owned.metadata as Record<string, unknown>).portfolio)
  const next = publishPortfolioSettings(existing, new Date().toISOString())
  return writePortfolioMetadata(transaction, { ...input, nextSettings: next })
}

export async function unpublishPortfolioClaim(
  transaction: TenantTransaction,
  input: { subjectUserId: string; claimId: string },
) {
  const owned = await findOwnedVerifiedClaimForPortfolio(transaction, input)
  if (!owned) return null
  const existing = parsePortfolioSettings((owned.metadata as Record<string, unknown>).portfolio)
  const next = unpublishPortfolioSettings(existing, new Date().toISOString())
  return writePortfolioMetadata(transaction, { ...input, nextSettings: next })
}

/** Sitemap-only. Filters in application code (not a jsonb SQL predicate) — this table stays small enough that it isn't worth a partial index for one low-traffic query. */
export async function listPublishedPortfolioClaimIds(transaction: ClaimsDb): Promise<string[]> {
  const rows = await transaction.select({
    id: builderClaims.id,
    metadata: builderClaims.metadata,
  }).from(builderClaims).where(eq(builderClaims.status, 'verified'))
  return rows
    .filter((row) => parsePortfolioSettings((row.metadata as Record<string, unknown>).portfolio).published)
    .map((row) => row.id)
}

/** Public, anonymous read via `publicDb` — independently rechecks `status = 'verified'` on every call so a revoked claim can never keep serving a cached or stale portfolio. */
export async function getPublicPortfolioClaim(transaction: ClaimsDb, claimId: string): Promise<PortfolioClaimRow | null> {
  const [row] = await transaction.select({
    claimId: builderClaims.id,
    metadata: builderClaims.metadata,
    source: builderIdentities.source,
    sourceId: builderIdentities.sourceId,
    username: builderIdentities.username,
    displayName: builderIdentities.displayName,
    avatarUrl: builderIdentities.avatarUrl,
    profileUrl: builderIdentities.profileUrl,
  }).from(builderClaims)
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderClaims.builderIdentityId))
    .where(and(eq(builderClaims.id, claimId), eq(builderClaims.status, 'verified')))
    .limit(1)
  return row ?? null
}

/**
 * The two facts the public portfolio page's cross-links need but the (cacheable) portfolio payload
 * itself must never carry: which builder identity to link back to, and whose session counts as
 * "the owner" — an owner-only fact is exactly what a shared cache entry can't hold without leaking
 * it to every other viewer. Deliberately no join to `builder_identities`/`published_builder_profiles`
 * — cheap enough to run on every request (cache hit or not), same independent
 * `status = 'verified'` recheck as `getPublicPortfolioClaim`.
 */
export async function getPortfolioLinkContext(
  transaction: ClaimsDb,
  claimId: string,
): Promise<{ builderIdentityId: string; subjectUserId: string } | null> {
  const [row] = await transaction.select({
    builderIdentityId: builderClaims.builderIdentityId,
    subjectUserId: builderClaims.subjectUserId,
  }).from(builderClaims)
    .where(and(eq(builderClaims.id, claimId), eq(builderClaims.status, 'verified')))
    .limit(1)
  return row ?? null
}
