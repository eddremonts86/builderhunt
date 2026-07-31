// Plan 29 (activity-feed) task 3 — transaction-bound activity repository.
//
// The activity emit is called from inside the same tenant
// transaction that just did the mutation. The row insert is
// idempotent on idempotency_key (a UNIQUE constraint) so a retry
// of the same operation is a no-op rather than a duplicate row.
//
// Why emit is on the same transaction:
// - rollback semantics: if the parent mutation rolls back, the
//   activity row goes with it. There is no "I deleted the query
//   but the activity says I created it" state.
// - cross-tenant safety: the row inherits the principal's
//   organization_id from the transaction's `app.organization_id`
//   GUC. RLS forces the comparison at insert time.
//
// Why no UPDATE:
// - activity is append-only. Corrections are a new event, not
//   an in-place edit. RLS denies UPDATE for the app role.
//
// Why no DELETE for the app role:
// - retention is the worker's job, not the app's. RLS allows
//   DELETE only for the worker role.

import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import { can } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { alerts, builderLists, organizationActivity, savedQueries } from '../db/schema'
import {
  ACTIVITY_EVENTS,
  getEventDefinition,
  idempotencyKey,
  isKnownEventType,
  type ActivityEventType,
} from '../activity/contracts'

export interface EmitActivityInput {
  type: ActivityEventType
  /** Stable business key for the affected target. Used in the
   *  idempotency hash so two emits against the same row on the
   *  same day are a no-op. */
  targetKey: string
  /** Raw metadata; will be parsed through the registry's zod
   *  schema. Anything not in the allowlist is rejected. */
  metadata: Record<string, unknown>
  /** When the event happened. Defaults to "now". */
  occurredAt?: Date
}

/**
 * Insert a single activity event. Idempotent on
 * `(type, organization_id, actor_user_id, target_key, day)` so
 * a retry of the same logical operation is a no-op.
 *
 * Throws if `type` is not a registered event type or if the
 * metadata does not match the registered zod schema. Both are
 * programming errors: the registry is the only way to introduce
 * a new event, and the call site is the only place that knows
 * the metadata shape, so the caller MUST pass a type that
 * matches the schema or the build is broken before it gets here.
 */
export async function emitActivity(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: EmitActivityInput,
): Promise<void> {
  if (!isKnownEventType(input.type)) {
    throw new Error(`Unknown activity event type: ${input.type}`)
  }
  const def = getEventDefinition(input.type)
  const parsed = def.metadata.safeParse(input.metadata)
  if (!parsed.success) {
    throw new Error(
      `Activity metadata for ${input.type} failed validation: ${parsed.error.message}`,
    )
  }
  const occurredAt = input.occurredAt ?? new Date()
  const idemKey = idempotencyKey(
    input.type,
    principal.organizationId,
    principal.userId,
    input.targetKey,
    occurredAt,
  )
  // ON CONFLICT DO NOTHING. The unique constraint on
  // idempotency_key is the conflict target. No "RETURNING" — we
  // do not care whether it was an insert or a no-op.
  await transaction
    .insert(organizationActivity)
    .values({
      organizationId: principal.organizationId,
      actorUserId: principal.userId || null,
      type: input.type,
      version: def.version,
      targetKey: input.targetKey,
      metadata: parsed.data as Record<string, unknown>,
      idempotencyKey: idemKey,
      occurredAt,
      expiresAt: def.retentionDays
        ? new Date(occurredAt.getTime() + def.retentionDays * 24 * 60 * 60 * 1000)
        : null,
    })
    .onConflictDoNothing({ target: organizationActivity.idempotencyKey })
}

export interface ListActivityOptions {
  /** Keyset cursor: return rows strictly older than (occurredAt, id). */
  before?: { occurredAt: Date; id: string }
  limit?: number
}

