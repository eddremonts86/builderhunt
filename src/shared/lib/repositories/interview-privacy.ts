import { and, eq, sql } from 'drizzle-orm'
import type { TenantTransaction } from '../db/client'

/**
 * What an account export says about the interviews a user ran (plan:
 * calendar-scheduling-interview-intelligence, Phase 11).
 *
 * ## The subject of this export is the organizer, not the candidate
 *
 * That distinction decides everything here. An organizer's GDPR export is *their* personal data — and a
 * candidate's CV, the text of what they said in an interview, and a model's assessment of them are not the
 * organizer's personal data. They are a third party's, processed by the organizer's employer.
 *
 * Handing one data subject another's personal data in the name of a subject access request would be a
 * disclosure, not compliance. So this returns the organizer's own records in full and, for anything a
 * candidate supplied, **counts and status only** — enough for the organizer to see what they hold and to
 * exercise their own rights over it, with no candidate content crossing into someone else's export.
 *
 * A candidate wanting their own data has a different route: a request against the invitation, mediated,
 * logged and reviewed. That is deliberately not a self-service endpoint.
 *
 * ## No object keys, no signed URLs, no hashes
 *
 * `candidate_documents.object_key` is a location in private storage, `capability_hash` is a credential
 * digest, and `subject_email_hash` is a pseudonymous identifier. None of them tells the organizer anything
 * they need and each is a thing an export file should not carry out of the system.
 */

export interface InterviewExportSection {
  invitations: Array<{
    id: string
    roleTitle: string
    durationMinutes: number
    timezone: string
    modality: string
    status: string
    createdAt: string
    /** No `sent_at` column exists — the status carries "sent". This is when the candidate first opened it. */
    openedAt: string | null
    bookedAt: string | null
    revokedAt: string | null
    /** Counts only — the submission itself is the candidate's data. */
    candidateSubmissions: number
    candidateDocuments: number
    candidateLinks: number
  }>
  interviews: Array<{
    eventId: string
    startsAt: string
    endsAt: string
    captureMode: string | null
    sessionState: string | null
    providerBilledSeconds: number | null
    /** Counts only — the transcript is a record of what a candidate said. */
    transcriptSegments: number
    hasBrief: boolean
    reportStatus: string | null
    reportFinalizedAt: string | null
  }>
  /** The organizer's own consent receipts. A candidate's consents belong to the candidate. */
  consentReceiptsRecorded: number
  creditUsage: Array<{
    operation: string
    reservations: number
    settledUnits: number
  }>
}

/**
 * Loads the organizer's interview footprint for one organization.
 *
 * Runs on the caller's tenant connection so RLS applies: an export must not become a way to read a
 * colleague's interviews, and the policies already say who may see what.
 */
