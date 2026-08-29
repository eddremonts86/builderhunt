/**
 * Scans and extracts candidate documents (plan:
 * calendar-scheduling-interview-intelligence, Phase 6, "Implement document repository and worker"),
 * and scans self-managed profile attachments over the same primitives
 * (plan: phase-2/07-perfiles-autogestionados) — two workers, one scan-and-promote core.
 *
 * ## The status is the lease, and the network I/O happens outside the transaction
 *
 * Each pass is three steps per tenant: claim rows in one committed transaction, do the scanning and
 * object moves with no transaction open, then apply each outcome in its own short transaction.
 *
 * The obvious alternative — one transaction around the whole thing — holds a tenant's rows locked
 * for the duration of a ClamAV stream and two S3 round trips, on a connection pool shared with
 * every live request. Committing the claim first is what makes `scanning`/`running` a durable lease
 * instead of a lock, and `reclaimStaleLeases` is the price: a process killed mid-flight leaves rows
 * in a state only that reclaim will rescue.
 *
 * ## Move before mark, deliberately
 *
 * Neither ordering is atomic, so the choice is which way it breaks:
 *
 *   - move then mark → worst case, an object sits under `clean/` that no row references. The
 *     document is retried, eventually failed, and the candidate re-uploads. Nothing is served
 *     wrongly; retention sweeps the orphan.
 *   - mark then move → worst case, a row says `clean` and points at a key holding no object. The UI
 *     shows a ready document and every download 404s.
 *
 * The first fails closed, which is the same reasoning `S3StorageProvider.moveObject` already
 * applies internally: a leftover source is a retention problem, a missing destination is a lost CV.
 *
 * ## An unavailable scanner never produces `clean`
 *
 * `clamav.ts` guarantees this at its own boundary; this module has to not undo it. The two failure
 * kinds are handled differently on purpose:
 *
 *   - `ScanResult{status:'error'}` — clamd answered, and its answer was that it *cannot* scan this
 *     object (encrypted archive, nesting limit). Retrying produces the same answer, so the document
 *     is rejected now rather than re-queued forever.
 *   - a thrown `ScanProviderError` — infrastructure. Requeued until the attempt cap, then failed.
 *     Failed, not clean: "we ran out of chances to check" is not a verdict.
 */
import { getStorageProvider, getVirusScanner } from '~/lib/storage/provider'
import { PARSER_VERSION, StoredDocumentExtractor } from '~/lib/storage/document-extraction'
import { cleanKeyFor, isCleanKey } from '~/lib/storage/object-keys'
import {
  DocumentExtractionError,
  type DocumentExtractionProvider,
  type StorageProvider,
  type VirusScanProvider,
} from '~/lib/storage/types'
import { workerDb, type WorkerTransaction } from '~/shared/lib/db/worker-db'
import { withJobRun, type JobRunOutcome } from '~/shared/lib/repositories/platform-operations'
import { collectWorkerOrganizationIds } from '~/shared/lib/repositories/worker-organization-scan'
import {
  leaseDocumentsForExtraction,
  leaseDocumentsForScan,
  listWorkerOrganizationIds,
  markDocumentClean,
  markDocumentRejected,
  recordExtraction,
  recordExtractionFailure,
  reclaimStaleLeases,
  expireAbandonedUploadIntents,
  releaseDocumentForExtractionRetry,
  releaseDocumentForScanRetry,
  withWorkerOrganization,
  type LeasedDocument,
} from '~/shared/lib/repositories/interview-documents'
import {
  expireAbandonedAttachmentIntents,
  leaseAttachmentsForScan,
  markAttachmentClean,
  markAttachmentRejected,
  reclaimStaleAttachmentScans,
  releaseAttachmentForScanRetry,
  type LeasedSelfManagedAttachment,
} from '~/shared/lib/repositories/self-managed-attachments'

// Namespaced like the other workers' keys (`calendar.recurrence-materialization`,
// `calendar.reminder-delivery`). The key is what `operational_schedules` and the job-run feed join
// on, so an off-convention name is a row nobody finds when they go looking by prefix.
export const DOCUMENT_JOB_KEY = 'interviews.document-processing'

/**
 * Three attempts, not more. Every retry re-streams the whole object through ClamAV, so a document
 * that cannot be read is not free to keep trying — and a candidate waiting on a genuinely broken
 * upload is better served by a definite rejection they can act on than by indefinite "processing".
 */
export const MAX_SCAN_ATTEMPTS = 3
export const MAX_EXTRACTION_ATTEMPTS = 3

