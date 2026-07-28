/**
 * Real disposable Postgres, real billing platform, fake provider.
 *
 * The evidence assembly is the half most likely to be quietly wrong: whether a pending document
 * contributes an empty manifest slot, whether a restricted link can carry text, whether ids stay stable
 * across regenerations. All three are database-shaped questions and none survive a mocked repository.
 *
 * The provider is faked because the paths worth testing are the ones a real one will not produce on
 * demand — a completion citing a source that was never sent, a schema violation, an outage.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  SENSITIVE_AI_ENABLED: 'true' as 'true' | 'false',
  SENSITIVE_AI_PROVIDER: 'mistral' as const,
  MISTRAL_BASE_URL: 'https://api.mistral.ai',
  MISTRAL_MODEL: 'mistral-medium-2604',
  MISTRAL_API_KEY: 'k',
  INTERVIEW_DOCUMENT_RETENTION_DAYS: 180,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const { generateBrief, editBrief, buildFallbackBrief, BriefServiceError } = await import('~/lib/interviews/brief-service')
const { assembleBriefEvidence } = await import('~/lib/interviews/evidence')
const { listBriefVersions } = await import('~/shared/lib/repositories/interviews')
const { AIParseError, AIProviderError } = await import('~/shared/lib/ai/errors')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'bs-org'
const OWNER = 'bs-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let invitationId = ''
let submissionId = ''
const principal = { organizationId: ORG, userId: OWNER, role: 'owner', requestId: 'r1' } as never

/** A completion that returns a valid brief citing whatever it was sent. */
function validCompletion() {
  return async (input: { schema: { parse: (v: unknown) => unknown } }) => {
    const manifest = capturedManifest
    const citable = manifest.filter((entry) => entry.kind !== 'submitted_link')
    const output = {
      candidateSummary: 'Assessed from the supplied sources.',
      relevantEvidence: citable.map((entry) => ({
        claim: `Evidence from ${entry.label}.`,
        sourceIds: [entry.id],
        confidence: 'high' as const,
      })),
      informationGaps: [],
      contradictions: [],
      questionGroups: [{
        category: 'technical' as const,
        question: 'Tell me about that work.',
        rationale: 'Cited above.',
        sourceIds: citable.length > 0 ? [citable[0].id] : [],
      }],
    }
    return {
      output: input.schema.parse(output),
      provider: 'mistral' as const,
      model: 'mistral-medium-2604',
      usage: { promptTokens: 100, completionTokens: 200 },
      durationMs: 5,
    }
  }
}

let capturedManifest: Array<{ id: string; kind: string; label: string }> = []

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('brief_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values({
    id: OWNER, name: 'Owner', email: 'bs@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  const customerId = uniqueId('cus')
  await db.insert(schema.billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: NOW, updatedAt: NOW,
  })
  await db.insert(schema.billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: NOW,
    createdAt: NOW, updatedAt: NOW,
  })

  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: ORG, calendarId: calendar.id, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
    title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 3_600_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })
  eventId = event.id

  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: ORG, ownerUserId: OWNER, roleTitle: 'Engineer', roleContext: 'Backend',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
  }).returning({ id: schema.schedulingInvitations.id })
  invitationId = invitation.id

  const [submission] = await db.insert(schema.candidateSubmissions).values({
    organizationId: ORG, invitationId, displayName: 'Candidate',
    emailNormalized: 'cand@test.invalid', retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.candidateSubmissions.id })
  submissionId = submission.id
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  // Leaf-first, following the FK chain: allocations reference reservations, ledger entries reference
  // grants, and reservations must go before the grants they drew from. Reservations from earlier tests
  // would otherwise make a "nothing was charged" assertion read a previous test's row.
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.documentExtractions)
  await db.delete(schema.candidateDocuments)
  await db.delete(schema.candidateWebImports)
  await db.delete(schema.candidateLinks)
  mockEnv.SENSITIVE_AI_ENABLED = 'true'
  capturedManifest = []
  await db.transaction((tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 200, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
})

