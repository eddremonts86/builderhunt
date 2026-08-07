import { createHmac, timingSafeEqual } from 'node:crypto'

import { env } from '~/shared/lib/env'

/**
 * Keyset cursors, signed.
 *
 * A keyset cursor carries the last row's value for every `ORDER BY` term, so the next page is a
 * tuple comparison rather than an `OFFSET`. That means the client hands the server values that go
 * straight into a `WHERE` clause — which is exactly why the cursor is signed. An unsigned cursor
 * is a way to supply arbitrary comparison operands, and on a tenant-scoped table it is also a way
 * to ask "what comes after *this* row" about a row in another organization.
 *
 * The construction is `security/feed-capability.ts`'s, not a new one: base64url payload, HMAC-
 * SHA256 over a versioned prefix, compared with `timingSafeEqual`. Only the prefix differs, so a
 * feed token can never be replayed as a cursor.
 *
 * **Server only.** This module reaches `node:crypto`; nothing that renders in a browser may import
 * it. Client code holds the cursor as an opaque string and never inspects it, which is why
 * `index.ts` does not re-export these functions — see the note there.
 */

const PREFIX = 'builderhunt:table-cursor:v1:'

/** A single `ORDER BY` value. Dates are ISO strings by the time they get here — JSON has no Date. */
export type CursorValue = string | number | boolean | null

export interface TableCursorPayload {
  /** Table id. A cursor minted for `sprint_results` is not a cursor for `disputes`. */
  t: string
  /** Canonical sort descriptor, e.g. `score:desc,id:asc`. */
  s: string
  /** Organization id, or `null` for a table that is not tenant-scoped. */
  o: string | null
  /** The last row's values, in the order of the sort descriptor's terms. */
  k: CursorValue[]
}

export interface CursorExpectation {
  table: string
  sort: string
  organizationId: string | null
}

/**
 * A cursor the server refuses.
 *
 * Carries a 400 rather than a 403 on purpose: from the server's side an unusable cursor is a
 * malformed request, and distinguishing "forged" from "stale" in the response would tell a caller
 * which of the two it managed. The shell drops the cursor and refetches page one either way.
 */
export class TableCursorError extends Error {
  readonly status = 400

  constructor(reason: string) {
    super(`Invalid table cursor: ${reason}`)
    this.name = 'TableCursorError'
  }
}

function signingSecret(override?: string): string {
  const secret = override ?? env.BETTER_AUTH_SECRET
  // Same reasoning as `access-requests.ts`: a cursor is a short-lived token that is never stored
  // and carries no personal data, so it reuses the application signing secret rather than adding
  // another one to rotate. (Contrast `PROFILE_REMOVAL_HMAC_KEY`, which hashes stored PII and is
  // required by its spec to be distinct.)
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to sign table cursors')
  return secret
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}${payload}`).digest('base64url')
}

/** Mint a cursor for the last row of the page just served. */
export function createTableCursor(payload: TableCursorPayload, secret?: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, signingSecret(secret))}`
}

/**
 * Verify a cursor against what the current request is actually asking for.
 *
 * Throws `TableCursorError` on a bad signature, a different table, a different sort, or a
 * different organization. The last three are not paranoia about forgery — they are what makes a
 * cursor unusable once the user changes the sort, which is precisely when reusing it would
 * silently produce a page from the middle of a different ordering.
 */
export function verifyTableCursor(
  token: string,
  expected: CursorExpectation,
  secret?: string,
): TableCursorPayload {
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra !== undefined) throw new TableCursorError('malformed token')

  const expectedSignature = Buffer.from(sign(encoded, signingSecret(secret)), 'base64url')
  const actualSignature = Buffer.from(signature, 'base64url')
  if (
    expectedSignature.length !== actualSignature.length
    || !timingSafeEqual(expectedSignature, actualSignature)
  ) throw new TableCursorError('signature mismatch')

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new TableCursorError('payload is not JSON')
  }

  if (typeof decoded !== 'object' || decoded === null) throw new TableCursorError('payload is not an object')
  const payload = decoded as Record<string, unknown>

  if (typeof payload.t !== 'string') throw new TableCursorError('missing table')
  if (typeof payload.s !== 'string') throw new TableCursorError('missing sort descriptor')
  if (payload.o !== null && typeof payload.o !== 'string') throw new TableCursorError('missing organization')
  if (!Array.isArray(payload.k)) throw new TableCursorError('missing key tuple')

  // The signature already proves this server minted it. These checks prove it was minted for the
  // question being asked now.
  if (payload.t !== expected.table) throw new TableCursorError('table mismatch')
  if (payload.s !== expected.sort) throw new TableCursorError('sort mismatch')
  if (payload.o !== expected.organizationId) throw new TableCursorError('organization mismatch')

  for (const value of payload.k) {
    const kind = typeof value
    if (value !== null && kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new TableCursorError('key tuple holds a non-primitive')
    }
  }

  return { t: payload.t, s: payload.s, o: payload.o, k: payload.k as CursorValue[] }
}

/** The canonical sort descriptor a cursor is bound to. Must match what plan 03 orders by. */
export function sortDescriptor(sort: ReadonlyArray<{ id: string; dir: 'asc' | 'desc' }>): string {
  return sort.map((term) => `${term.id}:${term.dir}`).join(',')
}
