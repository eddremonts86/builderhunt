/**
 * Deduplicated financial notifications (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Add financial
 * notifications, metrics, and alerts"). One sweep function, `runNotificationSweep`, covers all seven
 * message types the task names — renewal, grace, action-required, expiry-30/7/1 (three windows, one
 * message family), refund, dispute, reconciliation — using the SAME O(organizations) cross-org sweep
 * pattern `reconciliation.ts`/`operations-metrics.ts` already establish. Deliberately does NOT modify
 * any existing writer (`webhook-handlers.ts`, `refunds.ts`, `disputes.ts`, `reconciliation.ts`) — this
 * module only READS their tables and decides, per (organization, notification type, policy window),
 * whether a notification is due.
 *
 * The dedup mechanism is `billing_notification_log`'s unique index on
 * (organization_id, notification_type, window_key): `recordNotificationIfDue` does an
 * `ON CONFLICT DO NOTHING RETURNING` insert and the caller only sends the real email if a row was
 * actually inserted. This guarantees "one notification per policy window" even if the sweep runs more
 * than once inside the same window (e.g. a scheduler retry, or running twice in the same day) —
 * exactly what the task's time-travel test requirement is checking for.
 *
 * Window keys, one per message type:
 * - credit_expiry_30/7/1: `windowKey = grantId` (the notificationType itself distinguishes the
 *   bucket, so a grant can send at most one T-30, one T-7, and one T-1 notice — never more).
 * - subscription_renewal: `windowKey = "${subscriptionId}:${currentPeriodEnd date}"` — a NEW period
 *   end date is a genuinely new window, so a renewing subscription gets a fresh reminder every cycle.
 * - grace_period / action_required: `windowKey = "${subscriptionId}:${the marker timestamp}"` — tied
 *   to the specific grace/block INSTANCE (a subscription can enter grace more than once over its
 *   life; each instance gets exactly one notice).
 * - refund_decision: `windowKey = refundId` (a refund is decided once).
 * - dispute_opened: `windowKey = disputeId` (one notice per dispute).
 * - reconciliation_mismatch: platform-wide (organizationId = `'platform'`, no single tenant to scope
 *   to), `windowKey = runId` (one alert per non-clean run).
 *
 * This sweep requires an external scheduler to invoke it periodically (at least once daily, to catch
 * each exact expiry-day/renewal-day bucket) — same "no in-process cron in this bootstrap deployment"
 * pattern as `reconciliation.ts`/`worker.ts`.
 */
import { randomUUID } from 'node:crypto'
import { desc } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { platformDb } from '../db/client'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { billingNotificationLog, billingReconciliationRuns } from '../db/schema'
import {
  sendActionRequiredEmail,
  sendBillingPaymentFailedEmail,
  sendCreditExpiryNoticeEmail,
  sendDisputeNotificationEmail,
  sendRefundDecisionEmail,
  sendReconciliationAlertEmail,
  sendSubscriptionRenewalReminderEmail,
} from '../email'
import { getVerifiedBillingContact } from './billing-contact'
import { listOrganizationDisputes } from './disputes'
import { getCurrentSellerProfile } from './seller-profile'
import { isLiveMode } from './stripe-client'
import { findFullActiveBillingSubscription, findOrganizationOwnerEmail, listActiveBillingCreditGrants, listBillingRefunds } from '../repositories/billing'
import { listWorkerOrganizationIds, withWorkerOrganization } from '../repositories/billing-worker'

export type NotificationType =
  | 'credit_expiry_30'
  | 'credit_expiry_7'
  | 'credit_expiry_1'
  | 'subscription_renewal'
  | 'grace_period'
  | 'action_required'
  | 'refund_decision'
  | 'dispute_opened'
  | 'reconciliation_mismatch'

const DAY_MS = 24 * 60 * 60 * 1000

function daysUntil(target: Date, now: Date): number {
  return Math.floor((target.getTime() - now.getTime()) / DAY_MS)
}

type NotificationDb = WorkerTransaction | PostgresJsDatabase | typeof workerDb

/**
 * The general dedup primitive: returns `true` only the FIRST time this exact
 * (organizationId, notificationType, windowKey) combination is recorded — every subsequent call
 * for the same triple returns `false` and sends nothing. This is what a time-travel test exercises
 * directly: call twice with the same window, assert only the first returns `true`.
 */
export async function recordNotificationIfDue(
  db: NotificationDb,
  input: { organizationId: string; notificationType: NotificationType; windowKey: string },
): Promise<boolean> {
  const [row] = await db
    .insert(billingNotificationLog)
    .values({ id: randomUUID(), organizationId: input.organizationId, notificationType: input.notificationType, windowKey: input.windowKey })
    .onConflictDoNothing()
    .returning({ id: billingNotificationLog.id })
  return row !== undefined
}

/** The owner's account email, plus the verified billing contact's if one exists and differs — moved here (from `webhook-handlers.ts`) so both real webhook-driven sends and this sweep share one recipient-resolution rule instead of two copies. */
export async function billingNotificationRecipients(
  tx: WorkerTransaction,
  organizationId: string,
  authDbOverride?: PostgresJsDatabase,
): Promise<string[]> {
  const [ownerEmail, contact] = await Promise.all([
    findOrganizationOwnerEmail(organizationId, authDbOverride),
    getVerifiedBillingContact(tx, organizationId),
  ])
  const recipients = new Set<string>()
  if (ownerEmail) recipients.add(ownerEmail)
  if (contact) recipients.add(contact.email)
  return Array.from(recipients)
}

