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
  listOwnedOrganizationsWithOtherMembers,
  loadAccountExportSource,
  updateDeletionRequest,
} from '~/shared/lib/repositories/account-privacy'
import { sendDeletionCompletedEmail } from '~/shared/lib/email'
import { log } from '~/shared/lib/log'

const CURRENT_VERSIONS = {
  tos: 'v1.0',
  // v1.1 (2026-07-25): added the "Device recognition data" disclosure (abuse-and-usage-integrity
  // Phase 6) — a clarification of processing already covered by section 2(c)'s existing "prevent
  // abuse" purpose, not a new category of processing, so this is a minor bump: existing acceptances
  // of v1.0 remain valid (see `isMaterialVersionChange`).
  privacy: 'v1.1',
  cookies: 'v1.0',
} as const

export type ConsentDocument = keyof typeof CURRENT_VERSIONS
export const CURRENT_CONSENT_VERSIONS = CURRENT_VERSIONS

export interface ParsedDocumentVersion {
  major: number
  minor: number
}

/** Versions are `v<major>.<minor>` (e.g. `v1.0`, `v1.1`, `v2.0`). Returns null for anything else. */
export function parseDocumentVersion(version: string): ParsedDocumentVersion | null {
  const match = /^v(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * A major bump (`v1.x` -> `v2.0`) is a material change to a legal document — plans/stripe-billing-platform/
 * spec.md: "Material changes require fresh acceptance." A minor bump (`v1.0` -> `v1.1`, e.g. a typo or
 * clarification) is not: an existing acceptance of an earlier minor version stays valid. An unparseable
 * version on either side is always treated as material — fail closed, never silently skip reacceptance
 * because a version string didn't match the expected shape.
 */
export function isMaterialVersionChange(previousVersion: string, currentVersion: string): boolean {
  if (previousVersion === currentVersion) return false
  const previous = parseDocumentVersion(previousVersion)
  const current = parseDocumentVersion(currentVersion)
  if (!previous || !current) return true
  return previous.major !== current.major
}

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
  // Exact-version equality would demand fresh acceptance for a typo fix. `isMaterialVersionChange`
  // is the documented rule (major bump only), and it is what the billing consent gate already uses
  // — the two must not disagree about whether a user has accepted the current terms.
  const needsAcceptance = Object.entries(CURRENT_VERSIONS)
    .filter(([document, version]) => {
      const accepted = consents[document]
      if (accepted === undefined) return true
      return isMaterialVersionChange(accepted, version)
    })
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

export interface BlockingOrganization {
  organizationId: string
  organizationName: string
}

export class AccountDeletionOwnershipError extends Error {
  readonly status = 409
  constructor(readonly organizations: BlockingOrganization[]) {
    super('Transfer ownership of your organizations before deleting your account')
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
  const owned = await listOwnedOrganizationsWithOtherMembers(userId)
  if (owned.length > 0) throw new AccountDeletionOwnershipError(owned)
}
