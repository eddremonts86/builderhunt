/**
 * Signing a thousand fixture users in, without the sign-in becoming the thing under test (plan 55 phase 0).
 *
 * ## Why startup concurrency is bounded
 *
 * A thousand simultaneous `POST /api/auth/sign-in/email` calls is a load test of scrypt, not of the read
 * paths the run exists to measure. Better Auth hashes on every sign-in and the hash is deliberately
 * expensive, so an unbounded startup saturates every core on the host and the first minute of the run
 * reports latencies that describe a CPU-starved machine.
 *
 * Worse, it would be *reported* as capacity. The run's numbers would be real and the conclusion drawn from
 * them would be wrong.
 *
 * ## The rate limiter is a wall, and it is named
 *
 * `better-auth.ts` caps `/sign-in/email` at 20 per minute per IP. Every virtual user comes from one host, so
 * a full thousand-user startup hits that wall by design and every subsequent sign-in returns `429`. That is
 * the application behaving correctly, so this module does not work around it — it raises
 * `LoadAuthRateLimitedError`, and the runner turns that into an `aborted` report naming the limit. An
 * `aborted` verdict says "this run proved nothing"; a `fail` verdict would say "the system cannot do this",
 * which would be a false statement about the product.
 *
 * A run larger than the limiter allows needs the limit raised on the disposable load host by whoever owns
 * it. That is an operator decision about a throwaway environment, not something a script should quietly
 * take.
 */

import type { Sql } from 'postgres'
import { generateRandomString, makeSignature } from 'better-auth/crypto'

import { insertBatched, LOOPBACK_FIXTURE_PASSWORD } from './seed'

/**
 * The password the runner signs in with.
 *
 * Mirrors `fixturePasswordFor` in `seed.ts` but keyed on the *base URL*, because the runner never holds a
 * database target — it drives HTTP. Same rule: the published constant only for a loopback app, an explicit
 * `LOAD_FIXTURE_PASSWORD` for anything reachable. A mismatch between the two fails at sign-in rather than
 * silently, which is the right direction.
 */
export function runnerFixturePassword(baseUrl: string): string {
  const supplied = process.env.LOAD_FIXTURE_PASSWORD
  if (supplied) return supplied
  const host = new URL(baseUrl).hostname
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
    return LOOPBACK_FIXTURE_PASSWORD
  }
  throw new LoadAuthError(
    `LOAD_FIXTURE_PASSWORD is required to sign in against ${host} — the default is published in this ` +
      'repository and must never reach a host somebody else can call',
  )
}

/** A signed-in fixture user. The cookie is opaque here and never logged — see `describeSession`. */
export interface LoadSession {
  email: string
  organizationId: string
  sprintId: string
  /** The `Cookie` header value to replay. Held in memory only. */
  cookie: string
}

export class LoadAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoadAuthError'
  }
}

/**
 * The counts are optional because the single-user path does not know them.
 *
 * The first version had `signInFixtureUser` throw this with `(0, 1)` so the fields could be non-optional,
 * which meant any caller that printed the message — the preflight, for one — would have reported "rate
 * limited after 0 of 1 users" about a thousand-user startup. A number that is present and wrong is worse
 * than one that is absent.
 */
export class LoadAuthRateLimitedError extends LoadAuthError {
  constructor(
    readonly signedIn?: number,
    readonly attempted?: number,
  ) {
    super(
      (signedIn === undefined || attempted === undefined
        ? 'sign-in was rate limited. '
        : `sign-in was rate limited after ${signedIn} of ${attempted} users. `) +
        'better-auth.ts caps /sign-in/email at 20/min per IP; raise it on the disposable load host to run at this size',
    )
    this.name = 'LoadAuthRateLimitedError'
  }
}

/**
 * What may be printed about a session.
 *
 * The cookie is a live credential for a real account, and a load run's output is a file somebody attaches
 * to a ticket. Nothing anywhere else in this module returns the cookie for display.
 */
export function describeSession(session: LoadSession): string {
  return `${session.email} → ${session.organizationId}`
}

