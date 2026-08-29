/**
 * Reading and writing one person's self-managed profile (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## The owner is an argument, never a field
 *
 * Every write takes `ownerUserId` explicitly and the transaction is the one opened for the
 * authenticated principal, so `app.user_id` is already set and the table's policies filter on it.
 * Nothing here reads an owner out of a request DTO — `upsertSelfManagedProfileSchema` is `.strict()`
 * and has no such key, and a repository that accepted one would make the schema's omission
 * decorative. Passing somebody else's id does not widen access either: the row is not visible, an
 * update reports zero rows, and an insert is refused by the policy.
 *
 * That last claim comes from a negative test against the real `builderhunt_app` role, not from this
 * file. Unit tests here connect as a superuser and would pass no matter what the policies said.
 *
 * ## A handle is scarce, so availability is three questions and not one
 *
 * `isHandleAvailable` has to answer for a handle held by a live profile, one held by a profile
 * soft-deleted less than thirty days ago, and one reserved by somebody else whose reservation has
 * not expired. Asking only the first is the version that looks right and hands out a handle that
 * comes back thirty days later attached to a resurrected profile.
 *
 * ## Nothing is deleted on the request path
 *
 * Deleting a profile is a soft delete, and the rows it leaves behind are cleared by
 * `releaseExpiredHandleReservations` and `purgeDeletedProfiles` in bounded batches. Bounded because
 * an unbounded delete on a growing table is a statement whose cost nobody has measured — it runs
 * fine for a year and then holds a lock for four minutes on the night it matters.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'

import { randomId } from '~/lib/utils'
import type { TenantTransaction } from '../db/client'
import { builderClaims, selfManagedAttachments, selfManagedHandleReservations, selfManagedProfiles } from '../db/schema'
import {
  MAX_ACTIVE_ATTACHMENTS,
  HANDLE_RELEASE_AFTER_DELETE_MS,
  HANDLE_RESERVATION_TTL_MS,
  isAllowedVisibilityTransition,
  isPubliclyReadable,
  isSearchable,
  type PublicSelfManagedProfile,
  type SelfManagedVisibility,
  type UpsertSelfManagedProfile,
} from '../self-managed/contracts'

/** The owner's own view: everything on the row that the owner put there. */
export interface OwnSelfManagedProfile {
  id: string
  handle: string
  ownerUserId: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  visibility: SelfManagedVisibility
  promotedToBuilderClaimId: string | null
  declaredAt: Date
  updatedAt: Date
}

const OWN_COLUMNS = {
  id: selfManagedProfiles.id,
  handle: selfManagedProfiles.handle,
  ownerUserId: selfManagedProfiles.ownerUserId,
  displayName: selfManagedProfiles.displayName,
  headline: selfManagedProfiles.headline,
  bio: selfManagedProfiles.bio,
  locationCity: selfManagedProfiles.locationCity,
  locationCountryCode: selfManagedProfiles.locationCountryCode,
  languages: selfManagedProfiles.languages,
  services: selfManagedProfiles.services,
  topics: selfManagedProfiles.topics,
  visibility: selfManagedProfiles.visibility,
  promotedToBuilderClaimId: selfManagedProfiles.promotedToBuilderClaimId,
  declaredAt: selfManagedProfiles.declaredAt,
  updatedAt: selfManagedProfiles.updatedAt,
} as const

/**
 * A stored `visibility` can be anything the column's CHECK allows, and the CHECK could outlive a
 * value the product retires. Narrowing on read means one stale row renders as a draft — invisible,
 * which is the safe direction — instead of leaking under a state nothing understands.
 */
function narrowVisibility(value: string): SelfManagedVisibility {
  return value === 'public' || value === 'unlisted' ? value : 'draft'
}

function rowToOwn(row: {
  id: string
  handle: string
  ownerUserId: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  visibility: string
  promotedToBuilderClaimId: string | null
  declaredAt: Date
  updatedAt: Date
}): OwnSelfManagedProfile {
  return { ...row, visibility: narrowVisibility(row.visibility) }
}

/**
 * The owner's profile as a route hands it back: named fields, dates as strings, no subject id.
 *
 * `ownerUserId` is dropped because the caller *is* the owner — echoing it adds nothing and puts an
 * account id in every response body. A projection built by naming what goes in cannot leak a
 * column added later.
 */
