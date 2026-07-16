import { createFileRoute } from '@tanstack/react-router'

interface CheckResult {
  name: string
  ok: boolean
  message?: string
}

async function checkDb(): Promise<CheckResult> {
  try {
    const { db } = await import('~/shared/lib/db/index')
    const { sql } = await import('drizzle-orm')
    await db.execute(sql`SELECT 1`)
    return { name: 'db', ok: true }
  } catch (err) {
    return { name: 'db', ok: false, message: err instanceof Error ? err.message : 'unknown' }
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
    // @ts-expect-error — optional dep, only loaded when REDIS_URL is set
    const RedisMod = await import(/* @vite-ignore */ 'ioredis')
    const Redis = RedisMod.default ?? RedisMod
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await client.connect()
    await client.ping()
    await client.quit()
    return { name: 'redis', ok: true }
  } catch (err) {
    return { name: 'redis', ok: false, message: err instanceof Error ? err.message : 'unknown' }
  }
}

export const Route = createFileRoute('/api/status/')({
  component: () => null,
  server: {
    handlers: {
      GET: async () => {
        const [db, redis, memory] = await Promise.all([
          checkDb(),
          checkRedis(),
          checkMemory(),
        ])
        const allOk = [db, redis, memory].every((c) => c.ok)
        return Response.json(
          {
            status: allOk ? 'ok' : 'degraded',
            version: '1.0.0',
            uptime: process.uptime(),
            checks: { db, redis, memory },
            timestamp: new Date().toISOString(),
          },
          { status: allOk ? 200 : 503 },
        )
      },
    },
  },
})