export interface ActivityRowDTO {
  id: string
  type: ActivityEventType
  version: number
  /** Nullable: system actions (e.g. capability mint) have no
   *  TenantPrincipal. A null actor renders as "System" in the UI. */
  actorUserId: string | null
  /**
   * Resolved separately from this repository (see
   * `resolveActorDisplayNames` in `auth/organization-lifecycle.ts`) because
   * `auth_users`/`organization_members` are auth-broker-owned tables this
   * tenant repository has no grant on. Always `null` coming out of
   * `listActivity`; the API route fills it in. `null` here means "unknown
   * or no longer a member" — the UI renders "Former member", not a blank.
   */
  actorDisplayName: string | null
  targetKey: string
  metadata: Record<string, unknown>
  occurredAt: string
  /** The pre-rendered line the UI shows. */
  display: string
  /**
   * Server-derived navigation target, or `null` if the underlying row was
   * deleted or the viewing principal cannot read it (e.g. another member's
   * private shortlist). Never built from `targetKey` — that field is an
   * idempotency-hash input (sometimes a composite like `${listId}:${builderIdentityId}`),
   * not a validated route id. Only list/search/alert event types resolve a
   * target at all; everything else is always `null`.
   */
  targetHref: string | null
}

/** Event types whose `metadata.listId` names a `builder_lists` row. */
const BUILDER_LIST_HREF_TYPES = new Set<ActivityEventType>([
  'builder_list_created',
  'builder_list_updated',
  'builder_list_item_added',
  'builder_list_item_removed',
])

/** Event types whose `metadata.queryId` names a `saved_queries` row. */
const SAVED_QUERY_HREF_TYPES = new Set<ActivityEventType>(['saved_query_created', 'saved_query_visibility_changed'])

function stringField(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export interface ListActivityResult {
  rows: ActivityRowDTO[]
  /** The cursor to pass to the next call. null = end of feed. */
  nextCursor: { occurredAt: string; id: string } | null
}

/**
 * Keyset-paginated feed. The (organization_id, occurred_at desc,
 * id desc) index is the only access path. There is no offset
 * pagination: at 10k rows the offset becomes a quadratic cost,
 * and keyset is what the spec demands.
 */
export async function listActivity(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  options: ListActivityOptions = {},
): Promise<ListActivityResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  // Drizzle does not yet support tuple comparators directly, so
  // we build (occurred_at, id) < (cursor.occurredAt, cursor.id) by
  // hand: occurred_at < cursor.occurredAt OR (occurred_at = cursor.occurredAt AND id < cursor.id).
  const whereParts = [eq(organizationActivity.organizationId, principal.organizationId)]
  if (options.before) {
    whereParts.push(
      or(
        lt(organizationActivity.occurredAt, options.before.occurredAt),
        and(
          eq(organizationActivity.occurredAt, options.before.occurredAt),
          lt(organizationActivity.id, options.before.id),
        ),
      )!,
    )
  }
  const rows = await transaction
    .select({
      id: organizationActivity.id,
      type: organizationActivity.type,
      version: organizationActivity.version,
      actorUserId: organizationActivity.actorUserId,
      targetKey: organizationActivity.targetKey,
      metadata: organizationActivity.metadata,
      occurredAt: organizationActivity.occurredAt,
    })
    .from(organizationActivity)
    .where(and(...whereParts))
    .orderBy(desc(organizationActivity.occurredAt), desc(organizationActivity.id))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows
  const dtos: ActivityRowDTO[] = slice.map((r) => ({
    id: r.id,
    type: isKnownEventType(r.type) ? r.type : ('saved_query_created' as ActivityEventType),
    version: r.version,
    actorUserId: r.actorUserId,
    actorDisplayName: null,
    targetKey: r.targetKey,
    metadata: r.metadata,
    occurredAt: r.occurredAt.toISOString(),
    display: isKnownEventType(r.type)
      ? (ACTIVITY_EVENTS[r.type] as { format: (m: unknown) => string }).format(r.metadata)
      : r.type,
    targetHref: null,
  }))
  await attachTargetHrefs(transaction, principal, dtos)
  const last = slice[slice.length - 1]
  return {
    rows: dtos,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt.toISOString(), id: last.id } : null,
  }
}

