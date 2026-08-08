// Tenant-aware repository for builder lists and their items.
//
// Visibility: a list is `private` to the creator or `organization` for
// any member, gated by `can(principal, action, { creatorUserId, visibility })`.
// Items are pinned to the canonical `builderIdentityId`; the database
// refuses an item that names a builder the org has not tracked.

import { and, desc, eq, or, sql } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import { can } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { builderIdentities, builderListItems, builderLists, organizationBuilders } from '../db/schema'
import { SharedResourceError } from '../shared-resources/contracts'
import { emitActivity } from './activity'
import { randomId } from '~/lib/utils'
import { ENTITY_DETAIL_LIMIT, USER_SCOPED_LIMIT } from '../db/read-bounds'

// ── Lists ───────────────────────────────────────────────────────────────────

export interface CreateBuilderListInput {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  description: string | null
  visibility: 'private' | 'organization'
}

export async function findBuilderListById(
  transaction: TenantTransaction,
  organizationId: string,
  listId: string,
) {
  const [list] = await transaction.select().from(builderLists)
    .where(and(eq(builderLists.organizationId, organizationId), eq(builderLists.id, listId)))
    .limit(1)
  return list ?? null
}

/**
 * Visibility-aware read: a private list owned by another member is
 * invisible — same anti-enumeration contract as the saved-query repo.
 */
export async function findVisibleBuilderListById(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
) {
  const list = await findBuilderListById(transaction, principal.organizationId, listId)
  if (!list) return null
  if (!can(principal, 'resource:read', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })) {
    return null
  }
  return list
}

export async function listVisibleBuilderLists(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
) {
  return transaction.select().from(builderLists)
    .where(and(
      eq(builderLists.organizationId, principal.organizationId),
      or(
        eq(builderLists.createdByUserId, principal.userId),
        eq(builderLists.visibility, 'organization'),
      ),
    ))
    .orderBy(desc(builderLists.createdAt))
    // Lists a member created or may read, inside one organization — made by hand, one at a time.
    .limit(USER_SCOPED_LIMIT)
}

export async function createBuilderListForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: { name: string; description?: string | null; visibility: 'private' | 'organization' },
) {
  if (!can(principal, 'resource:create')) {
    throw new SharedResourceError('forbidden', 'Not allowed to create a builder list', 403)
  }
  const created = await createBuilderList(transaction, {
    id: randomId(),
    organizationId: principal.organizationId,
    createdByUserId: principal.userId,
    name: input.name,
    description: input.description ?? null,
    visibility: input.visibility,
  })
  if (created) {
    await emitActivity(transaction, principal, {
      type: 'builder_list_created',
      targetKey: created.id,
      metadata: { listId: created.id, listName: created.name, visibility: created.visibility },
    })
  }
  return created
}

export async function createBuilderList(
  transaction: TenantTransaction,
  input: CreateBuilderListInput,
) {
  const [list] = await transaction.insert(builderLists).values(input).returning()
  return list
}

export interface UpdateBuilderListInput {
  expectedVersion: number
  name?: string
  description?: string | null
  visibility?: 'private' | 'organization'
}

/**
 * Versioned rename/description/visibility edit (plans/UI/tasks.md Wave 2 "Shortlist metadata and
 * visibility editing"). Same permission shape as delete — creator, or an elevated (owner/admin)
 * member of an organization-visible list — since narrowing a shared list's visibility to private
 * or renaming it out from under the team is exactly the kind of change a plain member should not
 * make unilaterally.
 *
 * Throws `SharedResourceError('version_conflict', …, 409)` when `expectedVersion` no longer
 * matches — the UPDATE's own WHERE clause is the single source of truth for that, not a separate
 * read-then-compare, so a race between two concurrent edits can never both "succeed".
 */