export function ownProfileDto(profile: OwnSelfManagedProfile) {
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    headline: profile.headline,
    bio: profile.bio,
    locationCity: profile.locationCity,
    locationCountryCode: profile.locationCountryCode,
    languages: profile.languages,
    services: profile.services,
    topics: profile.topics,
    visibility: profile.visibility,
    promotedToBuilderClaimId: profile.promotedToBuilderClaimId,
    declaredAt: profile.declaredAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

/** The one live profile this person has, or `null`. Drafts included — it is their own. */
export async function getOwnProfile(
  transaction: TenantTransaction,
  ownerUserId: string,
): Promise<OwnSelfManagedProfile | null> {
  const [row] = await transaction
    .select(OWN_COLUMNS)
    .from(selfManagedProfiles)
    .where(and(eq(selfManagedProfiles.ownerUserId, ownerUserId), isNull(selfManagedProfiles.deletedAt)))
    .limit(1)

  return row ? rowToOwn(row) : null
}

/**
 * What a stranger gets at `/u/<handle>`.
 *
 * `unlisted` is included on purpose: it means reachable by anyone holding the link. Keeping it out
 * of *search* is a different question, answered by `isSearchable` at the indexing layer, because a
 * row policy cannot tell a direct visit from a listing.
 *
 * `verified` is a join rather than a column. A denormalised flag would need updating whenever a
 * claim's status changed, and the day it lagged the page would say "verified" about a claim that had
 * been revoked — the single worst thing this surface could get wrong.
 */
export async function getPublicProfileByHandle(
  transaction: TenantTransaction,
  handle: string,
): Promise<PublicSelfManagedProfile | null> {
  return (await getPublicProfileListing(transaction, handle))?.profile ?? null
}

/**
 * The same public projection, plus whether the profile is *listed*.
 *
 * The page needs one bit the projection deliberately withholds: `unlisted` must be served and
 * kept out of the index, and `public` must be served and indexed. Returning `listed` rather than
 * `visibility` gives the route exactly that decision without handing a reader the state name —
 * and `draft` never gets here at all, because it is not publicly readable.
 */
export async function getPublicProfileListing(
  transaction: TenantTransaction,
  handle: string,
): Promise<{ profile: PublicSelfManagedProfile; listed: boolean } | null> {
  const [row] = await transaction
    .select({
      handle: selfManagedProfiles.handle,
      displayName: selfManagedProfiles.displayName,
      headline: selfManagedProfiles.headline,
      bio: selfManagedProfiles.bio,
      locationCity: selfManagedProfiles.locationCity,
      locationCountryCode: selfManagedProfiles.locationCountryCode,
      languages: selfManagedProfiles.languages,
      services: selfManagedProfiles.services,
      topics: selfManagedProfiles.topics,
      visibility: selfManagedProfiles.visibility,
      updatedAt: selfManagedProfiles.updatedAt,
      claimStatus: builderClaims.status,
    })
    .from(selfManagedProfiles)
    .leftJoin(builderClaims, eq(builderClaims.id, selfManagedProfiles.promotedToBuilderClaimId))
    .where(and(eq(selfManagedProfiles.handle, handle), isNull(selfManagedProfiles.deletedAt)))
    .limit(1)

  const visibility = row ? narrowVisibility(row.visibility) : null
  if (!row || !visibility || !isPubliclyReadable(visibility)) return null

  const profile: PublicSelfManagedProfile = {
    handle: row.handle,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    locationCity: row.locationCity,
    locationCountryCode: row.locationCountryCode,
    languages: row.languages,
    services: row.services,
    topics: row.topics,
    updatedAt: row.updatedAt.toISOString(),
    verified: row.claimStatus === 'verified',
  }

  return { profile, listed: isSearchable(visibility) }
}

/** One searchable public profile, as the internal search origin reads it. */
export interface SearchableSelfManagedProfile {
  id: string
  handle: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  updatedAt: Date
}

/**
 * Public, listed profiles matching any of `keywords`.
 *
 * `visibility = 'public'` and not `unlisted`: unlisted means reachable by anyone holding the link,
 * and a search result is precisely the listing its owner opted out of. The row policy cannot tell
 * the two apart — it sees a select either way — so this predicate is where the distinction lives,
 * and `isSearchable` is the one place that decides it.
 *
 * Matching is case-insensitive over the declared text and the two tag arrays. Deliberately not
 * `to_tsvector`: a self-managed profile's text is short, its services are a closed taxonomy, and a
 * stemmed index would need a migration and a refresh path to answer questions this cardinality does
 * not yet pose. When it does, the query changes here and nothing above it moves.
 */
export async function searchPublicProfiles(
  transaction: TenantTransaction,
  input: { keywords: readonly string[]; limit: number },
): Promise<SearchableSelfManagedProfile[]> {
  const terms = input.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (terms.length === 0) return []

  const matches = terms.map((term) => {
    const like = `%${term.replace(/[%_\\]/g, (character) => `\\${character}`)}%`
    return sql`(
      lower(${selfManagedProfiles.displayName}) like ${like}
      or lower(coalesce(${selfManagedProfiles.headline}, '')) like ${like}
      or lower(coalesce(${selfManagedProfiles.bio}, '')) like ${like}
      or lower(${selfManagedProfiles.handle}) like ${like}
      or exists (select 1 from jsonb_array_elements_text(${selfManagedProfiles.topics}) as t(value) where lower(t.value) like ${like})
      or exists (select 1 from jsonb_array_elements_text(${selfManagedProfiles.services}) as s(value) where lower(s.value) like ${like})
    )`
  })

  const rows = await transaction
    .select({
      id: selfManagedProfiles.id,
      handle: selfManagedProfiles.handle,
      displayName: selfManagedProfiles.displayName,
      headline: selfManagedProfiles.headline,
      bio: selfManagedProfiles.bio,
      locationCity: selfManagedProfiles.locationCity,
      locationCountryCode: selfManagedProfiles.locationCountryCode,
      languages: selfManagedProfiles.languages,
      services: selfManagedProfiles.services,
      topics: selfManagedProfiles.topics,
      updatedAt: selfManagedProfiles.updatedAt,
    })
    .from(selfManagedProfiles)
    .where(and(
      eq(selfManagedProfiles.visibility, 'public'),
      isNull(selfManagedProfiles.deletedAt),
      or(...matches),
    ))
    // Freshest first, and bounded by the caller's provider page — the same ceiling every network
    // connector answers within, so one origin cannot flood a fused page.
    .orderBy(desc(selfManagedProfiles.updatedAt))
    .limit(input.limit)

  return rows
}

/** A public profile plus the clean attachments the semantic document may quote. */
export interface IndexableSelfManagedProfile extends SearchableSelfManagedProfile {
  attachments: Array<{ title: string; description: string | null }>
}

/**
 * Public profiles in id order for the reconciliation pass, at most `limit` at a time.
 *
 * Ordered and cursored on `id` rather than `updated_at`: the worker's job is to walk the whole set
 * exactly once per pass, and a cursor on a column an edit can move would revisit rows or skip them
 * depending on who saved during the walk.
 *
 * Attachments are fetched per page rather than joined, so a profile with twelve of them cannot
 * multiply its own row twelve times and silently shrink the page.
 */
export async function listIndexableProfiles(
  transaction: TenantTransaction,
  input: { after?: string | null; limit: number },
): Promise<IndexableSelfManagedProfile[]> {
  return listIndexableProfilesWhere(
    transaction,
    input.after ? gt(selfManagedProfiles.id, input.after) : undefined,
    input.limit,
  )
}

/** The one query both indexable reads run, so a filter added here cannot apply to only one of them. */
async function listIndexableProfilesWhere(
  transaction: TenantTransaction,
  extra: ReturnType<typeof eq> | undefined,
  limit: number,
): Promise<IndexableSelfManagedProfile[]> {
  const rows = await transaction
    .select({
      id: selfManagedProfiles.id,
      handle: selfManagedProfiles.handle,
      displayName: selfManagedProfiles.displayName,
      headline: selfManagedProfiles.headline,
      bio: selfManagedProfiles.bio,
      locationCity: selfManagedProfiles.locationCity,
      locationCountryCode: selfManagedProfiles.locationCountryCode,
      languages: selfManagedProfiles.languages,
      services: selfManagedProfiles.services,
      topics: selfManagedProfiles.topics,
      updatedAt: selfManagedProfiles.updatedAt,
    })
    .from(selfManagedProfiles)
    .where(and(
      eq(selfManagedProfiles.visibility, 'public'),
      isNull(selfManagedProfiles.deletedAt),
      ...(extra ? [extra] : []),
    ))
    .orderBy(asc(selfManagedProfiles.id))
    .limit(limit)

  if (rows.length === 0) return []

  const attachments = await transaction
    .select({
      profileId: selfManagedAttachments.profileId,
      title: selfManagedAttachments.title,
      description: selfManagedAttachments.description,
    })
    .from(selfManagedAttachments)
    .where(and(
      inArray(selfManagedAttachments.profileId, rows.map((row) => row.id)),
      // Clean only. An embedding is a copy: text that reaches the index has left the row policy
      // behind and cannot be un-indexed by tightening one later.
      eq(selfManagedAttachments.scanStatus, 'clean'),
      isNull(selfManagedAttachments.deletedAt),
    ))
    .orderBy(asc(selfManagedAttachments.uploadedAt))
    .limit(rows.length * MAX_ACTIVE_ATTACHMENTS)

  const byProfile = new Map<string, Array<{ title: string; description: string | null }>>()
  for (const attachment of attachments) {
    const list = byProfile.get(attachment.profileId) ?? []
    list.push({ title: attachment.title, description: attachment.description })
    byProfile.set(attachment.profileId, list)
  }

  return rows.map((row) => ({ ...row, attachments: byProfile.get(row.id) ?? [] }))
}

/**
 * One profile's indexable projection, or `null` when it is not eligible.
 *
 * `null` is the answer for absent, draft, unlisted and deleted alike, and the caller acts on it the
 * same way in every case: take the row out of the index. Distinguishing them here would push a
 * four-branch decision into every call site to reach the same conclusion.
 */
export async function findIndexableProfile(
  transaction: TenantTransaction,
  profileId: string,
): Promise<IndexableSelfManagedProfile | null> {
  const [row] = await listIndexableProfilesWhere(transaction, eq(selfManagedProfiles.id, profileId), 1)
  return row ?? null
}

/**
 * Whether `handle` may be taken by `forUserId` right now.
 *
 * Three ways it may not be: a live profile holds it, a profile soft-deleted inside the last thirty
 * days holds it, or somebody else's unexpired reservation holds it. The person's *own* reservation
 * is not an obstacle — reserving a handle and then being told it is taken would be absurd.
 */
export async function isHandleAvailable(
  transaction: TenantTransaction,
  input: { handle: string; forUserId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const releasedBefore = new Date(now.getTime() - HANDLE_RELEASE_AFTER_DELETE_MS)

  const [held] = await transaction
    .select({ id: selfManagedProfiles.id })
    .from(selfManagedProfiles)
    .where(
      and(
        eq(selfManagedProfiles.handle, input.handle),
        // Live, or soft-deleted recently enough that the handle is still being held back.
        or(isNull(selfManagedProfiles.deletedAt), gt(selfManagedProfiles.deletedAt, releasedBefore)),
        // Their own live profile keeping its own handle is not a conflict — that is a no-op rename.
        ne(selfManagedProfiles.ownerUserId, input.forUserId),
      ),
    )
    .limit(1)
  if (held) return false

  const [reserved] = await transaction
    .select({ handle: selfManagedHandleReservations.handle })
    .from(selfManagedHandleReservations)
    .where(
      and(
        eq(selfManagedHandleReservations.handle, input.handle),
        gt(selfManagedHandleReservations.expiresAt, now),
        ne(selfManagedHandleReservations.reservedByUserId, input.forUserId),
      ),
    )
    .limit(1)

  return !reserved
}

export interface CreateProfileInput {
  ownerUserId: string
  profile: UpsertSelfManagedProfile
  /** Injected so tests are deterministic; the route passes nothing. */
  now?: Date
}

/** Raised when the caller's request is refused for a reason the caller can act on. */
export class SelfManagedProfileError extends Error {
  constructor(
    readonly code:
      | 'handle-taken'
      | 'already-exists'
      | 'not-found'
      | 'invalid-transition'
      | 'claim-not-found'
      | 'claim-not-verified'
      | 'claim-already-linked',
    message: string,
  ) {
    super(message)
    this.name = 'SelfManagedProfileError'
  }
}

/**
 * Create this person's one profile.
 *
 * The uniqueness checks are advisory, not the guarantee: `self_managed_profiles_owner_live_unique`
 * and `..._handle_live_unique` are what actually hold under two concurrent requests. Checking first
 * exists so the common case gets a message naming the problem instead of a constraint violation, and
 * the constraint is caught below so the race does not surface as a 500.
 */
export async function createProfile(
  transaction: TenantTransaction,
  input: CreateProfileInput,
): Promise<OwnSelfManagedProfile> {
  const now = input.now ?? new Date()

  if (await getOwnProfile(transaction, input.ownerUserId)) {
    throw new SelfManagedProfileError('already-exists', 'This account already has a self-managed profile')
  }
  if (!(await isHandleAvailable(transaction, { handle: input.profile.handle, forUserId: input.ownerUserId, now }))) {
    throw new SelfManagedProfileError('handle-taken', `The handle "${input.profile.handle}" is not available`)
  }

  let row
  try {
    ;[row] = await transaction
      .insert(selfManagedProfiles)
      .values({
        id: randomId(),
        handle: input.profile.handle,
        ownerUserId: input.ownerUserId,
        displayName: input.profile.displayName,
        headline: input.profile.headline ?? null,
        bio: input.profile.bio ?? null,
        locationCity: input.profile.locationCity ?? null,
        locationCountryCode: input.profile.locationCountryCode ?? null,
        languages: input.profile.languages,
        services: input.profile.services,
        topics: input.profile.topics,
        visibility: input.profile.visibility,
        declaredAt: now,
        updatedAt: now,
      })
      // RETURNING needs the SELECT grant as well as the write one. A write-only role would succeed
      // at the insert and fail here, which reads as a mysterious 500 rather than a missing grant.
      .returning(OWN_COLUMNS)
  } catch (error) {
    throw translateUniqueViolation(error, input.profile.handle)
  }

  // Unreachable while the row is the caller's own: the policy permits the write, so RETURNING has a
  // row. Empty means RLS refused, and calling that "created" would turn a refused write into a
  // silent success the caller would then read back as missing.
  if (!row) throw new Error(`refused to create a self-managed profile for ${input.ownerUserId}`)

  // A handle in use no longer needs holding, and leaving the reservation would keep the row alive
  // for seven days pointing at a handle its owner already took.
  await transaction
    .delete(selfManagedHandleReservations)
    .where(eq(selfManagedHandleReservations.handle, input.profile.handle))

  return rowToOwn(row)
}

/**
 * Overwrite the owner's profile with a complete new state.
 *
 * A full replacement rather than a patch, matching `upsertSelfManagedProfileSchema`: a partial
 * update over a form that renders every field means an omitted key is ambiguous between "unchanged"
 * and "cleared", and the two get confused exactly once, on the field somebody wanted to clear.
 */
export async function updateProfile(
  transaction: TenantTransaction,
  input: CreateProfileInput,
): Promise<OwnSelfManagedProfile> {
  const now = input.now ?? new Date()
  const existing = await getOwnProfile(transaction, input.ownerUserId)
  if (!existing) throw new SelfManagedProfileError('not-found', 'This account has no self-managed profile')

  if (
    existing.handle !== input.profile.handle
    && !(await isHandleAvailable(transaction, { handle: input.profile.handle, forUserId: input.ownerUserId, now }))
  ) {
    throw new SelfManagedProfileError('handle-taken', `The handle "${input.profile.handle}" is not available`)
  }
  if (!isAllowedVisibilityTransition(existing.visibility, input.profile.visibility)) {
    throw new SelfManagedProfileError(
      'invalid-transition',
      `A profile cannot move from ${existing.visibility} to ${input.profile.visibility}`,
    )
  }

  let row
  try {
    ;[row] = await transaction
      .update(selfManagedProfiles)
      .set({
        handle: input.profile.handle,
        displayName: input.profile.displayName,
        headline: input.profile.headline ?? null,
        bio: input.profile.bio ?? null,
        locationCity: input.profile.locationCity ?? null,
        locationCountryCode: input.profile.locationCountryCode ?? null,
        languages: input.profile.languages,
        services: input.profile.services,
        topics: input.profile.topics,
        visibility: input.profile.visibility,
        updatedAt: now,
      })
      .where(and(eq(selfManagedProfiles.id, existing.id), isNull(selfManagedProfiles.deletedAt)))
      .returning(OWN_COLUMNS)
  } catch (error) {
    throw translateUniqueViolation(error, input.profile.handle)
  }

  if (!row) throw new Error(`refused to update the self-managed profile of ${input.ownerUserId}`)
  return rowToOwn(row)
}

/**
 * Move the profile between `draft`, `unlisted` and `public` without touching its content.
 *
 * Separate from `updateProfile` because the surfaces are separate: a toggle in the header should not
 * have to send the whole profile back, and re-sending it is how a stale form silently reverts an
 * edit made in another tab.
 */
export async function setVisibility(
  transaction: TenantTransaction,
  input: { ownerUserId: string; visibility: SelfManagedVisibility; now?: Date },
): Promise<OwnSelfManagedProfile> {
  const now = input.now ?? new Date()
  const existing = await getOwnProfile(transaction, input.ownerUserId)
  if (!existing) throw new SelfManagedProfileError('not-found', 'This account has no self-managed profile')
  if (!isAllowedVisibilityTransition(existing.visibility, input.visibility)) {
    throw new SelfManagedProfileError(
      'invalid-transition',
      `A profile cannot move from ${existing.visibility} to ${input.visibility}`,
    )
  }

  const [row] = await transaction
    .update(selfManagedProfiles)
    .set({ visibility: input.visibility, updatedAt: now })
    .where(and(eq(selfManagedProfiles.id, existing.id), isNull(selfManagedProfiles.deletedAt)))
    .returning(OWN_COLUMNS)

  if (!row) throw new Error(`refused to change the visibility of ${input.ownerUserId}'s profile`)
  return rowToOwn(row)
}

/**
 * Soft-delete the profile, holding its handle for thirty days.
 *
 * The hold is the point. Releasing the handle immediately lets somebody take it and inherit every
 * inbound link, bookmark and search result the previous owner built — which is indistinguishable, to
 * a reader, from impersonation.
 *
 * Attachments follow via the profile: `self_managed_attachments`' public read policy is a subquery
 * against the profile's visibility and `deleted_at`, so they stop being readable in the same
 * statement rather than in a second one somebody might forget.
 */
export async function softDeleteProfile(
  transaction: TenantTransaction,
  input: { ownerUserId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await transaction
    .update(selfManagedProfiles)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(selfManagedProfiles.ownerUserId, input.ownerUserId), isNull(selfManagedProfiles.deletedAt)))
    .returning({ id: selfManagedProfiles.id })

  return rows.length > 0
}

/**
 * Link this profile to a claim the owner has already proven, or unlink it again.
 *
 * ## What promotion is, and what it is not
 *
 * It is additive. The profile keeps rendering from its own row — its bio, its handle, its
 * attachments — and gains a verified block hydrated from the claim. Nothing is copied across and
 * nothing is replaced, which is what makes the reverse operation a single `null` write rather than
 * a restore.
 *
 * It is never inferred. The only signal this accepts is a claim id whose row is already
 * `verified` and whose `subject_user_id` is the caller: the decision goes through
 * `decideLink({ kind: 'verified_claim' })`, the module whose whole purpose is that resemblance is
 * not evidence. A matching handle, an identical display name and a 99.99% embedding similarity are
 * all equally insufficient here, and there is no parameter through which any of them could arrive.
 *
 * `promotion-*` errors are the caller's to act on; a lost race on the unique index comes back as
 * `claim-already-linked` rather than a 500.
 */
export async function promoteToBuilderClaim(
  transaction: TenantTransaction,
  input: { ownerUserId: string; profileId: string; claimId: string; now?: Date },
): Promise<OwnSelfManagedProfile> {
  const now = input.now ?? new Date()

  const existing = await getOwnProfile(transaction, input.ownerUserId)
  // One 404 for absent, deleted and somebody else's: the id in the path either names the caller's
  // own live profile or it names nothing.
  if (!existing || existing.id !== input.profileId) {
    throw new SelfManagedProfileError('not-found', 'This account has no such self-managed profile')
  }

  const [claim] = await transaction
    .select({
      id: builderClaims.id,
      subjectUserId: builderClaims.subjectUserId,
      status: builderClaims.status,
      verifiedAt: builderClaims.verifiedAt,
      revokedAt: builderClaims.revokedAt,
    })
    .from(builderClaims)
    .where(eq(builderClaims.id, input.claimId))
    .limit(1)

  // Absent and somebody else's claim answer alike, so this cannot be used to learn that a claim id
  // exists on another account.
  if (!claim || claim.subjectUserId !== input.ownerUserId) {
    throw new SelfManagedProfileError('claim-not-found', 'No such verified claim on this account')
  }
  // `status` and `revoked_at` are both checked. A revoked claim can keep a stale `verified` status
  // for as long as it takes a writer to be wrong once, and this is the read that would publish it.
  if (claim.status !== 'verified' || claim.verifiedAt === null || claim.revokedAt !== null) {
    throw new SelfManagedProfileError('claim-not-verified', 'That claim is not verified')
  }

  let row
  try {
    ;[row] = await transaction
      .update(selfManagedProfiles)
      .set({ promotedToBuilderClaimId: claim.id, updatedAt: now })
      .where(and(eq(selfManagedProfiles.id, existing.id), isNull(selfManagedProfiles.deletedAt)))
      .returning(OWN_COLUMNS)
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code
    if (code === '23505') {
      throw new SelfManagedProfileError('claim-already-linked', 'That claim already backs another profile')
    }
    throw error
  }

  if (!row) throw new Error(`refused to promote ${input.ownerUserId}'s self-managed profile`)
  return rowToOwn(row)
}

/**
 * Undo the link. The profile keeps everything it had before it was promoted.
 *
 * Idempotent by shape: unlinking a profile that is not linked writes `null` over `null` and reports
 * the row unchanged, because "there was nothing to undo" is not a failure anybody can act on.
 */
export async function unlinkBuilderClaim(
  transaction: TenantTransaction,
  input: { ownerUserId: string; profileId: string; now?: Date },
): Promise<OwnSelfManagedProfile> {
  const now = input.now ?? new Date()

  const existing = await getOwnProfile(transaction, input.ownerUserId)
  if (!existing || existing.id !== input.profileId) {
    throw new SelfManagedProfileError('not-found', 'This account has no such self-managed profile')
  }

  const [row] = await transaction
    .update(selfManagedProfiles)
    .set({ promotedToBuilderClaimId: null, updatedAt: now })
    .where(and(eq(selfManagedProfiles.id, existing.id), isNull(selfManagedProfiles.deletedAt)))
    .returning(OWN_COLUMNS)

  if (!row) throw new Error(`refused to unlink ${input.ownerUserId}'s self-managed profile`)
  return rowToOwn(row)
}

/**
 * Hold a handle for seven days before the profile exists.
 *
 * Keyed on the handle rather than the person, so one account cannot hold five. `onConflictDoUpdate`
 * refreshes the caller's own reservation and is guarded by the `WHERE`, so it cannot take over
 * somebody else's live one — the update simply matches nothing and the caller is told.
 */
export async function reserveHandle(
  transaction: TenantTransaction,
  input: { handle: string; userId: string; now?: Date },
): Promise<{ handle: string; expiresAt: Date }> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + HANDLE_RESERVATION_TTL_MS)

  if (!(await isHandleAvailable(transaction, { handle: input.handle, forUserId: input.userId, now }))) {
    throw new SelfManagedProfileError('handle-taken', `The handle "${input.handle}" is not available`)
  }

  let row
  try {
    ;[row] = await transaction
      .insert(selfManagedHandleReservations)
      .values({ handle: input.handle, reservedByUserId: input.userId, reservedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: selfManagedHandleReservations.handle,
        set: { reservedByUserId: input.userId, reservedAt: now, expiresAt },
        // Only the caller's own row, or one that has already lapsed. Without this, a conflict on
        // somebody else's live reservation would quietly reassign it.
        setWhere: or(
          eq(selfManagedHandleReservations.reservedByUserId, input.userId),
          lt(selfManagedHandleReservations.expiresAt, now),
        ),
      })
      .returning({ handle: selfManagedHandleReservations.handle, expiresAt: selfManagedHandleReservations.expiresAt })
  } catch (error) {
    // The availability read refuses a live rival first, so the only way here is losing a
    // razor-thin race to one. Under RLS that surfaces as the row policy refusing the DO UPDATE
    // (42501); on a database without RLS in force it would be the unique key (23505). Both mean
    // exactly one thing to the caller.
    const code = (error as { cause?: { code?: string } })?.cause?.code
    if (code === '42501' || code === '23505') {
      throw new SelfManagedProfileError('handle-taken', `The handle "${input.handle}" is not available`)
    }
    throw error
  }

  if (!row) throw new SelfManagedProfileError('handle-taken', `The handle "${input.handle}" is not available`)
  return row
}

