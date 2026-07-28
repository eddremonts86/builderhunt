import { randomUUID } from 'node:crypto'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { workerDb, type WorkerTransaction } from '../db/worker-db'
import { candidateDocuments, documentExtractions, organizations } from '../db/schema'

/**
 * Worker-role data access for candidate documents (plan:
 * calendar-scheduling-interview-intelligence, Phase 6, "Implement document repository and worker").
 *
 * Keeps its OWN `listWorkerOrganizationIds`/`withWorkerOrganization` pair rather than importing
 * another module's, following the precedent `calendar-worker.ts`, `alerts-worker.ts`,
 * `billing-worker.ts` and `sprints-worker.ts` each set. There is deliberately no query spanning
 * organizations: RLS scopes each transaction to exactly one tenant, so a bug in one tenant's batch
 * cannot read or write another's.
 *
 * ## Leasing, and why it is a single statement
 *
 * `leaseDocumentsForScan` claims rows with `FOR UPDATE SKIP LOCKED` and flips their status in the
 * same statement. Two workers running concurrently — a cron overlap, a manual admin run during a
 * scheduled one — must never both scan the same object: the second would move an object the first
 * already moved, and `moveObject` deletes the source. A select-then-update would leave exactly that
 * window open.
 *
 * ## Attempts are persisted, and that is the whole retry story
 *
 * A transient failure returns a row to `pending`. Without a durable counter that is an infinite
 * loop: an object the scanner can never read would be re-leased forever, each pass costing a real
 * scan. The lease increments the counter, so a row that keeps failing eventually exceeds the cap
 * and is failed permanently instead of retried.
 *
 * ## What the check constraints force
 *
 * Two of them shape this module more than the plan text does:
 *
 *   - `candidate_documents_rejection_check` ties `rejection_code` to `scan_status in
 *     ('infected','failed')`. An extraction failure has `scan_status = 'clean'`, so its error code
 *     *cannot* live on the document — it has to be a `document_extractions` row.
 *   - `document_extractions_content_sha256_check` demands 64 hex characters even on a failed row,
 *     which has no text to hash. Failed rows therefore carry the *source document's* sha256. That
 *     is not a workaround: keyed by (document, parser version, content hash) it means "this parser
 *     version failed on exactly these bytes", so a retry with the same parser collides instead of
 *     duplicating, and a newer parser version still gets its own row.
 */

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

export interface LeasedDocument {
  id: string
  organizationId: string
  submissionId: string
  objectKey: string
  declaredMediaType: string
  detectedMediaType: string | null
  sha256: string
  bytes: number
  scanAttempts: number
  extractionAttempts: number
  retentionExpiresAt: Date
}

const LEASED_COLUMNS = sql`
  id, organization_id, submission_id, object_key, declared_media_type, detected_media_type,
  sha256, bytes, scan_attempts, extraction_attempts, retention_expires_at
`

function toLeasedDocument(row: Record<string, unknown>): LeasedDocument {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    submissionId: String(row.submission_id),
    objectKey: String(row.object_key),
    declaredMediaType: String(row.declared_media_type),
    detectedMediaType: row.detected_media_type === null ? null : String(row.detected_media_type),
    sha256: String(row.sha256),
    bytes: Number(row.bytes),
    scanAttempts: Number(row.scan_attempts),
    extractionAttempts: Number(row.extraction_attempts),
    retentionExpiresAt: new Date(row.retention_expires_at as string),
  }
}

/**
 * Claims up to `limit` pending documents for scanning and marks them `scanning` atomically.
 *
 * `order by created_at` so the oldest upload — the candidate who has been waiting longest — is
 * scanned first rather than being starved by a steady arrival of newer ones.
 */
export async function leaseDocumentsForScan(
  transaction: WorkerTransaction,
  organizationId: string,
  options: { limit: number; maxAttempts: number },
): Promise<LeasedDocument[]> {
  const result = await transaction.execute(sql`
    update candidate_documents
    set scan_status = 'scanning', scan_attempts = scan_attempts + 1, updated_at = now()
    where id in (
      select id from candidate_documents
      where organization_id = ${organizationId}
        and scan_status = 'pending'
        and scan_attempts < ${options.maxAttempts}
      order by created_at
      limit ${options.limit}
      for update skip locked
    )
    returning ${LEASED_COLUMNS}
  `)
  return [...(result as unknown as Iterable<Record<string, unknown>>)].map(toLeasedDocument)
}

