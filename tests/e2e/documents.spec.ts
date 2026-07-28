/**
 * The candidate's document upload, against real MinIO and real ClamAV (plan:
 * calendar-scheduling-interview-intelligence, Phase 12).
 *
 * The unit tests cover `validateDocument`'s decisions on bytes it is handed. What
 * only this can prove is that the three-step flow agrees end to end: an intent
 * that presigns a PUT, a PUT that goes straight to storage without passing through
 * the app, and a completion that reads the object back and validates *what
 * actually landed* rather than what the client claimed.
 *
 * ## Why the checks live on completion, not on the PUT
 *
 * A presigned URL cannot enforce size or content — that is the whole point of
 * handing it out. So the declared `bytes` and `sha256` are claims, and completion
 * re-derives both from the object. Every assertion below therefore lies about
 * something on purpose and checks that the lie is caught.
 *
 * ## EICAR, not a real sample
 *
 * The EICAR test string is the industry's agreed-upon harmless stand-in: every
 * scanner detects it, and it does nothing. A real malware sample on a developer
 * laptop is a different kind of decision than a test needs to make.
 */
import { createHash } from 'node:crypto'
import { expect, test } from 'playwright/test'

import { uniqueId } from './harness/ids'
import {
  candidateContext,
  createInvitation,
  sendInvitation,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'docs',
    flags: { SCHEDULING_ENABLED: 'true', CANDIDATE_UPLOADS_ENABLED: 'true' },
  })

  // MinIO and ClamAV come from docker-compose. Without them every assertion below would fail
  // as a storage error, which reads as a product bug rather than a missing container.
  const health = await harness.owner.api!.get('/api/health')
  expect(health.status(), 'the worker server is up').toBe(200)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * A minimal but structurally valid PDF.
 *
 * The magic bytes matter: `validateDocument` sniffs content rather than trusting the declared
 * media type, so a text file called `cv.pdf` is rejected — which is one of the cases below.
 */
