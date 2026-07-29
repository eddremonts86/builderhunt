import { and, count, desc, eq, or, sql } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import { can } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { savedQueries } from '../db/schema'
import { SharedResourceError } from '../shared-resources/contracts'
import { emitActivity } from './activity'
import { randomId } from '~/lib/utils'

export interface CreateSavedQueryInput {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  keywords: string[]
  sources: string[]
  language: string | null
  country: string | null
}

export async function findSavedQueryById(transaction: TenantTransaction, organizationId: string, id: string) {
  const [query] = await transaction.select().from(savedQueries)
    .where(and(eq(savedQueries.organizationId, organizationId), eq(savedQueries.id, id)))
    .limit(1)
  return query ?? null
}

export function listSavedQueries(transaction: TenantTransaction, organizationId: string) {
  return transaction.select().from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
    .orderBy(savedQueries.createdAt)
}

/**
 * Visibility-aware list: every row in the active org the caller is
 * allowed to read. Reads as the union of:
 *  - rows the caller created (private or organization),
 *  - rows with `visibility = 'organization'` (any member reads them).
 *
 * A private row that another member created is invisible to the
 * caller — `can()` decides it on a per-row basis, but the SQL filter
 * is conservative: an admin still cannot see another member's
 * private row. (See `authorization/permissions.ts` `resource:read`.)
 */
export async function listVisibleSavedQueriesForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
) {
  return transaction.select()
    .from(savedQueries)
    .where(
      and(
        eq(savedQueries.organizationId, principal.organizationId),
        or(
          eq(savedQueries.userId, principal.userId),
          eq(savedQueries.visibility, 'organization'),
        ),
      ),
    )
    .orderBy(desc(savedQueries.createdAt))
}

export function listRecentSavedQueries(
  transaction: TenantTransaction,
  organizationId: string,
  limit: number,
) {
  return transaction.select({
    id: savedQueries.id,
    name: savedQueries.name,
    keywords: savedQueries.keywords,
    sources: savedQueries.sources,
  }).from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
    .orderBy(desc(savedQueries.createdAt))
    .limit(limit)
}

/**
 * "Legacy" here means the pre-multi-org read path (saved_queries scoped by
 * userId only, from before organizationId existed on this table). Every row
 * has carried a NOT NULL organizationId for a long time now, so the legacy
 * path must filter on it too — a user who belongs to more than one
 * organization (the common personal-workspace + team case) would otherwise
 * see every org's saved searches merged together, regardless of which
 * organization is currently active.
 */
export function listLegacySavedQueries(transaction: TenantTransaction, userId: string, organizationId: string) {
  return transaction.select().from(savedQueries)
    .where(and(eq(savedQueries.userId, userId), eq(savedQueries.organizationId, organizationId)))
    .orderBy(savedQueries.createdAt)
}

export async function countSavedQueries(transaction: TenantTransaction, organizationId: string) {
  const [row] = await transaction.select({ value: count() }).from(savedQueries)
    .where(eq(savedQueries.organizationId, organizationId))
  return Number(row?.value ?? 0)
}

export async function createSavedQuery(transaction: TenantTransaction, input: CreateSavedQueryInput) {
  const [query] = await transaction.insert(savedQueries).values({
    id: input.id,
    organizationId: input.organizationId,
    userId: input.createdByUserId,
    name: input.name,
    keywords: input.keywords,
    sources: input.sources,
    language: input.language,
    country: input.country,
  }).returning()
  return query
}

export async function deleteSavedQuery(transaction: TenantTransaction, organizationId: string, id: string) {
  const result = await transaction.delete(savedQueries)
    .where(and(eq(savedQueries.organizationId, organizationId), eq(savedQueries.id, id)))
    .returning({ id: savedQueries.id })
  return result.length > 0
}

// ── Tenant-aware (plan 28 task 3) ─────────────────────────────────────────

/**
 * Reads a single row only if the principal can read it. A private row
 * the caller did not create gets a `not_found` (not a `forbidden`) so
 * a probe by id cannot enumerate which ids exist.
 */
export async function findVisibleSavedQueryById(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  queryId: string,
) {
  const [query] = await transaction.select().from(savedQueries)
    .where(and(
      eq(savedQueries.organizationId, principal.organizationId),
      eq(savedQueries.id, queryId),
    ))
    .limit(1)
  if (!query) return null
  const allowed = can(principal, 'resource:read', {
    creatorUserId: query.userId,
    visibility: query.visibility === 'organization' ? 'organization' : 'private',
  })
  return allowed ? query : null
}

