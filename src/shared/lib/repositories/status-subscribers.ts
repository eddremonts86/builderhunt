// Plan 47 (status-and-trust) Phase 2 — incident-email subscribers.
//
// Public-facing repository: the subscribe and unsubscribe routes
// (no tenant context, no admin principal) are the only writers; the
// admin incident create/resolve routes read the confirmed list.
//
// Anti-enumeration contract (mirrors plan 28's feed-capability design):
//   - `id` is a 16-byte random base64url handle, not the email address.
//   - The unsubscribe token in the email is a separate 32-byte random
//     base64url handle. The row stores only its SHA-256.
//   - The raw unsubscribe token only ever appears in the email we send.
//   - Every "is this real" probe returns 404, indistinguishable from
//     "row not found" — so a leaked DB does not leak valid tokens, and
//     a guessed token does not leak which rows are real.
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { publicDb, type PublicDb } from '../db/client'
import { statusSubscribers } from '../db/schema'
import { SWEEP_BATCH } from '../db/read-bounds'

// The Drizzle handle type. `publicDb` is a Proxy that delegates to
// the real `PostgresJsDatabase<Record<string, never>>`; for the
// optional `db` parameter we accept the same shape.
export type StatusSubscriberDb = PublicDb

const TOKEN_BYTES = 32
const ID_BYTES = 16

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function newId(): string {
  return `sub_${randomBytes(ID_BYTES).toString('base64url')}`
}

export interface NewSubscriber {
  id: string
  email: string
  unsubscribeToken: string
  alreadySubscribed: boolean
}

export async function subscribe(input: { email: string; db?: StatusSubscriberDb }): Promise<NewSubscriber> {
  const db = input.db ?? publicDb
  const email = input.email.trim()
  const emailLower = email.toLowerCase()
  const id = newId()
  const unsubscribeToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const unsubscribeTokenHash = hashToken(unsubscribeToken)
  // Auto-confirm: the spec asked for plain-text emails on subscribe
  // (no double opt-in). See the route for the upgrade path.
  const now = new Date()
  try {
    await db
      .insert(statusSubscribers)
      .values({
        id,
        email,
        emailLower,
        unsubscribeTokenHash,
        confirmedAt: now,
        createdAt: now,
      })
    return { id, email, unsubscribeToken, alreadySubscribed: false }
  } catch (error) {
    // Unique-violation on `email_lower` → already subscribed.
    // Detect by error code rather than error message string (driver-portable).
    if (isUniqueViolation(error)) {
      const existing = await findByEmail(emailLower, db)
      if (existing) {
        // We deliberately do NOT return the existing token — the caller
        // cannot prove they own the address. The previous confirmation
        // email is the only way to recover it.
        return { id: existing.id, email: existing.email, unsubscribeToken: '', alreadySubscribed: true }
      }
    }
    throw error
  }
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps the underlying postgres.js error; the code may
  // be on the top-level error, on a `.cause`, or in a stringified
  // form. Check all three.
  const candidates: unknown[] = [error]
  if (error && typeof error === 'object' && 'cause' in error) {
    candidates.push((error as { cause: unknown }).cause)
  }
  for (const c of candidates) {
    if (
      c &&
      typeof c === 'object' &&
      'code' in c &&
      (c as { code: string }).code === '23505'
    ) {
      return true
    }
    if (c instanceof Error && /unique constraint|23505/i.test(c.message)) {
      return true
    }
  }
  return false
}

export async function unsubscribeByToken(input: { token: string; db?: StatusSubscriberDb }): Promise<boolean> {
  const db = input.db ?? publicDb
  const tokenHash = hashToken(input.token)
  // The token is hashed before comparison so a leak of the database
  // does not yield a list of working unsubscribe links. The comparison
  // is a constant-time string equality inside SQL (the hash is the same
  // length every time, so length-mismatch would also be a mismatch,
  // but we keep the function shape consistent).
  const result = await db
    .update(statusSubscribers)
    .set({ unsubscribedAt: new Date() })
    .where(and(
      eq(statusSubscribers.unsubscribeTokenHash, tokenHash),
      isNull(statusSubscribers.unsubscribedAt),
    ))
    .returning({ id: statusSubscribers.id })
  return result.length > 0
}

export async function findByEmail(
  emailLower: string,
  db: StatusSubscriberDb = publicDb,
): Promise<{ id: string; email: string; emailLower: string; unsubscribeTokenHash: string; confirmedAt: Date | null; createdAt: Date; unsubscribedAt: Date | null } | null> {
  const [row] = await db
    .select()
    .from(statusSubscribers)
    .where(eq(statusSubscribers.emailLower, emailLower.toLowerCase()))
    .limit(1)
  return (row as { id: string; email: string; emailLower: string; unsubscribeTokenHash: string; confirmedAt: Date | null; createdAt: Date; unsubscribedAt: Date | null } | undefined) ?? null
}

/**
 * One batch of confirmed, still-subscribed status subscribers — drained by the incident routes.
 *
 * A ceiling here is a subscriber who asked to be told about incidents and was not. `id` is unique,
 * so it is a total order on its own.
 */
export async function listConfirmedActive(
  db: StatusSubscriberDb = publicDb,
  after: string | null = null,
  limit: number = SWEEP_BATCH,
): Promise<Array<{ id: string; email: string; emailLower: string; unsubscribeTokenHash: string; confirmedAt: Date | null; createdAt: Date; unsubscribedAt: Date | null }>> {
  return db
    .select()
    .from(statusSubscribers)
    .where(and(
      isNull(statusSubscribers.unsubscribedAt),
      sql`${statusSubscribers.confirmedAt} IS NOT NULL`,
      ...(after ? [gt(statusSubscribers.id, after)] : []),
    ))
    .orderBy(asc(statusSubscribers.id))
    .limit(limit) as Promise<Array<{ id: string; email: string; emailLower: string; unsubscribeTokenHash: string; confirmedAt: Date | null; createdAt: Date; unsubscribedAt: Date | null }>>
}
