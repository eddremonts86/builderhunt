import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { WorkerTransaction } from '../db/worker-db'
import {
  candidateDocuments,
  candidateLinks,
  candidateSubmissions,
  candidateWebImports,
  documentExtractions,
  interviewBriefs,
  interviewReports,
  interviewSessions,
  interviewSuggestions,
  privacyConsents,
  transcriptSegments,
} from '../db/schema'

/**
 * Retention deletion for interview material (plan:
 * calendar-scheduling-interview-intelligence, Phase 11).
 *
 * ## The sweep reads `retention_expires_at`, and never recomputes it
 *
 * Every one of these tables stores its own expiry, written when the row was created from the policy in
 * force *then*. A worker that recomputed the window from today's `INTERVIEW_*_RETENTION_DAYS` would move
 * every existing row's deadline whenever an operator changed a number — extending retention on data a
 * candidate was promised would be deleted, or deleting data still inside its promised window. So the
 * column is the authority and this module has no policy of its own.
 *
 * A shorter organization-level policy therefore needs no schema and no branch here: whatever wrote the row
 * writes a nearer expiry, and the sweep honours it.
 *
 * ## Deletion order is child-first, and the FKs would not save us
 *
 * `transcript_segments` and `interview_suggestions` carry composite FKs to `interview_sessions`;
 * `document_extractions` to `candidate_documents`; `candidate_web_imports` to `candidate_links`. Those are
 * `on delete cascade`, so a parent-first delete would *work* — and would silently take children whose own
 * expiry has not arrived. A transcript retained for 90 days must not vanish because its session row
 * happened to expire first. Child-first with each table's own predicate is what keeps the two windows
 * independent.
 *
 * ## Consent rows outlive everything they consented to, on purpose
 *
 * `privacy_consents` is swept on its own much longer clock (`INTERVIEW_CONSENT_RETENTION_MONTHS`). Deleting
 * the consent with the data would destroy the only evidence that the processing was lawful, which is the
 * one record a regulator asks for after the data is gone.
 */

export interface ExpiredDocument {
  id: string
  organizationId: string
  objectKey: string
}

/**
 * Documents whose retention has passed, with the object key the worker must delete first.
 *
 * The key comes back because the row is about to be deleted: reading it afterwards is impossible, and
 * deleting the row first would orphan the object in R2 with nothing left to find it by.
 */
export async function listExpiredDocuments(
  transaction: WorkerTransaction,
  params: { now: Date; limit: number },
): Promise<ExpiredDocument[]> {
  const rows = await transaction
    .select({
      id: candidateDocuments.id,
      organizationId: candidateDocuments.organizationId,
      objectKey: candidateDocuments.objectKey,
    })
    .from(candidateDocuments)
    .where(lte(candidateDocuments.retentionExpiresAt, params.now))
    .limit(params.limit)
  return rows
}

export interface RetentionCounts {
  transcriptSegments: number
  interviewSuggestions: number
  interviewSessions: number
  interviewReports: number
  interviewBriefs: number
  documentExtractions: number
  candidateDocuments: number
  candidateWebImports: number
  candidateLinks: number
  candidateSubmissions: number
  privacyConsents: number
}

export function emptyRetentionCounts(): RetentionCounts {
  return {
    transcriptSegments: 0,
    interviewSuggestions: 0,
    interviewSessions: 0,
    interviewReports: 0,
    interviewBriefs: 0,
    documentExtractions: 0,
    candidateDocuments: 0,
    candidateWebImports: 0,
    candidateLinks: 0,
    candidateSubmissions: 0,
    privacyConsents: 0,
  }
}

/**
 * Deletes the expired rows for one tenant, children before parents.
 *
 * `documentIds` is passed in rather than re-derived: the worker deleted those objects from storage already,
 * and re-querying could pick up a row that expired in the intervening milliseconds — whose object would
 * then be deleted from the database while still sitting in R2.
 */
