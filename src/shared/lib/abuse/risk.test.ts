import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers } from '../db/schema'
import { insertAbuseSignal, listAbuseSignalsForUser } from '../repositories/abuse-signals'
import { getAccountRisk } from '../repositories/account-risk'
import {
  computeCandidateRiskStage,
  computeDecayedRiskScore,
  describeRiskReason,
  MIN_CORROBORATING_SIGNAL_TYPES,
  recomputeAccountRisk,
  RISK_DECAY_HALF_LIFE_HOURS,
  type RiskSignalInput,
} from './risk'

const NOW = new Date('2026-01-08T00:00:00Z')

function signal(type: RiskSignalInput['type'], severity: RiskSignalInput['severity'], hoursAgo: number): RiskSignalInput {
  return { type, severity, occurredAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000) }
}

describe('computeDecayedRiskScore', () => {
  it('returns 0 for no signals', () => {
    expect(computeDecayedRiskScore([], NOW)).toBe(0)
  })

  it('weighs severities low < medium < high at the same age', () => {
    const low = computeDecayedRiskScore([signal('ua_change', 'low', 0)], NOW)
    const medium = computeDecayedRiskScore([signal('ua_change', 'medium', 0)], NOW)
    const high = computeDecayedRiskScore([signal('ua_change', 'high', 0)], NOW)
    expect(low).toBeLessThan(medium)
    expect(medium).toBeLessThan(high)
  })

  it('decays a signal to half its weight after one half-life (7 -> round(3.5) = 4)', () => {
    const fresh = computeDecayedRiskScore([signal('impossible_travel', 'high', 0)], NOW)
    const oneHalfLife = computeDecayedRiskScore([signal('impossible_travel', 'high', RISK_DECAY_HALF_LIFE_HOURS)], NOW)
    expect(fresh).toBe(7)
    expect(oneHalfLife).toBe(4)
  })

  it('decays a signal to a quarter of its weight after two half-lives (7 -> round(1.75) = 2)', () => {
    const twoHalfLives = computeDecayedRiskScore([signal('impossible_travel', 'high', RISK_DECAY_HALF_LIFE_HOURS * 2)], NOW)
    expect(twoHalfLives).toBe(2)
  })

  it('sums multiple signals rather than averaging them', () => {
    const one = computeDecayedRiskScore([signal('ua_change', 'medium', 0)], NOW)
    const two = computeDecayedRiskScore([signal('ua_change', 'medium', 0), signal('seat_overuse', 'medium', 0)], NOW)
    expect(two).toBeCloseTo(one * 2, 0)
  })

  it('respects a custom half-life override', () => {
    const shortHalfLife = computeDecayedRiskScore([signal('ua_change', 'high', 10)], NOW, 10)
    expect(shortHalfLife).toBe(4) // 7 * 0.5^(10/10) = 3.5 -> round(3.5) = 4
  })
})

describe('computeCandidateRiskStage — scoring thresholds', () => {
  it('no signals stays at observe', () => {
    expect(computeCandidateRiskStage([], NOW).candidateStage).toBe('observe')
  })

  it('a single low-severity signal stays at observe (score below the warned threshold)', () => {
    const result = computeCandidateRiskStage([signal('ua_change', 'low', 0)], NOW)
    expect(result.score).toBe(1)
    expect(result.candidateStage).toBe('observe')
  })

  it('a fresh high-severity signal alone crosses into warned territory by score, but corroboration still applies', () => {
    const result = computeCandidateRiskStage([signal('impossible_travel', 'high', 0)], NOW)
    expect(result.score).toBe(7)
    expect(result.distinctSignalTypes).toBe(1)
    expect(result.candidateStage).toBe('warned')
  })
})

