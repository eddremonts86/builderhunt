/**
 * The virtual users, the clock, and the two ways a run can end (plan 55 phase 0).
 *
 * ## Why a fixed number of users and not a target rate
 *
 * A rate-driven generator hides the failure it exists to find. If the application slows down, an open-loop
 * generator keeps firing at the target rate, queues grow without bound, and the report shows a latency
 * collapse that describes the generator's queue rather than the system. A closed loop — a fixed user that
 * waits for its answer, thinks, and asks again — degrades the way real traffic does: the offered rate falls
 * when the system slows, and that fall is itself the signal. `expectedOfferedRate` is asserted against the
 * declared window so the closed loop still lands in the range the spec certifies.
 *
 * ## Why the preflight refuses rather than warns
 *
 * Every route in `LOAD_ROUTES` returns an empty result against an empty database, quickly. A run whose
 * fixtures did not apply would therefore produce the best numbers the system will ever show and a `pass`
 * verdict. The preflight asks for each route once, as a real signed-in user, and aborts unless every one
 * answers 2xx — before a single measurement is taken.
 *
 * ## Why an interrupted run is `aborted` and never `fail`
 *
 * Ctrl-C during the ramp leaves latencies that describe a system still filling its caches. Calling that a
 * threshold failure sends somebody looking for a slow query that does not exist. `aborted` carries exit code
 * 3 and no threshold evaluation at all; the report says so in its first line.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  DEFAULT_LOAD_CONFIG,
  jitterForUser,
  LOAD_EXIT_CODES,
  SMOKE_LOAD_CONFIG,
  validateLoadConfig,
  type LoadConfig,
  type LoadRoute,
} from './config'
import { LatencyHistogram } from './histogram'
import postgres from 'postgres'

import {
  LoadAuthRateLimitedError,
  mintSessions,
  resolveSessionCookieFormat,
  signInAll,
  type LoadSession,
} from './auth'
import { startMonitor } from './monitor'
import { buildLoadReport, renderLoadReportMarkdown, type ObservabilitySample, type RouteOutcome } from './report'
import type { LoadFixtureManifest } from './seed'

/** How many sign-ins run at once. Deliberately small — see `auth.ts`. */
const SIGN_IN_CONCURRENCY = 8

/**
 * What `better-auth.ts` caps `/sign-in/email` at, per IP per minute.
 *
 * Mirrored rather than imported because the runner never loads the app's modules — it drives HTTP.
 * If the cap moves there and not here, the worst case is minting when signing in would have worked.
 */
const SIGN_IN_RATE_LIMIT_PER_MINUTE = 20

/** The spec's drain window: in-flight requests get this long to answer before an aborted report is written. */
const DRAIN_MS = 30_000

interface RouteAccumulator {
  path: string
  ok: number
  serverErrors: number
  unexpected: number
  timeouts: number
  latency: LatencyHistogram
}

/**
 * Expands the weights into a hundred-slot lookup table, *interleaved* rather than blocked.
 *
 * The interleave is the whole point. A table built by pushing 45 copies of the first route, then 15 of the
 * second, gives the right proportions over a hundred iterations and the wrong traffic entirely over nine: the
 * first smoke run sent all nine of its requests to `/api/dashboard/overview` and reported four routes with no
 * samples. Any run shorter than the table therefore measured one route while claiming to measure a mix — and
 * the shorter the run, the more confidently wrong it was.
 *
 * Largest-remainder assignment fixes it exactly. Each slot goes to whichever route is furthest behind its
 * expected share, so the proportions are correct at *every* prefix of the table, not just at the end. A
 * weight of 45 lands roughly every second slot, and the counts over the full hundred are still 45/15/15/15/10.
 *
 * Picking a route is then an array index rather than a cumulative-sum scan per request, which matters at 444
 * requests a second, and the sequence stays deterministic and therefore comparable between two runs.
 */
export function weightedRouteTable(routes: readonly LoadRoute[]): LoadRoute[] {
  const total = routes.reduce((sum, route) => sum + route.weight, 0)
  const table: LoadRoute[] = []
  const credit = routes.map(() => 0)
  for (let slot = 0; slot < total; slot += 1) {
    for (const [index, route] of routes.entries()) credit[index] += route.weight
    let best = 0
    for (let index = 1; index < credit.length; index += 1) {
      if (credit[index] > credit[best]) best = index
    }
    table.push(routes[best])
    credit[best] -= total
  }
  return table
}

/**
 * The path a given user asks for on a given iteration.
 *
 * Offset by the user index so a thousand users do not march in lockstep through the same route — which would
 * turn a read-mix test into five sequential single-route tests, each hitting one warm index while the others
 * went cold.
 */
