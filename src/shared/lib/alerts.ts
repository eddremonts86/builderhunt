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

export const listTriggersForOrganization = listOrganizationTriggers
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
