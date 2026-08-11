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

import { LOAD_FIXTURE_PASSWORD } from './seed'

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
      body: JSON.stringify({ email: options.email, password: options.password ?? LOAD_FIXTURE_PASSWORD }),
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
