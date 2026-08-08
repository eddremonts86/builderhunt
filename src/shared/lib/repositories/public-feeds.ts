// Public feed capabilities — plan 28 (shared-resources) task 9.
//
// The capability table replaces the old "raw saved-query id + HMAC"
// feed. The id is a public, opaque handle (not the saved query id);
// the token is a 32-byte secret that only the creator ever sees.
// The server keeps a hash of the token, not the token itself, so a
// DB leak does not yield working feed URLs.
//
// Anti-enumeration: every error path (unknown id, wrong token,
// revoked, expired, query deleted) returns the same `null`, so an
// attacker who guesses ids and tokens cannot tell what is real.
//
// Revocation is soft (revoked_at is set, row is kept for audit).
// Expiry is hard (resolved at lookup). The FK on query_id is
// ON DELETE CASCADE, so deleting a saved query silently takes its
// capabilities with it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { feedCapabilities, savedQueries, type feedCapabilities as feedCapabilitiesTable } from '../db/schema'
import { emitActivity } from './activity'
import { USER_SCOPED_LIMIT } from '../db/read-bounds'

/**
 * The DB handle the repository operates on. Defaults to the
 * publicDb from the app, but tests pass a disposable database
 * here so they do not hit the real one.
 */
export type FeedCapabilityDb = PostgresJsDatabase<Record<string, never>>

export interface ResolvedCapability {
  organizationId: string
  queryId: string
}

const TOKEN_BYTES = 32

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function newCapabilityId(): string {
  return `fc_${randomBytes(16).toString('base64url')}`
}

/**
 * Public DTO for the UI. The token is INCLUDED here because the
 * caller just minted it and needs to copy the URL exactly once;
 * the row in the database stores only the hash.
 */
export interface CreatedCapability {
  id: string
  capability: string
  organizationId: string
  queryId: string
  createdAt: string
  expiresAt: string | null
}

/**
 * Issue a new capability for a saved query the principal can see.
 * The token is generated here and returned to the caller; only the
 * hash is persisted.
 */
export async function createFeedCapability(
  organizationId: string,
  queryId: string,
  options: { expiresAt?: Date | null; db?: FeedCapabilityDb; mintedByUserId?: string } = {},
): Promise<CreatedCapability> {
  const db = options.db ?? publicDb
  const id = newCapabilityId()
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const hash = hashToken(token)
  // The RLS policy on `feed_capabilities` requires `app.organization_id`
  // to match the row's organization_id. Public routes (and the e2e
  // harness) reach this code without a TenantPrincipal, so we set
  // the GUC inside a transaction that also performs the insert —
  // GUC values are transaction-local in Postgres, and `set_config(..,
  // true)` is required to actually propagate across statements
  // outside a transaction.
  const { sql: sqlTag } = await import('drizzle-orm')
  const minted = await db.transaction(async (tx) => {
    await tx.execute(
      sqlTag`select set_config('app.organization_id', ${organizationId}, true)`,
    )
    const [row] = await tx
      .insert(feedCapabilities)
      .values({
        id,
        organizationId,
        queryId,
        capabilityHash: hash,
        expiresAt: options.expiresAt ?? null,
      })
      .returning({
        id: feedCapabilities.id,
        organizationId: feedCapabilities.organizationId,
        queryId: feedCapabilities.queryId,
        createdAt: feedCapabilities.createdAt,
        expiresAt: feedCapabilities.expiresAt,
      })
    return row
  })
  if (!minted) throw new Error('Failed to mint feed capability')
  const row = minted
  const [query] = await db
    .select({ name: savedQueries.name })
    .from(savedQueries)
    .where(eq(savedQueries.id, queryId))
    .limit(1)
  await emitActivityAsOrganization(db, organizationId, options.mintedByUserId, {
    type: 'feed_capability_minted',
    targetKey: row.id,
    metadata: {
      capabilityId: row.id,
      queryId: row.queryId,
      queryName: query?.name ?? '(unknown)',
    },
  })
  return {
    id: row.id,
    capability: token,
    organizationId: row.organizationId,
    queryId: row.queryId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  }
}

/**
 * Resolve a capability id + token to the (organizationId, queryId)
 * it points at. Returns null for ANY failure — unknown id, wrong
 * token, revoked, expired. The caller surfaces 404 uniformly so
 * an attacker cannot tell what was wrong.
 */
export async function resolveFeedCapability(
  capabilityId: string,
  token: string,
  now: Date = new Date(),
  options: { db?: FeedCapabilityDb } = {},
): Promise<ResolvedCapability | null> {
  const db = options.db ?? publicDb
  const [row] = await db
    .select({
      id: feedCapabilities.id,
      organizationId: feedCapabilities.organizationId,
      queryId: feedCapabilities.queryId,
      capabilityHash: feedCapabilities.capabilityHash,
      expiresAt: feedCapabilities.expiresAt,
      revokedAt: feedCapabilities.revokedAt,
    })
    .from(feedCapabilities)
    .where(eq(feedCapabilities.id, capabilityId))
    .limit(1)
  if (!row) return null
  if (row.revokedAt) return null
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null

  // Constant-time compare; the stored hash is always 43 base64url
  // chars by construction, so length-mismatch would also be a
  // mismatch — but we keep the function shape consistent.
  const expected = Buffer.from(row.capabilityHash, 'base64url')
  const provided = Buffer.from(hashToken(token), 'base64url')
  if (expected.length !== provided.length) return null
  if (!timingSafeEqual(expected, provided)) return null

  return { organizationId: row.organizationId, queryId: row.queryId }
}