export function routeForIteration(table: readonly LoadRoute[], userIndex: number, iteration: number): LoadRoute {
  return table[(userIndex * 7 + iteration) % table.length]
}

/** `:sprintId` is the only template segment; a route that grows another must be handled here explicitly. */
export function resolvePath(path: string, session: LoadSession): string {
  return path.replace(':sprintId', encodeURIComponent(session.sprintId))
}

function currentCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export interface RunnerOptions {
  baseUrl: string
  manifestPath: string
  config: LoadConfig
  poolMode: 'direct' | 'transaction'
  monitorDatabaseUrl?: string
  /**
   * The fixture database, used only to mint sessions (plan 55 phase 2).
   *
   * Separate from `monitorDatabaseUrl`, which is a read-only observer: this one writes
   * `auth_sessions` rows. Absent means fall back to signing users in, which is correct for the
   * smoke profile and refused by the rate limiter for the thousand-user one.
   */
  fixtureDatabaseUrl?: string
  poolerAdminUrl?: string
  outputDirectory?: string
  log?: (message: string) => void
}

export interface RunnerResult {
  exitCode: number
  jsonPath: string
  markdownPath: string
  verdict: string
}

export async function runLoadTest(options: RunnerOptions): Promise<RunnerResult> {
  const config = validateLoadConfig(options.config)
  const log = options.log ?? ((message: string) => console.log(message))
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as LoadFixtureManifest
  const outputDirectory = options.outputDirectory ?? resolve(process.cwd(), 'tests/artifacts/load')

  if (manifest.users.length < config.users) {
    throw new Error(
      `the manifest holds ${manifest.users.length} users but the configuration wants ${config.users}; re-seed at that size`,
    )
  }
  const wanted = manifest.users.slice(0, config.users)

  const startedAt = new Date()
  let abortedReason: string | undefined
  /** Flipped by SIGINT/SIGTERM and by the end of the steady window. Virtual users read it every iteration. */
  let stopping = false

  const accumulators = new Map<string, RouteAccumulator>()
  for (const route of config.routes) {
    accumulators.set(route.path, {
      path: route.path,
      ok: 0,
      serverErrors: 0,
      unexpected: 0,
      timeouts: 0,
      latency: new LatencyHistogram(),
    })
  }

  let sessions: LoadSession[] = []
  try {
    /**
     * Minting above the rate limiter's ceiling, signing in below it.
     *
     * `/sign-in/email` is capped at 20/min per IP and every virtual user comes from one host, so any
     * profile larger than that aborts on a `429` — the product behaving correctly. Minting writes the
     * sessions straight to the fixture database instead, with better-auth's own signing primitives.
     *
     * Below the ceiling the real sign-in stays, because it exercises a path the run would otherwise
     * never touch, and it costs seconds at that size.
     */
    if (wanted.length > SIGN_IN_RATE_LIMIT_PER_MINUTE && options.fixtureDatabaseUrl) {
      log(`minting ${wanted.length} sessions (over the ${SIGN_IN_RATE_LIMIT_PER_MINUTE}/min sign-in limit)`)
      const sql = postgres(options.fixtureDatabaseUrl, { max: 4, prepare: false })
      try {
        const format = await resolveSessionCookieFormat({
          baseUrl: options.baseUrl,
          email: wanted[0]!.email,
          timeoutMs: config.requestTimeoutMs,
          secret: process.env.BETTER_AUTH_SECRET,
        })
        sessions = await mintSessions({ sql, users: wanted, format })
        log(`  ${sessions.length} minted`)
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined)
      }
    } else {
      log(`signing in ${wanted.length} users, ${SIGN_IN_CONCURRENCY} at a time`)
      sessions = await signInAll({
        baseUrl: options.baseUrl,
        users: wanted,
        concurrency: SIGN_IN_CONCURRENCY,
        timeoutMs: config.requestTimeoutMs,
        onProgress: (signedIn, total) => {
          if (signedIn % 100 === 0 || signedIn === total) log(`  ${signedIn}/${total}`)
        },
      })
    }
  } catch (error) {
    if (error instanceof LoadAuthRateLimitedError) abortedReason = error.message
    else throw error
  }

  const table = weightedRouteTable(config.routes)
  const monitor = options.monitorDatabaseUrl
    ? await startMonitor({
        databaseUrl: options.monitorDatabaseUrl,
        poolerAdminUrl: options.poolerAdminUrl,
      })
    : null

  if (!abortedReason) {
    /**
     * The preflight, through one real session.
     *
     * Sequential and unmeasured: it is not part of the run's numbers, and firing five routes concurrently
     * here would make a failure ambiguous between the route and the fixture.
     */
    const probe = sessions[0]
    for (const route of config.routes) {
      const path = resolvePath(route.path, probe)
      const response = await fetch(new URL(path, options.baseUrl), {
        headers: { cookie: probe.cookie, accept: 'application/json' },
      }).catch(() => null)
      if (!response || !response.ok) {
        abortedReason = `preflight failed on ${route.path}${response ? ` with ${response.status}` : ' (no response)'}`
        break
      }
    }
    if (!abortedReason) log(`preflight passed on all ${config.routes.length} routes`)
  }

  /**
   * Resolves only once a signal has fired and the drain window has elapsed.
   *
   * A plain `Promise.race([usersDone, sleep(DRAIN_MS)])` is what the first version did, and it applied the
   * drain ceiling to the *normal* ending too: every run longer than thirty seconds aborted itself thirty
   * seconds in. The ten-second smoke passed, so it looked correct — while the ten-minute baseline and the
   * two-hour certification, the runs this harness exists for, could never have completed. The deadline has
   * to start when the signal arrives, not when the run does.
   */
  let openDrainWindow: () => void = () => undefined
  const drainWindowClosed = new Promise<'timeout'>((resolveDrain) => {
    openDrainWindow = () => setTimeout(() => resolveDrain('timeout'), DRAIN_MS)
  })

  const onSignal = (signal: string): void => {
    if (stopping) return
    stopping = true
    abortedReason ??= `interrupted by ${signal}; draining for up to ${DRAIN_MS / 1000}s`
    log(`\n${abortedReason}`)
    openDrainWindow()
  }
  const onInt = (): void => onSignal('SIGINT')
  const onTerm = (): void => onSignal('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)

  try {
    if (!abortedReason) {
      const rampMs = config.stages.rampSeconds * 1_000
      const steadyMs = config.stages.steadySeconds * 1_000
      const endAt = Date.now() + rampMs + steadyMs
      log(`ramping ${config.stages.rampSeconds}s, then ${config.stages.steadySeconds}s steady`)

      const virtualUser = async (session: LoadSession, index: number): Promise<void> => {
        // Staggered start across the ramp, so a thousand users do not all arrive in the first millisecond.
        await sleep(Math.floor((rampMs * index) / Math.max(1, sessions.length)))
        for (let iteration = 0; !stopping && Date.now() < endAt; iteration += 1) {
          const route = routeForIteration(table, index, iteration)
          const accumulator = accumulators.get(route.path)
          if (!accumulator) continue
          const url = new URL(resolvePath(route.path, session), options.baseUrl)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
          const began = performance.now()
          try {
            const response = await fetch(url, {
              headers: { cookie: session.cookie, accept: 'application/json' },
              signal: controller.signal,
            })
            // Drained before the latency is recorded: without this the timing measures time-to-headers, and
            // a route that streams a slow body would look as fast as one that answers instantly.
            await response.arrayBuffer()
            const elapsed = performance.now() - began
            accumulator.latency.record(elapsed)
            if (response.ok) accumulator.ok += 1
            else if (response.status >= 500) accumulator.serverErrors += 1
            else accumulator.unexpected += 1
          } catch (error) {
            // A timeout has no latency to record — see `RouteOutcome.timeouts`.
            if (error instanceof Error && error.name === 'AbortError') accumulator.timeouts += 1
            else accumulator.unexpected += 1
          } finally {
            clearTimeout(timer)
          }
          await sleep(config.thinkTimeMs + jitterForUser(index, config.jitterMaxMs))
        }
      }

      /**
       * The drain, expressed as a race rather than as a sleep.
       *
       * Each virtual user checks `stopping` at the top of its loop, so after a signal they finish the
       * request they are on and return — bounded by `requestTimeoutMs` plus one think interval. Racing that
       * against `DRAIN_MS` gives the spec's thirty seconds as a *ceiling* on the wait, which is what a drain
       * is. The first version slept a flat two seconds and called it a thirty-second drain, which would have
       * cut in-flight requests off and counted them as timeouts in the report.
       */
      const usersDone = Promise.all(sessions.map((session, index) => virtualUser(session, index)))
      const drained = await Promise.race([usersDone.then(() => 'complete' as const), drainWindowClosed])
      if (drained === 'timeout') {
        abortedReason = `${abortedReason ?? 'stopped'}; the ${DRAIN_MS / 1000}s drain elapsed with requests still in flight`
      }
    }
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }

  const samples: ObservabilitySample[] = monitor ? monitor.samples : []
  await monitor?.stop()
  if (monitor && (monitor.failures.postgres > 0 || monitor.failures.pgbouncer > 0)) {
    log(`  monitoring failures: postgres=${monitor.failures.postgres} pgbouncer=${monitor.failures.pgbouncer}`)
  }
  /**
   * A run that observed nothing is aborted, not passed.
   *
   * Found the hard way: a syntax error in the activity query made every sample throw, and the report printed
   * `PostgreSQL connections: 0 peak ✅` — a threshold satisfied by the absence of data. The connection
   * ceiling is one of the two things the certification is actually about, so a run with no observations
   * behind it has not certified it, and saying `pass` would be a false statement rather than an optimistic
   * one. A partial failure is left alone: it is printed above, and the surviving samples are real.
   */
  if (monitor && samples.length > 0 && monitor.failures.postgres >= samples.length) {
    abortedReason ??= `every one of the ${samples.length} observability samples failed, so no connection or memory figure has data behind it`
  }
  if (!monitor) {
    // Named rather than silent: without samples the connection-ceiling check has nothing to fail on, so a
    // run without monitoring must not read as a run that proved its headroom.
    log('  no monitoring: connection and RSS checks have no observations behind them')
  }

  const routes: RouteOutcome[] = [...accumulators.values()].map((accumulator) => ({
    path: accumulator.path,
    ok: accumulator.ok,
    serverErrors: accumulator.serverErrors,
    unexpected: accumulator.unexpected,
    timeouts: accumulator.timeouts,
    latency: accumulator.latency.summary(),
  }))

  const report = buildLoadReport({
    runId: manifest.runId,
    poolMode: options.poolMode,
    commit: currentCommit(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    config,
    routes,
    samples,
    abortedReason,
  })

  await mkdir(outputDirectory, { recursive: true })
  const jsonPath = resolve(outputDirectory, `${manifest.runId}-${options.poolMode}.json`)
  const markdownPath = resolve(outputDirectory, `${manifest.runId}-${options.poolMode}.md`)
  await mkdir(dirname(jsonPath), { recursive: true })
  // `buildLoadReport` already ran `assertNoSecrets`, so anything reaching a file has been through it.
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, renderLoadReportMarkdown(report), 'utf8')

  log(`\n${report.verdict.toUpperCase()} — exit ${report.exitCode}`)
  log(`  ${jsonPath}`)
  log(`  ${markdownPath}`)
  return { exitCode: report.exitCode, jsonPath, markdownPath, verdict: report.verdict }
}