/**
 * Records a clean verdict and the key the object now lives under.
 *
 * `objectKey` is updated in the same statement as the status because the two must agree: a document
 * marked clean whose key still points at the quarantine prefix would be served from a location the
 * move already emptied.
 */
export async function markDocumentClean(
  transaction: WorkerTransaction,
  params: { organizationId: string; documentId: string; cleanObjectKey: string; detectedMediaType: string },
) {
  return transaction
    .update(candidateDocuments)
    .set({
      scanStatus: 'clean',
      objectKey: params.cleanObjectKey,
      detectedMediaType: params.detectedMediaType,
      rejectionCode: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))
    .returning({ id: candidateDocuments.id, scanStatus: candidateDocuments.scanStatus })
}

/**
 * Terminal rejection. `extraction_status` is set to `skipped` in the same write: leaving it
 * `pending` would let the extraction pass pick up a document that must never be parsed, and an
 * infected file is exactly the input a parser should never see.
 */
export async function markDocumentRejected(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    documentId: string
    scanStatus: 'infected' | 'failed'
    rejectionCode: string
    detectedMediaType?: string | null
  },
) {
  return transaction
    .update(candidateDocuments)
    .set({
      scanStatus: params.scanStatus,
      extractionStatus: 'skipped',
      // Truncated because it reaches a candidate-visible status DTO indirectly and a scanner's raw
      // detail line is not a message anyone should be shown.
      rejectionCode: params.rejectionCode.slice(0, 64),
      ...(params.detectedMediaType === undefined ? {} : { detectedMediaType: params.detectedMediaType }),
      updatedAt: new Date(),
    })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))
    .returning({ id: candidateDocuments.id, scanStatus: candidateDocuments.scanStatus })
}

/** Returns a document to the scan queue after a transient failure. The attempt already counted. */
export async function releaseDocumentForScanRetry(
  transaction: WorkerTransaction,
  params: { organizationId: string; documentId: string },
) {
  return transaction
    .update(candidateDocuments)
    .set({ scanStatus: 'pending', rejectionCode: null, updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))
    .returning({ id: candidateDocuments.id })
}

/** Claims clean documents whose text has not been extracted yet, marking them `running`. */
export async function leaseDocumentsForExtraction(
  transaction: WorkerTransaction,
  organizationId: string,
  options: { limit: number; maxAttempts: number },
): Promise<LeasedDocument[]> {
  const result = await transaction.execute(sql`
    update candidate_documents
    set extraction_status = 'running', extraction_attempts = extraction_attempts + 1, updated_at = now()
    where id in (
      select id from candidate_documents
      where organization_id = ${organizationId}
        and scan_status = 'clean'
        and extraction_status = 'pending'
        and extraction_attempts < ${options.maxAttempts}
      order by created_at
      limit ${options.limit}
      for update skip locked
    )
    returning ${LEASED_COLUMNS}
  `)
  return [...(result as unknown as Iterable<Record<string, unknown>>)].map(toLeasedDocument)
}

/**
 * Stores extracted text and marks the document extracted.
 *
 * `onConflictDoNothing` on the (document, parser version, content hash) index rather than an upsert:
 * a collision means this exact parser version already produced this exact text, so there is nothing
 * to update, and overwriting would rewrite a row a brief may already cite.
 */
export async function recordExtraction(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    documentId: string
    parser: string
    parserVersion: string
    contentSha256: string
    plainText: string
    evidenceMap: Record<string, unknown>
    retentionExpiresAt: Date
  },
) {
  const [extraction] = await transaction
    .insert(documentExtractions)
    .values({
      organizationId: params.organizationId,
      documentId: params.documentId,
      parser: params.parser,
      parserVersion: params.parserVersion,
      contentSha256: params.contentSha256,
      plainText: params.plainText,
      evidenceMap: params.evidenceMap,
      status: 'succeeded',
      errorCode: null,
      retentionExpiresAt: params.retentionExpiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: documentExtractions.id })

  await transaction
    .update(candidateDocuments)
    .set({ extractionStatus: 'succeeded', updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))

  return extraction ?? null
}