/**
 * Revoke a capability. Soft delete — the row is kept for audit
 * and the token's hash is kept so a leaked token cannot be
 * "re-minted" by guessing a new id. Returns true if a row was
 * actually updated (false = already revoked, or not in this org).
 */
export async function revokeFeedCapability(
  organizationId: string,
  capabilityId: string,
  options: { db?: FeedCapabilityDb; revokedByUserId?: string } = {},
): Promise<boolean> {
  const db = options.db ?? publicDb
  const [existing] = await db
    .select({
      id: feedCapabilities.id,
      queryId: feedCapabilities.queryId,
      revokedAt: feedCapabilities.revokedAt,
    })
    .from(feedCapabilities)
    .where(and(
      eq(feedCapabilities.id, capabilityId),
      eq(feedCapabilities.organizationId, organizationId),
    ))
    .limit(1)
  if (!existing || existing.revokedAt) return false
  const [query] = await db
    .select({ name: savedQueries.name })
    .from(savedQueries)
    .where(eq(savedQueries.id, existing.queryId))
    .limit(1)
  const result = await db
    .update(feedCapabilities)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(feedCapabilities.id, capabilityId),
      eq(feedCapabilities.organizationId, organizationId),
      isNull(feedCapabilities.revokedAt),
    ))
    .returning({ id: feedCapabilities.id })
  if (result.length > 0) {
    await emitActivityAsOrganization(db, organizationId, options.revokedByUserId, {
      type: 'feed_capability_revoked',
      targetKey: capabilityId,
      metadata: {
        capabilityId,
        queryId: existing.queryId,
        queryName: query?.name ?? '(unknown)',
      },
    })
  }
  return result.length > 0
}

/**
 * Emit an activity event in the public-DB context, where the
 * RLS policy needs `app.organization_id` to be set. This wraps
 * the emit in a `set_config` so the activity row is owned by
 * the same org as the capability. It is used only by the
 * capability mint/revoke paths, which (unlike saved-query /
 * list paths) do not have a TenantPrincipal in hand.
 */
async function emitActivityAsOrganization(
  db: FeedCapabilityDb,
  organizationId: string,
  userId: string | undefined,
  input: {
    type: import('../activity/contracts').ActivityEventType
    targetKey: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  const { sql: sqlTag } = await import('drizzle-orm')
  // GUC values are transaction-local in Postgres, so the
  // `set_config(..., true)` and the `emitActivity` insert must
  // run on the same connection. A transaction guarantees that.
  await db.transaction(async (tx) => {
    await tx.execute(sqlTag`select set_config('app.organization_id', ${organizationId}, true)`)
    await emitActivity(tx as never, {
      userId: userId ?? '',
      organizationId,
      role: 'owner',
      requestId: '',
    }, input)
  })
}

/**
 * Rotate a capability: the old one is revoked and a new one
 * (new id, new token) is issued against the same query. The
 * caller renders the new token to the user exactly once.
 */
export async function rotateFeedCapability(
  organizationId: string,
  capabilityId: string,
  options: { db?: FeedCapabilityDb } = {},
): Promise<CreatedCapability | null> {
  const db = options.db ?? publicDb
  const [existing] = await db
    .select({
      id: feedCapabilities.id,
      queryId: feedCapabilities.queryId,
      revokedAt: feedCapabilities.revokedAt,
    })
    .from(feedCapabilities)
    .where(and(
      eq(feedCapabilities.id, capabilityId),
      eq(feedCapabilities.organizationId, organizationId),
    ))
    .limit(1)
  if (!existing || existing.revokedAt) return null
  await db
    .update(feedCapabilities)
    .set({ revokedAt: new Date() })
    .where(eq(feedCapabilities.id, capabilityId))
  return createFeedCapability(organizationId, existing.queryId, { db })
}

/**
 * List the capabilities for an organization. Used by the dashboard
 * so a user can see and revoke their own feed URLs.
 */
export function listActiveFeedCapabilities(
  organizationId: string,
  options: { db?: FeedCapabilityDb } = {},
) {
  const db = options.db ?? publicDb
  return db
    .select({
      id: feedCapabilities.id,
      queryId: feedCapabilities.queryId,
      createdAt: feedCapabilities.createdAt,
      expiresAt: feedCapabilities.expiresAt,
      revokedAt: feedCapabilities.revokedAt,
    })
    .from(feedCapabilities)
    .where(eq(feedCapabilities.organizationId, organizationId))
    .orderBy(feedCapabilities.createdAt)
    // Feed tokens an organization minted, each a deliberate act in settings.
    .limit(USER_SCOPED_LIMIT)
}