export interface NotificationSweepDeps {
  now?: () => Date
  worker?: Parameters<typeof withWorkerOrganization>[2]
  platform?: PostgresJsDatabase | typeof platformDb
  /** Test-only override for `findOrganizationOwnerEmail`'s auth-broker read — defaults to the real `authDb`. */
  authDb?: PostgresJsDatabase
}

export interface NotificationSweepResult {
  organizationsScanned: number
  sent: Record<NotificationType, number>
}

const EMPTY_SENT: Record<NotificationType, number> = {
  credit_expiry_30: 0,
  credit_expiry_7: 0,
  credit_expiry_1: 0,
  subscription_renewal: 0,
  grace_period: 0,
  action_required: 0,
  refund_decision: 0,
  dispute_opened: 0,
  reconciliation_mismatch: 0,
}

export async function runNotificationSweep(deps: NotificationSweepDeps = {}): Promise<NotificationSweepResult> {
  const now = (deps.now ?? (() => new Date()))()
  const platform = deps.platform ?? platformDb
  const worker = deps.worker ?? workerDb
  const livemode = isLiveMode()
  const organizationRows = await listWorkerOrganizationIds(deps.worker)
  const sent: Record<NotificationType, number> = { ...EMPTY_SENT }

  for (const { id: organizationId } of organizationRows) {
    await withWorkerOrganization(organizationId, async (transaction) => {
      const recipients = await billingNotificationRecipients(transaction, organizationId, deps.authDb)
      if (recipients.length === 0) return

      const grants = await listActiveBillingCreditGrants(transaction, organizationId)
      for (const grant of grants) {
        const days = daysUntil(grant.expiresAt, now)
        const bucket: NotificationType | null = days === 30 ? 'credit_expiry_30' : days === 7 ? 'credit_expiry_7' : days === 1 ? 'credit_expiry_1' : null
        if (!bucket) continue
        const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: bucket, windowKey: grant.id })
        if (!due) continue
        await Promise.all(recipients.map((to) => sendCreditExpiryNoticeEmail(to, { remainingUnits: grant.remainingUnits, daysUntilExpiry: days })))
        sent[bucket] += 1
      }

      const subscription = await findFullActiveBillingSubscription(transaction, organizationId, livemode)
      if (subscription) {
        if (subscription.currentPeriodEnd && !subscription.cancelAtPeriodEnd && daysUntil(subscription.currentPeriodEnd, now) === 7) {
          const windowKey = `${subscription.id}:${subscription.currentPeriodEnd.toISOString().slice(0, 10)}`
          const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: 'subscription_renewal', windowKey })
          if (due) {
            await Promise.all(recipients.map((to) => sendSubscriptionRenewalReminderEmail(to, { tier: subscription.tier, currentPeriodEnd: subscription.currentPeriodEnd! })))
            sent.subscription_renewal += 1
          }
        }

        if (subscription.gracePeriodEndsAt) {
          const windowKey = `${subscription.id}:${subscription.gracePeriodEndsAt.toISOString()}`
          const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: 'grace_period', windowKey })
          if (due) {
            await Promise.all(recipients.map((to) => sendBillingPaymentFailedEmail(to)))
            sent.grace_period += 1
          }
        }

        if (subscription.paymentBlockedAt) {
          const windowKey = `${subscription.id}:${subscription.paymentBlockedAt.toISOString()}`
          const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: 'action_required', windowKey })
          if (due) {
            await Promise.all(recipients.map((to) => sendActionRequiredEmail(to)))
            sent.action_required += 1
          }
        }
      }

      const refunds = await listBillingRefunds(transaction, organizationId)
      for (const refund of refunds) {
        if (refund.state !== 'succeeded' && refund.state !== 'failed') continue
        const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: 'refund_decision', windowKey: refund.id })
        if (!due) continue
        await Promise.all(recipients.map((to) => sendRefundDecisionEmail(to, { amountCents: refund.amountCents, state: refund.state })))
        sent.refund_decision += 1
      }

      const disputes = await listOrganizationDisputes(transaction, organizationId)
      for (const dispute of disputes) {
        const due = await recordNotificationIfDue(transaction, { organizationId, notificationType: 'dispute_opened', windowKey: dispute.id })
        if (!due) continue
        await Promise.all(recipients.map((to) => sendDisputeNotificationEmail(to, { amountCents: dispute.amountCents, evidenceDueBy: dispute.evidenceDueBy })))
        sent.dispute_opened += 1
      }
    }, deps.worker)
  }

  const [lastRun] = await platform
    .select({ id: billingReconciliationRuns.id, result: billingReconciliationRuns.result, windowEnd: billingReconciliationRuns.windowEnd, mismatches: billingReconciliationRuns.mismatches })
    .from(billingReconciliationRuns)
    .orderBy(desc(billingReconciliationRuns.createdAt))
    .limit(1)

  if (lastRun && lastRun.result !== 'clean') {
    const sellerProfile = await getCurrentSellerProfile(platform)
    const due = await recordNotificationIfDue(worker, { organizationId: 'platform', notificationType: 'reconciliation_mismatch', windowKey: lastRun.id })
    if (due && sellerProfile) {
      await sendReconciliationAlertEmail(sellerProfile.supportEmail, { result: lastRun.result, mismatchCount: lastRun.mismatches.length, windowEnd: lastRun.windowEnd.toISOString() })
      sent.reconciliation_mismatch += 1
    }
  }

  return { organizationsScanned: organizationRows.length, sent }
}