/**
 * Collects the cookies Better Auth sets, dropping attributes.
 *
 * `set-cookie` carries `Path`, `HttpOnly`, `SameSite` and friends after the value; replaying those in a
 * `Cookie` request header makes the header invalid and the session silently anonymous — which then reads as
 * an authorization bug in the route rather than a bug here.
 */
export function cookieHeaderFrom(response: Response): string {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const pairs: string[] = []
  for (const entry of raw) {
    if (!entry) continue
    const pair = entry.split(';', 1)[0]?.trim()
    if (pair && pair.includes('=')) pairs.push(pair)
  }
  return pairs.join('; ')
}

export interface SignInOptions {
  baseUrl: string
  email: string
  password?: string
  timeoutMs: number
}

export async function signInFixtureUser(options: SignInOptions): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(new URL('/api/auth/sign-in/email', options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A browser sends `Origin` on every state-changing request, and Better Auth validates it. Omitting
        // it makes the runner's traffic shape differ from the product's on the one request that decides
        // whether the other 400,000 are authenticated at all.
        origin: new URL(options.baseUrl).origin,
      },
      body: JSON.stringify({
        email: options.email,
        password: options.password ?? runnerFixturePassword(options.baseUrl),
      }),
      signal: controller.signal,
      redirect: 'manual',
    })
    if (response.status === 429) throw new LoadAuthRateLimitedError()
    if (!response.ok) {
      /**
       * The status and Better Auth's own `code`, and nothing else.
       *
       * The full body is not safe to print — it can echo the submitted email, and on some paths more. The
       * `code` field is a short machine token (`INVALID_EMAIL_OR_PASSWORD`, `FORBIDDEN`, …), and it is the
       * difference between "sign-in returned 403" and knowing whether the credentials, the origin check or
       * the device gate refused. A bare status sent me looking in the wrong place for twenty minutes.
       */
      const code = await response
        .json()
        .then((body: unknown) =>
          typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
            ? (body as { code: string }).code
            : null,
        )
        .catch(() => null)
      throw new LoadAuthError(`sign-in returned ${response.status}${code ? ` (${code})` : ''}`)
    }
    const cookie = cookieHeaderFrom(response)
    if (!cookie) throw new LoadAuthError('sign-in succeeded but set no cookie')
    return cookie
  } catch (error) {
    if (error instanceof LoadAuthError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LoadAuthError(`sign-in exceeded ${options.timeoutMs} ms`)
    }
    throw new LoadAuthError(error instanceof Error ? error.message : 'sign-in failed')
  } finally {
    clearTimeout(timer)
  }
}

export interface FixtureUserRef {
  email: string
  organizationId: string
  sprintId: string
}

export interface SignInAllOptions {
  baseUrl: string
  users: readonly FixtureUserRef[]
  /** Simultaneous sign-in requests. Small on purpose — see the module comment. */
  concurrency: number
  timeoutMs: number
  onProgress?: (signedIn: number, total: number) => void
}

/**
 * Signs every fixture user in, `concurrency` at a time, and stops at the first rate limit.
 *
 * Stopping matters: continuing past a `429` would produce a run with an arbitrary subset of users, a
 * correspondingly reduced offered rate, and a report whose throughput check fails for a reason that has
 * nothing to do with the database.
 */
export async function signInAll(options: SignInAllOptions): Promise<LoadSession[]> {
  const sessions: LoadSession[] = []
  const queue = [...options.users]
  let rateLimited = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (rateLimited) return
      const user = queue.shift()
      if (!user) return
      try {
        const cookie = await signInFixtureUser({
          baseUrl: options.baseUrl,
          email: user.email,
          timeoutMs: options.timeoutMs,
        })
        sessions.push({ ...user, cookie })
        options.onProgress?.(sessions.length, options.users.length)
      } catch (error) {
        if (error instanceof LoadAuthRateLimitedError) {
          rateLimited = true
          return
        }
        throw error
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()))
  if (rateLimited) throw new LoadAuthRateLimitedError(sessions.length, options.users.length)
  return sessions
}

