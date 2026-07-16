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

async function checkRedis(): Promise<CheckResult> {
  // Try Redis if configured; if not configured, return ok (degraded mode)
  const url = process.env.REDIS_URL
  if (!url) return { name: 'redis', ok: true, message: 'not configured' }
  try {
    const { default: Redis } = await import('ioredis')
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
        const [db, redis] = await Promise.all([checkDb(), checkRedis()])
        const allOk = [db, redis].every((c) => c.ok)
        return Response.json(
          {
            status: allOk ? 'ok' : 'degraded',
            version: '1.0.0',
            uptime: process.uptime(),
            checks: { db, redis },
            timestamp: new Date().toISOString(),
          },
          { status: allOk ? 200 : 503 },
        )
      },
    },
  },
})