/**
 * Resolves `targetHref` for list/search/alert event types in place. Batches
 * one lookup per underlying table rather than one per row — a 50-row page
 * touches at most three tables. Every candidate id comes from validated
 * `metadata` fields (`listId`/`queryId`/`alertId`), never from `targetKey`.
 */
async function attachTargetHrefs(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  dtos: ActivityRowDTO[],
): Promise<void> {
  const listIds = new Set<string>()
  const queryIds = new Set<string>()
  const alertIds = new Set<string>()
  for (const row of dtos) {
    if (BUILDER_LIST_HREF_TYPES.has(row.type)) {
      const id = stringField(row.metadata, 'listId')
      if (id) listIds.add(id)
    } else if (SAVED_QUERY_HREF_TYPES.has(row.type)) {
      const id = stringField(row.metadata, 'queryId')
      if (id) queryIds.add(id)
    } else if (row.type === 'alert_created') {
      const id = stringField(row.metadata, 'alertId')
      if (id) alertIds.add(id)
    }
  }

  const [listRows, queryRows, alertRows] = await Promise.all([
    listIds.size > 0
      ? transaction
          .select({ id: builderLists.id, createdByUserId: builderLists.createdByUserId, visibility: builderLists.visibility })
          .from(builderLists)
          .where(and(eq(builderLists.organizationId, principal.organizationId), inArray(builderLists.id, [...listIds])))
      : Promise.resolve([]),
    queryIds.size > 0
      ? transaction
          .select({ id: savedQueries.id, userId: savedQueries.userId, visibility: savedQueries.visibility, keywords: savedQueries.keywords })
          .from(savedQueries)
          .where(and(eq(savedQueries.organizationId, principal.organizationId), inArray(savedQueries.id, [...queryIds])))
      : Promise.resolve([]),
    alertIds.size > 0
      ? transaction
          .select({ id: alerts.id })
          .from(alerts)
          .where(and(eq(alerts.organizationId, principal.organizationId), inArray(alerts.id, [...alertIds])))
      : Promise.resolve([]),
  ])
  const listsById = new Map(listRows.map((r) => [r.id, r]))
  const queriesById = new Map(queryRows.map((r) => [r.id, r]))
  const alertIdsFound = new Set(alertRows.map((r) => r.id))

  for (const row of dtos) {
    if (BUILDER_LIST_HREF_TYPES.has(row.type)) {
      const listId = stringField(row.metadata, 'listId')
      const list = listId ? listsById.get(listId) : undefined
      if (!list) continue
      const visible = can(principal, 'resource:read', {
        creatorUserId: list.createdByUserId,
        visibility: list.visibility === 'organization' ? 'organization' : 'private',
      })
      row.targetHref = visible ? `/lists/${listId}` : null
    } else if (SAVED_QUERY_HREF_TYPES.has(row.type)) {
      const queryId = stringField(row.metadata, 'queryId')
      const query = queryId ? queriesById.get(queryId) : undefined
      if (!query) continue
      const visible = can(principal, 'resource:read', {
        creatorUserId: query.userId,
        visibility: query.visibility === 'organization' ? 'organization' : 'private',
      })
      if (!visible) continue
      const q = query.keywords.join(' ').trim()
      row.targetHref = q ? `/search?q=${encodeURIComponent(q)}` : '/search'
    } else if (row.type === 'alert_created') {
      const alertId = stringField(row.metadata, 'alertId')
      row.targetHref = alertId && alertIdsFound.has(alertId) ? '/alerts' : null
    }
  }
}

// Re-export for callers that only need this side of the contract.
export { ACTIVITY_EVENTS, isKnownEventType, getEventDefinition, type ActivityEventType } from '../activity/contracts'