/**
 * Minting sessions in the database instead of signing a thousand users in (plan 55 phase 2).
 *
 * `signInAll` above is honest about its own ceiling: `/sign-in/email` is capped at 20 per minute per IP,
 * so a thousand-user startup is refused by the product working correctly, and the run aborts having proved
 * nothing. Raising that cap on the load host was the other way out, and it trades a real abuse control for
 * a test convenience on a box that also has to look like production.
 *
 * So the sessions are written straight to `auth_sessions`, and the cookie is assembled with better-auth's
 * *own* primitives — `generateRandomString` for the token, `makeSignature` for the signature. Using the
 * library's helpers rather than reimplementing HMAC-SHA256 is the point: the format cannot drift from what
 * better-auth verifies, because it is the same code.
 *
 * ## One real sign-in first, and why it is not optional
 *
 * The cookie *name* is better-auth's default (`better-auth.session_token`) only because no `cookiePrefix`
 * or `useSecureCookies` is configured — both would move it, and so would an upgrade. Hardcoding it would
 * survive every unit test and then make all four hundred thousand requests anonymous, which surfaces as
 * every route answering 401 and reads like an authorization bug in the app.
 *
 * `mintSessions` therefore performs exactly one real sign-in, reads the name off its `set-cookie`, and
 * re-signs that same session's token to check the signature it produces matches better-auth's byte for
 * byte. One request is far under the 20/min limit, and it turns "I reproduced the format correctly" from
 * an assumption into something every run re-proves.
 */
/** Same length better-auth uses for its own opaque tokens. */
const SESSION_TOKEN_LENGTH = 32

/** Long enough to outlive any run this harness performs, short enough to be junk by tomorrow. */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The cookie layout, learned from the running app rather than assumed.
 *
 * Its own type because it is its own decision: `resolveSessionCookieFormat` needs a server and
 * `mintSessions` needs a database, and folding them together made the thousand-session path
 * impossible to test without standing an app up — which is exactly the part that does not need one.
 */
export interface SessionCookieFormat {
  /** The cookie name better-auth actually set, e.g. `better-auth.session_token`. */
  name: string
  secret: string
}

export interface MintSessionsOptions {
  /** A connection to the *load fixture* database. Never production — `safety.ts` owns that judgement. */
  sql: Sql
  users: readonly FixtureUserRef[]
  format: SessionCookieFormat
  now?: Date
  sessionTtlMs?: number
}

/**
 * Splits a `name=value` cookie pair, tolerating `=` inside the value.
 *
 * The value is `${token}.${base64Signature}` and base64 padding is `=`, so splitting on every `=` truncates
 * the signature and produces a cookie that looks right and authenticates nobody.
 */
function splitCookiePair(pair: string): { name: string; value: string } | null {
  const at = pair.indexOf('=')
  if (at <= 0) return null
  return { name: pair.slice(0, at), value: pair.slice(at + 1) }
}

/**
 * Signs in once and returns the session cookie's name alongside the token and signature it carried.
 *
 * Exported for the unit test, which asserts the split survives a base64 signature ending in `=`.
 */
export function parseSessionCookie(cookieHeader: string): { name: string; token: string; signature: string } | null {
  for (const pair of cookieHeader.split(';')) {
    const split = splitCookiePair(pair.trim())
    if (!split) continue
    // The session cookie is the one whose value is `token.signature`; better-auth also sets a
    // `…session_data` cookie on some configurations, and picking the wrong one mints unusable cookies.
    if (!split.name.includes('session_token')) continue
    /**
     * Decoded, because better-call encodes inside the *signing* helper, not the serializer.
     *
     * `signCookieValue` in `better-call/dist/crypto.mjs` returns
     * `encodeURIComponent(`${value}.${signature}`)`, and `_serialize` then writes that verbatim. Reading
     * `_serialize` alone says the value is not encoded, which is true and misleading — base64 `+` and `=`
     * arrive as `%2B` and `%3D`, so a raw comparison against `makeSignature` never matches.
     *
     * Found by the byte-for-byte check in `resolveSessionCookieFormat` on its first real run, which is
     * precisely the assumption that check exists to refuse.
     */
    const decoded = decodeURIComponent(split.value)
    const dot = decoded.lastIndexOf('.')
    if (dot <= 0) continue
    return { name: split.name, token: decoded.slice(0, dot), signature: decoded.slice(dot + 1) }
  }
  return null
}

