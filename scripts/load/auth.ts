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
 * ## So a 1,000-user run does not sign in at all — it mints (added 2026-08-14)
 *
 * Both escapes the plan considered turned out not to exist. Pacing: `signInAll` has no rate parameter,
 * and the ramp it might have used runs *after* sign-in, not during it. Raising the cap: it is a literal
 * in `better-auth.ts`, so that is a code change and a redeploy of the app whose capacity is being
 * measured — and on a public site it removes a real brute-force guard for the length of the window.
 *
 * `mintSessions` writes the `auth_sessions` rows directly and builds the cookies with `better-auth`'s own
 * `makeSignature`, so a thousand sessions cost one batched insert instead of ~53 minutes of paced traffic,
 * and no protection is touched. `signInAll` stays: the smoke profile is small enough to sign in honestly,
 * and one real sign-in is what teaches `mintSessions` the cookie name and proves its signing.
 *
 * The trade-off is that a minted run does not exercise `/sign-in/email`. `spec.md` already says rate
 * limiting is not part of the capacity fix and sign-in is startup rather than the measured workload — but
 * it is a decision, and the certification report has to state it.
 */

import postgres from 'postgres'
import { generateRandomString, makeSignature } from 'better-auth/crypto'
import { LOOPBACK_FIXTURE_PASSWORD } from './seed'

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
  /**
   * Present on manifests seeded from 2026-08-14. `mintSessions` needs it for `auth_sessions.user_id`,
   * and it is carried explicitly rather than parsed back out of `email` — the seed happens to write
   * `${userId}@load.local`, and a run that silently depended on that shape would break the day the
   * fixture's email format changed for an unrelated reason.
   */
  userId?: string
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
 * What one real sign-in teaches us, so nothing below is hardcoded.
 *
 * Nothing in `better-auth.ts` configures `cookiePrefix` or `useSecureCookies`, so the cookie's name is
 * the library's default and a dependency upgrade could move it. Reading it from a live response costs
 * one request — far under the 20-per-minute limiter — and it is also the only way to prove that the
 * signature this module produces is the one the server verifies. Without that proof a format drift
 * would surface as every route answering 401 on a run that already cost two hours.
 */
export interface SessionCookieShape {
  /** e.g. `better-auth.session_token`. Never assumed. */
  name: string
  /** The `auth_sessions.token` half of the cookie, before the dot. */
  token: string
  /** The signature half, as the server produced it. */
  signature: string
}

const SESSION_COOKIE_MARKER = 'session_token'

/** Splits `name=value` pairs out of the `Cookie` header shape `cookieHeaderFrom` returns. */
function findSessionCookie(cookieHeader: string): { name: string; value: string } {
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    const name = pair.slice(0, index).trim()
    if (name.includes(SESSION_COOKIE_MARKER)) return { name, value: pair.slice(index + 1).trim() }
  }
  throw new LoadAuthError(
    `sign-in set no cookie whose name contains "${SESSION_COOKIE_MARKER}" — better-auth's cookie naming has changed`,
  )
}

/**
 * Signs one fixture user in and reports the session cookie's shape.
 *
 * The value is percent-encoded on the wire because the signature is standard base64 and carries `+`, `/`
 * and `=`; `tests/e2e/auth-and-sessions.spec.ts` decodes it the same way before matching
 * `auth_sessions.token`.
 */
export async function probeSessionCookie(options: SignInOptions): Promise<SessionCookieShape> {
  const cookieHeader = await signInFixtureUser(options)
  const { name, value } = findSessionCookie(cookieHeader)
  const decoded = decodeURIComponent(value)
  const dot = decoded.indexOf('.')
  if (dot <= 0 || dot === decoded.length - 1) {
    throw new LoadAuthError('the session cookie is not `token.signature` — better-auth\'s cookie format has changed')
  }
  return { name, token: decoded.slice(0, dot), signature: decoded.slice(dot + 1) }
}

export interface MintSessionsOptions {
  /** The load database `pnpm load:seed` wrote to. Never the application's own. */
  databaseUrl: string
  users: readonly FixtureUserRef[]
  /** The app's `BETTER_AUTH_SECRET`. Without it a minted cookie cannot be signed, so this refuses. */
  secret: string
  /** From `probeSessionCookie`. Passing a guess here is the one way to make this silently wrong. */
  cookie: SessionCookieShape
  /** Scopes the inserted rows so `cleanup.ts` removes them with everything else. */
  runId: string
  /** Session lifetime. Only has to outlast the run. */
  ttlMs?: number
  onProgress?: (minted: number, total: number) => void
}

const MINT_BATCH = 500
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Builds a cookie header for a token the way better-auth does: `name=urlencode(token.signature)`.
 *
 * Exported for the test that checks this against a real sign-in rather than against itself.
 */
export async function signSessionCookie(name: string, token: string, secret: string): Promise<string> {
  const signature = await makeSignature(token, secret)
  return `${name}=${encodeURIComponent(`${token}.${signature}`)}`
}

/**
 * Writes one `auth_sessions` row per fixture user and returns the cookies that authenticate as them.
 *
 * `active_organization_id` is set from the fixture rather than left null: it is what every tenant-scoped
 * route reads, and a minted session without it authenticates as a user with no active organization —
 * which the routes correctly refuse, and which would read as an authorization bug rather than as this
 * function forgetting a column.
 */
export async function mintSessions(options: MintSessionsOptions): Promise<LoadSession[]> {
  if (!options.secret) {
    throw new LoadAuthError('mintSessions needs BETTER_AUTH_SECRET — refusing rather than minting cookies the app cannot verify')
  }

  // Prove the signing before writing anything. `probeSessionCookie` handed us a token the server itself
  // signed; if our signature over that same token differs, every row we are about to write is useless.
  const ours = await makeSignature(options.cookie.token, options.secret)
  if (ours !== options.cookie.signature) {
    throw new LoadAuthError(
      'the signature this harness produces does not match the one the server produced for the same token — ' +
        'BETTER_AUTH_SECRET differs from the running app, or better-auth changed how it signs cookies',
    )
  }

  const missing = options.users.find((user) => !user.userId)
  if (missing) {
    throw new LoadAuthError(
      `fixture user ${missing.email} carries no userId — reseed with \`pnpm load:seed\`; manifests written before 2026-08-14 predate the field`,
    )
  }

  const sql = postgres(options.databaseUrl, { max: 4, prepare: false, idle_timeout: 20 })
  try {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_SESSION_TTL_MS))
    const sessions: LoadSession[] = []
    const rows: Record<string, unknown>[] = []

    for (const [index, user] of options.users.entries()) {
      const token = generateRandomString(32)
      rows.push({
        id: `ld_${options.runId}_ses${String(index).padStart(4, '0')}`,
        user_id: user.userId,
        token,
        expires_at: expiresAt,
        active_organization_id: user.organizationId,
        created_at: now,
        updated_at: now,
      })
      sessions.push({
        email: user.email,
        organizationId: user.organizationId,
        sprintId: user.sprintId,
        cookie: await signSessionCookie(options.cookie.name, token, options.secret),
      })
    }

    for (let offset = 0; offset < rows.length; offset += MINT_BATCH) {
      const batch = rows.slice(offset, offset + MINT_BATCH)
      await sql`insert into auth_sessions ${sql(batch)}`
      options.onProgress?.(Math.min(offset + batch.length, rows.length), rows.length)
    }

    return sessions
  } finally {
    await sql.end({ timeout: 5 })
  }
}