const DOCUMENTS_PER_TENANT = 20

/** Well above a 10 MB scan plus extraction, so this never reclaims work still running. */
const STALE_LEASE_MS = 15 * 60_000

/**
 * How long an issued-but-never-completed upload keeps holding quota.
 *
 * The signed URL lasts five minutes, so anything still `awaiting_upload` an hour later is abandoned.
 * Sweeping matters because the quota counts these rows: without it a candidate who closed the tab
 * mid-upload is locked out of part of their 25 MB with nothing on screen explaining why.
 */
const ABANDONED_INTENT_MS = 60 * 60_000

export interface DocumentWorkerResult extends JobRunOutcome {
  organizationsProcessed: number
  reclaimed: number
  abandonedIntents: number
  scannedClean: number
  scannedInfected: number
  scanRejected: number
  scanRetried: number
  extracted: number
  extractionRejected: number
  extractionRetried: number
  failedOrganizations: string[]
  processedCount: number
  failedCount: number
}

export interface DocumentWorkerOptions {
  now?: Date
  db?: typeof workerDb
  storage?: StorageProvider
  scanner?: VirusScanProvider
  extractor?: DocumentExtractionProvider
  documentsPerTenant?: number
  staleLeaseMs?: number
}

/** The media type a parser is chosen by: what the bytes turned out to be, not what was claimed. */
function effectiveMediaType(document: LeasedDocument): string {
  return document.detectedMediaType ?? document.declaredMediaType
}

export async function runDocumentWorker(options: DocumentWorkerOptions = {}): Promise<DocumentWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const perTenant = options.documentsPerTenant ?? DOCUMENTS_PER_TENANT
  const staleLeaseMs = options.staleLeaseMs ?? STALE_LEASE_MS

  // Resolved lazily so a run with nothing to do in a deployment without storage configured still
  // records a clean job run instead of throwing at import time.
  const storage = options.storage ?? getStorageProvider()
  const scanner = options.scanner ?? getVirusScanner()
  const extractor = options.extractor ?? new StoredDocumentExtractor((key) => storage.readObject({ key }))

  return withJobRun({ jobKey: DOCUMENT_JOB_KEY, now, db }, async () => {
    const result: DocumentWorkerResult = {
      organizationsProcessed: 0,
      reclaimed: 0,
      abandonedIntents: 0,
      scannedClean: 0,
      scannedInfected: 0,
      scanRejected: 0,
      scanRetried: 0,
      extracted: 0,
      extractionRejected: 0,
      extractionRetried: 0,
      failedOrganizations: [],
      processedCount: 0,
      failedCount: 0,
    }

    const organizationIds = (await collectWorkerOrganizationIds((after, limit) => listWorkerOrganizationIds(db, after, limit))).map((id) => ({ id }))

    for (const { id: organizationId } of organizationIds) {
      try {
        // Step 1, committed on its own: reclaim anything stranded, then claim this pass's work.
        const { toScan, toExtract, reclaimed, abandoned } = await withWorkerOrganization(organizationId, async (transaction) => {
          const stale = await reclaimStaleLeases(transaction, { organizationId, staleAfterMs: staleLeaseMs, now })
          const expired = await expireAbandonedUploadIntents(transaction, {
            organizationId,
            olderThan: new Date(now.getTime() - ABANDONED_INTENT_MS),
          })
          return {
            reclaimed: stale.scanning + stale.extracting,
            abandoned: expired,
            toScan: await leaseDocumentsForScan(transaction, organizationId, {
              limit: perTenant,
              maxAttempts: MAX_SCAN_ATTEMPTS,
            }),
            toExtract: await leaseDocumentsForExtraction(transaction, organizationId, {
              limit: perTenant,
              maxAttempts: MAX_EXTRACTION_ATTEMPTS,
            }),
          }
        }, db)

        result.reclaimed += reclaimed
        result.abandonedIntents += abandoned.length
        // Any partial object a broken upload left behind. The row is already gone, so a failure here
        // leaks bytes rather than state, and retention sweeps the prefix regardless.
        for (const intent of abandoned) {
          await storage.deleteObject({ key: intent.objectKey }).catch(() => undefined)
        }

        for (const document of toScan) {
          const outcome = await scanOne({ document, scanner, storage })
          await withWorkerOrganization(organizationId, (transaction) => applyScanOutcome(transaction, document, outcome), db)

          result.processedCount += 1
          if (outcome.kind === 'clean') result.scannedClean += 1
          else if (outcome.kind === 'infected') { result.scannedInfected += 1; result.failedCount += 1 }
          else if (outcome.kind === 'reject') { result.scanRejected += 1; result.failedCount += 1 }
          else result.scanRetried += 1
        }

        for (const document of toExtract) {
          const outcome = await extractOne({ document, extractor })
          await withWorkerOrganization(organizationId, (transaction) => applyExtractionOutcome(transaction, document, outcome), db)

          result.processedCount += 1
          if (outcome.kind === 'extracted') result.extracted += 1
          else if (outcome.kind === 'reject') { result.extractionRejected += 1; result.failedCount += 1 }
          else result.extractionRetried += 1
        }

        result.organizationsProcessed += 1
      } catch (error) {
        // One tenant's failure must not stop the rest — the loop is per-tenant precisely so a
        // broken organization cannot stall every other candidate's uploads. No message is logged
        // beyond the id: a scanner or storage error can carry a signed URL or an object key.
        result.failedOrganizations.push(organizationId)
        result.failedCount += 1
        console.error('document worker tenant failed:', organizationId, (error as Error)?.name)
      }
    }

    return result
  })
}

