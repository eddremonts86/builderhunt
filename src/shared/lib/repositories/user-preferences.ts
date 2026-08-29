/**
 * Reading and writing one person's preferences (plan: phase-2/02-segmentacion-usuarios).
 *
 * ## The user id is never a parameter the caller chooses
 *
 * Every function here takes a `TenantTransaction` and a `subjectUserId`, and the transaction is the
 * one opened for the authenticated principal — so `app.user_id` is already set and the table's RLS
 * policies filter on it. Passing a different id does not widen access: the row simply is not there,
 * an update reports zero rows, and an insert is refused by the policy. That was verified against the
 * real `builderhunt_app` role rather than assumed, because unit tests here connect as a superuser
 * and would see every row regardless.
 *
 * `subjectUserId` still exists as an argument rather than being read from the session inside this
 * module, so the layer stays testable and the route above stays the one place that decides whose
 * data is being touched.
 *
 * ## Absence is a value
 *
 * `getUserPreferences` returns a record with `primarySegment: null` for somebody who has never been
 * asked, not `null` for the whole record. Callers then have one shape to handle instead of two, and
 * "no row yet" stops being a special case that each of them re-implements.
 */
import { eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'
import { userPreferences } from '../db/schema'
import {
  SEGMENT_SCHEMA_VERSION,
  parseUserSegment,
  segmentSourceSchema,
  type SegmentSource,
  type UserSegment,
} from '../user-segments'

export interface UserPreferences {
  userId: string
  /** `null` means never chosen. Consumers map it through `resolveSegmentPreset`. */
  primarySegment: UserSegment | null
  segmentSource: SegmentSource | null
  segmentSchemaVersion: number | null
  segmentSelectedAt: Date | null
  /** `null` means never chosen — the inclusion policy resolves that to included, never to excluded. */
  searchIncludeSelfManaged: boolean | null
}

/** What a person who has never answered looks like. Never persisted; returned in place of a row. */
export function emptyUserPreferences(userId: string): UserPreferences {
  return {
    userId,
    primarySegment: null,
    segmentSource: null,
    segmentSchemaVersion: null,
    segmentSelectedAt: null,
    searchIncludeSelfManaged: null,
  }
}

/**
 * A stored row may hold anything — a value written under an older taxonomy, or a column edited by
 * hand. Narrowing on read means one bad row degrades to the general preset instead of crashing a
 * page, which is the right failure for a preference that grants nothing.
 */
function rowToPreferences(row: {
  userId: string
  primarySegment: string | null
  segmentSource: string | null
  segmentSchemaVersion: number | null
  segmentSelectedAt: Date | null
  searchIncludeSelfManaged: boolean | null
}): UserPreferences {
  const source = segmentSourceSchema.safeParse(row.segmentSource)
  return {
    userId: row.userId,
    primarySegment: parseUserSegment(row.primarySegment),
    segmentSource: source.success ? source.data : null,
    segmentSchemaVersion: row.segmentSchemaVersion,
    segmentSelectedAt: row.segmentSelectedAt,
    searchIncludeSelfManaged: row.searchIncludeSelfManaged,
  }
}

export async function getUserPreferences(
  transaction: TenantTransaction,
  subjectUserId: string,
): Promise<UserPreferences> {
  const [row] = await transaction
    .select({
      userId: userPreferences.userId,
      primarySegment: userPreferences.primarySegment,
      segmentSource: userPreferences.segmentSource,
      segmentSchemaVersion: userPreferences.segmentSchemaVersion,
      segmentSelectedAt: userPreferences.segmentSelectedAt,
      searchIncludeSelfManaged: userPreferences.searchIncludeSelfManaged,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, subjectUserId))
    .limit(1)

  return row ? rowToPreferences(row) : emptyUserPreferences(subjectUserId)
}

export interface SetPrimarySegmentInput {
  subjectUserId: string
  /** `null` clears the choice and returns the person to the general preset. */
  segment: UserSegment | null
  source: SegmentSource
  /** Injected so tests are deterministic; the route passes nothing. */
  now?: Date
}

/**
 * Idempotent upsert of the segment.
 *
 * `onConflictDoUpdate` rather than a read-then-write: two tabs saving at once would otherwise race
 * between the check and the insert, and the loser would get a primary-key violation surfaced as a
 * 500 on a settings page. The database decides which write is last.
 *
 * `segment_selected_at` moves on every successful write, including a write of the same value.
 * Re-affirming a choice is a real event — the analytics in this plan distinguish `segment_selected`
 * from `segment_changed` — and a timestamp that only moved on change could not tell them apart.
 *
 * Clearing (`segment: null`) also clears `segment_schema_version`: a version describes a value, and
 * there is no value to describe.
 */
export async function setPrimarySegment(
  transaction: TenantTransaction,
  input: SetPrimarySegmentInput,
): Promise<UserPreferences> {
  const now = input.now ?? new Date()
  const version = input.segment === null ? null : SEGMENT_SCHEMA_VERSION

  const [row] = await transaction
    .insert(userPreferences)
    .values({
      userId: input.subjectUserId,
      primarySegment: input.segment,
      segmentSource: input.source,
      segmentSchemaVersion: version,
      segmentSelectedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        primarySegment: input.segment,
        segmentSource: input.source,
        segmentSchemaVersion: version,
        segmentSelectedAt: now,
        updatedAt: now,
      },
    })
    // RETURNING needs the SELECT grant as well as the write one. `0171` grants both; a write-only
    // role would succeed at the insert and fail here, which reads as a mysterious 500.
    .returning({
      userId: userPreferences.userId,
      primarySegment: userPreferences.primarySegment,
      segmentSource: userPreferences.segmentSource,
      segmentSchemaVersion: userPreferences.segmentSchemaVersion,
      segmentSelectedAt: userPreferences.segmentSelectedAt,
      searchIncludeSelfManaged: userPreferences.searchIncludeSelfManaged,
    })

  // Unreachable while the row is the caller's own: the policy permits the write, so RETURNING has a
  // row. An empty result means RLS refused, and reporting that as "no preferences" would turn a
  // refused write into a silent success.
  if (!row) {
    throw new Error(`refused to write preferences for ${input.subjectUserId}`)
  }
  return rowToPreferences(row)
}

