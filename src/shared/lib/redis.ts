// Redis singleton — lazy, with safe fallback when REDIS_URL is not set.
//
// Usage:
//   const r = await getRedis()
//   if (r) { await r.set(...) }
//   else { /* in-memory fallback */ }
//
// In dev/test, REDIS_URL is unset and we return null. In production, set
// REDIS_URL=redis://host:6379 and the singleton will connect.

import type Redis from 'ioredis'

let client: Redis | null = null
let initPromise: Promise<Redis | null> | null = null

async function init(): Promise<Redis | null> {
  const url = process.env.REDIS_URL
  if (!url) return null
  try {
    // Dynamic import so the package isn't loaded unless REDIS_URL is set
    const { default: RedisCtor } = await import('ioredis')
    client = new RedisCtor(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    client.on('error', (err) => {
      // Swallow errors to avoid spamming logs; we fall back to no-op
      console.error('[redis] error:', err.message)
    })
    await client.connect()
    return client
  } catch (err) {
    console.error('[redis] init failed:', err instanceof Error ? err.message : 'unknown')
    client = null
    return null
  }
}

/**
 * Returns a connected Redis client, or null if REDIS_URL is not set or
 * the client can't connect. Safe to call repeatedly — the first call
 * initializes and caches the connection.
 */
export async function getRedis(): Promise<Redis | null> {
  if (client) return client
  if (initPromise) return initPromise
  initPromise = init().catch(() => null)
  return initPromise
}

export function getRedisSync(): Redis | null {
  return client
}
