import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import type { CapabilityTransaction } from '../db/capability-db'
import { candidateLinks, candidateWebImports, organizations } from '../db/schema'

/**
 * Data access for candidate link imports (plan:
 * calendar-scheduling-interview-intelligence, Phase 6, "Implement policy-controlled public-web
 * import").
 *
 * ## Two tables, two owners
 *
 * `candidate_links` is the candidate's: they add the URL, they attest to owning it, they ask for the
 * import. `builderhunt_capability` holds SELECT/INSERT/UPDATE on it (0078), so those writes need no
 * privileged path — unlike documents, where the completion UPDATE does.
 *
 * `candidate_web_imports` is the worker's. The capability role has no grant on it at all (0085), and
 * that is the right shape: the import record says what we fetched, when, whether robots allowed it,
 * and what the response hashed to. It is an audit trail of *our* outbound behaviour, and a subject of
 * that trail should not be able to write it.
 *
 * ## `queued` is the only thing a candidate can ask for
 *
 * A candidate can move a link to `queued`; only the worker moves it on to `running`, `succeeded` or
 * `failed`. Letting a client name a terminal state would let it claim an import happened, and the
 * evidence a brief later cites would rest on the subject's own assertion.
 */

export type ImportTransaction = WorkerTransaction | CapabilityTransaction

export function listWorkerOrganizationIds(db: PostgresJsDatabase | typeof workerDb = workerDb) {
  return db.select({ id: organizations.id }).from(organizations)
}

