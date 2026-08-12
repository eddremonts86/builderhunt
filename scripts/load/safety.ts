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
  /**
   * Overrides the `LOAD_TARGET_PRODUCTION` sentinel, for tests only.
   *
   * A caller cannot use this to sneak past the guard in anger: nothing in `seed.ts`, `cleanup.ts` or the
   * runner passes it, so in production the environment sentinel is the only way through.
   */
  allowProduction?: boolean
}

export interface LoadTarget {
  /** `true` when the caller deliberately authorized a production target. */
  production?: boolean
  url: string
  databaseName: string
  host: string
}

/**
 * Parses and refuses. Returns the target only when all three checks pass.
 */
/**
 * The one string that lets a run target production, and why it is a sentence.
 *
 * A load run against production seeds a thousand login-capable accounts into a live, internet-facing
 * database and later deletes rows from it. For this product that is an approved thing to do — there are no
 * real users during beta, and the production host is the only place the real Coolify private network and
 * the real pooler exist, so testing anywhere else measures a different system.
 *
 * What it must never be is *accidental*. `LOAD_DISPOSABLE_DATABASE=true` is one keystroke away from being
 * set in a shell that later runs something else; this is not. It has to be typed, it says what it does, and
 * it is required **together with** a `LOAD_FIXTURE_PASSWORD` — see `assertFixturePassword`, because the
 * repository's default fixture password is public and a thousand accounts carrying it on a public site is
 * an access problem rather than a data problem.
 */
export const PRODUCTION_TARGET_SENTINEL = 'i-am-seeding-and-deleting-rows-in-production'

/** Set to the sentinel above, and to nothing else, to allow a production target. */
export function productionTargetAuthorized(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOAD_TARGET_PRODUCTION === PRODUCTION_TARGET_SENTINEL
}

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

  /**
   * The production path, taken only when the sentinel is present.
   *
   * When it is, the name-prefix and production-marker checks are the two that have to yield — production's
   * database is not called `builderhunt_load_test_*` and its URL contains `coolify`. The loopback rule below
   * still applies and still needs its own flag, so a production run takes two deliberate variables and a
   * fixture password, not one.
   */
  const production = options.allowProduction ?? productionTargetAuthorized()

  // Checked first, because it is the one that fires on the likeliest mistake — the right host, the wrong
  // database — and its message can name the expected prefix without leaking anything.
  if (!production && !databaseName.startsWith(DISPOSABLE_DATABASE_PREFIX)) {
    throw new LoadSafetyError(
      `database "${databaseName}" is not disposable; its name must start with "${DISPOSABLE_DATABASE_PREFIX}". ` +
        `To target production deliberately, set LOAD_TARGET_PRODUCTION="${PRODUCTION_TARGET_SENTINEL}" ` +
        'and a LOAD_FIXTURE_PASSWORD.',
    )
  }

  /**
   * Scanned lowercased and across the whole URL, host *and* credentials.
   *
   * This runs even when `allowRemote` is set — that flag is for a remote *disposable* host, not for
   * production. Only the `LOAD_TARGET_PRODUCTION` sentinel yields here, and it takes a typed sentence plus a
   * `LOAD_FIXTURE_PASSWORD` to be usable, because a guard one variable can fully disable is not a guard.
   */
  const haystack = rawUrl.toLowerCase()
  const marker = PRODUCTION_MARKERS.find((needle) => haystack.includes(needle))
  if (marker && !production) {
    throw new LoadSafetyError(
      `the database URL contains "${marker}", which reads as a production target. If that is deliberate, ` +
        `set LOAD_TARGET_PRODUCTION="${PRODUCTION_TARGET_SENTINEL}".`,
    )
  }

  const host = parsed.hostname
  if (!LOOPBACK_HOSTS.has(host) && !options.allowRemote) {
    throw new LoadSafetyError(
      `host "${host}" is not loopback; set LOAD_DISPOSABLE_DATABASE=true to allow a remote disposable database`,
    )
  }

  return { url: rawUrl, databaseName, host, production }
}

/**
 * The fixture password, refused when it would be the public one on anything but loopback.
 *
 * `seed.ts` hashes one password for a thousand accounts, and the repository's default is a constant anybody
 * can read. On a loopback disposable database that is correct and deliberate — the accounts cannot be
 * reached. On a remote or production host those thousand accounts are live on the public internet with a
 * password published in git, and if a run aborts before cleanup they stay that way.
 *
 * So the default is loopback-only, and every other target must supply its own. This is the check that makes
 * the production path safe to have at all.
 */
export function assertFixturePassword(target: LoadTarget, publicDefault: string): string {
  const supplied = process.env.LOAD_FIXTURE_PASSWORD
  const loopback = LOOPBACK_HOSTS.has(target.host) && !target.production
  if (supplied && supplied.length >= 16) return supplied
  if (supplied) {
    throw new LoadSafetyError('LOAD_FIXTURE_PASSWORD must be at least 16 characters')
  }
  if (loopback) return publicDefault
  throw new LoadSafetyError(
    'LOAD_FIXTURE_PASSWORD is required for any target that is not a loopback disposable database. The ' +
      'default fixture password is published in this repository, and a thousand reachable accounts ' +
      'carrying it is an access problem. Generate one: openssl rand -hex 24',
  )
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
