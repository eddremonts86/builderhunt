/**
 * Interview-specific usage estimation arithmetic (plan: calendar-scheduling-interview-
 * intelligence, spec.md "Usage credits and pricing" + "Enforcement"). Pure — no I/O, no
 * reservation/ledger state of its own. This module only computes numbers; the actual
 * reserve/extend/heartbeat/settle/release/refund authority stays entirely with the billing
 * platform's own contracts (`shared/lib/billing/reservations.ts`, `credits.ts`) — this file must
 * never define a local grant or reservation state machine.
 */
import { INTERVIEW_RATE_CARD_KEYS, LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS, LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING } from '~/shared/lib/interview-config'

export class InterviewBillingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'InterviewBillingError'
  }
}

/** Rounds up to the next whole minute — a partial minute of provider-billed transcription still costs a full minute's credit, matching the platform's integer-unit ledger. */
export function estimateTranscriptionUnitsForSeconds(providerBilledSeconds: number): number {
  if (!Number.isFinite(providerBilledSeconds) || providerBilledSeconds < 0) {
    throw new InterviewBillingError('providerBilledSeconds must be a non-negative finite number', 'invalid_input')
  }
  const minutes = Math.ceil(providerBilledSeconds / 60)
  return minutes * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
}

export function estimateBriefUnits(): number {
  return INTERVIEW_RATE_CARD_KEYS.brief.units
}

export function estimateReportUnits(): number {
  return INTERVIEW_RATE_CARD_KEYS.report.units
}

/**
 * A single interview reservation's local sanity ceiling (this module's own bound, not yet
 * registered with the billing platform's `RATE_CARDS` map — a separate later task). Three hours
 * is a generous ceiling for one live interview session; it exists to prevent a runaway or
 * never-settled reservation, not to model a real product limit.
 */
export const MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES = 180

export function maxLiveTranscriptionReservationUnits(): number {
  return MAX_LIVE_TRANSCRIPTION_RESERVATION_MINUTES * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
}

/** Throws if a requested reservation would exceed the local sanity ceiling. */
export function assertWithinMaxReservation(requestedUnits: number): void {
  const max = maxLiveTranscriptionReservationUnits()
  if (requestedUnits > max) {
    throw new InterviewBillingError(`Requested ${requestedUnits} units exceeds the maximum single-session reservation of ${max} units`, 'reservation_too_large')
  }
}

export type LowBalanceWarningLevel = 'eighty_percent' | 'ninety_percent' | 'ten_minutes_remaining'

export interface LowBalanceWarning {
  level: LowBalanceWarningLevel
  remainingUnits: number
}

/** spec.md "Enforcement": "warn at 80%, 90%, and ten remaining minutes." A session past both percentage thresholds AND under the remaining-minutes floor returns every warning that applies, not just the most severe one — callers decide how to render multiple simultaneous warnings. */
export function resolveLowBalanceWarnings(params: { reservedUnits: number; consumedUnits: number }): LowBalanceWarning[] {
  const { reservedUnits, consumedUnits } = params
  if (!Number.isFinite(reservedUnits) || reservedUnits <= 0) {
    throw new InterviewBillingError('reservedUnits must be a positive finite number', 'invalid_input')
  }
  if (!Number.isFinite(consumedUnits) || consumedUnits < 0) {
    throw new InterviewBillingError('consumedUnits must be a non-negative finite number', 'invalid_input')
  }

  const remainingUnits = Math.max(0, reservedUnits - consumedUnits)
  const consumedFraction = consumedUnits / reservedUnits
  const warnings: LowBalanceWarning[] = []

  const [eightyFraction, ninetyFraction] = LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS
  if (consumedFraction >= eightyFraction) warnings.push({ level: 'eighty_percent', remainingUnits })
  if (consumedFraction >= ninetyFraction) warnings.push({ level: 'ninety_percent', remainingUnits })

  const remainingMinutes = remainingUnits / INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units
  if (remainingMinutes <= LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING) {
    warnings.push({ level: 'ten_minutes_remaining', remainingUnits })
  }

  return warnings
}

// ── Provider-usage normalization (spec.md: "Provider records reconcile duration/tokens/cost; variance must remain below 1%.") ─

export interface ProviderUsageVariance {
  estimatedUnits: number
  actualUnits: number
  varianceRatio: number
  withinTolerance: boolean
}

const MAX_ACCEPTABLE_VARIANCE_RATIO = 0.01

/** Normalizes a provider's raw billed-seconds figure to integer credit units and compares it against the estimate that authorized the reservation. */
export function normalizeProviderUsageVariance(params: { providerBilledSeconds: number; estimatedUnits: number }): ProviderUsageVariance {
  const { providerBilledSeconds, estimatedUnits } = params
  if (!Number.isFinite(estimatedUnits) || estimatedUnits < 0) {
    throw new InterviewBillingError('estimatedUnits must be a non-negative finite number', 'invalid_input')
  }
  const actualUnits = estimateTranscriptionUnitsForSeconds(providerBilledSeconds)
  const varianceRatio = estimatedUnits === 0 ? (actualUnits === 0 ? 0 : 1) : Math.abs(actualUnits - estimatedUnits) / estimatedUnits
  return {
    estimatedUnits,
    actualUnits,
    varianceRatio,
    withinTolerance: varianceRatio < MAX_ACCEPTABLE_VARIANCE_RATIO,
  }
}
