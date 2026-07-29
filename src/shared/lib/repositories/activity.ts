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

import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { organizationActivity } from '../db/schema'
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
  targetKey: string
  metadata: Record<string, unknown>
  occurredAt: string
  /** The pre-rendered line the UI shows. */
  display: string
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
    targetKey: r.targetKey,
    metadata: r.metadata,
    occurredAt: r.occurredAt.toISOString(),
    display: isKnownEventType(r.type)
      ? (ACTIVITY_EVENTS[r.type] as { format: (m: unknown) => string }).format(r.metadata)
      : r.type,
  }))
  const last = slice[slice.length - 1]
  return {
    rows: dtos,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt.toISOString(), id: last.id } : null,
  }
}

// Re-export for callers that only need this side of the contract.
export { ACTIVITY_EVENTS, isKnownEventType, getEventDefinition, type ActivityEventType } from '../activity/contracts'
