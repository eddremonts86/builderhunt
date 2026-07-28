/**
 * Against a real disposable Postgres, with fake storage and scanner.
 *
 * The database is real because the parts most likely to be wrong are the parts SQL owns: an atomic
 * lease, the check constraints that tie `rejection_code` to `scan_status`, and the attempt counters
 * a retry cap depends on. A mocked repository would assert that the worker calls the functions the
 * worker calls.
 *
 * Storage and the scanner are fake because the failures that matter here cannot be summoned from a
 * real one on demand — a scanner that is down, a move that fails after a clean verdict, a stream
 * that is unreadable. Those are exactly the paths where "we could not check" could become "clean".
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  candidateDocuments,
  candidateSubmissions,
  documentExtractions,
  organizations,
  schedulingInvitations,
} from '~/shared/lib/db/schema'
import { MAX_SCAN_ATTEMPTS, runDocumentWorker, type DocumentWorkerOptions } from '~/lib/scheduling/document-worker'
import { CLEAN_PREFIX, quarantineKeyFor } from '~/lib/storage/object-keys'
import { DocumentExtractionError, ScanProviderError, type ScanResult } from '~/lib/storage/types'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'dw-org-a'
const ORG_B = 'dw-org-b'
const OWNER = 'dw-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')
const RETENTION = new Date('2027-12-31T00:00:00.000Z')

let submissionA: string
let submissionB: string

/** Objects by key, so a move or delete is observable rather than asserted on a spy call. */
class FakeStorage {
  objects = new Map<string, string>()
  moveShouldFail = false

  async createSignedUploadUrl() { throw new Error('not used') }
  async createSignedDownloadUrl() { throw new Error('not used') }
  async headObject({ key }: { key: string }) {
    const body = this.objects.get(key)
    return body === undefined ? null : { bytes: body.length, contentType: 'text/plain', sha256: null }
  }
  async deleteObject({ key }: { key: string }) { this.objects.delete(key) }
  async moveObject({ fromKey, toKey }: { fromKey: string; toKey: string }) {
    if (this.moveShouldFail) throw new Error('copy failed')
    const body = this.objects.get(fromKey)
    if (body === undefined) throw new Error('missing source')
    this.objects.set(toKey, body)
    this.objects.delete(fromKey)
  }
  async readObject({ key }: { key: string }) {
    const body = this.objects.get(key)
    if (body === undefined) throw new Error('missing object')
    const bytes = new TextEncoder().encode(body)
    return { bytes: bytes.byteLength, stream: (async function* () { yield bytes })() }
  }
}

let storage: FakeStorage
let scanBehaviour: (key: string) => Promise<ScanResult>
let extractBehaviour: (key: string) => Promise<{
  text: string
  sectionMap: ReadonlyArray<{ page?: number; section?: string; offset: number }>
  parser: string
  parserVersion: string
  contentSha256: string
  truncated: boolean
}>

const scanner = { scanObject: ({ key }: { key: string }) => scanBehaviour(key) }
const extractor = { extractText: ({ key }: { key: string }) => extractBehaviour(key) }

function run(overrides: DocumentWorkerOptions = {}) {
  return runDocumentWorker({
    now: NOW,
    db: db as unknown as DocumentWorkerOptions['db'],
    storage: storage as unknown as DocumentWorkerOptions['storage'],
    scanner,
    extractor,
    ...overrides,
  })
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_document_worker')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: 'dw-org-a' },
    { id: ORG_B, name: 'B', slug: 'dw-org-b' },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'dw-owner@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
  ])

  const invitations = await db.insert(schedulingInvitations).values([ORG_A, ORG_B].map((organizationId) => ({
    organizationId,
    ownerUserId: OWNER,
    roleTitle: 'Engineer',
    roleContext: 'Backend',
    durationMinutes: 45,
    timezone: 'UTC',
    modality: 'remote_call',
    policyVersion: 'v1',
  }))).returning({ id: schedulingInvitations.id, organizationId: schedulingInvitations.organizationId })

  const submissions = await db.insert(candidateSubmissions).values(invitations.map((invitation) => ({
    organizationId: invitation.organizationId,
    invitationId: invitation.id,
    displayName: 'Candidate',
    emailNormalized: `candidate-${invitation.organizationId}@test.invalid`,
    retentionExpiresAt: RETENTION,
  }))).returning({ id: candidateSubmissions.id, organizationId: candidateSubmissions.organizationId })

  submissionA = submissions.find((row) => row.organizationId === ORG_A)!.id
  submissionB = submissions.find((row) => row.organizationId === ORG_B)!.id
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(documentExtractions)
  await db.delete(candidateDocuments)
  storage = new FakeStorage()
  scanBehaviour = async () => ({ status: 'clean', detailCode: null })
  extractBehaviour = async () => ({
    text: 'extracted cv text',
    sectionMap: [{ page: 1, offset: 0 }],
    parser: 'fake',
    parserVersion: '1',
    contentSha256: 'b'.repeat(64),
    truncated: false,
  })
})

