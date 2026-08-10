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
      /**
       * Queued while connecting, not thrown.
       *
       * With the offline queue disabled, a command issued in the window where the socket is not yet
       * ready throws immediately — it does not wait for the connection it is about to have. That window
       * is small and it is exactly when the first request after a deploy or a server start arrives.
       *
       * It cost an afternoon here. `rate-limit.ts` fails **closed** under `E2E_MODE` by design, so the
       * one request that lost that race came back as "Too many accounts created from this device
       * recently" — with the counter in Redis reading 1, naming a limit that was never consulted.
       *
       * This does not weaken the closed failure for a Redis that is genuinely unreachable: the queue
       * drains into the same `maxRetriesPerRequest: 1` and still rejects. It only stops treating "not
       * connected yet" as "not reachable".
       */
      enableOfflineQueue: true,
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
  /**
   * A failed init must not be cached, and this used to cache it forever.
   *
   * `initPromise` was assigned once and never cleared, so a single transient failure — the container
   * still starting, a socket refused for one moment — resolved to `null` and every later call returned
   * that same settled promise. Redis stayed off for the whole life of the process, with no retry and no
   * second error message to explain it.
   *
   * That is bad in production, where it silently disables caching and rate limiting until a restart.
   * Under `E2E_MODE` it is worse, because `rate-limit.ts` fails **closed** on purpose: one lost connect
   * at boot turned every subsequent sign-up in the run into "Too many accounts created from this device
   * recently", with every counter in Redis reading 1. The message named a limit that was never
   * consulted, and the real cause was three layers down.
   *
   * Clearing it on failure makes the next caller try again. `client` is still cached on success, so a
   * healthy process pays for exactly one connect.
   */
  initPromise = init()
    .catch(() => null)
    .then((resolved) => {
      if (!resolved) initPromise = null
      return resolved
    })
  return initPromise
}

export function getRedisSync(): Redis | null {
  return client
}