/**
 * Delete lapsed reservations, at most `limit` at a time.
 *
 * Bounded and ordered by expiry so repeated calls make progress from the oldest end instead of
 * re-reading the same page. The caller loops until this returns fewer than `limit`.
 */
export async function releaseExpiredHandleReservations(
  transaction: TenantTransaction,
  input: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 500

  const doomed = await transaction
    .select({ handle: selfManagedHandleReservations.handle })
    .from(selfManagedHandleReservations)
    .where(lt(selfManagedHandleReservations.expiresAt, now))
    .orderBy(asc(selfManagedHandleReservations.expiresAt))
    .limit(limit)
  if (doomed.length === 0) return 0

  const rows = await transaction
    .delete(selfManagedHandleReservations)
    .where(inArray(selfManagedHandleReservations.handle, doomed.map((row) => row.handle)))
    .returning({ handle: selfManagedHandleReservations.handle })

  return rows.length
}

/**
 * Hard-delete profiles soft-deleted longer ago than the handle hold, at most `limit` at a time.
 *
 * This is what finally frees a handle for somebody else, and it is deliberately the same thirty days
 * `isHandleAvailable` uses rather than a second constant that could drift from it: two numbers
 * meaning one policy is how a handle becomes available to a checker and unavailable to an insert.
 */