/** A document whose upload already completed, which is the worker's actual input. */
async function seedDocument(options: {
  organizationId?: string
  body?: string
  scanAttempts?: number
  extractionAttempts?: number
  scanStatus?: string
  createdAt?: Date
} = {}) {
  const organizationId = options.organizationId ?? ORG_A
  const submissionId = organizationId === ORG_A ? submissionA : submissionB
  const [row] = await db.insert(candidateDocuments).values({
    organizationId,
    submissionId,
    // A placeholder replaced below: the key needs the generated id, which only exists after insert.
    objectKey: `pending-${crypto.randomUUID()}`,
    originalName: 'cv.txt',
    declaredMediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    bytes: 32,
    // The column defaults to `awaiting_upload`; the worker only leases `pending`, so a fixture that
    // relied on the default would silently test nothing.
    scanStatus: options.scanStatus ?? 'pending',
    // Stamped from the worker's clock, not the database's. `created_at` defaults to real `now()`,
    // which against a fixed 2027 `now` makes every fixture row look an epoch old — the abandoned-
    // intent sweep would then delete the very row a test just set up.
    createdAt: options.createdAt ?? NOW,
    scanAttempts: options.scanAttempts ?? 0,
    extractionAttempts: options.extractionAttempts ?? 0,
    retentionExpiresAt: RETENTION,
  }).returning({ id: candidateDocuments.id })

  const objectKey = quarantineKeyFor({ organizationId, submissionId, documentId: row.id })
  await db.update(candidateDocuments).set({ objectKey }).where(eq(candidateDocuments.id, row.id))
  storage.objects.set(objectKey, options.body ?? 'a candidate cv')
  return { id: row.id, objectKey }
}

const readDocument = async (id: string) => {
  const [row] = await db.select().from(candidateDocuments).where(eq(candidateDocuments.id, id))
  return row
}

describe('a clean document is promoted and extracted', () => {
  it('moves the object, marks it clean, and stores the text', async () => {
    const document = await seedDocument()

    const result = await run()
    expect(result.scannedClean).toBe(1)

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('clean')
    expect(row.objectKey.startsWith(CLEAN_PREFIX)).toBe(true)
    expect(storage.objects.has(document.objectKey), 'the quarantine object must be gone').toBe(false)
    expect(storage.objects.has(row.objectKey)).toBe(true)

    // Extraction happens on the next pass: this pass promoted the document, and the lease only sees
    // rows that were already clean when it ran.
    const second = await run()
    expect(second.extracted).toBe(1)

    const extracted = await readDocument(document.id)
    expect(extracted.extractionStatus).toBe('succeeded')
    const [extraction] = await db.select().from(documentExtractions).where(eq(documentExtractions.documentId, document.id))
    expect(extraction.plainText).toBe('extracted cv text')
    expect(extraction.status).toBe('succeeded')
    expect(extraction.evidenceMap).toMatchObject({ truncated: false })
  })

  it('does not re-process a document it already finished', async () => {
    await seedDocument()
    await run()
    await run()
    const third = await run()

    expect(third.scannedClean).toBe(0)
    expect(third.extracted).toBe(0)
    const rows = await db.select().from(documentExtractions)
    expect(rows).toHaveLength(1)
  })
})

