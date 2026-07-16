// Redis-backed rate limiting with in-memory fallback.
//
// Usage:
//   const limit = await rateLimit('search', request, 30, 60) // 30 req per 60s
//   if (!limit.allowed) return new Response('Too many requests', { status: 429 })

import { getRedis } from './redis'

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetMs: number
  limit: number
}

interface Bucket {
  count: number
  resetAt: number
}

const memoryBuckets = new Map<string, Bucket>()

function getKey(scope: string, id: string): string {
  return `rl:${scope}:${id}`
}

export async function rateLimit(
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = getKey(scope, id)
  const now = Date.now()
  const windowMs = windowSeconds * 1000

  // Try Redis first
  try {
    const redis = await getRedis()
    if (redis) {
      const redisKey = `rl:${scope}:${id}`
      const count = await redis.incr(redisKey)
      if (count === 1) {
        await redis.expire(redisKey, windowSeconds)
      }
      const ttl = await redis.ttl(redisKey)
      const resetMs = ttl > 0 ? ttl * 1000 : windowMs
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetMs,
        limit,
      }
    }
  } catch {
    // Fall through to in-memory
  }

  // In-memory fallback
  const bucket = memoryBuckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, resetMs: windowMs, limit }
  }
  bucket.count += 1
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetMs: Math.max(0, bucket.resetAt - now),
    limit,
  }
}

/**
 * Extract a stable client ID from a request — IP first, fallback to UA hash.
 */
export function getRateLimitId(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp
  const ua = request.headers.get('user-agent') ?? 'unknown'
  // Simple hash — same UA gets the same bucket
  let h = 0
  for (let i = 0; i < ua.length; i++) h = (h * 31 + ua.charCodeAt(i)) | 0
  return `ua:${h}`
}