export async function purgeDeletedProfiles(
  transaction: TenantTransaction,
  input: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 200
  const purgeBefore = new Date(now.getTime() - HANDLE_RELEASE_AFTER_DELETE_MS)

  const doomed = await transaction
    .select({ id: selfManagedProfiles.id })
    .from(selfManagedProfiles)
    .where(and(isNotNull(selfManagedProfiles.deletedAt), lt(selfManagedProfiles.deletedAt, purgeBefore)))
    .orderBy(asc(selfManagedProfiles.deletedAt))
    .limit(limit)
  if (doomed.length === 0) return 0

  // Attachments go with it: the foreign key is `on delete cascade`, so the storage sweep has to have
  // already run. `purgeDeletedAttachments` is what makes that true, and the worker orders them.
  const rows = await transaction
    .delete(selfManagedProfiles)
    .where(inArray(selfManagedProfiles.id, doomed.map((row) => row.id)))
    .returning({ id: selfManagedProfiles.id })

  return rows.length
}

/**
 * Postgres reports both live unique indexes as 23505, and the caller can act on the difference.
 *
 * Without this a lost race on the handle and a lost race on "one profile per person" both arrive as
 * a raw driver error, and the form shows the same unhelpful failure for two problems with different
 * fixes.
 */
function translateUniqueViolation(error: unknown, handle: string): unknown {
  const constraint = (error as { constraint_name?: string; constraint?: string } | null)?.constraint_name
    ?? (error as { constraint?: string } | null)?.constraint
  if (constraint === 'self_managed_profiles_handle_live_unique') {
    return new SelfManagedProfileError('handle-taken', `The handle "${handle}" is not available`)
  }
  if (constraint === 'self_managed_profiles_owner_live_unique') {
    return new SelfManagedProfileError('already-exists', 'This account already has a self-managed profile')
  }
  return error
}
