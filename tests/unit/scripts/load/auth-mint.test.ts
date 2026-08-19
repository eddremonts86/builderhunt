/**
 * Minting a thousand sessions without signing a thousand users in (plan: phase-1/55, phase 2).
 *
 * The value of this test is narrow and specific: it proves the rows land and the cookies are distinct.
 * What it deliberately cannot prove is that better-auth *accepts* a minted cookie — that needs the real
 * server, and it is asserted in `tests/e2e/load-minted-session.spec.ts`. Splitting them that way keeps the
 * expensive check honest instead of stubbing the one thing worth checking.
 */
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { mintSessions, parseSessionCookie } from '../../../../scripts/load/auth'

let sql: Sql
let drop: () => Promise<void>

const SECRET = 'load-harness-test-secret-not-a-real-one'
const USERS = 1_000

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('load_mint')
  drop = disposable.drop
  sql = postgres(disposable.databaseUrl, { max: 4, prepare: false })

  // One organization, a thousand members. The shape the fixture seeder produces is one org per user, but
  // `mintSessions` only ever reads `organizationId` off the ref it was handed — what it resolves from the
  // database is the user id, and that is what this seeds properly.
  await sql`insert into organizations (id, name, slug, created_at) values ('mint-org', 'Mint Org', 'mint-org', now())`
  const rows = Array.from({ length: USERS }, (_, i) => ({
    id: `mint-u-${String(i).padStart(4, '0')}`,
    name: `Mint ${i}`,
    email: `mint-u-${String(i).padStart(4, '0')}@load.local`,
    email_verified: true,
    created_at: new Date(),
    updated_at: new Date(),
  }))
  for (let offset = 0; offset < rows.length; offset += 500) {
    await sql`insert into auth_users ${sql(rows.slice(offset, offset + 500))}`
  }
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => undefined)
  await drop?.()
})

/** The refs the runner would hand over, straight off the manifest. */
function refs(count = USERS) {
  return Array.from({ length: count }, (_, i) => ({
    email: `mint-u-${String(i).padStart(4, '0')}@load.local`,
    organizationId: 'mint-org',
    sprintId: `mint-sp-${i}`,
  }))
}

describe('parseSessionCookie', () => {
  /**
   * The signature is base64, so it can end in `=`. Splitting the pair on every `=` truncates it, and the
   * result is a cookie that looks structurally right and authenticates nobody — the failure would surface
   * four hundred thousand requests later as a run where every route answered 401.
   */
  it('decodes the percent-encoding better-call applies inside its signing helper', () => {
    // `signCookieValue` returns encodeURIComponent(`${token}.${signature}`), so base64 `+` and `=`
    // arrive as %2B and %3D. Comparing the raw header against makeSignature never matches.
    //
    // The fixture is deliberately three characters long. A realistic-looking base64 blob after
    // `session_token=` is what GitGuardian's generic detector matches on, and this file failed the
    // secret scan on 2026-08-19 over a value that never authenticated anything. Nothing here needs
    // length: `%2B` and `%3D` are the whole subject, and one of each proves the decoding. Keep it
    // small, or the next scan turns a passing test into a security incident again.
    const parsed = parseSessionCookie('better-auth.session_token=tok.s%2Bg%3D%3D; Path=/; HttpOnly')
    expect(parsed).toEqual({ name: 'better-auth.session_token', token: 'tok', signature: 's+g==' })
  })

  /** The token itself never contains a dot, but splitting on the *last* one is what makes that not matter. */
  it('splits on the last dot, not the first', () => {
    expect(parseSessionCookie('better-auth.session_token=a.b.sig')?.token).toBe('a.b')
  })

  it('ignores cookies that are not the session token', () => {
    expect(parseSessionCookie('other=1; csrf=2.3')).toBeNull()
  })
})

describe('mintSessions', () => {
  const format = { name: 'better-auth.session_token', secret: SECRET }

  /**
   * The headline: a thousand sessions, no sign-in, no server.
   *
   * `signInAll` cannot reach this size — `/sign-in/email` is capped at 20/min per IP and every virtual
   * user comes from one host — so before this existed the thousand-user profile aborted on a `429` having
   * proved nothing.
   */
  it('writes one row per user and hands back a distinct cookie for each', async () => {
    const sessions = await mintSessions({ sql, users: refs(), format })

    expect(sessions).toHaveLength(USERS)
    const [{ count }] = await sql<{ count: string }[]>`select count(*)::text as count from auth_sessions`
    expect(Number(count)).toBe(USERS)

    // Distinct, because a reused token is one session pretending to be a thousand — the run would report
    // the concurrency it was asked for while the database saw one.
    expect(new Set(sessions.map((session) => session.cookie)).size).toBe(USERS)
    const [{ tokens }] = await sql<{ tokens: string }[]>`select count(distinct token)::text as tokens from auth_sessions`
    expect(Number(tokens)).toBe(USERS)
  }, 120_000)

  /** Every row has to carry the org the request will be answered in, or the tenant boundary is untested. */
  it('scopes each session to the org the ref names', async () => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from auth_sessions where active_organization_id = 'mint-org'
    `
    expect(Number(rows[0]!.n)).toBe(USERS)
  })

  /** The cookie is `name=token.signature`, and the token in it is the one that reached the database. */
  it('signs the token it stored, under the name it was given', async () => {
    const [session] = await mintSessions({
      sql,
      users: [{ email: 'mint-u-0000@load.local', organizationId: 'mint-org', sprintId: 's' }],
      format,
    })
    const parsed = parseSessionCookie(session!.cookie)
    expect(parsed?.name).toBe('better-auth.session_token')
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from auth_sessions where token = ${parsed!.token}`
    expect(Number(rows[0]!.n)).toBe(1)
  })

  /**
   * A missing fixture must be named, not surfaced as a foreign-key violation five hundred rows into a
   * batch insert — that error names a constraint, not the seeding step somebody skipped.
   */
  it('says which fixtures are missing instead of failing on a foreign key', async () => {
    await expect(
      mintSessions({
        sql,
        users: [{ email: 'nobody@load.local', organizationId: 'mint-org', sprintId: 'x' }],
        format,
      }),
    ).rejects.toThrow(/1 of 1 fixture users are not in auth_users/)
  })

  it('is a no-op for an empty user list', async () => {
    await expect(mintSessions({ sql, users: [], format })).resolves.toEqual([])
  })
})