async function seedReadyDocument(name = 'cv.pdf', text = 'Ten years of Rust.') {
  const [doc] = await db.insert(schema.candidateDocuments).values({
    organizationId: ORG, submissionId, objectKey: `clean/${ORG}/${uniqueId('k')}`,
    originalName: name, declaredMediaType: 'application/pdf', sha256: 'a'.repeat(64),
    bytes: 100, scanStatus: 'clean', extractionStatus: 'succeeded', retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.candidateDocuments.id })
  await db.insert(schema.documentExtractions).values({
    organizationId: ORG, documentId: doc.id, parser: 'pdfjs', parserVersion: '1',
    contentSha256: 'b'.repeat(64), plainText: text, status: 'succeeded', retentionExpiresAt: FAR_FUTURE(),
  })
  return doc.id
}

async function seedPendingDocument() {
  const [doc] = await db.insert(schema.candidateDocuments).values({
    organizationId: ORG, submissionId, objectKey: `quarantine/${ORG}/${uniqueId('k')}`,
    originalName: 'pending.pdf', declaredMediaType: 'application/pdf', sha256: 'c'.repeat(64),
    bytes: 100, scanStatus: 'pending', retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.candidateDocuments.id })
  return doc.id
}

async function seedRestrictedLink(url = 'https://linkedin.com/in/someone') {
  const [link] = await db.insert(schema.candidateLinks).values({
    organizationId: ORG, submissionId, url, normalizedUrl: url,
    sourceType: 'platform', acquisitionMode: 'user_submitted', policyDecision: 'user_submitted',
    importState: 'not_importable',
  }).returning({ id: schema.candidateLinks.id })
  return link.id
}

async function seedImportedLink(url = 'https://someone.dev/', text = 'Built a cache.') {
  const [link] = await db.insert(schema.candidateLinks).values({
    organizationId: ORG, submissionId, url, normalizedUrl: url,
    sourceType: 'personal_site', acquisitionMode: 'authorized_crawl', policyDecision: 'authorized_crawl',
    importState: 'succeeded', authorizationNoticeVersion: '2026-07-28.1', authorizationAttestedAt: NOW,
  }).returning({ id: schema.candidateLinks.id })
  await db.insert(schema.candidateWebImports).values({
    organizationId: ORG, candidateLinkId: link.id, finalUrl: url, sourcePolicyVersion: 'attestation:1',
    robotsResult: 'allowed', status: 'succeeded', extractedText: text, contentSha256: 'd'.repeat(64),
    retentionExpiresAt: FAR_FUTURE(),
  })
  return link.id
}

const run = (overrides: Record<string, unknown> = {}) => db.transaction((tx) => generateBrief(
  tx as never,
  principal,
  {
    eventId, submissionId, roleTitle: 'Engineer', roleContext: 'Backend', now: NOW,
    complete: (async (input: never) => {
      capturedManifest = capturedEvidence
      return validCompletion()(input as never)
    }) as never,
    ...overrides,
  },
))

let capturedEvidence: Array<{ id: string; kind: string; label: string }> = []

