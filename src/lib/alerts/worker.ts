import { searchBuilders } from '~/lib/search'
import { randomId } from '~/lib/utils'
import { evaluateMatch, isDueForEvaluation, type AlertMatchPayload, type TriggerConditions } from '~/shared/lib/alerts'
import { sendAlertDigestEmail, type AlertDigestItem } from '~/shared/lib/email'
import { log } from '~/shared/lib/log'
import {
  findWorkerBuilder,
  findWorkerUserEmail,
  listEnabledWorkerAlerts,
  listWorkerOrganizationIds,
  listWorkerSeenSourceIds,
  markWorkerAlertEvaluated,
  recordWorkerTrigger,
  withWorkerOrganization,
} from '~/shared/lib/repositories/alerts-worker'

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
  const digestsByUser = new Map<string, AlertDigestItem[]>()
  const organizations = await listWorkerOrganizationIds()

  for (const { id: organizationId } of organizations) {
    const activeAlerts = await withWorkerOrganization(organizationId, (tx) =>
      listEnabledWorkerAlerts(tx, organizationId),
    )
    for (const alert of activeAlerts) {
      // Reads the persisted next-evaluation intent when there is one, so a failure's backoff is
      // honored instead of being flattened back to a full frequency window.
      if (!isDueForEvaluation(alert, new Date())) continue
      result.alertsEvaluated++
      // Tracked per alert so the `finally` below can record whether THIS evaluation succeeded.
      // Without it, a failure would advance the alert a full frequency window as if it had run
      // cleanly, and a weekly alert would go silent for a week over one transient error.
      let evaluationSucceeded = true
      let evaluationErrorCode: string | null = null
      try {
        const conditions = alert.triggerConditions as TriggerConditions
        const wantsEmail = (alert.deliveryChannel ?? 'email') === 'email'
        if (conditions.builderId) {
          const builder = await withWorkerOrganization(organizationId, (tx) =>
            findWorkerBuilder(tx, organizationId, conditions.builderId as string),
          )
          const since = alert.lastTriggeredAt ?? alert.createdAt ?? new Date(0)
          if (!builder || (builder.lastSeen && builder.lastSeen <= since)) continue
          if (!evaluateMatch(
            conditions,
            {
              followersCount: builder.followersCount ?? undefined,
              topics: builder.topics ?? [],
              bio: builder.bio,
              metadata: builder.metadata ?? {},
            },
            { type: conditions.eventType, payload: { sourceId: builder.sourceId, source: builder.source } },
          )) continue

          await withWorkerOrganization(organizationId, (tx) => recordWorkerTrigger(tx, {
            id: randomId(),
            organizationId,
            alertId: alert.id,
            userId: alert.userId,
            builderId: builder.id,
            eventType: conditions.eventType,
            payload: {
              name: builder.displayName ?? builder.username,
              description: `New activity from ${builder.username}`,
              sourceId: builder.sourceId,
              source: builder.source,
              username: builder.username,
              // This branch used to omit `profileUrl` entirely, which left the
              // inbox unable to render the person at all (see
              // `readAlertMatchPayload`, which requires it).
              profileUrl: builder.profileUrl,
              displayName: builder.displayName ?? null,
              avatarUrl: builder.avatarUrl ?? null,
              bio: builder.bio ?? null,
              followersCount: builder.followersCount ?? undefined,
              language: builder.language ?? null,
              country: builder.country ?? null,
              topics: builder.topics ?? [],
            } satisfies AlertMatchPayload,
          }))
          result.triggersCreated++
          if (wantsEmail) pushDigest(digestsByUser, alert.userId, {
            alertName: alert.name,
            username: builder.username,
            displayName: builder.displayName,
            source: builder.source,
            profileUrl: builder.profileUrl,
            eventType: conditions.eventType,
          })
          continue
        }

        const keywords = (conditions.keywords?.length ? conditions.keywords : alert.keywords) ?? []
        if (keywords.length === 0) continue
        const [searchResults, alreadySeen] = await Promise.all([
          searchBuilders({ keywords, perPage: 20 }),
          withWorkerOrganization(organizationId, (tx) =>
            listWorkerSeenSourceIds(tx, organizationId, alert.id),
          ),
        ])
        // `searchBuilders` returns both people and repositories; an alert is
        // about *builders*, so drop the repo rows — otherwise the inbox fills
        // up with project names ("symfony", "bagisto") that a recruiter can
        // neither track nor contact. Every other consumer of this function
        // already filters the same way (sprints/discovery workers,
        // SearchPage, public radars, explore) — this worker was the one
        // place that didn't.
        const candidates = searchResults.filter((builder) => builder.kind === 'person')
        let createdForAlert = 0
        for (const candidate of candidates) {
          if (createdForAlert >= MAX_NEW_TRIGGERS_PER_ALERT) break
          if (alreadySeen.has(candidate.sourceId)) continue
          if (!evaluateMatch(
            conditions,
            {
              followersCount: candidate.followersCount ?? undefined,
              topics: candidate.topics ?? [],
              bio: candidate.bio,
              metadata: candidate.metadata ?? {},
            },
            {
              type: conditions.eventType === 'any_activity' ? 'any_activity' : conditions.eventType,
              payload: { sourceId: candidate.sourceId },
            },
          )) continue
          const matchPayload: AlertMatchPayload = {
            name: candidate.displayName ?? candidate.username,
            description: candidate.bio ?? '',
            source: candidate.source,
            sourceId: candidate.sourceId,
            username: candidate.username,
            profileUrl: candidate.profileUrl,
            displayName: candidate.displayName ?? null,
            avatarUrl: candidate.avatarUrl ?? null,
            bio: candidate.bio ?? null,
            followersCount: candidate.followersCount ?? undefined,
            language: candidate.language ?? null,
            country: candidate.country ?? null,
            topics: candidate.topics ?? [],
            score: candidate.score,
          }
          await withWorkerOrganization(organizationId, (tx) => recordWorkerTrigger(tx, {
            id: randomId(),
            organizationId,
            alertId: alert.id,
            userId: alert.userId,
            builderId: null,
            // Deliberately `keyword_match`, NOT `conditions.eventType`. This
            // branch runs a keyword search and reports who it found — it does
            // not detect repo/product events at all (real event detection is
            // still unbuilt; see smart-alerts' "Future" section). Echoing the
            // alert's condition back made the inbox label a person row "New
            // repository" for an event nobody observed. Recording what
            // actually happened keeps the inbox honest.
            eventType: 'keyword_match',
            payload: { ...matchPayload },
          }))
          alreadySeen.add(candidate.sourceId)
          result.triggersCreated++
          createdForAlert++
          if (wantsEmail) pushDigest(digestsByUser, alert.userId, {
            alertName: alert.name,
            username: candidate.username,
            displayName: candidate.displayName,
            source: candidate.source,
            profileUrl: candidate.profileUrl,
            eventType: conditions.eventType,
          })
        }
      } catch (error) {
        evaluationSucceeded = false
        // The persisted column gets a short slug (it renders in the alerts UI); the admin-only
        // worker response keeps the full message, which is where an operator needs it.
        evaluationErrorCode = error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : null
        result.errors.push(`alert ${alert.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        log.error('alerts_worker_alert_failed', { organizationId, alertId: alert.id, error })
      } finally {
        await withWorkerOrganization(organizationId, (tx) => markWorkerAlertEvaluated(
          tx,
          organizationId,
          { id: alert.id, frequency: alert.frequency, consecutiveFailures: alert.consecutiveFailures },
          { succeeded: evaluationSucceeded, errorCode: evaluationErrorCode },
        ))
      }
    }
  }

  for (const [userId, items] of digestsByUser) {
    if (items.length === 0) continue
    try {
      const email = await findWorkerUserEmail(userId)
      if (!email) continue
      await sendAlertDigestEmail(email, items)
      result.usersEmailed++
    } catch (error) {
      result.errors.push(`digest email failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log.info('alerts_worker_run', result as unknown as Record<string, unknown>)
  return result
}

function pushDigest(map: Map<string, AlertDigestItem[]>, userId: string, item: AlertDigestItem) {
  const items = map.get(userId) ?? []
  items.push(item)
  map.set(userId, items)
}
