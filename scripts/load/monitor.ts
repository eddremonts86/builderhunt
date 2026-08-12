/**
 * Samples the things a latency number cannot tell you (plan 55 phase 0).
 *
 * ## Why sampling at all, when the report already has percentiles
 *
 * A run can pass every latency threshold while sitting one connection below the pool ceiling, and the report
 * would call it a success. The next release adds one query and the same load falls over. Latency says how it
 * felt; these samples say how much headroom was left, which is the part a capacity decision needs.
 *
 * ## Why a sample can be partly null
 *
 * `pgBouncerBackends` is `null` when there is no pooler in the path, and that is different from `0`. A direct
 * baseline has no PgBouncer numbers at all, so `report.ts` skips the pooled checks entirely for it — while a
 * pooled run reporting zero backends would be a finding. A sampler that defaulted to `0` would make the two
 * indistinguishable and quietly turn a broken pooler into a passing run.
 *
 * ## Why a failed sample is recorded and not thrown
 *
 * A monitor that dies takes the run's evidence with it, and the run is the expensive part — two hours in the
 * certification case. A failed query increments a counter that the report prints, so a run whose sampling was
 * unreliable says so rather than looking like a run with fewer data points.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres, { type Sql } from 'postgres'
import type { ObservabilitySample } from './report'
import {
  readPgBouncerConfig,
  readPgBouncerPools,
  readPgBouncerStats,
  readPostgresActivity,
  type PgBouncerConfigFacts,
} from './sql'

const run = promisify(execFile)

/** Every five seconds, per the spec. A 2-hour run is 1,440 samples — small, and constant per run. */
export const SAMPLE_INTERVAL_MS = 5_000

export interface MonitorOptions {
  /** Direct connection to the database under test. Never the pooler — see `poolerAdminUrl`. */
  databaseUrl: string
  /**
   * PgBouncer's admin console (`database=pgbouncer`), or undefined for a direct run.
   *
   * Separate credentials on purpose: the admin console is a different authorization surface from the
   * application's, and the monitor should not be able to read application rows through the pooler it is
   * measuring.
   */
  poolerAdminUrl?: string
  intervalMs?: number
  /**
   * The application container, when there is one.
   *
   * Absent for a run against a locally started server, which is why every container field in a sample is
   * optional: the spec asks for CPU, RSS, restart count and open file descriptors, and a monitor outside
   * compose genuinely cannot see them. Reporting zeros would be worse than reporting nothing.
   */
  containerName?: string
  onError?: (kind: 'postgres' | 'pgbouncer' | 'container') => void
}

export interface MonitorRun {
  samples: ObservabilitySample[]
  /** Samples where a query failed. Printed by the report so unreliable sampling is visible. */
  failures: { postgres: number; pgbouncer: number; container: number }
  poolerConfig: PgBouncerConfigFacts | null
  stop: () => Promise<void>
}


export interface ContainerStats {
  cpuPercent: number
  rssBytes: number
  restarts: number
  openFileDescriptors: number
}

/**
 * Parses a `docker stats` memory figure — `412.3MiB`, `1.2GiB`, `980KiB`.
 *
 * Docker's units are binary despite the decimal-looking suffix, so `MiB` is 1024², and reading it as 10⁶
 * would understate RSS by 5% — which is inside the spec's 10% leak threshold and would therefore turn a real
 * leak into a passing run.
 */
export function parseDockerBytes(value: string): number | null {
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2].toUpperCase()
  const scale: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  }
  const factor = scale[unit]
  return factor === undefined ? null : Math.round(amount * factor)
}

/**
 * CPU, RSS, restart count and open file descriptors for one container.
 *
 * Three separate readings because Docker exposes them in three places: `stats` for the live gauges, `inspect`
 * for the restart counter, and the container's own `/proc/1/fd` for descriptors. Returning `null` on any
 * failure — rather than a partial object — keeps a half-read sample from looking like a complete one.
 *
 * `--no-stream` matters: without it `docker stats` streams forever and the sampler never returns.
 */
export async function readContainerStats(containerName: string): Promise<ContainerStats | null> {
  try {
    const [stats, inspect, fds] = await Promise.all([
      run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', containerName]),
      run('docker', ['inspect', '--format', '{{.RestartCount}}', containerName]),
      // `ls` in the container rather than `lsof` on the host: the host's view is the host's descriptors.
      run('docker', ['exec', containerName, 'sh', '-c', 'ls /proc/1/fd | wc -l']),
    ])
    const [cpuRaw, memRaw] = stats.stdout.trim().split('|')
    const cpuPercent = Number((cpuRaw ?? '').replace('%', ''))
    // `412.3MiB / 8GiB` — the reading is the first half.
    const rssBytes = parseDockerBytes((memRaw ?? '').split('/')[0] ?? '')
    const restarts = Number(inspect.stdout.trim())
    const openFileDescriptors = Number(fds.stdout.trim())
    if (!Number.isFinite(cpuPercent) || rssBytes === null) return null
    return {
      cpuPercent,
      rssBytes,
      restarts: Number.isFinite(restarts) ? restarts : 0,
      openFileDescriptors: Number.isFinite(openFileDescriptors) ? openFileDescriptors : 0,
    }
  } catch {
    // No docker, no such container, or no shell in the image. All three mean "not observable", which the
    // caller records as a container-sampling failure rather than as a zero.
    return null
  }
}

/**
 * Starts sampling and returns a handle.
 *
 * `samples` is the same array that grows as the run proceeds, deliberately: the runner passes it straight to
 * `buildLoadReport` after `stop()`, and copying it would leave two versions of the truth.
 */