describe('evidence assembly decides what may be cited', () => {
  it('includes a scanned, extracted document as citable text', async () => {
    const docId = await seedReadyDocument()
    const evidence = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })

    expect(evidence.manifest).toHaveLength(1)
    expect(evidence.manifest[0]).toMatchObject({ id: `doc:${docId}`, kind: 'document', text: 'Ten years of Rust.' })
    expect(evidence.summary.citableSources).toBe(1)
  })

  it('omits a pending document entirely rather than adding an empty slot', async () => {
    await seedPendingDocument()
    const evidence = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })

    // A manifest slot with no text invites the model to invent what it might have said, and a citation
    // to it would look identical to a citation of something real.
    expect(evidence.manifest).toHaveLength(0)
    expect(evidence.summary.pendingDocuments).toBe(1)
  })

  it('omits an infected document and counts it as rejected', async () => {
    await db.insert(schema.candidateDocuments).values({
      organizationId: ORG, submissionId, objectKey: `q/${uniqueId('k')}`, originalName: 'bad.pdf',
      declaredMediaType: 'application/pdf', sha256: 'e'.repeat(64), bytes: 10,
      scanStatus: 'infected', extractionStatus: 'skipped', rejectionCode: 'Eicar-Test-Signature',
      retentionExpiresAt: FAR_FUTURE(),
    })
    const evidence = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })
    expect(evidence.manifest).toHaveLength(0)
    expect(evidence.summary.rejectedDocuments).toBe(1)
  })

  it('keeps a restricted link as url-only, with no text at all', async () => {
    const linkId = await seedRestrictedLink()
    const evidence = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })

    expect(evidence.manifest).toEqual([
      { id: `link:${linkId}`, kind: 'submitted_link', label: 'https://linkedin.com/in/someone' },
    ])
    // The absence of `text` is the assertion: this is a URL an interviewer can open, not a source.
    expect(evidence.manifest[0]).not.toHaveProperty('text')
    expect(evidence.summary.citableSources).toBe(0)
  })

  it('includes a fetched site as citable, using the url we ended up at', async () => {
    await seedImportedLink('https://someone.dev/')
    const evidence = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })
    expect(evidence.manifest[0]).toMatchObject({ kind: 'approved_web', text: 'Built a cache.' })
    expect(evidence.summary.citableSources).toBe(1)
  })

  it('keeps ids stable across two assemblies', async () => {
    // Ids derive from the row, never from an array index. If regenerating renumbered them, every citation
    // in every earlier version would silently point somewhere else.
    await seedReadyDocument('a.pdf')
    await seedReadyDocument('b.pdf')
    const first = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })
    const second = await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })
    expect(first.manifest.map((entry) => entry.id)).toEqual(second.manifest.map((entry) => entry.id))
  })
})

describe('generation', () => {
  it('refuses to generate with no readable evidence', async () => {
    await seedPendingDocument()
    const outcome = await run()

    expect(outcome.kind).toBe('no_evidence')
    // The counts are the point: the UI can say "one document is still being scanned", which the
    // organizer can act on.
    if (outcome.kind === 'no_evidence') expect(outcome.summary.pendingDocuments).toBe(1)
    expect(await listBriefVersions(db as never, { organizationId: ORG, eventId })).toHaveLength(0)
  })

  it('generates, settles five credits, and records provenance', async () => {
    await seedReadyDocument()
    capturedEvidence = (await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })).manifest as never

    const outcome = await run()
    expect(outcome.kind).toBe('generated')
    if (outcome.kind !== 'generated') return

    expect(outcome.settledUnits).toBe(5)
    expect(outcome.brief.version).toBe(1)
    expect(outcome.brief.status).toBe('draft')
    expect(outcome.brief.provider).toBe('mistral')
    expect(outcome.brief.promptVersion).toBe('1')
    // A flat 5, not token-proportional: the price of preparing for an interview must not depend on how
    // long the candidate's CV happens to be.
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    expect(reservation.settledUnits).toBe(5)
  })

  it('never sends a request when the organization has no credits', async () => {
    // Order matters: `billing_ledger_entries` references the grant, so the grant cannot go first.
    await db.delete(schema.billingLedgerEntries)
    await db.delete(schema.billingCreditGrants)
    await seedReadyDocument()
    let called = false

    await expect(run({
      complete: (async () => { called = true; throw new Error('unreachable') }) as never,
    })).rejects.toBeInstanceOf(BriefServiceError)
    expect(called, 'no provider request before a reservation exists').toBe(false)
  })
})

