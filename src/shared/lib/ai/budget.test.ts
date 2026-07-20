import { describe, expect, it } from 'vitest'
import { checkAndConsumeBudget, decideBudget } from './budget'
import type { AITaskDefinition } from './tasks'

describe('decideBudget', () => {
  it('allows calls under the limit', () => {
    expect(decideBudget({ used: 3, limit: 5 })).toEqual({ allowed: true })
  })

  it('allows the call that reaches the limit exactly (limit means N successful calls/day)', () => {
    expect(decideBudget({ used: 5, limit: 5 })).toEqual({ allowed: true })
  })

  it('blocks with reason budget once usage exceeds the limit', () => {
    expect(decideBudget({ used: 6, limit: 5 })).toEqual({ allowed: false, reason: 'budget' })
  })

  it('blocks with reason plan when the tier has zero allowance', () => {
    expect(decideBudget({ used: 0, limit: 0 })).toEqual({ allowed: false, reason: 'plan' })
  })

  it('always allows when limit is Infinity', () => {
    expect(decideBudget({ used: 1_000_000, limit: Number.POSITIVE_INFINITY })).toEqual({ allowed: true })
  })
})

describe('checkAndConsumeBudget (in-memory fallback, no REDIS_URL in tests)', () => {
  const task: Pick<AITaskDefinition, 'id' | 'allowances'> = {
    id: `budget-test-task-${Math.random()}`,
    allowances: { free: 2, pro: 20, team: 20 },
  }
  const principal = { organizationId: 'org-budget-test', userId: 'user-budget-test' }

  it('counts calls per user+task+day and blocks once the limit is reached', async () => {
    const first = await checkAndConsumeBudget(principal, { tier: 'free' }, task)
    expect(first).toEqual({ allowed: true, used: 1, limit: 2 })

    const second = await checkAndConsumeBudget(principal, { tier: 'free' }, task)
    expect(second).toEqual({ allowed: true, used: 2, limit: 2 })

    const third = await checkAndConsumeBudget(principal, { tier: 'free' }, task)
    expect(third).toEqual({ allowed: false, used: 3, limit: 2, reason: 'budget' })
  })

  it('scopes counters independently per organization+user+task', async () => {
    const isolatedTask: Pick<AITaskDefinition, 'id' | 'allowances'> = {
      id: `budget-isolated-task-${Math.random()}`,
      allowances: { free: 1, pro: 20, team: 20 },
    }
    const a = await checkAndConsumeBudget({ organizationId: 'org-a', userId: 'user-1' }, { tier: 'free' }, isolatedTask)
    const b = await checkAndConsumeBudget({ organizationId: 'org-b', userId: 'user-1' }, { tier: 'free' }, isolatedTask)
    expect(a).toEqual({ allowed: true, used: 1, limit: 1 })
    expect(b).toEqual({ allowed: true, used: 1, limit: 1 })
  })

  it('gates a zero-allowance tier immediately with reason plan', async () => {
    const gatedTask: Pick<AITaskDefinition, 'id' | 'allowances'> = {
      id: `budget-gated-task-${Math.random()}`,
      allowances: { free: 0, pro: 20, team: 20 },
    }
    const result = await checkAndConsumeBudget(principal, { tier: 'free' }, gatedTask)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('plan')
  })
})
