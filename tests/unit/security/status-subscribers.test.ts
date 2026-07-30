// Plan 47 (status-and-trust) Phase 2 — status subscribers repository.
//
// Covers the anti-enumeration contract: the unsubscribe token is
// stored only as its SHA-256, the subscribe endpoint never reveals
// whether an address was new or already on the list, and the
// unsubscribe GET is the only thing that ever flips
// `unsubscribed_at`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '~/shared/lib/db/schema'
import { statusSubscribers } from '~/shared/lib/db/schema'
import { findByEmail, listConfirmedActive, subscribe, unsubscribeByToken } from '~/shared/lib/repositories/status-subscribers'

// The test connects to the same DATABASE_URL the app uses. The repo
// is the production code path; the test only resets the table it
// owns and never mutates any other schema object.
const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/builderhunt'
const sql = postgres(TEST_DB_URL, { max: 2, prepare: false })
const testDb = drizzle(sql, { schema })

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

async function resetTable(): Promise<void> {
  await sql`delete from status_subscribers`
}

beforeEach(async () => { await resetTable() })
afterAll(async () => { await resetTable(); await sql.end({ timeout: 1 }) })

describe('status subscribers — repository', () => {
  it('mints a fresh row with a hashed unsubscribe token on subscribe', async () => {
    const result = await subscribe({ email: 'User@Example.com', db: testDb })
    expect(result.id).toMatch(/^sub_/)
    // The token is returned exactly once, to the caller (the route
    // uses it for the confirmation email's unsubscribe link). It is
    // never persisted in raw form.
    expect(result.unsubscribeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(result.alreadySubscribed).toBe(false)
    // The persisted row's `email` preserves the original casing
    // (we want to render "User@Example.com" in admin tooling), but
    // `email_lower` is the unique key — the second subscribe with a
    // different casing must hit the unique-violation path, not a
    // new row.
    const [row] = await testDb.select().from(statusSubscribers).where(eq(statusSubscribers.id, result.id))
    expect(row?.emailLower).toBe('user@example.com')
    // The stored hash matches the token we returned.
    const expectedHash = hashToken(result.unsubscribeToken)
    expect(row?.unsubscribeTokenHash).toBe(expectedHash)
    // And the raw token is NOT in the row.
    const rowString = JSON.stringify(row)
    expect(rowString).not.toContain(result.unsubscribeToken)
  })

  it('returns alreadySubscribed=true (and an empty token) on a duplicate email', async () => {
    const first = await subscribe({ email: 'first@example.com', db: testDb })
    const second = await subscribe({ email: 'first@example.com', db: testDb })
    expect(second.alreadySubscribed).toBe(true)
    // The token is empty: the original confirmation email is the
    // only way to recover a working unsubscribe link. A new caller
    // cannot prove they own the address.
    expect(second.unsubscribeToken).toBe('')
    // The row count is still 1.
    const all = await listConfirmedActive(testDb)
    expect(all).toHaveLength(1)
    // The original row's token still works.
    const removed = await unsubscribeByToken({ token: first.unsubscribeToken, db: testDb })
    expect(removed).toBe(true)
  })

  it('treats different casings of the same address as a single subscriber', async () => {
    await subscribe({ email: 'Mixed@Case.com', db: testDb })
    const second = await subscribe({ email: 'mixed@CASE.com', db: testDb })
    expect(second.alreadySubscribed).toBe(true)
    const all = await listConfirmedActive(testDb)
    expect(all).toHaveLength(1)
  })

  it('only matches the exact token on unsubscribe (anti-enumeration)', async () => {
    await subscribe({ email: 'a@example.com', db: testDb })
    // A random token does not match any row.
    const fake = randomBytes(32).toString('base64url')
    const removed = await unsubscribeByToken({ token: fake, db: testDb })
    expect(removed).toBe(false)
    // The row is still active.
    const all = await listConfirmedActive(testDb)
    expect(all).toHaveLength(1)
  })

  it('is idempotent — unsubscribing twice returns false the second time', async () => {
    const result = await subscribe({ email: 'b@example.com', db: testDb })
    const first = await unsubscribeByToken({ token: result.unsubscribeToken, db: testDb })
    const second = await unsubscribeByToken({ token: result.unsubscribeToken, db: testDb })
    expect(first).toBe(true)
    expect(second).toBe(false)
    // The row is still in the table (soft-cancel) — see the repo
    // docstring for why we never hard-delete.
    const found = await findByEmail('b@example.com', testDb)
    expect(found?.unsubscribedAt).toBeInstanceOf(Date)
  })

  it('listConfirmedActive excludes unconfirmed and unsubscribed rows', async () => {
    const a = await subscribe({ email: 'a@example.com', db: testDb })
    // Mark `a` as unconfirmed by clearing confirmedAt directly.
    await testDb.update(statusSubscribers).set({ confirmedAt: null }).where(eq(statusSubscribers.id, a.id))
    // And add a confirmed row that is then unsubscribed.
    const b = await subscribe({ email: 'b@example.com', db: testDb })
    await unsubscribeByToken({ token: b.unsubscribeToken, db: testDb })
    // And add a third, fully-active row.
    await subscribe({ email: 'c@example.com', db: testDb })
    const active = await listConfirmedActive(testDb)
    expect(active).toHaveLength(1)
    expect(active[0]?.emailLower).toBe('c@example.com')
  })
})
