import type { WorkerTransaction } from '../db/worker-db'
import { listAbuseSignalsForUser } from '../repositories/abuse-signals'
import { type AccountRiskRecord, upsertAccountRisk } from '../repositories/account-risk'
import type { AbuseSignalSeverity, AbuseSignalType } from './signals'

/**
 * Candidate enforcement stage — "candidate" because this module only scores; deciding whether/how
 * to actually act on a stage is the enforcement ladder's job (`resolveEnforcement()`, Phase 5, not
 * built yet). Matches `account_risk.stage`'s check constraint exactly
 * (`drizzle/0043_abuse_usage_integrity_tables.sql`).
 */
export type RiskStage = 'observe' | 'warned' | 'stepup' | 'throttled' | 'blocked'

const STAGE_ORDER: RiskStage[] = ['observe', 'warned', 'stepup', 'throttled', 'blocked']

function stageRank(stage: RiskStage): number {
  return STAGE_ORDER.indexOf(stage)
}

const SEVERITY_WEIGHT: Record<AbuseSignalSeverity, number> = {
  low: 1,
  medium: 3,
  high: 7,
}

/** A signal's weight halves every this many hours — a burst from last week barely moves today's score. */
export const RISK_DECAY_HALF_LIFE_HOURS = 72

/**
 * Minimum number of DISTINCT signal types required before a candidate stage may escalate past
 * `warned` — the OWASP NAT/proxy caveat this whole plan is built around (spec.md: "a single weak
 * signal ... never escalates past `warn`; escalation requires corroborating signals"). Score alone
 * can never justify stepup/throttled/blocked without corroboration.
 */
export const MIN_CORROBORATING_SIGNAL_TYPES = 2

const STAGE_THRESHOLDS: Array<{ stage: RiskStage; minScore: number }> = [
  { stage: 'blocked', minScore: 40 },
  { stage: 'throttled', minScore: 25 },
  { stage: 'stepup', minScore: 12 },
  { stage: 'warned', minScore: 4 },
  { stage: 'observe', minScore: 0 },
]

export interface RiskSignalInput {
  type: AbuseSignalType
  severity: AbuseSignalSeverity
  occurredAt: Date
}

function decayedWeight(severity: AbuseSignalSeverity, ageHours: number, halfLifeHours: number): number {
  const base = SEVERITY_WEIGHT[severity]
  if (ageHours <= 0) return base
  return base * 0.5 ** (ageHours / halfLifeHours)
}

/** Sums each signal's severity weight, decayed by age — older signals fade toward zero rather than being dropped at a hard cutoff. */
export function computeDecayedRiskScore(
  signals: RiskSignalInput[],
  now: Date,
  halfLifeHours: number = RISK_DECAY_HALF_LIFE_HOURS,
): number {
  const total = signals.reduce((sum, signal) => {
    const ageHours = (now.getTime() - signal.occurredAt.getTime()) / (1000 * 60 * 60)
    return sum + decayedWeight(signal.severity, ageHours, halfLifeHours)
  }, 0)
  return Math.round(total)
}

function stageForScore(score: number): RiskStage {
  const match = STAGE_THRESHOLDS.find((entry) => score >= entry.minScore)
  return match?.stage ?? 'observe'
}

export interface RiskScoringResult {
  score: number
  candidateStage: RiskStage
  distinctSignalTypes: number
}

/**
 * Combines signals into a decayed score and a candidate stage, gated by corroboration: if fewer
 * than `MIN_CORROBORATING_SIGNAL_TYPES` distinct signal types are present, the candidate stage is
 * capped at `warned` even when the raw score alone would justify going further.
 */
export function computeCandidateRiskStage(
  signals: RiskSignalInput[],
  now: Date,
  halfLifeHours: number = RISK_DECAY_HALF_LIFE_HOURS,
): RiskScoringResult {
  const score = computeDecayedRiskScore(signals, now, halfLifeHours)
  const distinctSignalTypes = new Set(signals.map((signal) => signal.type)).size
  const scoreStage = stageForScore(score)
  const corroborated = distinctSignalTypes >= MIN_CORROBORATING_SIGNAL_TYPES
  const candidateStage = !corroborated && stageRank(scoreStage) > stageRank('warned') ? 'warned' : scoreStage
  return { score, candidateStage, distinctSignalTypes }
}

/** Short, human-readable `account_risk.reason` summarizing which signal types contributed. */
export function describeRiskReason(signals: RiskSignalInput[]): string | null {
  if (signals.length === 0) return null
  return `Signals: ${[...new Set(signals.map((signal) => signal.type))].join(', ')}`
}

export interface RecomputeAccountRiskDeps {
  listSignals?: typeof listAbuseSignalsForUser
  now?: Date
}

/**
 * Reads a user's recent abuse signals, scores them, and upserts the resulting candidate stage into
 * `account_risk`. Signals are read via the plain `listAbuseSignalsForUser` default (not the caller's
 * transaction) — `abuse_signals` has no RLS/tenant context to inherit, so there's no correctness
 * reason to share the transaction, only the `account_risk` write needs it (RLS-scoped to `app.user_id`,
 * see `repositories/account-risk.ts`'s `withWorkerUser`).
 */
export async function recomputeAccountRisk(
  transaction: WorkerTransaction,
  userId: string,
  deps: RecomputeAccountRiskDeps = {},
): Promise<AccountRiskRecord> {
  const listSignals = deps.listSignals ?? listAbuseSignalsForUser
  const now = deps.now ?? new Date()
  const records = await listSignals(userId)
  const signals: RiskSignalInput[] = records.map((record) => ({
    type: record.type as AbuseSignalType,
    severity: record.severity as AbuseSignalSeverity,
    occurredAt: record.createdAt,
  }))
  const { score, candidateStage } = computeCandidateRiskStage(signals, now)
  return upsertAccountRisk(transaction, {
    userId,
    riskScore: score,
    stage: candidateStage,
    reason: describeRiskReason(signals),
  })
}