/** The table-agnostic half of a scan verdict: what happened to the object, not to any row. */
type ObjectScanOutcome =
  | { kind: 'clean'; cleanObjectKey: string }
  | { kind: 'infected'; rejectionCode: string }
  | { kind: 'reject'; rejectionCode: string }
  | { kind: 'retry' }

type ScanOutcome =
  | { kind: 'clean'; cleanObjectKey: string; detectedMediaType: string }
  | { kind: 'infected'; rejectionCode: string }
  | { kind: 'reject'; rejectionCode: string }
  | { kind: 'retry' }

/**
 * Scan one stored object and, on a clean verdict, promote it out of quarantine.
 *
 * Shared by the candidate and self-managed pipelines: everything here is about an object key and an
 * attempt counter, and nothing is about which table the row lives in. The verdict handling is the
 * module-comment contract — an unavailable scanner never produces `clean`.
 */
async function scanStoredObject(params: {
  objectKey: string
  scanAttempts: number
  maxAttempts: number
  scanner: VirusScanProvider
  storage: StorageProvider
}): Promise<ObjectScanOutcome> {
  const { objectKey, scanAttempts, maxAttempts, scanner, storage } = params

  let verdict
  try {
    verdict = await scanner.scanObject({ key: objectKey })
  } catch {
    // Infrastructure. Nothing about this says anything about the file, so the document keeps its
    // place in the queue until the attempt cap decides otherwise.
    return scanAttempts >= maxAttempts
      ? { kind: 'reject', rejectionCode: 'scan_unavailable' }
      : { kind: 'retry' }
  }

  if (verdict.status === 'infected') {
    // Deleted, not kept for inspection: nobody is going to forensically examine an infected CV,
    // and retaining known malware in a bucket the app can read is a liability.
    await storage.deleteObject({ key: objectKey }).catch(() => undefined)
    return { kind: 'infected', rejectionCode: verdict.detailCode ?? 'infected' }
  }

  if (verdict.status === 'error') {
    await storage.deleteObject({ key: objectKey }).catch(() => undefined)
    return { kind: 'reject', rejectionCode: verdict.detailCode ?? 'scan_error' }
  }

  // A leased key already under `clean/` means a previous pass moved the object and died before the
  // mark landed. The verdict still has to be earned on every pass; the move does not.
  if (isCleanKey(objectKey)) {
    return { kind: 'clean', cleanObjectKey: objectKey }
  }

  const cleanObjectKey = cleanKeyFor(objectKey)
  try {
    await storage.moveObject({ fromKey: objectKey, toKey: cleanObjectKey })
  } catch {
    // The verdict was clean but the object did not make it across. Retry rather than mark clean:
    // marking clean would point the row at a key that may hold nothing.
    return scanAttempts >= maxAttempts
      ? { kind: 'reject', rejectionCode: 'promotion_failed' }
      : { kind: 'retry' }
  }

  return { kind: 'clean', cleanObjectKey }
}

async function scanOne(params: {
  document: LeasedDocument
  scanner: VirusScanProvider
  storage: StorageProvider
}): Promise<ScanOutcome> {
  const { document, scanner, storage } = params
  const outcome = await scanStoredObject({
    objectKey: document.objectKey,
    scanAttempts: document.scanAttempts,
    maxAttempts: MAX_SCAN_ATTEMPTS,
    scanner,
    storage,
  })
  return outcome.kind === 'clean'
    ? { ...outcome, detectedMediaType: effectiveMediaType(document) }
    : outcome
}

