/**
 * The three refusals that stand between a load run and somebody's production database (plan 55 phase 0).
 *
 * ## Why this is its own module
 *
 * `seed.ts` writes a thousand users and `cleanup.ts` deletes rows. Both are destructive, both take a
 * connection string from the environment, and both are run by hand on a laptop that has production
 * credentials in `.env` for other reasons. The guard is the interesting part of either script, so it lives
 * apart from them, is unit-tested against strings rather than against a live cluster, and cannot be
 * skipped by a caller that forgot to call it — `seed.ts` and `cleanup.ts` have no other way to obtain a URL.
 *
 * ## Why three checks and not one
 *
 * Each catches a different mistake, and any one alone leaves a real path open:
 *
 * - **the disposable-name prefix** catches pointing at the *right host* and the wrong database — the most
 *   likely error by far, because `DATABASE_URL` on a developer machine is the dev database;
 * - **the loopback rule** catches pointing at the right *name* on a remote host, which is how a staging
 *   cluster gets a thousand fixture users;
 * - **the production-marker scan** catches a URL that satisfies both by accident, and is the one that
 *   would otherwise depend on a human reading a hostname correctly at 02:00.
 *
 * A single "is this production?" predicate would have to be right about every future environment. These
 * three are each right about one thing.
 */

/** Every load fixture database must be named for what it is. */
export const DISPOSABLE_DATABASE_PREFIX = 'builderhunt_load_test'

/**
 * Substrings that mean "not this one", scanned across the whole URL rather than just the host.
 *
 * Credentials and database names carry these too — `postgres://builderhunt_prod:…@10.0.0.4/builderhunt`
 * is caught by the user, not the host. Deliberately broad: a false refusal costs somebody a minute and an
 * explicit `LOAD_DISPOSABLE_DATABASE=true`, while a false acceptance costs a customer's data.
 */
export const PRODUCTION_MARKERS = ['prod', 'production', 'live', 'coolify', 'hetzner'] as const

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

export class LoadSafetyError extends Error {
  constructor(message: string) {
    super(`refusing to run load fixtures: ${message}`)
    this.name = 'LoadSafetyError'
  }
}

export interface LoadTargetOptions {
  /**
   * Set `LOAD_DISPOSABLE_DATABASE=true` to allow a non-loopback host.
   *
   * The escape hatch exists because the certification host is by definition remote. It relaxes **only**
   * the loopback rule: the name prefix and the production markers still apply, so the flag cannot be used
   * to point a run at production by adding one environment variable.
   */
  allowRemote?: boolean
}

export interface LoadTarget {
  url: string
  databaseName: string
  host: string
}

/**
 * Parses and refuses. Returns the target only when all three checks pass.
 */
export function assertDisposableLoadTarget(rawUrl: string | undefined, options: LoadTargetOptions = {}): LoadTarget {
  if (!rawUrl) throw new LoadSafetyError('no database URL was provided')

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    // Never echo the URL in an error: it carries a password.
    throw new LoadSafetyError('the database URL could not be parsed')
  }

  const databaseName = parsed.pathname.replace(/^\//, '')
  if (!databaseName) throw new LoadSafetyError('the database URL names no database')

  // Checked first, because it is the one that fires on the likeliest mistake — the right host, the wrong
  // database — and its message can name the expected prefix without leaking anything.
  if (!databaseName.startsWith(DISPOSABLE_DATABASE_PREFIX)) {
    throw new LoadSafetyError(
      `database "${databaseName}" is not disposable; its name must start with "${DISPOSABLE_DATABASE_PREFIX}"`,
    )
  }

  /**
   * Scanned lowercased and across the whole URL, host *and* credentials.
   *
   * This runs even when `allowRemote` is set. The flag is for the certification host, not for production,
   * and a guard that one environment variable can fully disable is not a guard.
   */
  const haystack = rawUrl.toLowerCase()
  const marker = PRODUCTION_MARKERS.find((needle) => haystack.includes(needle))
  if (marker) {
    throw new LoadSafetyError(`the database URL contains "${marker}", which reads as a production target`)
  }

  const host = parsed.hostname
  if (!LOOPBACK_HOSTS.has(host) && !options.allowRemote) {
    throw new LoadSafetyError(
      `host "${host}" is not loopback; set LOAD_DISPOSABLE_DATABASE=true to allow a remote disposable database`,
    )
  }

  return { url: rawUrl, databaseName, host }
}

/** `true` only for the exact string. `LOAD_DISPOSABLE_DATABASE=1` or `yes` is not an authorization. */
export function remoteAllowedFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOAD_DISPOSABLE_DATABASE === 'true'
}

/**
 * The run id every fixture row carries, so cleanup can delete exactly what this run made.
 *
 * Cleanup is scoped by this and never by "everything in the table": a load database is disposable, but the
 * same script pointed at a shared disposable database — two operators, one host — must not remove the
 * other run's rows while it is still using them.
 */
export function loadRunId(now: Date, suffix: string): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  if (!/^[a-z0-9-]{1,16}$/.test(suffix)) {
    throw new LoadSafetyError(`run-id suffix "${suffix}" must be 1-16 chars of [a-z0-9-]`)
  }
  return `load-${stamp}-${suffix}`
}
