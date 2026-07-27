import { describe, expect, it, vi } from 'vitest'
import { resolveEnforcement, resolveEnforcementForUser } from '~/shared/lib/abuse/enforcement'

describe('resolveEnforcement', () => {
  it('always resolves to observe in observe mode, whatever the candidate stage', () => {
    for (const candidateStage of ['observe', 'warned', 'stepup', 'throttled', 'blocked'] as const) {
      const decision = resolveEnforcement('observe', candidateStage)
      expect(decision.stage).toBe('observe')
      expect(decision.candidateStage).toBe(candidateStage)
      expect(decision.mode).toBe('observe')
    }
  })

  it('caps the effective stage at warned in warn mode', () => {
    expect(resolveEnforcement('warn', 'observe').stage).toBe('observe')
    expect(resolveEnforcement('warn', 'warned').stage).toBe('warned')
    expect(resolveEnforcement('warn', 'stepup').stage).toBe('warned')
    expect(resolveEnforcement('warn', 'throttled').stage).toBe('warned')
    expect(resolveEnforcement('warn', 'blocked').stage).toBe('warned')
  })

  it('preserves the candidate stage on the decision even when capped', () => {
    const decision = resolveEnforcement('warn', 'blocked')
    expect(decision.stage).toBe('warned')
    expect(decision.candidateStage).toBe('blocked')
  })

  it('passes the candidate stage through unchanged in enforce mode', () => {
    for (const candidateStage of ['observe', 'warned', 'stepup', 'throttled', 'blocked'] as const) {
      expect(resolveEnforcement('enforce', candidateStage).stage).toBe(candidateStage)
    }
  })
})

describe('resolveEnforcementForUser', () => {
  it('never queries account_risk in observe mode — the query result could never change the outcome', async () => {
    const getAccountRisk = vi.fn()
    const withWorkerUser = vi.fn()
    const decision = await resolveEnforcementForUser('user-1', { mode: 'observe', getAccountRisk, withWorkerUser })
    expect(decision.stage).toBe('observe')
    expect(withWorkerUser).not.toHaveBeenCalled()
    expect(getAccountRisk).not.toHaveBeenCalled()
  })

  it('treats a user with no account_risk row as observe-stage', async () => {
    const withWorkerUser = vi.fn((userId, operation) => operation({} as never))
    const getAccountRisk = vi.fn().mockResolvedValue(null)
    const decision = await resolveEnforcementForUser('user-1', { mode: 'enforce', getAccountRisk, withWorkerUser })
    expect(decision.stage).toBe('observe')
    expect(decision.candidateStage).toBe('observe')
  })

  it('reads the persisted stage and applies the mode policy on top of it', async () => {
    const withWorkerUser = vi.fn((userId, operation) => operation({} as never))
    const getAccountRisk = vi.fn().mockResolvedValue({ userId: 'user-1', riskScore: 50, stage: 'blocked', reason: null, updatedAt: new Date() })
    const decision = await resolveEnforcementForUser('user-1', { mode: 'warn', getAccountRisk, withWorkerUser })
    expect(decision.candidateStage).toBe('blocked')
    expect(decision.stage).toBe('warned') // warn mode caps it
  })

  it('falls back to observe for a corrupt/unexpected persisted stage value (defensive)', async () => {
    const withWorkerUser = vi.fn((userId, operation) => operation({} as never))
    const getAccountRisk = vi.fn().mockResolvedValue({ userId: 'user-1', riskScore: 0, stage: 'not-a-real-stage', reason: null, updatedAt: new Date() })
    const decision = await resolveEnforcementForUser('user-1', { mode: 'enforce', getAccountRisk, withWorkerUser })
    expect(decision.stage).toBe('observe')
  })
})
