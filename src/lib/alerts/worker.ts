// Smart-alerts cron worker (Plan: smart-alerts, Phase 3).
//
// This is the piece that was missing entirely before this fix: `alerts.ts`
// had matcher/recording primitives (evaluateMatch, recordTrigger) but nothing
// ever called them outside of tests and a dev-only `/api/alerts/test-trigger`
// endpoint. This worker actually evaluates every enabled alert and records
// real triggers + sends real digest emails.
//
// There is no OS-level cron in this bootstrap deployment, so this is exposed
// via an admin-gated HTTP endpoint (`POST /api/admin/alerts/run-worker`)
// that an external scheduler (systemd timer, Coolify scheduled task, or a
// plain `curl` in a crontab) can hit every 12 hours, matching the plan's
// "running every 12 hours" cadence.
//
// Matching strategy (v1, given the current data model):
//   - Builder-watch alerts (triggerConditions.builderId set): re-check the
//     saved builder's `lastSeen` against the alert's `lastTriggeredAt` — if
//     it advanced, the builder had new activity.
//   - Keyword/global alerts: re-run the search pipeline with the alert's
//     keywords (same pipeline as recommendations.ts), then treat any
//     candidate that hasn't already produced a trigger for this alert
//     (deduped via alertTriggers.payload.sourceId) as a new match.
//
// Email digests are grouped per user and sent once per worker run via
// sendAlertDigestEmail (Resend if configured, dev-mode console log
// otherwise — same fallback pattern as the rest of the app).

import { db } from '~/shared/lib/db/index'
import { alerts, alertTriggers, builders, authUsers } from '~/shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { evaluateMatch, recordTrigger, type TriggerConditions } from '~/shared/lib/alerts'
import { searchBuilders } from '~/lib/search'
import { sendAlertDigestEmail, type AlertDigestItem } from '~/shared/lib/email'
import { log } from '~/shared/lib/log'

const MAX_NEW_TRIGGERS_PER_ALERT = 5

export interface AlertsWorkerResult {
  alertsEvaluated: number
  triggersCreated: number
  usersEmailed: number
  errors: string[]
}

export async function runAlertsWorker(): Promise<AlertsWorkerResult> {
  const result: AlertsWorkerResult = {
    alertsEvaluated: 0,
    triggersCreated: 0,
    usersEmailed: 0,
    errors: [],
  }

  const activeAlerts = await db.select().from(alerts).where(eq(alerts.enabled, true))

  // userId -> digest items to email at the end of the run
  const digestsByUser = new Map<string, AlertDigestItem[]>()
  const emailChannelByUser = new Map<string, boolean>()

  for (const alert of activeAlerts) {
    result.alertsEvaluated++
    try {
      const conditions = alert.triggerConditions as TriggerConditions
      const since = alert.lastTriggeredAt ?? alert.createdAt ?? new Date(0)
      const wantsEmail = (alert.deliveryChannel ?? 'email') === 'email'
      if (wantsEmail) emailChannelByUser.set(alert.userId, true)

      if (conditions.builderId) {
        // Single-builder watch
        const [builder] = await db
          .select()
          .from(builders)
          .where(and(eq(builders.id, conditions.builderId), eq(builders.userId, alert.userId)))
          .limit(1)
        if (!builder) continue
        if (builder.lastSeen && builder.lastSeen <= since) continue

        const matched = evaluateMatch(
          conditions,
          {
            followersCount: builder.followersCount ?? undefined,
            topics: builder.topics ?? [],
            bio: builder.bio,
            metadata: builder.metadata ?? {},
          },
          { type: conditions.eventType, payload: { sourceId: builder.sourceId, source: builder.source } },
        )
        if (!matched) continue

        await recordTrigger({
          alertId: alert.id,
          userId: alert.userId,
          builderId: builder.id,
          eventType: conditions.eventType,
          payload: {
            name: builder.displayName ?? builder.username,
            description: `${builder.source} · new activity from ${builder.username}`,
            sourceId: builder.sourceId,
            source: builder.source,
            username: builder.username,
          },
        })
        result.triggersCreated++
        if (wantsEmail) {
          pushDigest(digestsByUser, alert.userId, {
            alertName: alert.name,
            username: builder.username,
            displayName: builder.displayName,
            source: builder.source,
            profileUrl: builder.profileUrl,
            eventType: conditions.eventType,
          })
        }
        continue
      }

      // Global keyword/filter watch — re-run search with the alert's keywords
      const keywords = (conditions.keywords?.length ? conditions.keywords : alert.keywords) ?? []
      if (keywords.length === 0) continue

      const candidates = await searchBuilders({ keywords, perPage: 20 })

      // Dedup against triggers we've already recorded for this alert
      const priorTriggers = await db
        .select({ payload: alertTriggers.payload })
        .from(alertTriggers)
        .where(eq(alertTriggers.alertId, alert.id))
      const alreadySeen = new Set(
        priorTriggers
          .map((t) => (t.payload as Record<string, unknown>)?.sourceId)
          .filter((v): v is string => typeof v === 'string'),
      )

      let createdForThisAlert = 0
      for (const candidate of candidates) {
        if (createdForThisAlert >= MAX_NEW_TRIGGERS_PER_ALERT) break
        if (alreadySeen.has(candidate.sourceId)) continue

        const matched = evaluateMatch(
          conditions,
          {
            followersCount: candidate.followersCount ?? undefined,
            topics: candidate.topics ?? [],
            bio: candidate.bio,
            metadata: candidate.metadata ?? {},
          },
          { type: conditions.eventType === 'any_activity' ? 'any_activity' : conditions.eventType, payload: { sourceId: candidate.sourceId } },
        )
        if (!matched) continue

        await recordTrigger({
          alertId: alert.id,
          userId: alert.userId,
          builderId: null,
          eventType: conditions.eventType,
          payload: {
            name: candidate.displayName ?? candidate.username,
            description: `${candidate.source} · ${candidate.profileUrl}`,
            sourceId: candidate.sourceId,
            source: candidate.source,
            username: candidate.username,
            profileUrl: candidate.profileUrl,
          },
        })
        result.triggersCreated++
        createdForThisAlert++
        if (wantsEmail) {
          pushDigest(digestsByUser, alert.userId, {
            alertName: alert.name,
            username: candidate.username,
            displayName: candidate.displayName,
            source: candidate.source,
            profileUrl: candidate.profileUrl,
            eventType: conditions.eventType,
          })
        }
      }
    } catch (err) {
      const msg = `alert ${alert.id} failed: ${err instanceof Error ? err.message : String(err)}`
      result.errors.push(msg)
      log.error('alerts_worker_alert_failed', { alertId: alert.id, error: err })
    }
  }

  // Send one digest email per user with pending items
  for (const [userId, items] of digestsByUser) {
    if (items.length === 0) continue
    try {
      const [user] = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId)).limit(1)
      if (!user?.email) continue
      await sendAlertDigestEmail(user.email, items)
      result.usersEmailed++
    } catch (err) {
      result.errors.push(`digest email to user ${userId} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  log.info('alerts_worker_run', result as unknown as Record<string, unknown>)
  return result
}

function pushDigest(map: Map<string, AlertDigestItem[]>, userId: string, item: AlertDigestItem) {
  const list = map.get(userId) ?? []
  list.push(item)
  map.set(userId, list)
}