describe('an upload that never completed is not work', () => {
  it('never leases a document still awaiting its bytes', async () => {
    // The reason `awaiting_upload` exists. The row is created when the signed URL is issued, so
    // without this state the worker would lease it and scan an object that does not exist yet —
    // burning attempts on, and eventually failing, a document the candidate is still uploading.
    const document = await seedDocument({ scanStatus: 'awaiting_upload' })
    // No object either, matching reality before the PUT lands.
    storage.objects.delete(document.objectKey)

    const result = await run()

    expect(result.scannedClean).toBe(0)
    expect(result.processedCount).toBe(0)
    expect((await readDocument(document.id)).scanStatus).toBe('awaiting_upload')
    expect((await readDocument(document.id)).scanAttempts).toBe(0)
  })
})

describe('an upload nobody completed stops holding quota', () => {
  it('sweeps an intent older than the abandonment window and deletes its partial object', async () => {
    // The candidate closed the tab mid-upload. The row counts toward their 25 MB, so leaving it
    // locks them out of part of their allowance with nothing on screen explaining why.
    const document = await seedDocument({
      scanStatus: 'awaiting_upload',
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
    })

    const result = await run()

    expect(result.abandonedIntents).toBe(1)
    expect(await readDocument(document.id)).toBeUndefined()
    expect(storage.objects.has(document.objectKey), 'a partial object must not survive its row').toBe(false)
  })

  it('leaves a fresh intent alone', async () => {
    const document = await seedDocument({ scanStatus: 'awaiting_upload', createdAt: NOW })
    const result = await run()
    expect(result.abandonedIntents).toBe(0)
    expect((await readDocument(document.id)).scanStatus).toBe('awaiting_upload')
  })
})

describe('an infected document never reaches the clean prefix', () => {
  it('marks it infected, deletes the object, and skips extraction', async () => {
    const document = await seedDocument()
    scanBehaviour = async () => ({ status: 'infected', detailCode: 'Eicar-Test-Signature' })

    const result = await run()
    expect(result.scannedInfected).toBe(1)

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('infected')
    expect(row.rejectionCode).toBe('Eicar-Test-Signature')
    expect(row.objectKey).toBe(document.objectKey)
    expect(storage.objects.size, 'known malware must not be retained').toBe(0)
    // `skipped`, not `pending`: a pending extraction status would let the parser pass pick up the
    // one file it must never open.
    expect(row.extractionStatus).toBe('skipped')

    await run()
    expect(await db.select().from(documentExtractions)).toHaveLength(0)
  })
})

describe('an unavailable scanner never yields clean', () => {
  it('requeues the document and counts the attempt', async () => {
    const document = await seedDocument()
    scanBehaviour = async () => { throw new ScanProviderError('down', 'provider_unavailable') }

    const result = await run()
    expect(result.scanRetried).toBe(1)

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('pending')
    expect(row.scanAttempts).toBe(1)
    expect(storage.objects.has(document.objectKey), 'the object stays quarantined').toBe(true)
  })

  it('fails the document once the cap is spent, and fails it rather than passing it', async () => {
    const document = await seedDocument()
    scanBehaviour = async () => { throw new ScanProviderError('down', 'provider_unavailable') }

    for (let pass = 0; pass < MAX_SCAN_ATTEMPTS + 2; pass += 1) await run()

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('failed')
    expect(row.rejectionCode).toBe('scan_unavailable')
    expect(row.scanAttempts).toBe(MAX_SCAN_ATTEMPTS)
    expect(row.objectKey.startsWith(CLEAN_PREFIX), 'never promoted').toBe(false)
  })

  it('stops leasing a document that has spent its attempts', async () => {
    // Belt and braces on the cap: a row left `pending` with attempts already at the ceiling — by an
    // older worker or a manual reset — must not be picked up again.
    const document = await seedDocument({ scanAttempts: MAX_SCAN_ATTEMPTS })
    const result = await run()

    expect(result.scannedClean).toBe(0)
    expect((await readDocument(document.id)).scanStatus).toBe('pending')
  })
})

