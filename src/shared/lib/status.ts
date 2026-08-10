/**
 * Status page aggregator. Pure functions, testable.
 */

export interface CheckResult {
  name: string
  ok: boolean
  message?: string
}

/**
 * The three checks the public `/api/status` route and the cron-triggered snapshot worker both
 * run — extracted here (status-and-trust plan, Phase 1) so the snapshot worker doesn't duplicate
 * `/api/status`'s inline check logic. `checkDb`/`checkRedis`/`checkMemory` return the same
 * `{name, ok, message?}` shape `/api/status` has always returned per-check; `runStatusChecks()`
 * runs all three concurrently and is what both callers should use.
 */
async function checkDb(): Promise<CheckResult> {
  try {
    const { db } = await import('~/shared/lib/db/index')
    const { sql } = await import('drizzle-orm')
    await db.execute(sql`SELECT 1`)
    return { name: 'db', ok: true }
  } catch (err) {
    console.error('status db check failed:', err)
    return { name: 'db', ok: false, message: 'unavailable' }
  }
}

async function checkMemory(): Promise<CheckResult> {
  const mem = process.memoryUsage()
  const rssMB = mem.rss / 1024 / 1024
  // Flag if RSS > STATUS_MEMORY_LIMIT_MB (default 1024MB prod / 2048MB dev).
  // The previous fixed 1GB threshold turned /status into a noisy "degraded"
  // page on every dev visit (saas-review F8): Vite + TanStack-Start SSR
  // routinely sits at 1100–1600MB in dev, and the same Node process in prod
  // stays under 800MB. One knob, env-driven, default tuned for production.
  const isDev = process.env.NODE_ENV !== 'production'
  const limitMB = Number(process.env.STATUS_MEMORY_LIMIT_MB) || (isDev ? 2048 : 1024)
  const ok = rssMB < limitMB
  return {
    name: 'memory',
    ok,
    message: ok ? `${rssMB.toFixed(0)}MB rss` : `${rssMB.toFixed(0)}MB rss — high (limit ${limitMB}MB)`,
  }
}

async function checkRedis(): Promise<CheckResult> {
  // Try Redis if configured; if not configured, return ok (degraded mode).
  // Use a fully-dynamic import so Vite doesn't try to resolve 'ioredis'
  // at build time when the package isn't installed.
  const url = process.env.REDIS_URL
  if (!url) return { name: 'redis', ok: true, message: 'not configured' }
  try {
    const RedisMod = await import(/* @vite-ignore */ 'ioredis')
    const Redis = RedisMod.default ?? RedisMod
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })
    // ioredis emits 'error' on an EventEmitter with no listener, which node reports as
    // "[ioredis] Unhandled error event" and, depending on flags, can take the process down. The
    // catch below handles the rejected promise but never the event. A health check is the one thing
    // that must stay standing while the thing it checks is broken, so it gets a listener that does
    // nothing: the `catch` already turns the failure into `{ ok: false }`.
    client.on('error', () => {})
    try {
      await client.connect()
      await client.ping()
      return { name: 'redis', ok: true }
    } finally {
      // Always released, so a failed ping cannot leak a socket on every /api/status hit.
      client.disconnect()
    }
  } catch (err) {
    console.error('status redis check failed:', err)
    return { name: 'redis', ok: false, message: 'unavailable' }
  }
}

export async function runStatusChecks(): Promise<CheckResult[]> {
  return Promise.all([checkDb(), checkRedis(), checkMemory()])
}

/**
 * Expected-samples uptime over a trailing window, from periodic snapshot rows. Missing samples
 * (gaps where the cron didn't run, or hadn't started yet) count as down, not as "no data" — the
 * absence of a snapshot is itself evidence the service might not have been observed/healthy.
 * Returns null when there's under a day of history, since a percentage from a handful of samples
 * is misleading (the status page hides the uptime figure entirely in that case).
 */
export function computeUptime(
  checks: Array<{ checkedAt: Date; ok: boolean }>,
  days: number,
  intervalMinutes = 5,
): number | null {
  if (checks.length === 0) return null
  return computeUptimeFromAggregate(
    {
      oldest: checks.reduce((min, c) => (c.checkedAt < min ? c.checkedAt : min), checks[0].checkedAt),
      okSamples: checks.filter((c) => c.ok).length,
    },
    days,
    intervalMinutes,
  )
}

/**
 * The same calculation from two aggregates instead of from every row.
 *
 * `computeUptime` only ever reduced its array to these two numbers — a minimum and a count of `ok` —
 * and the array itself was a real cost: `/api/status` is public and unauthenticated, the window is 30
 * days, and the cron samples every 5 minutes, so the route was loading up to
 * `30 × 24 × 60 / 5 = 8640` rows on **every request** to produce two integers.
 *
 * It could not simply be capped, either. `expectedSamples` is the denominator, so a `LIMIT 1000` would
 * have returned `1000 / 8640 ≈ 11.6%` and published a catastrophic outage on the status page of a
 * healthy service. A ceiling here is not lossy, it is wrong — which is what makes SQL aggregation the
 * only correct bound.
 *
 * `oldest` stays part of the contract because the under-a-day rule depends on it: a percentage drawn
 * from a handful of samples is misleading, and the status page hides the figure entirely in that case.
 */
export function computeUptimeFromAggregate(
  aggregate: { oldest: Date | null; okSamples: number },
  days: number,
  intervalMinutes = 5,
): number | null {
  const oneDayMs = 24 * 60 * 60 * 1000
  if (!aggregate.oldest) return null
  if (Date.now() - aggregate.oldest.getTime() < oneDayMs) return null

  const expectedSamples = Math.round((days * 24 * 60) / intervalMinutes)
  return Math.min(100, (aggregate.okSamples / expectedSamples) * 100)
}

export type ComponentStatus = 'operational' | 'degraded' | 'outage'

export interface ComponentCheck {
  name: string
  status: ComponentStatus
  message?: string
}

export interface SystemStatus {
  status: ComponentStatus
  components: ComponentCheck[]
  lastUpdated: string
}

export function aggregateStatus(components: ComponentCheck[]): SystemStatus {
  const worst = components.reduce<ComponentStatus>((acc, c) => {
    if (c.status === 'outage') return 'outage'
    if (c.status === 'degraded' && acc !== 'outage') return 'degraded'
    return acc
  }, 'operational')
  return {
    status: worst,
    components,
    lastUpdated: new Date().toISOString(),
  }
}

export interface Incident {
  id: string
  title: string
  description: string | null
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  severity: 'minor' | 'major' | 'critical'
  affectedComponents: string[]
  startedAt: string
  resolvedAt: string | null
  durationMinutes: number | null
}

export function computeDuration(startedAt: string, resolvedAt: string | null): number | null {
  if (!resolvedAt) return null
  return Math.round((new Date(resolvedAt).getTime() - new Date(startedAt).getTime()) / 60000)
}

export function formatDuration(minutes: number | null): string {
  if (minutes == null) return '—'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
