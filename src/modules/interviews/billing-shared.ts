/**
 * Interview usage arithmetic, and nothing else (plan: calendar-scheduling-interview-intelligence,
 * spec.md "Usage credits and pricing" + "Enforcement").
 *
 * **This file exists so a browser can import it.** `CreditBalance` renders a low-balance warning, which
 * needs `resolveLowBalanceWarnings` — and when these functions lived alongside `withInterviewCredits`, that
 * one import dragged `feature-authorization` → the tenant repositories → `db/client` → the `postgres`
 * driver into the client bundle. `postgres` calls `Buffer.allocUnsafe` at module scope, so the browser
 * threw `Buffer is not defined` before any of the app's JavaScript ran: no hydration, no navigation, no
 * theme toggle. The page rendered from SSR and then did nothing.
 *
 * So the split is not tidiness. It is the same rule `src/routes/_dashboard/alerts.tsx` already documents
 * for `alerts-shared`: a module a component imports may not reach the database layer, however indirectly.
 * `tests/unit/modules/interviews/billing-shared.test.ts` asserts this file's import graph stays clean.
 *
 * Pure — no I/O and no reservation state of its own. The reserve/extend/settle/release authority stays
 * entirely with the billing platform's contracts, in the server-only `billing.ts` next door.
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

// ── Reserve-and-settle wrapper (plan Phase 7: "Wrap every interview provider boundary in reserve
//    and settlement") ─────────────────────────────────────────────────────────────────────────────

import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  FeatureBillingError,
  checkEntitlement,
  extendReservation,
  releaseReservation,
  reserveCredits,
  settleReservation,
} from '~/shared/lib/billing/feature-authorization'
import { getInterviewRateCardKey, type InterviewRateCardOperation } from '~/shared/lib/interview-config'

/**
 * What the provider-backed work is handed. Everything it needs to stay inside the budget that was
 * approved, and nothing that would let it approve more on its own.
 */