/**
 * `--smoke` or the thousand-user profile.
 *
 * `--baseline` and the default resolve to the same configuration on purpose: the difference between a
 * baseline and a certification is the topology and the duration an operator passes, not a different set of
 * thresholds. Giving `--baseline` its own branch that returned the same object would imply otherwise.
 */
function configFromArgv(argv: readonly string[]): LoadConfig {
  return argv.includes('--smoke') ? SMOKE_LOAD_CONFIG : DEFAULT_LOAD_CONFIG
}

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  return argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const base = configFromArgv(argv)
  const users = flag(argv, 'users')
  const seconds = flag(argv, 'seconds')
  const config: LoadConfig = {
    ...base,
    users: users ? Number(users) : base.users,
    stages: seconds
      ? { rampSeconds: Math.min(base.stages.rampSeconds, 2), steadySeconds: Number(seconds) }
      : base.stages,
    // An explicit `--users`/`--seconds` makes the offered-rate window meaningless: it is derived from the
    // thousand-user profile. Widened rather than dropped, so the check still appears and still reports.
    thresholds: users || seconds
      ? { ...base.thresholds, offeredRatePerSecond: { min: 0, max: Number.POSITIVE_INFINITY } }
      : base.thresholds,
  }

  const manifestFile = flag(argv, 'manifest') ?? process.env.LOAD_MANIFEST
  if (!manifestFile) {
    console.error('load runner: --manifest=<path> or LOAD_MANIFEST is required (produced by pnpm load:seed)')
    process.exit(1)
  }

  runLoadTest({
    baseUrl: flag(argv, 'base-url') ?? process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000',
    manifestPath: manifestFile,
    config,
    poolMode: argv.includes('--pooled') ? 'transaction' : 'direct',
    monitorDatabaseUrl: process.env.LOAD_MONITOR_DATABASE_URL,
    poolerAdminUrl: process.env.LOAD_PGBOUNCER_ADMIN_URL,
  })
    .then((result) => process.exit(result.exitCode))
    .catch((error: unknown) => {
      console.error(`load run failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exit(LOAD_EXIT_CODES.aborted)
    })
}
