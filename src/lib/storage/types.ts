/**
 * Object storage provider contract (plan: calendar-scheduling-interview-intelligence, spec.md
 * "Private file contract"). No I/O, no vendor SDK import — this module only defines the shapes
 * the rest of the candidate-document pipeline (upload routes, scan worker, extraction worker)
 * share. The concrete adapter implements this interface against the S3 API; domain code never sees
 * an AWS SDK response type or error class.
 *
 * The backing store is **self-hosted MinIO**, not Cloudflare R2 — see
 * `docs/operations/interview-provider-register.md`, which chose MinIO to avoid a paid vendor, a DPA
 * and a sub-processor entry. The env vars keep their `INTERVIEW_R2_*` prefix deliberately, so
 * moving to R2 later is a configuration change rather than a code change. Do not infer the vendor
 * from the variable names.
 *
 * No adapter exists yet: this file and its test are the whole module today.
 */

export interface SignedUploadUrl {
  url: string
  method: 'PUT'
  headers: Readonly<Record<string, string>>
  expiresAt: string
}

export interface SignedDownloadUrl {
  url: string
  method: 'GET'
  expiresAt: string
}

export interface StorageObjectMetadata {
  bytes: number
  contentType: string
  sha256: string | null
}

export type StorageErrorCode = 'not_found' | 'access_denied' | 'checksum_mismatch' | 'invalid_key' | 'provider_unavailable'

export class StorageProviderError extends Error {
  constructor(message: string, readonly code: StorageErrorCode) {
    super(message)
    this.name = 'StorageProviderError'
  }
}

/** Signed upload/download/delete/move over a private object store. Every method returns a normalized error via `StorageProviderError`, never a vendor exception. */
export interface StorageProvider {
  createSignedUploadUrl(params: { key: string; contentType: string; maxBytes: number }): Promise<SignedUploadUrl>
  createSignedDownloadUrl(params: { key: string; expiresInSeconds: number }): Promise<SignedDownloadUrl>
  headObject(params: { key: string }): Promise<StorageObjectMetadata | null>
  deleteObject(params: { key: string }): Promise<void>
  moveObject(params: { fromKey: string; toKey: string }): Promise<void>
}

// ── Virus scanning (spec.md: "Stream every object through ClamAV before moving/copying to the clean private prefix") ─

export type ScanStatus = 'clean' | 'infected' | 'error'

export interface ScanResult {
  status: ScanStatus
  /** The scanner's own signature/error label, if any — an internal diagnostic value, never shown to a candidate/organizer as-is. */
  detailCode: string | null
}

export type ScanProviderErrorCode = 'provider_unavailable' | 'object_too_large' | 'timeout'

export class ScanProviderError extends Error {
  constructor(message: string, readonly code: ScanProviderErrorCode) {
    super(message)
    this.name = 'ScanProviderError'
  }
}

export interface VirusScanProvider {
  scanObject(params: { key: string }): Promise<ScanResult>
}

// ── Document text extraction (spec.md: "Parse clean PDF/DOCX/TXT deterministically") ────────

export interface DocumentExtractionResult {
  text: string
  sectionMap: ReadonlyArray<{ page?: number; section?: string; offset: number }>
  parserVersion: string
}

export type DocumentExtractionErrorCode = 'unsupported_media_type' | 'encrypted_document' | 'corrupt_document' | 'parser_failure'

export class DocumentExtractionError extends Error {
  constructor(message: string, readonly code: DocumentExtractionErrorCode) {
    super(message)
    this.name = 'DocumentExtractionError'
  }
}

export interface DocumentExtractionProvider {
  extractText(params: { key: string; mediaType: string }): Promise<DocumentExtractionResult>
}