describe('a scanner that answers "cannot scan" is a rejection, not a retry', () => {
  it('fails the document immediately with the scanner detail', async () => {
    const document = await seedDocument()
    scanBehaviour = async () => ({ status: 'error', detailCode: 'Encrypted.Archive' })

    const result = await run()
    expect(result.scanRejected).toBe(1)

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('failed')
    expect(row.rejectionCode).toBe('Encrypted.Archive')
    expect(row.scanAttempts, 'one attempt, not the whole cap').toBe(1)
  })
})

describe('a failed promotion does not mark a document clean', () => {
  it('requeues when the move fails after a clean verdict', async () => {
    const document = await seedDocument()
    storage.moveShouldFail = true

    const result = await run()
    expect(result.scanRetried).toBe(1)

    const row = await readDocument(document.id)
    expect(row.scanStatus).toBe('pending')
    expect(row.objectKey).toBe(document.objectKey)
  })
})

describe('extraction outcomes', () => {
  async function promote(organizationId = ORG_A) {
    const document = await seedDocument({ organizationId })
    await run()
    return document
  }

  it('records a permanent failure without retrying it', async () => {
    const document = await promote()
    extractBehaviour = async () => { throw new DocumentExtractionError('encrypted', 'encrypted_document') }

    const result = await run()
    expect(result.extractionRejected).toBe(1)

    const row = await readDocument(document.id)
    expect(row.extractionStatus).toBe('failed')
    // The error code cannot live on the document — `candidate_documents_rejection_check` binds
    // `rejection_code` to a non-clean scan status — so it has to be on the extraction row.
    expect(row.rejectionCode).toBeNull()
    const [extraction] = await db.select().from(documentExtractions).where(eq(documentExtractions.documentId, document.id))
    expect(extraction.status).toBe('failed')
    expect(extraction.errorCode).toBe('encrypted_document')
    expect(extraction.plainText).toBeNull()
    expect(extraction.contentSha256).toBe('a'.repeat(64))
  })

  it('requeues a transient extraction failure', async () => {
    const document = await promote()
    extractBehaviour = async () => { throw new Error('storage hiccup') }

    const result = await run()
    expect(result.extractionRetried).toBe(1)

    const row = await readDocument(document.id)
    expect(row.extractionStatus).toBe('pending')
    expect(row.extractionAttempts).toBe(1)
  })
})

describe('tenant isolation', () => {
  it('leaves another tenant untouched when one tenant fails', async () => {
    const a = await seedDocument({ organizationId: ORG_A })
    const b = await seedDocument({ organizationId: ORG_B })
    scanBehaviour = async (key) => {
      if (key === a.objectKey) throw new ScanProviderError('down', 'provider_unavailable')
      return { status: 'clean', detailCode: null }
    }

    await run()

    expect((await readDocument(a.id)).scanStatus).toBe('pending')
    expect((await readDocument(b.id)).scanStatus).toBe('clean')
  })
})

describe('stale leases are reclaimed', () => {
  it('returns a document abandoned mid-scan to the queue', async () => {
    // Simulates a worker killed after claiming: status `scanning`, nothing coming back for it.
    const document = await seedDocument()
    await db.update(candidateDocuments)
      .set({ scanStatus: 'scanning', updatedAt: new Date(NOW.getTime() - 60 * 60_000) })
      .where(eq(candidateDocuments.id, document.id))

    const result = await run({ staleLeaseMs: 60_000 })
    expect(result.reclaimed).toBe(1)
    // Reclaimed and re-leased in the same pass, so it also completes.
    expect((await readDocument(document.id)).scanStatus).toBe('clean')
  })

  it('leaves a fresh lease alone', async () => {
    const document = await seedDocument()
    // Fresh relative to the worker's clock, which is what the cutoff is measured against — using
    // the real wall clock here would make the row ancient against a fixed 2027 `now`.
    await db.update(candidateDocuments)
      .set({ scanStatus: 'scanning', updatedAt: NOW })
      .where(eq(candidateDocuments.id, document.id))

    const result = await run({ staleLeaseMs: 15 * 60_000 })
    expect(result.reclaimed).toBe(0)
    expect((await readDocument(document.id)).scanStatus).toBe('scanning')
  })
})