export function withWorkerOrganization<TResult>(
  organizationId: string,
  operation: (transaction: WorkerTransaction) => Promise<TResult>,
  db: PostgresJsDatabase | typeof workerDb = workerDb,
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      select
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.organization_role', 'worker', true),
        set_config('app.request_id', ${randomUUID()}, true)
    `)
    return operation(transaction as WorkerTransaction)
  })
}

export interface CandidateLinkRow {
  id: string
  organizationId: string
  submissionId: string
  url: string
  normalizedUrl: string
  sourceType: string
  acquisitionMode: string
  policyDecision: string
  importState: string
  authorizationNoticeVersion: string | null
  authorizationAttestedAt: Date | null
}

const LINK_COLUMNS = {
  id: candidateLinks.id,
  organizationId: candidateLinks.organizationId,
  submissionId: candidateLinks.submissionId,
  url: candidateLinks.url,
  normalizedUrl: candidateLinks.normalizedUrl,
  sourceType: candidateLinks.sourceType,
  acquisitionMode: candidateLinks.acquisitionMode,
  policyDecision: candidateLinks.policyDecision,
  importState: candidateLinks.importState,
  authorizationNoticeVersion: candidateLinks.authorizationNoticeVersion,
  authorizationAttestedAt: candidateLinks.authorizationAttestedAt,
}

/** One link, scoped to the submission — the candidate cannot address another candidate's link. */
export async function findLinkForSubmission(
  transaction: ImportTransaction,
  params: { organizationId: string; submissionId: string; linkId: string },
): Promise<CandidateLinkRow | null> {
  const [row] = await transaction
    .select(LINK_COLUMNS)
    .from(candidateLinks)
    .where(and(
      eq(candidateLinks.organizationId, params.organizationId),
      eq(candidateLinks.submissionId, params.submissionId),
      eq(candidateLinks.id, params.linkId),
    ))
    .limit(1)
  return row ?? null
}

/**
 * Records the attestation and the policy decision it produced, queueing the import when permitted.
 *
 * The attestation timestamp and the decision are written together because the database will not
 * accept them apart: `candidate_links_attestation_check` refuses an `authorized_crawl` decision
 * without a versioned attestation on file. Two statements could commit the decision and lose the
 * attestation, and the check would reject the pair rather than let the row exist half-formed — which
 * is the constraint doing its job, but only because they are written as one act.
 */
export async function recordLinkPolicyDecision(
  transaction: ImportTransaction,
  params: {
    organizationId: string
    linkId: string
    policyDecision: 'official_api' | 'authorized_crawl' | 'user_submitted' | 'not_importable'
    importState: 'not_requested' | 'queued' | 'not_importable'
    attestedNoticeVersion: string | null
    attestedAt: Date | null
  },
) {
  return transaction
    .update(candidateLinks)
    .set({
      policyDecision: params.policyDecision,
      importState: params.importState,
      authorizationNoticeVersion: params.attestedNoticeVersion,
      authorizationAttestedAt: params.attestedAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(candidateLinks.organizationId, params.organizationId),
      eq(candidateLinks.id, params.linkId),
    ))
    .returning({ id: candidateLinks.id, policyDecision: candidateLinks.policyDecision, importState: candidateLinks.importState })
}

/**
 * Claims queued links for import, atomically, exactly as the document worker claims documents.
 *
 * `for update skip locked` for the same reason: two overlapping workers must not both fetch the same
 * URL. A duplicate fetch is not merely wasteful — it is a second unrequested request to someone
 * else's server, which is precisely the behaviour the whole policy layer exists to bound.
 */
export async function leaseQueuedLinks(
  transaction: WorkerTransaction,
  organizationId: string,
  limit: number,
): Promise<CandidateLinkRow[]> {
  const result = await transaction.execute(sql`
    update candidate_links
    set import_state = 'running', updated_at = now()
    where id in (
      select id from candidate_links
      where organization_id = ${organizationId}
        and import_state = 'queued'
        and policy_decision in ('official_api', 'authorized_crawl')
      order by updated_at
      limit ${limit}
      for update skip locked
    )
    returning id, organization_id, submission_id, url, normalized_url, source_type,
              acquisition_mode, policy_decision, import_state,
              authorization_notice_version, authorization_attested_at
  `)
  return [...(result as unknown as Iterable<Record<string, unknown>>)].map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    submissionId: String(row.submission_id),
    url: String(row.url),
    normalizedUrl: String(row.normalized_url),
    sourceType: String(row.source_type),
    acquisitionMode: String(row.acquisition_mode),
    policyDecision: String(row.policy_decision),
    importState: String(row.import_state),
    authorizationNoticeVersion: row.authorization_notice_version === null ? null : String(row.authorization_notice_version),
    authorizationAttestedAt: row.authorization_attested_at === null ? null : new Date(row.authorization_attested_at as string),
  }))
}

export async function setLinkImportState(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    linkId: string
    importState: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_importable'
  },
) {
  return transaction
    .update(candidateLinks)
    .set({ importState: params.importState, updatedAt: new Date() })
    .where(and(
      eq(candidateLinks.organizationId, params.organizationId),
      eq(candidateLinks.id, params.linkId),
    ))
    .returning({ id: candidateLinks.id })
}

/**
 * Writes the import record.
 *
 * `onConflictDoNothing` against `candidate_web_imports_link_content_unique`: re-importing a page whose
 * content has not changed collides rather than duplicating, so a weekly re-fetch of a stable
 * portfolio does not accumulate a row per run.
 *
 * `robotsResult` is stored, never inferred later. spec.md wants "we were allowed to fetch this" to
 * stay auditable *after* the site's robots.txt changes — which it will, and a decision recomputed
 * against today's file is not a record of what we were permitted yesterday.
 *
 * The raw response body is deliberately not a parameter. Only its hash and the extracted text are
 * stored; the bytes are discarded by the caller.
 */
export async function recordWebImport(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    candidateLinkId: string
    finalUrl: string
    sourcePolicyVersion: string
    robotsResult: 'allowed' | 'disallowed' | 'unavailable'
    status: 'succeeded' | 'failed' | 'blocked'
    errorCode: string | null
    fetchedAt: Date | null
    responseSha256: string | null
    contentSha256: string | null
    mediaType: string | null
    bytes: number | null
    extractionVersion: string | null
    extractedText: string | null
    evidenceMap: Record<string, unknown>
    retentionExpiresAt: Date
  },
) {
  const [row] = await transaction
    .insert(candidateWebImports)
    .values({
      organizationId: params.organizationId,
      candidateLinkId: params.candidateLinkId,
      finalUrl: params.finalUrl.slice(0, 2048),
      sourcePolicyVersion: params.sourcePolicyVersion,
      robotsResult: params.robotsResult,
      status: params.status,
      // `candidate_web_imports_outcome_check` binds these: a non-success needs a code, a success must
      // not carry one.
      errorCode: params.errorCode === null ? null : params.errorCode.slice(0, 64),
      fetchedAt: params.fetchedAt,
      responseSha256: params.responseSha256,
      contentSha256: params.contentSha256,
      mediaType: params.mediaType,
      bytes: params.bytes,
      extractionVersion: params.extractionVersion,
      extractedText: params.extractedText,
      evidenceMap: params.evidenceMap,
      retentionExpiresAt: params.retentionExpiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: candidateWebImports.id })
  return row ?? null
}