async function applyScanOutcome(
  transaction: WorkerTransaction,
  document: LeasedDocument,
  outcome: ScanOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'clean':
      await markDocumentClean(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
        cleanObjectKey: outcome.cleanObjectKey,
        detectedMediaType: outcome.detectedMediaType,
      })
      break
    case 'infected':
      await markDocumentRejected(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
        scanStatus: 'infected',
        rejectionCode: outcome.rejectionCode,
      })
      break
    case 'reject':
      await markDocumentRejected(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
        scanStatus: 'failed',
        rejectionCode: outcome.rejectionCode,
      })
      break
    case 'retry':
      await releaseDocumentForScanRetry(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
      })
      break
  }
}

type ExtractionOutcome =
  | {
      kind: 'extracted'
      parser: string
      parserVersion: string
      contentSha256: string
      plainText: string
      evidenceMap: Record<string, unknown>
    }
  | { kind: 'reject'; errorCode: string }
  | { kind: 'retry' }

async function extractOne(params: {
  document: LeasedDocument
  extractor: DocumentExtractionProvider
}): Promise<ExtractionOutcome> {
  const { document, extractor } = params
  try {
    const extraction = await extractor.extractText({
      key: document.objectKey,
      mediaType: effectiveMediaType(document),
    })
    return {
      kind: 'extracted',
      parser: extraction.parser,
      parserVersion: extraction.parserVersion,
      contentSha256: extraction.contentSha256,
      plainText: extraction.text,
      // The section map is evidence for a citation, so it is stored with the flag that says whether
      // the text it indexes is the whole document.
      evidenceMap: { sections: extraction.sectionMap, truncated: extraction.truncated },
    }
  } catch (error) {
    // A `DocumentExtractionError` is a verdict about the file — unsupported, encrypted, corrupt.
    // The same parser version will reach the same conclusion, so retrying is pure waste.
    if (error instanceof DocumentExtractionError) {
      return { kind: 'reject', errorCode: error.code }
    }
    return document.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS
      ? { kind: 'reject', errorCode: 'extraction_unavailable' }
      : { kind: 'retry' }
  }
}

// ── Self-managed profile attachments ──────────────────────────────────────────────────────────

/**
 * Its own job key and its own worker, not a fourth phase of `runDocumentWorker`: that worker's loop,
 * kill switch and job history are all per-organization things, and a self-managed profile belongs to
 * an account, not a tenant. Sharing `interviews.document-processing` would also merge two features'
 * run histories under one key, which is the row nobody finds when they go looking by prefix.
 */
export const SELF_MANAGED_SCAN_JOB_KEY = 'self-managed.attachment-scan'

/** Same bound as `DOCUMENTS_PER_TENANT`, global here — there is no tenant to be fair between. */
const ATTACHMENTS_PER_RUN = 20

export interface SelfManagedScanWorkerResult extends JobRunOutcome {
  reclaimed: number
  abandonedIntents: number
  scannedClean: number
  scannedInfected: number
  scanRejected: number
  scanRetried: number
  processedCount: number
  failedCount: number
}

export interface SelfManagedScanWorkerOptions {
  now?: Date
  db?: typeof workerDb
  storage?: StorageProvider
  scanner?: VirusScanProvider
  attachmentsPerRun?: number
  staleLeaseMs?: number
}

/**
 * One pass over pending self-managed attachments: reclaim, lease, scan, apply — the same
 * three-step contract as `runDocumentWorker`, minus the tenant loop and the extraction phase.
 * Nothing extracts text from a profile attachment; a stranger downloads the bytes or nothing.
 */
