import { randomId } from '~/lib/utils'
import {
  cancelPendingDeletion,
  findAccountEmail,
  findDeletionRequest,
  hardDeleteAccountSubject,
  insertAccountConsent,
  insertDeletionRequest,
  listAccountConsents,
  listExpiredPendingDeletionRequests,
  listOwnedOrganizations,
  loadAccountExportSource,
  updateDeletionRequest,
} from '~/shared/lib/repositories/account-privacy'
import { sendDeletionCompletedEmail } from '~/shared/lib/email'
import { log } from '~/shared/lib/log'

const CURRENT_VERSIONS = {
  tos: 'v1.0',
  privacy: 'v1.0',
  cookies: 'v1.0',
} as const

export type ConsentDocument = keyof typeof CURRENT_VERSIONS
export const CURRENT_CONSENT_VERSIONS = CURRENT_VERSIONS

export async function getConsentStatus(userId: string | null) {
  if (!userId) {
    return {
      userId: null as string | null,
      consents: {} as Record<string, string>,
      required: CURRENT_VERSIONS,
      needsAcceptance: Object.keys(CURRENT_VERSIONS) as ConsentDocument[],
    }
  }
  const rows = await listAccountConsents(userId)
  const consents: Record<string, string> = {}
  for (const row of rows) if (!consents[row.document]) consents[row.document] = row.version
  const needsAcceptance = Object.entries(CURRENT_VERSIONS)
    .filter(([document, version]) => consents[document] !== version)
    .map(([document]) => document as ConsentDocument)
  return { userId, consents, required: CURRENT_VERSIONS, needsAcceptance }
}

export function recordConsent(userId: string, document: ConsentDocument, version: string) {
  return insertAccountConsent({ id: randomId(), userId, document, version })
}

export async function buildExportPayload(userId: string) {
  const source = await loadAccountExportSource(userId)
  if (!source) return null
  const { trackedBuilders, plan, planChanges, planRequests, ...accountSubject } = source
  return {
    exportedAt: new Date().toISOString(),
    accountSubject,
    trackedBuilders,
    plan,
    planChanges,
    planRequests,
    tenantDataNotice: 'Organization resources require a separately authorized organization export.',
  }
}

export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000

export class AccountDeletionOwnershipError extends Error {
  readonly status = 409
  constructor(readonly organizationIds: string[]) {
    super('Transfer or delete owned organizations before deleting the account')
    this.name = 'AccountDeletionOwnershipError'
  }
}

export const getDeletionRequest = findDeletionRequest

export async function requestDeletion(userId: string) {
  await assertNoOwnedOrganizations(userId)
  const existing = await findDeletionRequest(userId)
  const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_MS)
  if (existing?.status === 'pending') {
    return { id: existing.id, gracePeriodEndsAt: existing.gracePeriodEndsAt, alreadyPending: true }
  }
  if (existing) {
    await updateDeletionRequest(existing.id, { status: 'pending', gracePeriodEndsAt, completedAt: null })
    return { id: existing.id, gracePeriodEndsAt, alreadyPending: false }
  }
  const id = randomId()
  await insertDeletionRequest({ id, userId, status: 'pending', gracePeriodEndsAt })
  return { id, gracePeriodEndsAt, alreadyPending: false }
}

export const cancelDeletion = cancelPendingDeletion

export async function performHardDelete(userId: string) {
  await assertNoOwnedOrganizations(userId)
  return hardDeleteAccountSubject(userId)
}

export interface ProcessPendingDeletionsResult {
  processed: number
  errors: number
}

/**
 * Executes the deletion right the request/grace-period flow only promises:
 * finds every `deletion_requests` row past its grace period, hard-deletes the
 * subject, then marks the compliance row `completed`. Meant to be invoked by
 * `POST /api/admin/legal/run-worker` on a daily cron — see plans/legal-and-compliance.
 * Idempotent: a request already completed/cancelled, or still within its grace
 * period, is never selected again.
 */
export async function processPendingDeletions(): Promise<ProcessPendingDeletionsResult> {
  const due = await listExpiredPendingDeletionRequests()
  let processed = 0
  let errors = 0
  for (const request of due) {
    try {
      // Capture the email before the hard delete removes the auth_users row.
      const email = await findAccountEmail(request.userId)
      await performHardDelete(request.userId)
      await updateDeletionRequest(request.id, { status: 'completed', completedAt: new Date() })
      processed++
      if (email) {
        // Best-effort — a failed send must not undo the completed deletion or
        // block the next request in this batch.
        try {
          const sent = await sendDeletionCompletedEmail(email)
          if (!sent.ok) log.error('legal.process_pending_deletions.email_failed', { error: sent.error, deletionRequestId: request.id })
        } catch (error) {
          log.error('legal.process_pending_deletions.email_failed', { error, deletionRequestId: request.id })
        }
      }
    } catch (error) {
      errors++
      log.error('legal.process_pending_deletions.failed', { error, deletionRequestId: request.id })
    }
  }
  return { processed, errors }
}

async function assertNoOwnedOrganizations(userId: string) {
  const owned = await listOwnedOrganizations(userId)
  if (owned.length > 0) throw new AccountDeletionOwnershipError(owned.map((row) => row.organizationId))
}