describe('failure produces an honest fallback, not a partial brief', () => {
  it('falls back when sensitive AI is switched off, without charging', async () => {
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    await seedReadyDocument()

    const outcome = await run()
    expect(outcome.kind).toBe('fallback')
    if (outcome.kind !== 'fallback') return
    expect(outcome.reason).toBe('ai_disabled')
    // No provenance at all — the row says plainly that no model wrote it.
    expect(outcome.brief.provider).toBeNull()
    expect(outcome.brief.model).toBeNull()
    // Charging for a brief the kill switch forbids generating would be indefensible.
    expect(await db.select().from(schema.billingCreditReservations)).toHaveLength(0)
  })

  it.each([
    ['a provider outage', () => new AIProviderError(503, 'down'), 'provider_failed'],
    ['unparseable output', () => new AIParseError('not json'), 'invalid_output'],
  ])('falls back on %s', async (_label, makeError, reason) => {
    await seedReadyDocument()
    const outcome = await run({ complete: (async () => { throw makeError() }) as never })

    expect(outcome.kind).toBe('fallback')
    if (outcome.kind !== 'fallback') return
    expect(outcome.reason).toBe(reason)
    expect(outcome.brief.provider).toBeNull()
  })

  it('falls back when the completion cites a source it was never sent', async () => {
    // The fabrication the per-call schema exists to catch: the model invents `doc:missing`.
    //
    // The fake validates the way the real adapter does — `safeParse`, then `AIParseError` — because
    // calling `schema.parse` directly throws a ZodError, which no production path can produce and which
    // would have made this test assert a failure mode that does not exist.
    await seedReadyDocument()
    const outcome = await run({
      complete: (async (input: { schema: { safeParse: (v: unknown) => { success: boolean } } }) => {
        const parsed = input.schema.safeParse({
          candidateSummary: 'x',
          relevantEvidence: [{ claim: 'y', sourceIds: ['doc:missing'], confidence: 'high' }],
          informationGaps: [], contradictions: [], questionGroups: [],
        })
        if (!parsed.success) throw new AIParseError('output failed validation')
        throw new Error('the schema should have rejected a fabricated citation')
      }) as never,
    })

    expect(outcome.kind).toBe('fallback')
    if (outcome.kind === 'fallback') expect(outcome.reason).toBe('invalid_output')
  })

  it('builds a fallback that asserts nothing about the candidate', () => {
    const content = buildFallbackBrief({
      roleTitle: 'Engineer',
      manifest: [
        { id: 'doc:1', kind: 'document', label: 'cv.pdf', text: 'x' },
        { id: 'link:1', kind: 'submitted_link', label: 'https://linkedin.com/in/x' },
      ],
      reason: 'ai_disabled',
    })

    // Every claim is true by construction — "a source was supplied" — at low confidence, because a
    // document existing is not evidence about a person.
    expect(content.relevantEvidence.every((entry) => entry.confidence === 'low')).toBe(true)
    expect(content.relevantEvidence.every((entry) => entry.claim.startsWith('A source was supplied'))).toBe(true)
    // The absence of AI is stated, not disguised.
    expect(content.candidateSummary).toMatch(/switched off/i)
    expect(content.informationGaps.join(' ')).toMatch(/not generated from the sources/i)
    // The unreadable link is named as something to open manually.
    expect(content.informationGaps.join(' ')).toMatch(/opened manually/i)
    // And nothing cites the restricted link as evidence.
    expect(content.relevantEvidence.flatMap((entry) => entry.sourceIds)).not.toContain('link:1')
  })
})

describe('editing', () => {
  it('applies an edit and records the editor', async () => {
    await seedReadyDocument()
    capturedEvidence = (await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })).manifest as never
    const generated = await run()
    if (generated.kind !== 'generated') throw new Error('expected a generated brief')

    const edited = await db.transaction((tx) => editBrief(tx as never, principal, {
      eventId,
      expectedVersion: generated.brief.version,
      content: { ...generated.brief.content, candidateSummary: 'Corrected.' },
      evidenceManifest: generated.brief.evidenceManifest,
      status: 'active',
    }))

    expect(edited.content.candidateSummary).toBe('Corrected.')
    expect(edited.editedByUserId).toBe(OWNER)
    expect(edited.status).toBe('active')
  })

  it('reports a version conflict rather than discarding the other tab’s work', async () => {
    await seedReadyDocument()
    capturedEvidence = (await assembleBriefEvidence(db as never, { organizationId: ORG, submissionId })).manifest as never
    const generated = await run()
    if (generated.kind !== 'generated') throw new Error('expected a generated brief')

    await expect(db.transaction((tx) => editBrief(tx as never, principal, {
      eventId, expectedVersion: generated.brief.version + 5,
      content: generated.brief.content, evidenceManifest: generated.brief.evidenceManifest,
    }))).rejects.toMatchObject({ name: 'BriefServiceError', code: 'version_conflict' })
  })
})