export async function updateBuilderListForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
  input: UpdateBuilderListInput,
) {
  const list = await findVisibleBuilderListById(transaction, principal, listId)
  if (!list) throw new SharedResourceError('not_found', 'Builder list not found', 404)
  if (!can(principal, 'resource:update', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to edit this builder list', 403)
  }

  const visibilityChanged = input.visibility !== undefined && input.visibility !== list.visibility
  const [updated] = await transaction
    .update(builderLists)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      version: sql`${builderLists.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(builderLists.id, listId), eq(builderLists.version, input.expectedVersion)))
    .returning()

  if (!updated) {
    throw new SharedResourceError('version_conflict', 'This shortlist changed while you were editing. Reload to see the newer version.', 409)
  }

  await emitActivity(transaction, principal, {
    type: 'builder_list_updated',
    targetKey: updated.id,
    metadata: {
      listId: updated.id,
      listName: updated.name,
      visibility: updated.visibility,
      visibilityChanged,
    },
  })

  return updated
}

export async function deleteBuilderListForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
): Promise<void> {
  const list = await findVisibleBuilderListById(transaction, principal, listId)
  if (!list) throw new SharedResourceError('not_found', 'Builder list not found', 404)
  if (!can(principal, 'resource:delete', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to delete this builder list', 403)
  }
  await emitActivity(transaction, principal, {
    type: 'builder_list_deleted',
    targetKey: list.id,
    metadata: { listId: list.id, listName: list.name },
  })
  await transaction.delete(builderLists).where(eq(builderLists.id, listId))
}

// ── Items ───────────────────────────────────────────────────────────────────

export interface CreateBuilderListItemInput {
  id: string
  listId: string
  organizationId: string
  builderIdentityId: string
  createdByUserId: string
}

export async function listItemsForList(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
) {
  // A peer who cannot see the parent list cannot see its items either;
  // the visibility check is on the list, not the item row.
  const list = await findVisibleBuilderListById(transaction, principal, listId)
  if (!list) throw new SharedResourceError('not_found', 'Builder list not found', 404)
  // Joined with organization_builders for the id `/builder/$builderId` actually navigates by
  // (never `builderIdentityId`, which is global and not tenant-scoped) and with builder_identities
  // for the display fields the row needs — plans/UI/tasks.md Wave 2 "Connect shortlist members to
  // the builder workspace". The composite FK on builder_list_items guarantees both joins always
  // find a row, so neither is left/optional here.
  return transaction
    .select({
      id: builderListItems.id,
      listId: builderListItems.listId,
      organizationId: builderListItems.organizationId,
      builderIdentityId: builderListItems.builderIdentityId,
      createdByUserId: builderListItems.createdByUserId,
      createdAt: builderListItems.createdAt,
      organizationBuilderId: organizationBuilders.id,
      username: builderIdentities.username,
      displayName: builderIdentities.displayName,
      avatarUrl: builderIdentities.avatarUrl,
      source: builderIdentities.source,
      sourceId: builderIdentities.sourceId,
      profileUrl: builderIdentities.profileUrl,
    })
    .from(builderListItems)
    .innerJoin(
      organizationBuilders,
      and(
        eq(organizationBuilders.organizationId, builderListItems.organizationId),
        eq(organizationBuilders.builderIdentityId, builderListItems.builderIdentityId),
      ),
    )
    .innerJoin(builderIdentities, eq(builderIdentities.id, builderListItems.builderIdentityId))
    .where(and(eq(builderListItems.listId, listId), eq(builderListItems.organizationId, principal.organizationId)))
    .orderBy(desc(builderListItems.createdAt))
    // Members of one shortlist, rendered whole — see `ENTITY_DETAIL_LIMIT`.
    .limit(ENTITY_DETAIL_LIMIT)
}

/**
 * Idempotent add: a duplicate (list, builder) pair is a no-op rather
 * than a 5xx. The composite unique index on (list_id, builder_identity_id)
 * is the database-side enforcement; `onConflictDoNothing` matches it.
 */
export async function addItemToListForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
  builderIdentityId: string,
) {
  const list = await findVisibleBuilderListById(transaction, principal, listId)
  if (!list) throw new SharedResourceError('not_found', 'Builder list not found', 404)
  if (!can(principal, 'resource:update', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to add to this builder list', 403)
  }

  // The identity must exist globally and the org must have tracked the
  // builder. Both checks run before the insert so a caller never gets a
  // 23503 (FK violation) — every error is a typed 4xx.
  const [identity] = await transaction.select({ id: builderIdentities.id })
    .from(builderIdentities)
    .where(eq(builderIdentities.id, builderIdentityId))
    .limit(1)
  if (!identity) throw new SharedResourceError('invalid_identity', 'Builder identity does not exist', 422)

  const [tracked] = await transaction.select({ builderIdentityId: organizationBuilders.builderIdentityId })
    .from(organizationBuilders)
    .where(and(
      eq(organizationBuilders.organizationId, principal.organizationId),
      eq(organizationBuilders.builderIdentityId, builderIdentityId),
    ))
    .limit(1)
  if (!tracked) {
    throw new SharedResourceError(
      'invalid_identity',
      'Organization has not tracked this builder — track it first',
      422,
    )
  }

  const inserted = await transaction.insert(builderListItems)
    .values({
      id: randomId(),
      listId,
      organizationId: principal.organizationId,
      builderIdentityId,
      createdByUserId: principal.userId,
    })
    .onConflictDoNothing({ target: [builderListItems.listId, builderListItems.builderIdentityId] })
    .returning()
  if (inserted[0]) {
    await emitActivity(transaction, principal, {
      type: 'builder_list_item_added',
      targetKey: `${listId}:${builderIdentityId}`,
      metadata: { listId, listName: list.name, builderIdentityId },
    })
  }
  return inserted[0] ?? null
}

export async function removeItemFromListForPrincipal(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  listId: string,
  itemId: string,
) {
  const list = await findVisibleBuilderListById(transaction, principal, listId)
  if (!list) throw new SharedResourceError('not_found', 'Builder list not found', 404)
  if (!can(principal, 'resource:update', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })) {
    throw new SharedResourceError('forbidden', 'Not allowed to remove from this builder list', 403)
  }
  // Read the item BEFORE deleting so the activity metadata has the
  // builder identity. The metadata is a snapshot, not a live
  // reference — a future schema migration cannot resurrect a
  // hard-deleted item just to break this emit.
  const [item] = await transaction
    .select({ builderIdentityId: builderListItems.builderIdentityId })
    .from(builderListItems)
    .where(and(eq(builderListItems.id, itemId), eq(builderListItems.listId, listId)))
    .limit(1)
  if (item) {
    await emitActivity(transaction, principal, {
      type: 'builder_list_item_removed',
      targetKey: `${listId}:${item.builderIdentityId}`,
      metadata: {
        listId,
        listName: list.name,
        builderIdentityId: item.builderIdentityId,
      },
    })
  }
  await transaction.delete(builderListItems).where(and(
    eq(builderListItems.id, itemId),
    eq(builderListItems.listId, listId),
  ))
}

// re-export so tests can use the same identity check directly
export { builderIdentities, organizationBuilders }

// silence the unused-import warning that the `sql` template tag would
// otherwise surface if a future edit removes the only reference above.
export const _sql = sql
