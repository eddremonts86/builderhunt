import { getRedis } from './redis'
import { PublicPortfolioSchema, type PublicPortfolio } from './portfolio'

const TTL_SECONDS = 60
const memoryCache = new Map<string, { value: PublicPortfolio; expiresAt: number }>()

function cacheKey(claimId: string): string {
  return `portfolio:${claimId}:v1`
}

/** Only ever caches a schema-valid published DTO — never a draft, never a raw row. */
export async function getCachedPortfolio(claimId: string): Promise<PublicPortfolio | null> {
  const key = cacheKey(claimId)
  const redis = await getRedis()
  if (redis) {
    const raw = await redis.get(key).catch(() => null)
    if (!raw) return null
    const parsed = PublicPortfolioSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  }
  const entry = memoryCache.get(key)
  if (!entry || entry.expiresAt < Date.now()) return null
  return entry.value
}

export async function setCachedPortfolio(claimId: string, value: PublicPortfolio): Promise<void> {
  const key = cacheKey(claimId)
  const redis = await getRedis()
  if (redis) {
    await redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS).catch(() => null)
    return
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + TTL_SECONDS * 1000 })
}

/** Called from every portfolio write and from claim revocation — a stale cache entry must never outlive the state change that invalidated it. */
export async function purgePortfolioCache(claimId: string): Promise<void> {
  const key = cacheKey(claimId)
  const redis = await getRedis()
  if (redis) {
    await redis.del(key).catch(() => null)
    return
  }
  memoryCache.delete(key)
}