export async function startMonitor(options: MonitorOptions): Promise<MonitorRun> {
  const interval = options.intervalMs ?? SAMPLE_INTERVAL_MS
  const samples: ObservabilitySample[] = []
  const failures = { postgres: 0, pgbouncer: 0, container: 0 }

  const db: Sql = postgres(options.databaseUrl, { max: 1, prepare: false, idle_timeout: 0 })
  /**
   * The admin console does not implement the extended query protocol, and `prepare: false` is not what
   * arranges that.
   *
   * `prepare: false` turns off prepared-statement *caching*. The protocol is chosen per query, and
   * `sql.unsafe(text)` with no bind parameters already picks the simple one — so `SHOW POOLS` and
   * `SHOW STATS` were never the problem. What was: `fetch_types` defaults to true, so on connect
   * postgres.js asks the server for array type OIDs, with the extended protocol, before any of this
   * code runs a query. PgBouncer answers `extended query protocol not supported by admin console`.
   *
   * It surfaced as an **uncaught** rejection — `triggerUncaughtException(err, fromPromise)` out of the
   * socket's read handler — which is why every `try`/`catch` and `.catch(() => null)` below missed it: the
   * error belongs to a query this module never issued, so there was no pending promise to reject. The run
   * died four seconds into the pooled leg, after the fifteenth sign-in, with the load never starting.
   *
   * postgres.js sets the same flag for the same class of reason in its own `subscribe.js`; a replication
   * connection cannot run arbitrary queries either.
   *
   * Never reached CI before 2026-08-12, because the job died at the direct leg on an owner-role
   * `DATABASE_URL` and never got here.
   */
  const pooler: Sql | null = options.poolerAdminUrl
    ? postgres(options.poolerAdminUrl, { max: 1, prepare: false, fetch_types: false, idle_timeout: 0 })
    : null

  let poolerConfig: PgBouncerConfigFacts | null = null
  if (pooler) {
    // Read once, before the load starts: it is configuration, not a time series, and reading it every five
    // seconds would add a query to the pooler being measured for no information.
    poolerConfig = await readPgBouncerConfig(pooler).catch(() => null)
  }

  const sampleOnce = async (): Promise<void> => {
    let connections = 0
    let active: number | null = null
    let idleInTransaction: number | null = null
    let waiting: number | null = null
    let tooManyConnections: number | null = null
    try {
      const activity = await readPostgresActivity(db)
      connections = activity.connections
      active = activity.active
      idleInTransaction = activity.idleInTransaction
      waiting = activity.waiting
      tooManyConnections = 0
    } catch (error) {
      failures.postgres += 1
      options.onError?.('postgres')
      /**
       * `53300 too_many_connections` is counted here, from the monitor's own refusal.
       *
       * It is the one place the condition is observable without reading the server log: when PostgreSQL is
       * at `max_connections`, the monitor's connection is refused too, and that refusal is the signal. It is
       * also exactly the moment a monitor is most likely to go quiet, so counting it rather than only
       * failing keeps the reason in the report.
       */
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '53300') {
        tooManyConnections = 1
      }
      // Recorded anyway, so the sample count matches elapsed time and a gap is visible as a failure count
      // rather than as a shorter run.
    }

    let backends: number | null = null
    let clientsWaiting: number | null = null
    let maxWaitMs: number | null = null
    let totalQueryCount: number | null = null
    let avgQueryTimeUs: number | null = null
    if (pooler) {
      try {
        const pools = await readPgBouncerPools(pooler)
        backends = pools.backends
        clientsWaiting = pools.clientsWaiting
        maxWaitMs = pools.maxWaitMs
        const stats = await readPgBouncerStats(pooler)
        totalQueryCount = stats.totalQueryCount
        avgQueryTimeUs = stats.avgQueryTimeUs
      } catch {
        failures.pgbouncer += 1
        options.onError?.('pgbouncer')
      }
    }

    const container = options.containerName ? await readContainerStats(options.containerName) : null
    if (options.containerName && !container) {
      failures.container += 1
      options.onError?.('container')
    }

    samples.push({
      postgresConnections: connections,
      postgresActive: active,
      postgresIdleInTransaction: idleInTransaction,
      postgresWaiting: waiting,
      tooManyConnections,
      pgBouncerBackends: backends,
      pgBouncerClientsWaiting: clientsWaiting,
      pgBouncerMaxWaitMs: maxWaitMs,
      pgBouncerTotalQueryCount: totalQueryCount,
      pgBouncerAvgQueryTimeUs: avgQueryTimeUs,
      containerCpuPercent: container?.cpuPercent ?? null,
      containerRssBytes: container?.rssBytes ?? null,
      containerRestarts: container?.restarts ?? null,
      openFileDescriptors: container?.openFileDescriptors ?? null,
      /**
       * This process's RSS, which is the runner's — not the application's.
       *
       * Stated here because it is the honest limit of what a script outside the container can see, and
       * because the leak threshold in the spec is about the application. `docs/operations` carries the
       * container-side reading; a run whose runner leaks is still worth catching, and it is what this
       * number is for.
       */
      processRssBytes: process.memoryUsage.rss(),
    })
  }

  await sampleOnce()
  const timer = setInterval(() => {
    void sampleOnce()
  }, interval)

  return {
    samples,
    failures,
    poolerConfig,
    stop: async () => {
      clearInterval(timer)
      await Promise.all([
        db.end({ timeout: 5 }).catch(() => undefined),
        pooler?.end({ timeout: 5 }).catch(() => undefined),
      ])
    },
  }
}