/**
 * Update an existing saved query. Authorization is read-then-update:
 * a caller who cannot read the row cannot update it either. The
 * visibility field is rewritten to a validated enum value or the
 * call fails closed with `invalid_visibility`.
 */
export async function updateSavedQueryForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  queryId: string,
  patch: { name?: string; keywords?: string[]; sources?: string[]; language?: string | null; country?: string | null },
) {
  const existing = await findVisibleSavedQueryById(transaction, principal, queryId)
  if (!existing) throw new SharedResourceError('not_found', 'Saved query not found', 404)
  if (!can(principal, 'resource:update', {
    creatorUserId: existing.userId,
    visibility: existing.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to update this saved query', 403)
  }
  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) updates.name = patch.name
  if (patch.keywords !== undefined) updates.keywords = patch.keywords
  if (patch.sources !== undefined) updates.sources = patch.sources
  if (patch.language !== undefined) updates.language = patch.language
  if (patch.country !== undefined) updates.country = patch.country
  if (Object.keys(updates).length === 0) return existing
  const [updated] = await transaction.update(savedQueries)
    .set(updates)
    .where(eq(savedQueries.id, queryId))
    .returning()
  return updated
}

/**
 * Flip the visibility between `private` and `organization`. The
 * action `resource:share` is its own gate — a member with read but
 * not share would never need to write visibility, so the action
 * check is independent and lives in the same `can()` vocabulary.
 */
export async function changeSavedQueryVisibilityForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  queryId: string,
  visibility: 'private' | 'organization',
) {
  const existing = await findVisibleSavedQueryById(transaction, principal, queryId)
  if (!existing) throw new SharedResourceError('not_found', 'Saved query not found', 404)
  if (!can(principal, 'resource:share', {
    creatorUserId: existing.userId,
    visibility: existing.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to change visibility on this saved query', 403)
  }
  if (visibility !== 'private' && visibility !== 'organization') {
    throw new SharedResourceError('invalid_visibility', 'Visibility must be private or organization', 422)
  }
  const [updated] = await transaction.update(savedQueries)
    .set({ visibility, updatedAt: new Date() })
    .where(eq(savedQueries.id, queryId))
    .returning()
  if (updated) {
    await emitActivity(transaction, principal, {
      type: 'saved_query_visibility_changed',
      targetKey: updated.id,
      metadata: {
        queryId: updated.id,
        queryName: updated.name,
        from: existing.visibility,
        to: updated.visibility,
      },
    })
  }
  return updated
}

export async function deleteSavedQueryForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  queryId: string,
): Promise<void> {
  const existing = await findVisibleSavedQueryById(transaction, principal, queryId)
  if (!existing) throw new SharedResourceError('not_found', 'Saved query not found', 404)
  if (!can(principal, 'resource:delete', {
    creatorUserId: existing.userId,
    visibility: existing.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to delete this saved query', 403)
  }
  await emitActivity(transaction, principal, {
    type: 'saved_query_deleted',
    targetKey: existing.id,
    metadata: { queryId: existing.id, queryName: existing.name },
  })
  await transaction.delete(savedQueries).where(eq(savedQueries.id, queryId))
}

/**
 * Atomic create: a saved query is a row plus the associated keyword
 * and source records. The `saved_query_keywords` /
 * `saved_query_sources` associations are not yet modeled as a
 * separate table (today they are stored as a jsonb array on the
 * row), so "atomic" here is a single insert. The function name is
 * future-compatible with the normalized schema.
 */
export async function createSavedQueryForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: Omit<CreateSavedQueryInput, 'id' | 'organizationId' | 'createdByUserId'>,
) {
  if (!can(principal, 'resource:create')) {
    throw new SharedResourceError('forbidden', 'Not allowed to create a saved query', 403)
  }
  const created = await createSavedQuery(transaction, {
    id: randomId(),
    organizationId: principal.organizationId,
    createdByUserId: principal.userId,
    name: input.name,
    keywords: input.keywords,
    sources: input.sources,
    language: input.language,
    country: input.country,
  })
  if (created) {
    await emitActivity(transaction, principal, {
      type: 'saved_query_created',
      targetKey: created.id,
      metadata: {
        queryId: created.id,
        queryName: created.name,
        visibility: 'private',
      },
    })
  }
  return created
}

// re-export to keep the count(*) and the sql tag available to tests
export const _sql = sql