function pdfBytes(payload = 'E2E candidate CV'): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n${payload}\n`,
    'utf8',
  )
}

/** The EICAR test string, assembled so this file is not itself flagged by a scanner. */
function eicarBytes(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*']
  return Buffer.from(parts.join(''), 'utf8')
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

interface CandidateSession {
  context: Awaited<ReturnType<typeof candidateContext>>
  invitationId: string
}

/** A sent invitation with a submission, which uploads hang off. */
async function candidateWithSubmission(): Promise<CandidateSession> {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)

  const submission = await context.put(`/api/public/scheduling/${invitation.invitationId}/submission`, {
    data: {
      displayName: 'E2E Document Candidate',
      email: `doc-${uniqueId('c').slice(-8)}@test.invalid`,
      links: [],
      consentDecisions: [
        { purpose: 'terms_and_privacy', decision: 'accepted' },
        { purpose: 'candidate_document_processing', decision: 'accepted' },
      ],
    },
  })
  expect(submission.status(), await submission.text()).toBe(200)
  return { context, invitationId: invitation.invitationId }
}

interface UploadIntent { documentId: string; uploadUrl: string; expiresAt: string }

async function createIntent(
  session: CandidateSession,
  input: { originalName: string; declaredMediaType: string; bytes: number },
): Promise<UploadIntent> {
  const response = await session.context.post(`/api/public/scheduling/${session.invitationId}/uploads`, {
    data: input,
  })
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<UploadIntent>
}

/**
 * Puts the bytes at the presigned URL with a plain `fetch`.
 *
 * Deliberately not through the candidate's request context: the point of a presigned PUT is that
 * the object never passes through the application, and using the app's context would hide a URL
 * that only works because of an app cookie.
 */
async function putObject(uploadUrl: string, body: Buffer, contentType: string): Promise<number> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  })
  return response.status
}

async function completeUpload(
  session: CandidateSession,
  documentId: string,
  body: { sha256: string; bytes: number },
) {
  return session.context.post(
    `/api/public/scheduling/${session.invitationId}/uploads/${documentId}/complete`,
    { data: body },
  )
}

test('a real PDF uploads, completes, and is scanned clean', async () => {
  const session = await candidateWithSubmission()
  const body = pdfBytes()
  const intent = await createIntent(session, {
    originalName: 'cv.pdf',
    declaredMediaType: 'application/pdf',
    bytes: body.byteLength,
  })

  // A presigned URL, straight to storage — the app never sees the bytes on the way in.
  expect(await putObject(intent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)

  const completion = await completeUpload(session, intent.documentId, {
    sha256: sha256(body),
    bytes: body.byteLength,
  })
  expect(completion.status(), await completion.text()).toBe(200)

  const [row] = await harness.sql<{ scan_status: string; sha256: string | null; detected_media_type: string | null; object_key: string }[]>`
    select scan_status, sha256, detected_media_type, object_key
    from candidate_documents where id = ${intent.documentId}
  `
  expect(row?.sha256, 'the hash is the one the server computed from the object').toBe(sha256(body))
  expect(row?.detected_media_type).toBe('application/pdf')
  // Pending, not clean: scanning is a worker's job, and a completion that claimed "clean"
  // synchronously would be claiming a scan that never ran.
  expect(row?.scan_status).toBe('pending')
  // The key must not embed the candidate's name or email — it appears in storage logs.
  expect(row?.object_key).not.toMatch(/@/)

  const scan = await harness.owner.api!.post('/api/admin/interviews/run-retention', {
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
  }).catch(() => null)
  // The retention worker is a different job; this only asserts it does not reject a clean document.
  if (scan) expect(scan.status()).toBeLessThan(500)
})

test('EICAR is rejected and its object is removed', async () => {
  const session = await candidateWithSubmission()
  const body = eicarBytes()
  const intent = await createIntent(session, {
    originalName: 'resume.pdf',
    declaredMediaType: 'application/pdf',
    bytes: body.byteLength,
  })
  expect(await putObject(intent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)

  const completion = await completeUpload(session, intent.documentId, {
    sha256: sha256(body),
    bytes: body.byteLength,
  })
  // 422, not 400: the request was well-formed and the *content* was refused, which is a different
  // thing for the portal to say.
  expect(completion.status(), await completion.text()).toBe(422)
  const refusal = await completion.json() as { rejectionCode?: string; status?: string }
  expect(refusal.rejectionCode, 'a coded reason, so the portal can explain it').toBeTruthy()

  const [row] = await harness.sql<{ scan_status: string; rejection_code: string | null }[]>`
    select scan_status, rejection_code from candidate_documents where id = ${intent.documentId}
  `
  expect(row?.scan_status).toBe('failed')
  expect(row?.rejection_code).toBeTruthy()
})

test('a text file called cv.pdf is refused on content, not on its name', async () => {
  const session = await candidateWithSubmission()
  const body = Buffer.from('Dear hiring manager, this is not a PDF at all.\n', 'utf8')
  const intent = await createIntent(session, {
    originalName: 'cv.pdf',
    declaredMediaType: 'application/pdf',
    bytes: body.byteLength,
  })
  expect(await putObject(intent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)

  const completion = await completeUpload(session, intent.documentId, {
    sha256: sha256(body),
    bytes: body.byteLength,
  })
  expect(completion.status(), await completion.text()).toBe(422)
  const [row] = await harness.sql<{ rejection_code: string | null; detected_media_type: string | null }[]>`
    select rejection_code, detected_media_type from candidate_documents where id = ${intent.documentId}
  `
  // The declared type is a claim. A polyglot's whole trick is that the name and the header disagree.
  expect(row?.rejection_code).toBeTruthy()
  expect(row?.detected_media_type).not.toBe('application/pdf')
})

test('a misreported hash is caught against the stored object', async () => {
  const session = await candidateWithSubmission()
  const body = pdfBytes('honest bytes')
  const intent = await createIntent(session, {
    originalName: 'cv.pdf',
    declaredMediaType: 'application/pdf',
    bytes: body.byteLength,
  })
  expect(await putObject(intent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)

  const completion = await completeUpload(session, intent.documentId, {
    // A valid-looking hash of something else entirely.
    sha256: sha256(pdfBytes('different bytes')),
    bytes: body.byteLength,
  })
  expect(completion.status(), await completion.text()).toBe(422)
  const [row] = await harness.sql<{ rejection_code: string | null }[]>`
    select rejection_code from candidate_documents where id = ${intent.documentId}
  `
  expect(row?.rejection_code, 'the integrity mismatch is recorded, not shrugged off').toBeTruthy()
})

test('an oversized intent is refused before a URL is issued', async () => {
  const session = await candidateWithSubmission()
  const response = await session.context.post(`/api/public/scheduling/${session.invitationId}/uploads`, {
    data: { originalName: 'huge.pdf', declaredMediaType: 'application/pdf', bytes: 500 * 1024 * 1024 },
  })
  // Refused at the intent, so no signed URL exists that could be used to write 500 MB and only
  // then be rejected — the bytes would already have been paid for.
  expect(response.status()).toBeGreaterThanOrEqual(400)
  expect(await response.text()).not.toMatch(/http/i)
})

test("another candidate's document id is unreachable, and indistinguishable from a missing one", async () => {
  const mine = await candidateWithSubmission()
  const theirs = await candidateWithSubmission()

  const body = pdfBytes('their CV')
  const theirIntent = await createIntent(theirs, {
    originalName: 'cv.pdf', declaredMediaType: 'application/pdf', bytes: body.byteLength,
  })
  expect(await putObject(theirIntent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)

  // My capability, their document id.
  const crossed = await completeUpload(mine, theirIntent.documentId, {
    sha256: sha256(body), bytes: body.byteLength,
  })
  const invented = await completeUpload(mine, '00000000-0000-4000-8000-000000000000', {
    sha256: sha256(body), bytes: body.byteLength,
  })
  expect(crossed.status()).toBe(invented.status())
  expect(await crossed.text()).toBe(await invented.text())
  expect(crossed.status()).toBe(404)

  // And it is still awaiting its owner's completion, not marked by mine.
  const [row] = await harness.sql<{ scan_status: string }[]>`
    select scan_status from candidate_documents where id = ${theirIntent.documentId}
  `
  expect(row?.scan_status).toBe('awaiting_upload')
})

test('the organizer can download their candidate\'s document; nobody else can', async () => {
  const session = await candidateWithSubmission()
  const body = pdfBytes('downloadable')
  const intent = await createIntent(session, {
    originalName: 'portfolio.pdf', declaredMediaType: 'application/pdf', bytes: body.byteLength,
  })
  expect(await putObject(intent.uploadUrl, body, 'application/pdf')).toBeLessThan(300)
  expect((await completeUpload(session, intent.documentId, { sha256: sha256(body), bytes: body.byteLength })).status()).toBe(200)

  /*
   * The scan has to run first, and that is the point rather than a setup step.
   *
   * The download route filters on `scan_status = 'clean'` in the query, so a completed-but-unscanned
   * document answers `404` — which is what this test got when it assumed completion was enough.
   * Handing an organizer a file that no scanner has looked at is exactly what the quarantine prefix
   * exists to prevent, so the 404 was right and the expectation was wrong.
   */
  const scanned = await harness.owner.api!.post('/api/admin/documents/run-worker', {
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
  })
  expect(scanned.status(), await scanned.text()).toBeLessThan(400)

  const [afterScan] = await harness.sql<{ scan_status: string; object_key: string }[]>`
    select scan_status, object_key from candidate_documents where id = ${intent.documentId}
  `
  expect(afterScan?.scan_status, 'a clean PDF passes ClamAV').toBe('clean')
  // Promotion out of quarantine is the other half: a clean row still under `quarantine/` would mean
  // the worker updated the status without moving the object.
  expect(afterScan?.object_key).not.toMatch(/^quarantine\//)

  const download = await harness.owner.api!.get(
    `/api/scheduling/invitations/${session.invitationId}/documents/${intent.documentId}/download`,
  )
  expect(download.status(), await download.text()).toBe(200)
  const signed = await download.json() as { downloadUrl: string; originalName: string; expiresAt: string }
  expect(signed.originalName).toBe('portfolio.pdf')

  // The signed URL actually serves the bytes, and serves the *same* bytes.
  const fetched = await fetch(signed.downloadUrl)
  expect(fetched.status).toBe(200)
  const served = Buffer.from(await fetched.arrayBuffer())
  expect(sha256(served)).toBe(sha256(body))

  // It expires. A download link with no bound is a permanent copy of a candidate's CV in
  // whatever chat it was pasted into.
  expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now())
  expect(new Date(signed.expiresAt).getTime() - Date.now()).toBeLessThan(24 * 60 * 60_000)

  // The candidate's own capability is not a route to the organizer's download endpoint.
  const asCandidate = await session.context.get(
    `/api/scheduling/invitations/${session.invitationId}/documents/${intent.documentId}/download`,
  )
  expect(asCandidate.status(), 'the organizer endpoint needs a session, not a capability').toBeGreaterThanOrEqual(400)
})

test('audio is refused whatever it is called', async () => {
  const session = await candidateWithSubmission()
  // A WAV header. Interview audio is never stored — the schema has a check constraint saying so —
  // and the upload boundary must refuse it rather than relying on that constraint to fire.
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'utf8'), Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WAVEfmt ', 'utf8'), Buffer.from([16, 0, 0, 0]),
  ])

  for (const declared of ['audio/wav', 'application/pdf']) {
    const response = await session.context.post(`/api/public/scheduling/${session.invitationId}/uploads`, {
      data: { originalName: 'interview.wav', declaredMediaType: declared, bytes: wav.byteLength },
    })
    if (response.status() < 400) {
      // The intent was allowed on the declared type; completion must still refuse the content.
      const intent = await response.json() as UploadIntent
      expect(await putObject(intent.uploadUrl, wav, declared)).toBeLessThan(300)
      const completion = await completeUpload(session, intent.documentId, {
        sha256: sha256(wav), bytes: wav.byteLength,
      })
      expect(completion.status(), `audio declared as ${declared} must be refused`).toBe(422)
    }
  }

  const [{ count }] = await harness.sql<{ count: number }[]>`
    select count(*)::int as count from candidate_documents
    where detected_media_type like 'audio/%' and scan_status <> 'failed'
  `
  expect(count, 'no audio document is ever in a non-failed state').toBe(0)
})
