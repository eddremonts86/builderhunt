import { createHash } from 'node:crypto'
import { getRedis } from '~/shared/lib/redis'
import type { AITaskDefinition } from './tasks'

export function tenantAiCacheKey(input: { organizationId: string; artifact: string; input: string }) {
  if (!input.organizationId.trim()) throw new Error('AI tenant cache requires an organization ID')
  if (!input.artifact.trim()) throw new Error('AI tenant cache requires an artifact type')
  return `ai:tenant:${digest(input.organizationId)}:${digest(input.artifact)}:${digest(input.input)}`
}

export function publicSourceCacheKey(input: { source: string; sourceId: string; input: string }) {
  if (!input.source.trim() || !input.sourceId.trim()) throw new Error('Public AI cache requires source provenance')
  return `ai:public:${digest(`${input.source}:${input.sourceId}`)}:${digest(input.input)}`
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Recursively sorts object keys so semantically-equal inputs (same keys,
 * different insertion order) serialize identically. Arrays keep their order
 * (order is semantically significant for arrays).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value))
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson)
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
    const sorted: Record<string, unknown> = {}
    for (const key of sortedKeys) {
      sorted[key] = sortForCanonicalJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Generic per-task AI response cache key: `ai:cache:{taskId}:{sha256(canonicalJson(input))}`. */
export function cacheKeyFor(taskId: string, input: unknown): string {
  return `ai:cache:${taskId}:${digest(canonicalJson(input))}`
}

/**
 * Reads a cached AI response for `task`/`input`. Returns `null` when Redis is
 * unavailable, the key is missing, or the cached value fails to parse — cache
 * misses always degrade to "call the provider", never an error.
 */
export async function getCached<O>(task: Pick<AITaskDefinition, 'id'>, input: unknown): Promise<O | null> {
  const redis = await getRedis()
  if (!redis) return null
  try {
    const raw = await redis.get(cacheKeyFor(task.id, input))
    if (!raw) return null
    return JSON.parse(raw) as O
  } catch {
    return null
  }
}

/**
 * Writes a cached AI response. No-ops when Redis is unavailable (no
 * in-memory fallback — AI responses can be large) or when the task disables
 * caching (`cacheTtlSeconds === null`).
 */
export async function setCached(
  task: Pick<AITaskDefinition, 'id' | 'cacheTtlSeconds'>,
  input: unknown,
  output: unknown,
): Promise<void> {
  if (task.cacheTtlSeconds === null) return
  const redis = await getRedis()
  if (!redis) return
  try {
    await redis.set(cacheKeyFor(task.id, input), JSON.stringify(output), 'EX', task.cacheTtlSeconds)
  } catch {
    // Best-effort cache write; failures never block the caller.
  }
}