export async function deleteExpiredInterviewData(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    now: Date
    /** Documents whose objects the worker has already removed from storage. */
    documentIds: readonly string[]
    consentCutoff: Date
    limit: number
  },
): Promise<RetentionCounts> {
  const counts = emptyRetentionCounts()
  const scope = params.organizationId

  counts.transcriptSegments = await deleteWhere(
    transaction,
    sql`delete from transcript_segments
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )
  counts.interviewSuggestions = await deleteWhere(
    transaction,
    sql`delete from interview_suggestions
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )
  // After its children, so a session whose transcript is still inside its own window survives — the FK
  // cascade would otherwise take that transcript with it.
  counts.interviewSessions = await deleteWhere(
    transaction,
    sql`delete from interview_sessions s
        where s.organization_id = ${scope} and s.retention_expires_at <= ${params.now.toISOString()}
          and not exists (
            select 1 from transcript_segments t
            where t.organization_id = s.organization_id and t.session_id = s.id
          )
          and not exists (
            select 1 from interview_suggestions g
            where g.organization_id = s.organization_id and g.session_id = s.id
          )`,
  )
  counts.interviewReports = await deleteWhere(
    transaction,
    sql`delete from interview_reports
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )
  counts.interviewBriefs = await deleteWhere(
    transaction,
    sql`delete from interview_briefs
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )
  counts.documentExtractions = await deleteWhere(
    transaction,
    sql`delete from document_extractions
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )

  if (params.documentIds.length > 0) {
    const deleted = await transaction
      .delete(candidateDocuments)
      .where(and(
        eq(candidateDocuments.organizationId, scope),
        inArray(candidateDocuments.id, [...params.documentIds]),
        // Re-checked inside the transaction: the list was read before the object deletions, and a row
        // whose expiry was pushed out in between must not be deleted on the strength of a stale read.
        lte(candidateDocuments.retentionExpiresAt, params.now),
      ))
      .returning({ id: candidateDocuments.id })
    counts.candidateDocuments = deleted.length
  }

  counts.candidateWebImports = await deleteWhere(
    transaction,
    sql`delete from candidate_web_imports
        where organization_id = ${scope} and retention_expires_at <= ${params.now.toISOString()}`,
  )
  // `candidate_links` has **no** `retention_expires_at` — measured, not assumed: the query written against
  // one failed with `column "retention_expires_at" does not exist`. A link's retention is its submission's,
  // inherited through the composite FK. So the predicate is the *submission's* clock, and a link whose web
  // import is still inside its own window survives to keep that import's parent alive.
  counts.candidateLinks = await deleteWhere(
    transaction,
    sql`delete from candidate_links l
        where l.organization_id = ${scope}
          and exists (
            select 1 from candidate_submissions s
            where s.organization_id = l.organization_id and s.id = l.submission_id
              and s.retention_expires_at <= ${params.now.toISOString()}
          )
          and not exists (
            select 1 from candidate_web_imports w
            where w.organization_id = l.organization_id and w.candidate_link_id = l.id
          )`,
  )
  // Last of the candidate tables: a submission is the parent of both documents and links, and its cascade
  // would take any child still inside its own window.
  counts.candidateSubmissions = await deleteWhere(
    transaction,
    sql`delete from candidate_submissions s
        where s.organization_id = ${scope} and s.retention_expires_at <= ${params.now.toISOString()}
          and not exists (
            select 1 from candidate_documents d
            where d.organization_id = s.organization_id and d.submission_id = s.id
          )
          and not exists (
            select 1 from candidate_links l
            where l.organization_id = s.organization_id and l.submission_id = s.id
          )`,
  )

  // A much longer clock, and deliberately independent: the consent is the evidence that the processing was
  // lawful, and it is the one record still worth having after the data it covered is gone.
  counts.privacyConsents = await purgeExpiredConsents(transaction, scope, params.consentCutoff)

  return counts
}

/** `execute` returns no count in this driver, so the affected rows are counted explicitly. */
/**
 * Consent evidence is the one thing here that no role may DELETE — 0075 withheld the privilege from
 * everyone on purpose, so that "the candidate withdrew" and "the row was removed" stay
 * distinguishable. The purge therefore goes through `purge_expired_privacy_consents` (0099), which
 * runs under the owning role and can only express "this tenant's evidence, older than X" — the
 * window itself stays configuration (`INTERVIEW_CONSENT_RETENTION_MONTHS`, capped at 24 months by
 * `env.ts`), since 24 months is a ceiling on retention and a shorter window is the stricter choice.
 *
 * Issuing the DELETE from here directly, as this function used to, is denied with 42501 — and since
 * it shares a transaction with every other statement in the pass, that denial silently took the
 * whole retention run with it while the endpoint still reported success.
 */
async function purgeExpiredConsents(
  transaction: WorkerTransaction,
  organizationId: string,
  cutoff: Date,
): Promise<number> {
  const result = await transaction.execute(
    sql`select purge_expired_privacy_consents(${organizationId}, ${cutoff.toISOString()}::timestamptz) as n`,
  )
  const rows = result as unknown as Array<{ n: number }>
  return Number(rows[0]?.n ?? 0)
}

async function deleteWhere(transaction: WorkerTransaction, statement: ReturnType<typeof sql>): Promise<number> {
  const result = await transaction.execute(sql`with deleted as (${statement} returning 1) select count(*)::int as n from deleted`)
  const rows = result as unknown as Array<{ n: number }>
  return Number(rows[0]?.n ?? 0)
}

/** Tenants with anything expired, so the worker leases per organization rather than scanning globally. */
export async function listTenantsWithExpiredInterviewData(
  transaction: WorkerTransaction,
  params: { now: Date; consentCutoff: Date; limit: number },
): Promise<string[]> {
  const rows = await transaction.execute(sql`
    select distinct organization_id from (
      select organization_id from transcript_segments where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from interview_suggestions where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from interview_sessions where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from interview_reports where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from interview_briefs where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from document_extractions where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from candidate_documents where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from candidate_web_imports where retention_expires_at <= ${params.now.toISOString()}
      -- No candidate_links row here: that table has no retention column, so a link only becomes due when
      -- its submission does, and the submission is already in this union.
      union all select organization_id from candidate_submissions where retention_expires_at <= ${params.now.toISOString()}
      union all select organization_id from privacy_consents where decided_at <= ${params.consentCutoff.toISOString()}
    ) expired
    limit ${params.limit}
  `)
  return (rows as unknown as Array<{ organization_id: string }>).map((row) => String(row.organization_id))
}

/**
 * Interview reservations left `reserved` past their deadline.
 *
 * Scoped to `interview_%` operations on purpose: this worker has no business closing another feature's
 * reservations, and a sweep that did would be a second billing worker wearing a retention hat.
 */
export async function listStaleInterviewReservations(
  transaction: WorkerTransaction,
  params: { now: Date; limit: number },
): Promise<Array<{ id: string; organizationId: string; operation: string }>> {
  const rows = await transaction.execute(sql`
    select id, organization_id, operation
    from billing_credit_reservations
    where state = 'reserved'
      and operation like 'interview_%'
      and deadline_at <= ${params.now.toISOString()}
    limit ${params.limit}
  `)
  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    operation: String(row.operation),
  }))
}

export { privacyConsents }