describe('computeCandidateRiskStage — corroboration gate', () => {
  it('never escalates past `warned` from a single signal type, no matter how high the score', () => {
    // Many repeats of the SAME type, fresh and high-severity -> huge score, but only 1 distinct type.
    const signals = Array.from({ length: 20 }, () => signal('impossible_travel', 'high', 0))
    const result = computeCandidateRiskStage(signals, NOW)
    expect(result.score).toBeGreaterThan(40) // would be `blocked` by score alone
    expect(result.distinctSignalTypes).toBe(1)
    expect(result.candidateStage).toBe('warned')
  })

  it(`escalates past warned once >= ${MIN_CORROBORATING_SIGNAL_TYPES} distinct signal types corroborate a high score`, () => {
    const signals = [
      signal('impossible_travel', 'high', 0),
      signal('concurrent_sessions', 'high', 0),
      signal('ua_change', 'medium', 0),
    ]
    const result = computeCandidateRiskStage(signals, NOW)
    expect(result.distinctSignalTypes).toBe(3)
    expect(result.score).toBeGreaterThanOrEqual(12)
    expect(result.candidateStage).not.toBe('warned')
    expect(['stepup', 'throttled', 'blocked']).toContain(result.candidateStage)
  })

  it('exactly at the corroboration minimum unlocks escalation', () => {
    const signals = [signal('impossible_travel', 'high', 0), signal('concurrent_sessions', 'high', 0)]
    const result = computeCandidateRiskStage(signals, NOW)
    expect(result.distinctSignalTypes).toBe(MIN_CORROBORATING_SIGNAL_TYPES)
    expect(result.candidateStage).not.toBe('warned')
  })

  it('one below the corroboration minimum caps at warned regardless of score', () => {
    const signals = [signal('impossible_travel', 'high', 0), signal('impossible_travel', 'high', 1)]
    const result = computeCandidateRiskStage(signals, NOW)
    expect(result.distinctSignalTypes).toBe(1)
    expect(result.candidateStage).toBe('warned')
  })

  it('corroboration never demotes a low score below what it would otherwise be — observe stays observe even with 2 distinct weak types', () => {
    const signals = [signal('ua_change', 'low', 0), signal('seat_overuse', 'low', 0)]
    const result = computeCandidateRiskStage(signals, NOW)
    expect(result.distinctSignalTypes).toBe(2)
    expect(result.candidateStage).toBe('observe')
  })
})

describe('recomputeAccountRisk', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('abuse_risk')
    db = disposable.db
    drop = disposable.drop
    await db.insert(authUsers).values([
      { id: 'risk-recompute-a', name: 'A', email: 'risk-recompute-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: 'risk-recompute-b', name: 'B', email: 'risk-recompute-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ])
  }, 60_000)

  afterAll(async () => {
    await drop()
  })

  it('reads real abuse_signals rows, scores them, and upserts the candidate stage into account_risk', async () => {
    await insertAbuseSignal({ id: crypto.randomUUID(), type: 'impossible_travel', severity: 'high', userId: 'risk-recompute-a' }, db)
    await insertAbuseSignal({ id: crypto.randomUUID(), type: 'concurrent_sessions', severity: 'high', userId: 'risk-recompute-a' }, db)

    const result = await db.transaction((tx) => recomputeAccountRisk(tx, 'risk-recompute-a', {
      listSignals: (userId) => listAbuseSignalsForUser(userId, 50, db),
    }))

    expect(result.userId).toBe('risk-recompute-a')
    expect(result.riskScore).toBeGreaterThanOrEqual(12) // 2 distinct high-severity types corroborate
    expect(result.stage).not.toBe('warned')
    expect(result.reason).toContain('impossible_travel')
    expect(result.reason).toContain('concurrent_sessions')

    const stored = await db.transaction((tx) => getAccountRisk(tx, 'risk-recompute-a'))
    expect(stored).toMatchObject({ userId: 'risk-recompute-a', stage: result.stage, riskScore: result.riskScore })
  })

  it('returns to observe once a user has no signals at all', async () => {
    const result = await db.transaction((tx) => recomputeAccountRisk(tx, 'risk-recompute-b', {
      listSignals: (userId) => listAbuseSignalsForUser(userId, 50, db),
    }))
    expect(result.riskScore).toBe(0)
    expect(result.stage).toBe('observe')
    expect(result.reason).toBeNull()
  })
})

describe('describeRiskReason', () => {
  it('returns null for no signals', () => {
    expect(describeRiskReason([])).toBeNull()
  })

  it('lists distinct signal types once each', () => {
    const signals = [signal('ua_change', 'low', 0), signal('ua_change', 'low', 1), signal('seat_overuse', 'medium', 0)]
    expect(describeRiskReason(signals)).toBe('Signals: ua_change, seat_overuse')
  })
})