/**
 * How many accounts sit in each segment, `unknown` included.
 *
 * For the internal metrics surface only, and deliberately a count rather than a list: the spec
 * allows internal staff to see aggregates and not to use somebody's segment as support data. It
 * takes a plain client because it is not one person's data and has no `app.user_id` to filter on —
 * which is also why it can never be reached from a route a member can call.
 */
export async function countUsersBySegment(
  db: { execute: TenantTransaction['execute'] },
): Promise<Record<string, number>> {
  const rows = await db.execute<{ segment: string | null; total: string }>(sql`
    SELECT ${userPreferences.primarySegment} AS segment, count(*)::text AS total
    FROM ${userPreferences}
    GROUP BY 1
  `)
  const counts: Record<string, number> = {}
  for (const row of rows) {
    // A value that is no longer in the taxonomy still has to be counted — dropping it would make the
    // distribution silently not add up to the number of accounts.
    const key = parseUserSegment(row.segment) ?? 'unknown'
    counts[key] = (counts[key] ?? 0) + Number(row.total)
  }
  return counts
}

/**
 * Record whether this person wants self-managed profiles in their matching surfaces.
 *
 * Upserts the row rather than requiring one to exist: a preference is the first thing many people
 * ever set, and "you must have answered the segment question first" is a coupling neither question
 * asks for. `null` is not writable here — clearing a choice back to "never asked" is not something
 * the product offers, and a nullable setter would make the difference between the two states
 * depend on which caller happened to run.
 */
export async function setSearchIncludeSelfManaged(
  transaction: TenantTransaction,
  input: { userId: string; include: boolean; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await transaction
    .insert(userPreferences)
    .values({ userId: input.userId, searchIncludeSelfManaged: input.include, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { searchIncludeSelfManaged: input.include, updatedAt: now },
    })
}
