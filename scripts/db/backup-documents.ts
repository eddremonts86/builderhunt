// Daily candidate-document backup to local disk. Run via cron at 03:30 UTC —
// half an hour after the database dump, so the two are close enough in time
// that a restore does not pair a document row with missing bytes.
//
// Usage: pnpm db:backup:documents
//
// The interview provider register requires this before real candidate data
// lands: storage is self-hosted MinIO on one box, which unlike Cloudflare R2
// has no redundancy at all. If that disk fails without this, every CV and
// portfolio a candidate uploaded is gone — and the `candidate_documents` rows
// that survive in the database point at object keys that no longer resolve,
// which is worse than losing both, because the app then believes it has
// documents it cannot serve.
//
// Uses `@aws-sdk/client-s3`, already a dependency, rather than shelling out to
// the `mc` client: a cron job on a production box should not need a second
// binary installed and version-matched beside it.
//
// Configurable via env:
//   INTERVIEW_R2_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY — required
//   DOCUMENT_BACKUP_DIR — where to write (default: /var/backups/builderhunt/documents)
//   DOCUMENT_BACKUP_KEEP — daily snapshots to retain (default: 14)
//
// Retention is shorter than the database's 30 days on purpose: documents are
// personal data under a 180-day product retention, and keeping backup copies
// longer than the product does widens the blast radius of the backup itself.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, sep } from 'path'
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

const ENDPOINT = process.env.INTERVIEW_R2_ENDPOINT
const BUCKET = process.env.INTERVIEW_R2_BUCKET
const ACCESS_KEY = process.env.INTERVIEW_R2_ACCESS_KEY_ID
const SECRET_KEY = process.env.INTERVIEW_R2_SECRET_ACCESS_KEY
const BACKUP_DIR = process.env.DOCUMENT_BACKUP_DIR ?? '/var/backups/builderhunt/documents'
const KEEP = Number(process.env.DOCUMENT_BACKUP_KEEP ?? 14)

function fail(message: string): never {
  console.error(`[document-backup] ${message}`)
  process.exit(1)
}

/**
 * An object key becomes a path under the snapshot directory. Keys are generated
 * server-side, but a backup job must not be the thing that trusts that: `..`
 * anywhere in a key would otherwise write outside the snapshot.
 */
function safeLocalPath(root: string, key: string): string {
  const parts = key.split('/').filter((part) => part !== '' && part !== '.' && part !== '..')
  if (parts.length === 0) throw new Error(`refusing to write an object with an empty key: ${JSON.stringify(key)}`)
  const resolved = join(root, ...parts)
  if (!resolved.startsWith(root + sep)) throw new Error(`object key escapes the snapshot directory: ${key}`)
  return resolved
}

async function main() {
  // Fail loudly rather than writing an empty snapshot: a backup that "succeeds"
  // against an unconfigured endpoint is how you discover, during a restore,
  // that there was never anything in it.
  if (!ENDPOINT || !BUCKET || !ACCESS_KEY || !SECRET_KEY) {
    fail('INTERVIEW_R2_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY are all required')
  }
  if (!Number.isSafeInteger(KEEP) || KEEP < 1) fail(`DOCUMENT_BACKUP_KEEP must be a positive integer, got ${KEEP}`)

  const client = new S3Client({
    endpoint: ENDPOINT,
    region: 'auto',
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    // MinIO serves path-style; virtual-host style would resolve the bucket as a
    // subdomain of an internal hostname that has no DNS entry.
    forcePathStyle: true,
  })

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const target = join(BACKUP_DIR, stamp)
  mkdirSync(target, { recursive: true })
  console.log(`[document-backup] mirroring ${BUCKET} to ${target}`)

  let copied = 0
  let bytes = 0
  let continuationToken: string | undefined

  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }))
    for (const object of page.Contents ?? []) {
      if (!object.Key || object.Key.endsWith('/')) continue
      const body = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: object.Key }))
      const buffer = Buffer.from(await body.Body!.transformToByteArray())
      const path = safeLocalPath(target, object.Key)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, buffer)
      copied += 1
      bytes += buffer.byteLength
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  console.log(`[document-backup] copied ${copied} object(s), ${(bytes / 1024 / 1024).toFixed(2)} MiB`)
  if (copied === 0) {
    // Not fatal — an empty bucket is legitimate before the feature is switched
    // on — but it has to be visible rather than look like a healthy run.
    console.warn('[document-backup] the snapshot is empty; is the bucket actually in use?')
  }

  prune()
}

function prune() {
  const snapshots = readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - KEEP))) {
    rmSync(join(BACKUP_DIR, name), { recursive: true, force: true })
    console.log(`[document-backup] pruned ${name}`)
  }
  console.log(`[document-backup] ${Math.min(snapshots.length, KEEP)} snapshot(s) retained`)
}

main().catch((error) => {
  console.error('[document-backup] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})

export { safeLocalPath }