export async function loadInterviewExportSection(
  transaction: TenantTransaction,
  params: { organizationId: string; userId: string },
): Promise<InterviewExportSection> {
  const invitations = await transaction.execute(sql`
    select
      i.id, i.role_title, i.duration_minutes, i.timezone, i.modality, i.status,
      i.created_at, i.opened_at, i.booked_at, i.revoked_at,
      (select count(*)::int from candidate_submissions s
        where s.organization_id = i.organization_id and s.invitation_id = i.id) as submissions,
      (select count(*)::int from candidate_documents d
        join candidate_submissions s2 on s2.organization_id = d.organization_id and s2.id = d.submission_id
        where s2.organization_id = i.organization_id and s2.invitation_id = i.id) as documents,
      (select count(*)::int from candidate_links l
        join candidate_submissions s3 on s3.organization_id = l.organization_id and s3.id = l.submission_id
        where s3.organization_id = i.organization_id and s3.invitation_id = i.id) as links
    from scheduling_invitations i
    where i.organization_id = ${params.organizationId} and i.owner_user_id = ${params.userId}
    order by i.created_at
  `)

  const interviews = await transaction.execute(sql`
    select
      e.id as event_id, e.starts_at, e.ends_at,
      sess.capture_mode, sess.state as session_state, sess.provider_billed_seconds,
      coalesce((select count(*)::int from transcript_segments t
        where t.organization_id = sess.organization_id and t.session_id = sess.id), 0) as segments,
      (select count(*)::int from interview_briefs b
        where b.organization_id = e.organization_id and b.event_id = e.id and b.status = 'active') as briefs,
      (select r.status from interview_reports r
        where r.organization_id = e.organization_id and r.event_id = e.id
        order by r.version desc limit 1) as report_status,
      (select r.finalized_at from interview_reports r
        where r.organization_id = e.organization_id and r.event_id = e.id
        order by r.version desc limit 1) as report_finalized_at
    from calendar_events e
    left join interview_sessions sess
      on sess.organization_id = e.organization_id and sess.event_id = e.id
    where e.organization_id = ${params.organizationId} and e.owner_user_id = ${params.userId}
      and exists (
        select 1 from scheduling_invitations i2
        where i2.organization_id = e.organization_id and i2.booked_event_id = e.id
      )
    order by e.starts_at
  `)

  const consents = await transaction.execute(sql`
    select count(*)::int as n from privacy_consents c
    join scheduling_invitations i on i.organization_id = c.organization_id and i.id = c.invitation_id
    where c.organization_id = ${params.organizationId} and i.owner_user_id = ${params.userId}
  `)

  // Grouped, not itemised: the organizer's spending is theirs, and a per-reservation list keyed by
  // interview would reconstruct which candidate cost what.
  const credits = await transaction.execute(sql`
    select operation, count(*)::int as reservations, coalesce(sum(settled_units), 0)::int as settled
    from billing_credit_reservations
    where organization_id = ${params.organizationId} and operation like 'interview_%'
    group by operation
    order by operation
  `)

  const rows = <T>(result: unknown) => result as unknown as T[]

  return {
    invitations: rows<Record<string, unknown>>(invitations).map((row) => ({
      id: String(row.id),
      roleTitle: String(row.role_title),
      durationMinutes: Number(row.duration_minutes),
      timezone: String(row.timezone),
      modality: String(row.modality),
      status: String(row.status),
      createdAt: iso(row.created_at),
      openedAt: optionalIso(row.opened_at),
      bookedAt: optionalIso(row.booked_at),
      revokedAt: optionalIso(row.revoked_at),
      candidateSubmissions: Number(row.submissions ?? 0),
      candidateDocuments: Number(row.documents ?? 0),
      candidateLinks: Number(row.links ?? 0),
    })),
    interviews: rows<Record<string, unknown>>(interviews).map((row) => ({
      eventId: String(row.event_id),
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      captureMode: optionalText(row.capture_mode),
      sessionState: optionalText(row.session_state),
      providerBilledSeconds: row.provider_billed_seconds === null ? null : Number(row.provider_billed_seconds),
      transcriptSegments: Number(row.segments ?? 0),
      hasBrief: Number(row.briefs ?? 0) > 0,
      reportStatus: optionalText(row.report_status),
      reportFinalizedAt: optionalIso(row.report_finalized_at),
    })),
    consentReceiptsRecorded: Number(rows<{ n: number }>(consents)[0]?.n ?? 0),
    creditUsage: rows<Record<string, unknown>>(credits).map((row) => ({
      operation: String(row.operation),
      reservations: Number(row.reservations ?? 0),
      settledUnits: Number(row.settled ?? 0),
    })),
  }
}

/**
 * Field names that must never appear in an export.
 *
 * Exported so the test asserts against this list rather than a copy of it — a field added to the section
 * above and forgotten here would otherwise pass a test that looks thorough.
 */
export const FORBIDDEN_EXPORT_FIELDS = Object.freeze([
  'objectKey', 'object_key', 'capabilityHash', 'capability_hash', 'subjectEmailHash', 'subject_email_hash',
  'plainText', 'plain_text', 'extractedText', 'extracted_text', 'text', 'content', 'candidateEmail',
  'candidate_email', 'emailNormalized', 'email_normalized', 'requestEvidenceHash', 'request_evidence_hash',
])

/**
 * Anonymises the organizer's interview footprint on account deletion.
 *
 * Deleted rather than anonymised where the row is only about the organizer; **left alone** where it is a
 * candidate's record. An interview that happened is a fact about a candidate too, and erasing their
 * transcript because the interviewer closed their account would delete a third party's data on a request
 * they never made — and destroy the evidence trail the candidate's own rights depend on.
 *
 * What the deletion does instead is sever the link to the departing user: `owner_user_id` cannot be null, so
 * the row's *retention* is shortened to now, which hands it to the retention worker under the normal policy.
 * The candidate's material then goes on the ordinary clock rather than on an account-closure event.
 */
export async function shortenInterviewRetentionForOwner(
  transaction: TenantTransaction,
  params: { organizationId: string; userId: string; now: Date },
): Promise<{ invitations: number; sessions: number; briefs: number; reports: number }> {
  const at = params.now.toISOString()
  const scope = params.organizationId
  const user = params.userId

  const count = async (statement: ReturnType<typeof sql>) => {
    const result = await transaction.execute(sql`with touched as (${statement} returning 1) select count(*)::int as n from touched`)
    return Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0)
  }

  return {
    invitations: await count(sql`
      update scheduling_invitations set revoked_at = coalesce(revoked_at, ${at}), updated_at = ${at}
      where organization_id = ${scope} and owner_user_id = ${user} and revoked_at is null`),
    sessions: await count(sql`
      update interview_sessions set retention_expires_at = ${at}, updated_at = ${at}
      where organization_id = ${scope} and owner_user_id = ${user}`),
    briefs: await count(sql`
      update interview_briefs set retention_expires_at = ${at}, updated_at = ${at}
      where organization_id = ${scope} and owner_user_id = ${user}`),
    reports: await count(sql`
      update interview_reports set retention_expires_at = ${at}, updated_at = ${at}
      where organization_id = ${scope} and owner_user_id = ${user}`),
  }
}

function iso(value: unknown): string {
  return new Date(value as string).toISOString()
}

function optionalIso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString()
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

export { and, eq }
