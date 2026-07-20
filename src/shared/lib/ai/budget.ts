// Per-user, per-task daily AI call budgets — Redis-backed with an in-memory
// fallback modeled on `src/shared/lib/rate-limit.ts`.
//
// Usage:
//   const result = await checkAndConsumeBudget(principal, entitlement, task)
//   if (!result.allowed) return new Response('...', { status: 429 })

import { getRedis } from '~/shared/lib/redis'
import type { EntitlementPolicy } from '~/shared/lib/repositories/entitlements'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { AITaskDefinition } from './tasks'

export interface BudgetDecision {
  allowed: boolean
  reason?: 'plan' | 'budget'
}

/**
 * Pure decision: is another call allowed given usage-so-far (inclusive of
 * the call being evaluated) and the plan's daily limit? Mirrors the
 * increment-then-check convention already used by `rate-limit.ts`
 * (`allowed: count <= limit`) so a tier's allowance of N means exactly N
 * successful calls per day, not N-1.
 */
export function decideBudget({ used, limit }: { used: number; limit: number }): BudgetDecision {
  if (limit === 0) return { allowed: false, reason: 'plan' }
  if (limit === Number.POSITIVE_INFINITY) return { allowed: true }
  if (used > limit) return { allowed: false, reason: 'budget' }
  return { allowed: true }
}

export interface BudgetResult extends BudgetDecision {
  used: number
  limit: number
}

// Slightly over 24h so a request right at day-boundary doesn't reset the
// counter mid-request; the key itself is already scoped to the UTC date.
const BUDGET_KEY_EXPIRE_SECONDS = 90000

function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10) // YYYY-MM-DD
}

function budgetKey(organizationId: string, userId: string, taskId: string, date: string): string {
  return `ai:budget:${organizationId}:${userId}:${taskId}:${date}`
}

interface MemoryCounter {
  count: number
  dateKey: string
}

const memoryCounters = new Map<string, MemoryCounter>()

/**
 * Atomically increments today's usage counter for this principal+task and
 * returns whether the call is allowed under the entitlement's plan-tier
 * allowance. Consumes one unit of budget regardless of the outcome's
 * `allowed` value being read afterward is left to the caller (typical usage:
 * check before the provider call).
 */
export async function checkAndConsumeBudget(
  principal: Pick<TenantPrincipal, 'organizationId' | 'userId'>,
  entitlement: Pick<EntitlementPolicy, 'tier'>,
  task: Pick<AITaskDefinition, 'id' | 'allowances'>,
): Promise<BudgetResult> {
  const limit = task.allowances[entitlement.tier]
  const dateKey = utcDateKey()
  const key = budgetKey(principal.organizationId, principal.userId, task.id, dateKey)

  try {
    const redis = await getRedis()
    if (redis) {
      const used = await redis.incr(key)
      if (used === 1) await redis.expire(key, BUDGET_KEY_EXPIRE_SECONDS)
      return { ...decideBudget({ used, limit }), used, limit }
    }
  } catch {
    // Fall through to in-memory
  }

  const existing = memoryCounters.get(key)
  const used = existing && existing.dateKey === dateKey ? existing.count + 1 : 1
  memoryCounters.set(key, { count: used, dateKey })
  return { ...decideBudget({ used, limit }), used, limit }
}
