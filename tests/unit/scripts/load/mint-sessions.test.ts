import { makeSignature } from 'better-auth/crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { LoadAuthError, mintSessions, signSessionCookie, type FixtureUserRef } from '../../../../scripts/load/auth'

/**
 * `mintSessions` replaces a thousand rate-limited sign-ins with one batched insert.
 *
 * The thing worth testing is not that it writes rows — it is that the cookies it writes are the ones
 * the application will accept. Everything here either checks that, or checks a refusal that exists so
 * a wrong cookie is never written in the first place: a two-hour run authenticating as nobody would
 * surface as every route answering 401, which reads like an authorization bug in the product.
 *
 * The end-to-end proof, that a minted cookie actually authenticates against a running server, lives in
 * `tests/e2e/api/load-minted-session.spec.ts`. This file covers the parts that do not need one.
 */

const SECRET = 'test-secret-not-the-application-one'
const COOKIE_NAME = 'better-auth.session_token'

function shapeFor(token: string, signature: string): { name: string; token: string; signature: string } {
  return { name: COOKIE_NAME, token, signature }
}

describe('signSessionCookie', () => {
  it('produces `name=urlencoded(token.signature)`', async () => {
    const cookie = await signSessionCookie(COOKIE_NAME, 'tok', SECRET)
    const [name, ...rest] = cookie.split('=')
    const value = rest.join('=')

    expect(name).toBe(COOKIE_NAME)
    const [token, signature] = decodeURIComponent(value).split('.')
    expect(token).toBe('tok')
    expect(signature).toBe(await makeSignature('tok', SECRET))
  })

  /**
   * The signature is standard base64, so it carries `+`, `/` and `=`. Sending it raw would produce a
   * cookie the server parses differently than it was written — and `tests/e2e/auth-and-sessions.spec.ts`
   * confirms the real cookie is percent-encoded by decoding it before matching `auth_sessions.token`.
   */
  it('percent-encodes, because the signature is base64 and not cookie-safe', async () => {
    const signature = await makeSignature('tok', SECRET)
    expect(signature).toMatch(/[+/=]/)

    const cookie = await signSessionCookie(COOKIE_NAME, 'tok', SECRET)
    expect(cookie).not.toContain(signature)
    expect(decodeURIComponent(cookie.split('=').slice(1).join('='))).toContain(signature)
  })
})

describe('mintSessions refusals', () => {
  const users: FixtureUserRef[] = [
    { userId: 'u1', email: 'u1@load.local', organizationId: 'o1', sprintId: 's1' },
  ]
  const base = { databaseUrl: 'postgresql://unused/none', users, runId: 'r1' }

  it('refuses without a secret rather than minting cookies the app cannot verify', async () => {
    await expect(
      mintSessions({ ...base, secret: '', cookie: shapeFor('t', 'sig') }),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/)
  })

  /**
   * The check that makes the whole approach safe. `probeSessionCookie` hands over a token the *server*
   * signed; if our signature over that same token differs, our secret is not the running app's and every
   * row we were about to write would authenticate as nobody.
   */
  it('refuses when its signature disagrees with the one the server produced', async () => {
    await expect(
      mintSessions({ ...base, secret: SECRET, cookie: shapeFor('t', 'a-signature-from-a-different-secret') }),
    ).rejects.toThrow(/does not match the one the server produced/)
  })

  it('refuses a manifest with no userId, naming the fix', async () => {
    const token = 'tok'
    await expect(
      mintSessions({
        ...base,
        users: [{ email: 'old@load.local', organizationId: 'o1', sprintId: 's1' }],
        secret: SECRET,
        cookie: shapeFor(token, await makeSignature(token, SECRET)),
      }),
    ).rejects.toThrow(/reseed with/)
  })

  it('every refusal is a LoadAuthError, so the runner reports rather than crashes', async () => {
    await expect(
      mintSessions({ ...base, secret: '', cookie: shapeFor('t', 'sig') }),
    ).rejects.toBeInstanceOf(LoadAuthError)
  })
})

describe('mintSessions against a real database', () => {
  let databaseUrl: string
  let sql: Sql
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('load_mint_sessions')
    databaseUrl = disposable.databaseUrl
    drop = disposable.drop
    sql = postgres(databaseUrl, { max: 2, prepare: false, idle_timeout: 5 })

    await sql`insert into organizations (id, name, slug) values ('o1', 'Load Org', 'load-org')`
    await sql`
      insert into auth_users (id, name, email, email_verified)
      values ('u1', 'Load One', 'u1@load.local', true), ('u2', 'Load Two', 'u2@load.local', true)
    `
  }, 60_000)

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await drop?.()
  })

  it('writes one row per user, with the active organization set', async () => {
    const token = 'probe-token'
    const sessions = await mintSessions({
      databaseUrl,
      users: [
        { userId: 'u1', email: 'u1@load.local', organizationId: 'o1', sprintId: 's1' },
        { userId: 'u2', email: 'u2@load.local', organizationId: 'o1', sprintId: 's2' },
      ],
      secret: SECRET,
      cookie: shapeFor(token, await makeSignature(token, SECRET)),
      runId: 'r1',
    })

    expect(sessions).toHaveLength(2)
    // Distinct cookies, or a thousand virtual users would share one session and the run would measure
    // one session's cache behaviour while reporting a thousand.
    expect(new Set(sessions.map((session) => session.cookie)).size).toBe(2)

    const rows = await sql<{ user_id: string; token: string; active_organization_id: string | null }[]>`
      select user_id, token, active_organization_id from auth_sessions order by user_id
    `
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.user_id)).toEqual(['u1', 'u2'])
    // Without this the session authenticates as a user with no active organization, which every
    // tenant-scoped route correctly refuses — and which would read as an authorization bug.
    expect(rows.every((row) => row.active_organization_id === 'o1')).toBe(true)

    /** The row's token has to be the half of the cookie the server looks up. */
    for (const session of sessions) {
      const value = decodeURIComponent(session.cookie.split('=').slice(1).join('='))
      const [cookieToken, signature] = value.split('.')
      expect(rows.some((row) => row.token === cookieToken)).toBe(true)
      expect(signature).toBe(await makeSignature(cookieToken, SECRET))
    }
  })

  it('scopes its row ids on the run id, so cleanup removes them with everything else', async () => {
    const rows = await sql<{ id: string }[]>`select id from auth_sessions`
    expect(rows.every((row) => row.id.startsWith('ld_r1_ses'))).toBe(true)
  })
})
