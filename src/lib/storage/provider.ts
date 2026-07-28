/**
 * Resolves the object-storage provider, mirroring `getBillingProvider`'s shape
 * so both read the same way.
 *
 * Fails closed and loudly. There is no in-memory or on-disk stand-in: a
 * fallback would let the upload path appear to work while candidate documents
 * went nowhere, and the first sign of trouble would be a download returning
 * nothing months later. An operator who sees this error has exactly one fix,
 * which is to configure the store.
 */
import { env } from '~/shared/lib/env'
import { ClamAvScanner } from './clamav'
import { S3StorageProvider } from './s3-provider'
import type { StorageProvider, VirusScanProvider } from './types'

export class StorageDisabledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageDisabledError'
  }
}

let singleton: StorageProvider | null = null
let scanner: VirusScanProvider | null = null

/** Drops the memos so a test can swap configuration between cases. */
export function resetStorageProviderForTesting(): void {
  singleton = null
  scanner = null
}

export function getStorageProvider(): StorageProvider {
  if (singleton) return singleton

  const { INTERVIEW_R2_ENDPOINT, INTERVIEW_R2_BUCKET, INTERVIEW_R2_ACCESS_KEY_ID, INTERVIEW_R2_SECRET_ACCESS_KEY } = env
  if (!INTERVIEW_R2_ENDPOINT || !INTERVIEW_R2_BUCKET || !INTERVIEW_R2_ACCESS_KEY_ID || !INTERVIEW_R2_SECRET_ACCESS_KEY) {
    // `env.ts` already refuses to boot with CANDIDATE_UPLOADS_ENABLED=true and
    // any of these missing, so reaching here means a caller invoked the upload
    // path while the feature is switched off — a wiring bug, not a
    // misconfiguration.
    throw new StorageDisabledError(
      'object storage is not configured; INTERVIEW_R2_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY are all required',
    )
  }

  singleton = new S3StorageProvider({
    endpoint: INTERVIEW_R2_ENDPOINT,
    bucket: INTERVIEW_R2_BUCKET,
    accessKeyId: INTERVIEW_R2_ACCESS_KEY_ID,
    secretAccessKey: INTERVIEW_R2_SECRET_ACCESS_KEY,
  })
  return singleton
}

/**
 * Fails closed for the same reason `getStorageProvider` does, and it matters
 * more here: the fallback a missing scanner invites is "skip the scan", which
 * publishes an unscanned document to the clean prefix. There is no degraded
 * mode — an operator without clamd has uploads switched off, not unscanned.
 */
export function getVirusScanner(): VirusScanProvider {
  if (scanner) return scanner

  const storage = getStorageProvider()
  const { INTERVIEW_CLAMAV_HOST, INTERVIEW_CLAMAV_PORT } = env
  if (!INTERVIEW_CLAMAV_HOST) {
    throw new StorageDisabledError('virus scanning is not configured; INTERVIEW_CLAMAV_HOST is required')
  }

  scanner = new ClamAvScanner(
    { host: INTERVIEW_CLAMAV_HOST, port: INTERVIEW_CLAMAV_PORT },
    (key) => storage.readObject({ key }),
  )
  return scanner
}
