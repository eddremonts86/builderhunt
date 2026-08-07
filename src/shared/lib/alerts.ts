import { randomId } from '~/lib/utils'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  listOrganizationTriggers,
  markOrganizationTriggerRead,
  recordOrganizationTrigger,
  unreadOrganizationTriggerCount,
  type AlertTriggerRecord,
} from '~/shared/lib/repositories/organization-alerts'
import { log } from './log'

export type TriggerEventType = 'new_repo' | 'new_product' | 'keyword_match' | 'any_activity'
export type DeliveryChannel = 'email' | 'dashboard'

export interface TriggerConditions {
  eventType: TriggerEventType
  minStars?: number
  minFollowers?: number
  keywords?: string[]
  builderId?: string
}

export type { AlertTriggerRecord }

// The match-payload contract lives in `alerts-shared.ts` — this module pulls
// in `node:crypto` and the tenant DB repositories, so the inbox UI cannot
// import from here. Re-exported for server-side callers' convenience.
export { readAlertMatchPayload, type AlertMatchPayload } from './alerts-shared'

export async function recordTrigger(
  transaction: TenantTransaction,
  input: {
    organizationId: string
    alertId: string
    userId: string
    builderId: string | null
    eventType: string
    payload: Record<string, unknown>
  },
) {
  const trigger = await recordOrganizationTrigger(transaction, { id: randomId(), ...input })
  if (trigger) {
    log.info('alert_triggered', {
      organizationId: input.organizationId,
      alertId: input.alertId,
      eventType: input.eventType,
      builderId: input.builderId,
    })
  }
  return trigger
}

export function evaluateMatch(
  conditions: TriggerConditions,
  builder: {
    followersCount?: number
    topics?: string[]
    bio?: string | null
    metadata?: Record<string, unknown>
  },
  event: { type: string; payload: Record<string, unknown> },
) {
  if (conditions.eventType !== 'any_activity' && conditions.eventType !== event.type) return false
  if (conditions.builderId) return true
  if (conditions.minStars != null && (builder.followersCount ?? 0) < conditions.minStars) return false
  if (conditions.minFollowers != null && (builder.followersCount ?? 0) < conditions.minFollowers) return false
  if (conditions.keywords?.length) {
    const haystack = [...(builder.topics ?? []), builder.bio ?? '', JSON.stringify(event.payload)]
      .join(' ')
      .toLowerCase()
    if (!conditions.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) return false
  }
  return true
}

export const markTriggerRead = markOrganizationTriggerRead
export const unreadTriggerCount = unreadOrganizationTriggerCount

export type AlertFrequency = 'hourly' | 'daily' | 'weekly'

// Slightly under the nominal window so an alert due right at the boundary
// isn't skipped for a full extra cycle by cron jitter or a slow worker run
// (e.g. a "daily" alert checked at 23:55 yesterday should still run today).
const FREQUENCY_WINDOW_MS: Record<AlertFrequency, number> = {
  hourly: 55 * 60 * 1000, // 55 min
  daily: 20 * 60 * 60 * 1000, // 20 h
  weekly: 6.5 * 24 * 60 * 60 * 1000, // 6.5 days
}

/**
 * Plan: smart-alerts Phase 1. Pure — whether the worker should re-evaluate
 * this alert on this pass. Never checked yet (`lastCheckedAt === null`) is
 * always due, so a freshly created alert doesn't wait out its first window.
 */
export function isDueForCheck(frequency: AlertFrequency, lastCheckedAt: Date | null, now: Date): boolean {
  if (lastCheckedAt === null) return true
  return now.getTime() - lastCheckedAt.getTime() >= FREQUENCY_WINDOW_MS[frequency]
}

// ── Honest evaluation timing (plan: calendar-scheduling-interview-intelligence, Phase 4) ──────

/** First retry delay after a failure. Doubles per consecutive failure, capped at the frequency window. */
const RETRY_BASE_MS = 5 * 60 * 1000

/**
 * When the worker intends to evaluate this alert next.
 *
 * On success the answer is simply one frequency window out. On failure it is a short exponential
 * backoff instead, because a failed evaluation produced no result at all: advancing to the full
 * window would mean a transient error silences a *weekly* alert for a week. The backoff is capped at
 * the window so a persistently broken alert never checks less often than a healthy one would — the
 * cap is what stops backoff from turning a bug into an indefinite outage.
 *
 * The returned value is a *checking* time. It never asserts that a match will exist then; the
 * calendar feed labels it accordingly.
 */
export function computeNextEvaluationAt(
  frequency: AlertFrequency,
  evaluatedAt: Date,
  consecutiveFailures: number,
): Date {
  const window = FREQUENCY_WINDOW_MS[frequency]
  if (consecutiveFailures <= 0) return new Date(evaluatedAt.getTime() + window)

  // 2^(n-1) grows fast enough that clamping the exponent keeps the shift well inside Number range
  // before `Math.min` ever runs; without the clamp a long-broken alert overflows to Infinity and
  // produces an invalid Date rather than the capped window.
  const exponent = Math.min(consecutiveFailures - 1, 40)
  const backoff = RETRY_BASE_MS * 2 ** exponent
  return new Date(evaluatedAt.getTime() + Math.min(backoff, window))
}

export interface AlertEvaluationOutcome {
  /** `false` means the evaluation itself failed — not that it ran and found nothing. */
  succeeded: boolean
  /** Short stable code; never a provider message. Ignored when `succeeded`. */
  errorCode?: string | null
}

/**
 * The full timing state to persist after one evaluation attempt.
 *
 * Returned as one object so the caller writes it in a single UPDATE. Writing `lastCheckedAt` and
 * `nextEvaluationAt` separately would leave a window where the feed shows a next run derived from
 * the previous attempt's failure count.
 */
export function nextAlertTimingState(
  frequency: AlertFrequency,
  evaluatedAt: Date,
  previousConsecutiveFailures: number,
  outcome: AlertEvaluationOutcome,
) {
  const consecutiveFailures = outcome.succeeded ? 0 : previousConsecutiveFailures + 1
  return {
    lastCheckedAt: evaluatedAt,
    nextEvaluationAt: computeNextEvaluationAt(frequency, evaluatedAt, consecutiveFailures),
    consecutiveFailures,
    // Cleared on success so a stale code never lingers next to a healthy alert.
    lastEvaluationErrorCode: outcome.succeeded ? null : redactedAlertErrorCode(outcome.errorCode),
  }
}

/**
 * Whether the worker should evaluate this alert on this pass.
 *
 * Prefers the persisted `nextEvaluationAt` when present, because that is the worker's own recorded
 * intent — including a shortened retry after a failure, which recomputing from `frequency` alone
 * would flatten back to a full window and undo the backoff. Rows that predate the column (or a
 * freshly created alert) fall back to the frequency window, so the migration needed no backfill.
 */
export function isDueForEvaluation(
  alert: { frequency: string | null; lastCheckedAt: Date | null; nextEvaluationAt: Date | null },
  now: Date,
): boolean {
  if (alert.nextEvaluationAt !== null) return now.getTime() >= alert.nextEvaluationAt.getTime()
  return isDueForCheck((alert.frequency ?? 'daily') as AlertFrequency, alert.lastCheckedAt, now)
}

/** Keeps the persisted code to a short slug — this column is rendered in the alerts UI. */
export function redactedAlertErrorCode(code: string | null | undefined): string {
  if (typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)) return code
  return 'evaluation_failed'
}