/**
 * Records a permanent extraction failure.
 *
 * The row carries the *source* sha256, because the content-hash check demands 64 hex characters and
 * a failure has no text — see the module header. `errorCode` is required by
 * `document_extractions_outcome_check` whenever status is `failed`, which is the schema making the
 * same point this code does: a failure without a reason is not a record of anything.
 */
export async function recordExtractionFailure(
  transaction: WorkerTransaction,
  params: {
    organizationId: string
    documentId: string
    parser: string
    parserVersion: string
    sourceSha256: string
    errorCode: string
    retentionExpiresAt: Date
  },
) {
  await transaction
    .insert(documentExtractions)
    .values({
      organizationId: params.organizationId,
      documentId: params.documentId,
      parser: params.parser,
      parserVersion: params.parserVersion,
      contentSha256: params.sourceSha256,
      plainText: null,
      evidenceMap: {},
      status: 'failed',
      errorCode: params.errorCode.slice(0, 64),
      retentionExpiresAt: params.retentionExpiresAt,
    })
    .onConflictDoNothing()

  return transaction
    .update(candidateDocuments)
    .set({ extractionStatus: 'failed', updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))
    .returning({ id: candidateDocuments.id })
}

/** Returns a document to the extraction queue after a transient failure. */
export async function releaseDocumentForExtractionRetry(
  transaction: WorkerTransaction,
  params: { organizationId: string; documentId: string },
) {
  return transaction
    .update(candidateDocuments)
    .set({ extractionStatus: 'pending', updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.id, params.documentId),
    ))
    .returning({ id: candidateDocuments.id })
}

/**
 * Returns rows abandoned mid-flight to their queue.
 *
 * The `scanning`/`running` status *is* the lease — it is what lets the worker commit the claim and
 * then scan over the network without holding a transaction open across I/O. The cost of that is
 * that a process killed between claiming and finishing leaves rows stuck in a state nothing will
 * ever pick up again. Without this, a single deploy in the wrong second silently strands a
 * candidate's CV as "processing" forever.
 *
 * `staleAfterMs` must stay comfortably above the slowest legitimate scan plus extraction, or this
 * reclaims work that is still in progress and two workers end up on the same object.
 *
 * The cutoff comes from the caller's `now`, not from Postgres's `now()`, matching every other
 * worker in this codebase. A clock the worker accepts but some of its queries ignore is worse than
 * no injected clock at all: a test can set up a scenario the code then evaluates against a
 * different timeline, and it passes or fails for reasons unrelated to the behaviour under test.
 */
export async function reclaimStaleLeases(
  transaction: WorkerTransaction,
  params: { organizationId: string; staleAfterMs: number; now: Date },
): Promise<{ scanning: number; extracting: number }> {
  const cutoff = new Date(params.now.getTime() - params.staleAfterMs)

  const scanning = await transaction
    .update(candidateDocuments)
    .set({ scanStatus: 'pending', updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.scanStatus, 'scanning'),
      lt(candidateDocuments.updatedAt, cutoff),
    ))
    .returning({ id: candidateDocuments.id })

  const extracting = await transaction
    .update(candidateDocuments)
    .set({ extractionStatus: 'pending', updatedAt: new Date() })
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.extractionStatus, 'running'),
      lt(candidateDocuments.updatedAt, cutoff),
    ))
    .returning({ id: candidateDocuments.id })

  return { scanning: scanning.length, extracting: extracting.length }
}

/**
 * Bytes already committed against a submission's 25 MB quota.
 *
 * Counts every document that is not a terminal rejection: `pending` and `scanning` rows count
 * because their bytes are already in the bucket, and excluding them would let a burst of concurrent
 * uploads each see an empty quota and collectively blow past it.
 */
export async function sumSubmissionDocumentBytes(
  transaction: WorkerTransaction,
  params: { organizationId: string; submissionId: string },
): Promise<number> {
  const [row] = await transaction
    .select({ total: sql<number>`coalesce(sum(${candidateDocuments.bytes}), 0)::int` })
    .from(candidateDocuments)
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.submissionId, params.submissionId),
      sql`${candidateDocuments.scanStatus} not in ('infected', 'failed')`,
    ))
  return row?.total ?? 0
}
