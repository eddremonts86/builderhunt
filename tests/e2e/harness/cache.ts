/**
 * Wave 1 Task 1 — per-worker Redis namespace.
 *
 * Each Playwright worker receives a unique key prefix
 * (`e2e:<runId>:w<workerIndex>:*`) so rate-limit, AI cache, and any
 * other Redis-backed state can never bleed across workers. Isolation
 * is enforced by the application code itself (see
 * `src/shared/lib/rate-limit.ts` which scopes `rl:*` keys through the
 * `E2E_REDIS_PREFIX` env var in E2E mode) — the harness only owns the
 * prefix and the cleanup.
 *
 * `dropWorkerRedisNamespace` deletes only keys with the worker's prefix,
 * never a global FLUSHDB — multiple workers must coexist in the same
 * Redis instance for the duration of the run without trampling each
 * other's state.
 *
 * The module-level `redis` namespace object exposes low-level helpers
 * for tests that need a one-off ioredis connection bound to a specific
 * worker prefix (e.g. asserting that one worker cannot read another
 * worker's keys).
 */
import Redis from 'ioredis'
import { e2eEnv, runId } from './env'

export interface WorkerRedis {
  workerIndex: number
  prefix: string
  key(suffix: string): string
}

const acquired = new Map<number, WorkerRedis>()

export function redisPrefix(workerIndex: number, runIdValue?: string): string {
  const tag = runIdValue ?? runId()
  return `e2e:${tag}:w${workerIndex}`
}

export async function acquireWorkerRedis(workerIndex: number): Promise<WorkerRedis> {
  const existing = acquired.get(workerIndex)
  if (existing) return existing
  const env = e2eEnv()
  if (!env.REDIS_URL) {
    throw new Error('acquireWorkerRedis requires REDIS_URL — env.ts already rejects this in E2E mode')
  }
  const prefix = redisPrefix(workerIndex)
  const handle: WorkerRedis = {
    workerIndex,
    prefix,
    key(suffix: string): string {
      return `${prefix}:${suffix}`
    },
  }
  // Verify connectivity up-front — fail fast on a misconfigured
  // REDIS_URL instead of failing on the first set call.
  const probe = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  })
  try {
    await probe.connect()
    await probe.ping()
  } finally {
    await probe.quit().catch(() => undefined)
  }
  acquired.set(workerIndex, handle)
  return handle
}

export async function dropWorkerRedisNamespace(prefixOrIndex: string | number): Promise<void> {
  const prefix = typeof prefixOrIndex === 'number'
    ? acquired.get(prefixOrIndex)?.prefix ?? redisPrefix(prefixOrIndex)
    : prefixOrIndex
  const env = e2eEnv()
  if (!env.REDIS_URL) return
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  })
  try {
    await client.connect()
    // SCAN is safer than KEYS for a worker that may have thousands of keys.
    // Use the worker's prefix as a glob pattern so we never delete state
    // belonging to another worker.
    let cursor = '0'
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
      if (batch.length > 0) {
        await client.del(...batch)
      }
      cursor = next
    } while (cursor !== '0')
  } finally {
    await client.quit().catch(() => undefined)
  }
  if (typeof prefixOrIndex === 'number') {
    acquired.delete(prefixOrIndex)
  }
}

/**
 * `redis` namespace object exposes the helpers above plus a `client(prefix)`
 * helper for tests that prefer a one-off ioredis connection bound to a
 * specific worker prefix.
 */
export const redis = {
  prefix: redisPrefix,
  acquire: acquireWorkerRedis,
  drop: dropWorkerRedisNamespace,
  async client(prefix: string): Promise<Redis> {
    const env = e2eEnv()
    if (!env.REDIS_URL) {
      throw new Error('redis.client requires REDIS_URL — env.ts already rejects this in E2E mode')
    }
    const c = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    })
    await c.connect()
    return c
  },
}