/**
 * Signs in once, and returns the cookie layout it observed — including proof we can reproduce it.
 *
 * The cookie *name* is better-auth's default only because no `cookiePrefix` or `useSecureCookies` is
 * configured; both would move it, and so would an upgrade. Hardcoding it would pass every unit test and
 * then make all four hundred thousand requests anonymous, which surfaces as every route answering 401 and
 * reads like an authorization bug in the app.
 *
 * So this re-signs the *same* token the server just issued and compares byte for byte. One request is far
 * under the 20/min limit, and it turns "I reproduced the format correctly" into something each run
 * re-proves.
 */
export async function resolveSessionCookieFormat(options: {
  baseUrl: string
  email: string
  timeoutMs: number
  secret: string | undefined
  /** Defaults to the load fixture password. Named explicitly by callers whose users are not fixtures. */
  password?: string
}): Promise<SessionCookieFormat> {
  const secret = options.secret
  if (!secret) {
    throw new LoadAuthError(
      'BETTER_AUTH_SECRET is required to mint sessions — without it every minted cookie would fail '
        + 'verification and the run would measure the signed-out application',
    )
  }
  const probeCookie = await signInFixtureUser({
    baseUrl: options.baseUrl,
    email: options.email,
    password: options.password,
    timeoutMs: options.timeoutMs,
  })
  const probe = parseSessionCookie(probeCookie)
  if (!probe) {
    throw new LoadAuthError(
      'sign-in set no cookie whose name contains "session_token" — better-auth\'s cookie layout has moved, '
        + 'and minting against the old one would make every request anonymous',
    )
  }
  if ((await makeSignature(probe.token, secret)) !== probe.signature) {
    throw new LoadAuthError(
      'the signature this harness produces no longer matches better-auth\'s for the same token, so every '
        + 'minted cookie would be rejected. Check BETTER_AUTH_SECRET matches the app, then better-auth\'s '
        + 'cookie signing',
    )
  }
  return { name: probe.name, secret }
}

/**
 * Writes one `auth_sessions` row per fixture user and returns replayable cookies.
 *
 * Takes the format rather than discovering it, so this half is provable against a disposable database with
 * no server in sight — see `tests/unit/scripts/load/auth-mint.test.ts`. The runner pairs it with
 * `resolveSessionCookieFormat`, and the e2e proves the two together against the real app.
 */
export async function mintSessions(options: MintSessionsOptions): Promise<LoadSession[]> {
  if (options.users.length === 0) return []
  const { name, secret } = options.format

  // `auth_sessions.user_id` is a real foreign key and the manifest carries only emails. Resolved in one
  // round trip rather than parsed out of the address, which happens to be `${userId}@load.local` today and
  // is not a contract.
  const emails = options.users.map((user) => user.email)
  const rows = await options.sql<{ id: string; email: string }[]>`
    select id, email from auth_users where email = any(${emails})
  `
  const idByEmail = new Map(rows.map((row) => [row.email, row.id]))
  const missing = emails.filter((email) => !idByEmail.has(email))
  if (missing.length > 0) {
    throw new LoadAuthError(
      `${missing.length} of ${emails.length} fixture users are not in auth_users (first: ${missing[0]}) — `
        + 'seed the fixtures against this database before minting',
    )
  }

  const now = options.now ?? new Date()
  const expiresAt = new Date(now.getTime() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS))
  const sessions: LoadSession[] = []
  const sessionRows: Record<string, unknown>[] = []

  for (const [index, user] of options.users.entries()) {
    const token = generateRandomString(SESSION_TOKEN_LENGTH)
    sessionRows.push({
      id: `load-sess-${now.getTime()}-${String(index).padStart(5, '0')}`,
      user_id: idByEmail.get(user.email)!,
      active_organization_id: user.organizationId,
      token,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    // Encoded on the way out for the same reason it is decoded on the way in — this is the exact string
    // better-call would have written.
    const signed = encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)
    sessions.push({ ...user, cookie: `${name}=${signed}` })
  }

  await insertBatched(options.sql, 'auth_sessions', sessionRows)
  return sessions
}