export async function runSelfManagedAttachmentScanWorker(
  options: SelfManagedScanWorkerOptions = {},
): Promise<SelfManagedScanWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const perRun = options.attachmentsPerRun ?? ATTACHMENTS_PER_RUN
  const staleLeaseMs = options.staleLeaseMs ?? STALE_LEASE_MS
  const storage = options.storage ?? getStorageProvider()
  const scanner = options.scanner ?? getVirusScanner()

  return withJobRun({ jobKey: SELF_MANAGED_SCAN_JOB_KEY, now, db }, async () => {
    const result: SelfManagedScanWorkerResult = {
      reclaimed: 0,
      abandonedIntents: 0,
      scannedClean: 0,
      scannedInfected: 0,
      scanRejected: 0,
      scanRetried: 0,
      processedCount: 0,
      failedCount: 0,
    }

    // Committed on its own, same as the candidate worker: the lease has to be durable before any
    // network I/O starts, or a crash strands rows only the stale reclaim will ever rescue.
    const { toScan, abandoned } = await db.transaction(async (transaction) => {
      result.reclaimed = await reclaimStaleAttachmentScans(transaction as WorkerTransaction, {
        staleAfterMs: staleLeaseMs,
        now,
      })
      return {
        abandoned: await expireAbandonedAttachmentIntents(transaction as WorkerTransaction, {
          olderThan: new Date(now.getTime() - ABANDONED_INTENT_MS),
        }),
        toScan: await leaseAttachmentsForScan(transaction as WorkerTransaction, {
          limit: perRun,
          maxAttempts: MAX_SCAN_ATTEMPTS,
        }),
      }
    })

    result.abandonedIntents = abandoned.length
    // Any partial object a broken upload left behind. The row is already gone, so a failure here
    // leaks bytes rather than state, and retention sweeps the prefix regardless.
    for (const intent of abandoned) {
      await storage.deleteObject({ key: intent.storageKey }).catch(() => undefined)
    }

    for (const attachment of toScan) {
      try {
        const outcome = await scanStoredObject({
          objectKey: attachment.storageKey,
          scanAttempts: attachment.scanAttempts,
          maxAttempts: MAX_SCAN_ATTEMPTS,
          scanner,
          storage,
        })
        await db.transaction((transaction) =>
          applyAttachmentScanOutcome(transaction as WorkerTransaction, attachment, outcome),
        )

        result.processedCount += 1
        if (outcome.kind === 'clean') result.scannedClean += 1
        else if (outcome.kind === 'infected') { result.scannedInfected += 1; result.failedCount += 1 }
        else if (outcome.kind === 'reject') { result.scanRejected += 1; result.failedCount += 1 }
        else result.scanRetried += 1
      } catch (error) {
        // One broken attachment must not stall the batch. The row stays `scanning` and the stale
        // reclaim returns it to the queue. Only the id is logged: an error from storage or the
        // scanner can carry a signed URL or an object key.
        result.failedCount += 1
        console.error('self-managed attachment scan failed:', attachment.id, (error as Error)?.name)
      }
    }

    return result
  })
}

async function applyAttachmentScanOutcome(
  transaction: WorkerTransaction,
  attachment: LeasedSelfManagedAttachment,
  outcome: ObjectScanOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'clean':
      await markAttachmentClean(transaction, {
        attachmentId: attachment.id,
        cleanObjectKey: outcome.cleanObjectKey,
      })
      break
    case 'infected':
      await markAttachmentRejected(transaction, {
        attachmentId: attachment.id,
        scanStatus: 'infected',
        rejectionCode: outcome.rejectionCode,
      })
      break
    case 'reject':
      await markAttachmentRejected(transaction, {
        attachmentId: attachment.id,
        scanStatus: 'failed',
        rejectionCode: outcome.rejectionCode,
      })
      break
    case 'retry':
      await releaseAttachmentForScanRetry(transaction, { attachmentId: attachment.id })
      break
  }
}

async function applyExtractionOutcome(
  transaction: WorkerTransaction,
  document: LeasedDocument,
  outcome: ExtractionOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'extracted':
      await recordExtraction(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
        parser: outcome.parser,
        parserVersion: outcome.parserVersion,
        contentSha256: outcome.contentSha256,
        plainText: outcome.plainText,
        evidenceMap: outcome.evidenceMap,
        retentionExpiresAt: document.retentionExpiresAt,
      })
      break
    case 'reject':
      await recordExtractionFailure(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
        // `none` because the extractor threw before it could say which parser it chose, and the
        // real PARSER_VERSION rather than an encoding of the failure kind: the row means "version 1
        // could not read these bytes", so a future version 2 gets its own row and can be retried.
        // (Retrying it needs a backfill to reset `extraction_status` to pending — the lease only
        // looks at pending rows.)
        parser: 'none',
        parserVersion: PARSER_VERSION,
        sourceSha256: document.sha256,
        errorCode: outcome.errorCode,
        retentionExpiresAt: document.retentionExpiresAt,
      })
      break
    case 'retry':
      await releaseDocumentForExtractionRetry(transaction, {
        organizationId: document.organizationId,
        documentId: document.id,
      })
      break
  }
}
