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
  // Flag if RSS > 1GB
  return {
    name: 'memory',
    ok: rssMB < 1024,
    message: rssMB < 1024 ? `${rssMB.toFixed(0)}MB rss` : `${rssMB.toFixed(0)}MB rss — high`,
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
  const oneDayMs = 24 * 60 * 60 * 1000
  if (checks.length === 0) return null
  const oldest = checks.reduce((min, c) => (c.checkedAt < min ? c.checkedAt : min), checks[0].checkedAt)
  const spanMs = Date.now() - oldest.getTime()
  if (spanMs < oneDayMs) return null

  const expectedSamples = Math.round((days * 24 * 60) / intervalMinutes)
  const okSamples = checks.filter((c) => c.ok).length
  return Math.min(100, (okSamples / expectedSamples) * 100)
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
