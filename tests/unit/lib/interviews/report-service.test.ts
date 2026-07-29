/**
 * Real disposable Postgres, real billing platform, fake provider.
 *
 * The report is the artifact a hiring decision gets argued from weeks later, so the assertions that matter
 * are about what it *cannot* contain: a score, a conclusion, or a citation that resolves to nothing. Each of
 * those has to hold for a hand-edited report as much as a generated one, which is a database-shaped claim —
 * the evidence list lives in a column and an edit must not be able to widen it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  SENSITIVE_AI_ENABLED: 'true' as 'true' | 'false',
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const service = await import('~/lib/interviews/report-service')
const {
  finalizeReport,
  findLatestReport,
  insertBriefVersion,
  listReportVersions,
} = await import('~/shared/lib/repositories/interviews')
const { AIParseError, AIProviderError } = await import('~/shared/lib/ai/errors')
import { tenantTransaction } from '../../helpers/tenant-transaction'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'rep-org'
const OWNER = 'rep-owner'
const OTHER = 'rep-other'
const NOW = new Date('2027-11-01T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let sessionId = ''
let segmentIds: string[] = []
const principal = { organizationId: ORG, userId: OWNER, role: 'owner', requestId: 'r1' } as never

const briefContent = {
  candidateSummary: 'Backend engineer with cache work.',
  relevantEvidence: [{ claim: 'Rewrote a cache.', sourceIds: ['doc:1'], confidence: 'high' as const }],
  informationGaps: [],
  contradictions: [],
  questionGroups: [
    { category: 'critical' as const, question: 'Explain the rollout sequence.', rationale: 'Dates disagree.', sourceIds: ['doc:1'] },
    { category: 'technical' as const, question: 'How did you measure latency?', rationale: 'Numbers claimed.', sourceIds: ['doc:1'] },
  ],
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('report_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'rep@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: OTHER, name: 'Other', email: 'rep2@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
  ])
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
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.interviewReports)
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 100, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
  mockEnv.SENSITIVE_AI_ENABLED = 'true'

  const [session] = await db.insert(schema.interviewSessions).values({
    organizationId: ORG, eventId, ownerUserId: OWNER, state: 'processing',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v1', captureCapability: 'microphone_and_shared_audio_available',
    startedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.interviewSessions.id })
  sessionId = session.id
  segmentIds = []
})

async function seedBrief() {
  await tenantTransaction(db, ORG, (tx) => insertBriefVersion(tx as never, {
    organizationId: ORG, eventId, ownerUserId: OWNER,
    content: briefContent, evidenceManifest: [{ id: 'doc:1', kind: 'document', label: 'cv.pdf' }],
    provider: 'mistral', model: 'mistral-medium-2604', promptVersion: '1',
    status: 'active', retentionExpiresAt: FAR_FUTURE(),
  }))
}

async function seedSegments(count = 3) {
  for (let n = 1; n <= count; n += 1) {
    const [row] = await db.insert(schema.transcriptSegments).values({
      organizationId: ORG, sessionId, providerSegmentId: `req:0:${n}`, sequence: n,
      speakerEstimate: n % 2 === 0 ? 'speaker_b' : 'speaker_a',
      text: `Turn ${n} about the cache rewrite.`, startsMs: n * 60_000, endsMs: n * 60_000 + 3_000,
      retentionExpiresAt: FAR_FUTURE(),
    }).returning({ id: schema.transcriptSegments.id })
    segmentIds.push(row.id)
  }
  return segmentIds
}

async function currentSession(overrides: Record<string, unknown> = {}) {
  const [row] = await db.select().from(schema.interviewSessions)
  return { ...row, ...overrides } as never
}

/** Validates the way the real boundary does: `safeParse`, then `AIParseError`. */
function validateLikeProvider<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AIParseError('sensitive provider returned output that failed validation')
  return result.data as T
}

const reportContent = (ids: string[], overrides: Record<string, unknown> = {}) => ({
  summary: [{ statement: 'Described a cache rewrite and its measured effect.', segmentIds: [ids[0]] }],
  answersByTopic: [
    { topicId: 'topic:1', answer: 'Walked through the rollout in two stages.', segmentIds: [ids[0]], status: 'answered' as const },
    { topicId: 'topic:2', answer: 'Not discussed.', segmentIds: [], status: 'unanswered' as const },
  ],
  openQuestions: ['How was the rollback tested?'],
  followUps: [{ action: 'Ask for the latency dashboard.', segmentIds: [ids[1] ?? ids[0]] }],
  ...overrides,
})

function goodProvider(calls: { count: number }, overrides: Record<string, unknown> = {}) {
  return async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
    calls.count += 1
    const ids = [...input.prompt.matchAll(/\[([0-9a-f-]{36})\]/g)].map((match) => match[1])
    return {
      output: validateLikeProvider(input.schema as never, reportContent(ids, overrides)),
      provider: 'mistral' as const,
      model: 'mistral-medium-2604',
      usage: { promptTokens: 900, completionTokens: 400 },
      durationMs: 9,
    }
  }
}

const generate = (overrides: Record<string, unknown> = {}) => tenantTransaction(db, ORG, async (tx) => service.generateReport(
  tx as never,
  principal,
  { session: await currentSession(), now: NOW, complete: goodProvider({ count: 0 }) as never, ...overrides },
))

describe('generating a report', () => {
  it('stores version 1 with provenance and the real evidence list', async () => {
    await seedBrief()
    const ids = await seedSegments()
    const outcome = await generate()
    expect(outcome.kind).toBe('generated')
    expect(outcome.kind === 'generated' && outcome.report.version).toBe(1)
    expect(outcome.kind === 'generated' && outcome.report.provider).toBe('mistral')
    expect(outcome.kind === 'generated' && outcome.report.promptVersion).toBe('1')
    expect(outcome.kind === 'generated' && outcome.report.evidenceSegmentIds).toEqual(ids)
  })

  it('settles five credits', async () => {
    await seedBrief()
    await seedSegments()
    await generate()
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    expect(reservation.state).toBe('settled')
    expect(reservation.settledUnits).toBe(5)
  })

  it('refuses a caller who does not own the interview', async () => {
    await seedBrief()
    await seedSegments()
    await expect(tenantTransaction(db, ORG, async (tx) => service.generateReport(tx as never, principal, {
      session: await currentSession({ ownerUserId: OTHER }), now: NOW, complete: goodProvider({ count: 0 }) as never,
    }))).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('reports no transcript rather than an empty record', async () => {
    await seedBrief()
    const outcome = await generate()
    // A manual-only interview, or one whose capture never started. A report of empty sections presented as
    // a record would be worse than none.
    expect(outcome.kind).toBe('no_transcript')
    expect(await db.select().from(schema.interviewReports)).toHaveLength(0)
  })

  it('does not consult the provider or reserve credits with no transcript', async () => {
    await seedBrief()
    const calls = { count: 0 }
    await generate({ complete: goodProvider(calls) as never })
    expect(calls.count).toBe(0)
    expect(await db.select().from(schema.billingCreditReservations)).toHaveLength(0)
  })

  it('labels remote speakers by role and renders timestamps', async () => {
    await seedBrief()
    await seedSegments(2)
    let prompt = ''
    await generate({
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        prompt = input.prompt
        return goodProvider({ count: 0 })(input)
      },
    })
    expect(prompt).toMatch(/01:00 Interviewer:/)
    expect(prompt).toMatch(/02:00 Candidate:/)
    expect(prompt).not.toMatch(/speaker_a/)
  })

  it('keeps the organizer notes in their own region', async () => {
    await seedBrief()
    await seedSegments()
    let prompt = ''
    await generate({
      organizerNotes: 'Hesitant about scale.',
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        prompt = input.prompt
        return goodProvider({ count: 0 })(input)
      },
    })
    // Merging them into the transcript would let a private impression be cited as something the candidate
    // said.
    expect(prompt).toMatch(/<interviewer-notes>/)
    expect(prompt.indexOf('</transcript>')).toBeLessThan(prompt.indexOf('<interviewer-notes>'))
  })
})

describe('the template path', () => {
  const expectTemplate = async (outcome: Awaited<ReturnType<typeof generate>>, reason: string) => {
    expect(outcome.kind).toBe('template')
    expect(outcome.kind === 'template' && outcome.reason).toBe(reason)
    // `provider: null` is the marker. A template presented as model output would be the most misleading
    // thing this service could produce.
    expect(outcome.kind === 'template' && outcome.report.provider).toBeNull()
    expect(outcome.kind === 'template' && outcome.report.model).toBeNull()
    expect(outcome.kind === 'template' && outcome.report.promptVersion).toBeNull()
  }

  it('produces a template when the AI switch is off, and charges nothing', async () => {
    await seedBrief()
    await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await generate()
    await expectTemplate(outcome, 'ai_disabled')
    // Checked before reserving. An organizer handed a blank form and billed for a report would be right to
    // be angry.
    expect(await db.select().from(schema.billingCreditReservations)).toHaveLength(0)
  })

  it('produces a template when the provider is down, and releases the hold', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await generate({ complete: async () => { throw new AIProviderError(503, 'down') } })
    await expectTemplate(outcome, 'provider_failed')
    const [reservation] = await db.select().from(schema.billingCreditReservations)
    // Released, not settled: nothing was produced.
    expect(reservation.state).toBe('released')
  })

  it('produces a template when the output does not validate', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await generate({ complete: async () => { throw new AIParseError('not json') } })
    await expectTemplate(outcome, 'invalid_output')
  })

  it('produces a template when there is no brief to take topics from', async () => {
    await seedSegments()
    const outcome = await generate()
    // `answersByTopic` is where the report's structure comes from. A template lets the organizer write the
    // record without a model inventing a shape for it.
    await expectTemplate(outcome, 'no_topics')
  })

  it('gives the template the real evidence list so the organizer\'s own citations resolve', async () => {
    await seedBrief()
    const ids = await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await generate()
    expect(outcome.kind === 'template' && outcome.report.evidenceSegmentIds).toEqual(ids)
  })

  it('marks every template topic unanswered', async () => {
    await seedBrief()
    await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await generate()
    const content = outcome.kind === 'template' ? outcome.report.content : null
    expect(content?.answersByTopic.every((entry) => entry.status === 'unanswered')).toBe(true)
  })

  it('does not produce a template for a credit refusal', async () => {
    await seedBrief()
    await seedSegments()
    await db.delete(schema.billingCreditAllocations)
    await db.delete(schema.billingLedgerEntries)
    await db.delete(schema.billingCreditGrants)
    await tenantTransaction(db, ORG, (tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
      source: 'promotional', units: 1, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
    }))
    // A report is a deliberate priced action the organizer asked for. Silently handing them a blank form
    // would hide the fact that they need to top up.
    await expect(generate()).rejects.toMatchObject({ code: 'insufficient_credits' })
    expect(await db.select().from(schema.interviewReports)).toHaveLength(0)
  })

  it('does not produce a template for a tier refusal', async () => {
    await seedBrief()
    await seedSegments()
    await db.delete(schema.billingSubscriptions)
    await expect(generate()).rejects.toMatchObject({ code: 'not_entitled' })
    const [customer] = await db.select().from(schema.billingCustomers)
    await db.insert(schema.billingSubscriptions).values({
      id: uniqueId('sub'), organizationId: ORG, customerId: customer.id, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: NOW,
      createdAt: NOW, updatedAt: NOW,
    })
  })
})

describe('the report cannot conclude anything', () => {
  it('refuses a completion carrying a score', async () => {
    await seedBrief()
    const ids = await seedSegments()
    const outcome = await generate({
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        return {
          output: validateLikeProvider(input.schema as never, {
            ...reportContent([...input.prompt.matchAll(/\[([0-9a-f-]{36})\]/g)].map((m) => m[1])),
            summary: [{ statement: 'Overall score 8 of 10.', segmentIds: [ids[0]] }],
          }),
          provider: 'mistral', model: 'm', usage: { promptTokens: 1, completionTokens: 1 }, durationMs: 1,
        }
      },
    })
    // Degraded to a template rather than stored. The words are refused whatever persuaded the model to
    // write them.
    expect(outcome.kind === 'template' && outcome.reason).toBe('invalid_output')
  })

  it('refuses a completion citing a segment outside the transcript', async () => {
    await seedBrief()
    const ids = await seedSegments()
    const outcome = await generate({
      complete: async (input: { schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => ({
        output: validateLikeProvider(input.schema as never, {
          ...reportContent(ids),
          summary: [{ statement: 'They led a team of twelve.', segmentIds: ['00000000-0000-4000-8000-000000000000'] }],
        }),
        provider: 'mistral', model: 'm', usage: { promptTokens: 1, completionTokens: 1 }, durationMs: 1,
      }),
    })
    // A timestamp link that resolves to nothing is how an unsupported claim survives review.
    expect(outcome.kind === 'template' && outcome.reason).toBe('invalid_output')
  })
})

describe('editing', () => {
  async function generated() {
    await seedBrief()
    const ids = await seedSegments()
    const outcome = await generate()
    return { ids, report: outcome.kind === 'generated' ? outcome.report : null }
  }

  const edit = (content: unknown, expectedVersion = 1, actor = principal) =>
    tenantTransaction(db, ORG, async (tx) => service.editReport(tx as never, actor, {
      session: await currentSession(), expectedVersion, content, now: NOW,
    }))

  it('appends a new version and records who edited it', async () => {
    const { ids } = await generated()
    const edited = await edit(reportContent(ids, {
      openQuestions: ['How was the rollback tested, and by whom?'],
    }))
    // A new version, not an update: silently overwriting what a model wrote would erase the difference
    // between the machine's record and the human's correction.
    expect(edited.version).toBe(2)
    expect(edited.editedByUserId).toBe(OWNER)
    // The original provenance survives, so a reader knows a model produced the first draft.
    expect(edited.provider).toBe('mistral')
  })

  it('refuses a stale expected version', async () => {
    const { ids } = await generated()
    await edit(reportContent(ids))
    await expect(edit(reportContent(ids), 1)).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('refuses a non-owner', async () => {
    const { ids } = await generated()
    await expect(tenantTransaction(db, ORG, async (tx) => service.editReport(tx as never, principal, {
      session: await currentSession({ ownerUserId: OTHER }), expectedVersion: 1, content: reportContent(ids),
    }))).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('refuses an edit citing a segment outside the stored evidence', async () => {
    const { ids } = await generated()
    // A hand-edited report is exactly where an unsupported claim would be introduced, so this check matters
    // more here, not less.
    await expect(edit(reportContent(ids, {
      summary: [{ statement: 'They mentioned managing a large team.', segmentIds: ['00000000-0000-4000-8000-000000000000'] }],
    }))).rejects.toMatchObject({ code: 'dangling_reference' })
  })

  it('refuses an edit introducing a score', async () => {
    const { ids } = await generated()
    await expect(edit(reportContent(ids, {
      summary: [{ statement: 'My score for them is high.', segmentIds: [ids[0]] }],
    }))).rejects.toMatchObject({ code: 'invalid_content' })
  })

  it('refuses an edit introducing a hire recommendation', async () => {
    const { ids } = await generated()
    await expect(edit(reportContent(ids, {
      followUps: [{ action: 'Recommend to hire.', segmentIds: [ids[0]] }],
    }))).rejects.toMatchObject({ code: 'invalid_content' })
  })

  it('refuses malformed content', async () => {
    await generated()
    await expect(edit({ summary: 'not an array' })).rejects.toMatchObject({ code: 'invalid_content' })
  })

  it('does not let an edit widen the evidence list', async () => {
    const { ids } = await generated()
    const edited = await edit(reportContent(ids))
    // Inherited from the previous version, never taken from the request. An editable evidence list would
    // let a citation be pointed at a segment that was never in the transcript.
    expect(edited.evidenceSegmentIds).toEqual(ids)
  })

  it('refuses an edit when there is no report', async () => {
    await expect(edit({ summary: [], answersByTopic: [], openQuestions: [], followUps: [] }))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('finalizing', () => {
  async function generated() {
    await seedBrief()
    const ids = await seedSegments()
    await generate()
    return ids
  }

  const finalize = (expectedVersion = 1) =>
    tenantTransaction(db, ORG, async (tx) => service.finalize(tx as never, principal, {
      session: await currentSession(), expectedVersion, now: NOW,
    }))

  it('marks the version final with a timestamp', async () => {
    await generated()
    const finalized = await finalize()
    expect(finalized.status).toBe('final')
    expect(finalized.finalizedAt).toEqual(NOW)
  })

  it('refuses a second finalize rather than rewriting when the decision was recorded', async () => {
    await generated()
    await finalize()
    await expect(finalize()).rejects.toMatchObject({ code: 'already_final' })
  })

  it('refuses a stale version', async () => {
    const ids = await generated()
    await tenantTransaction(db, ORG, async (tx) => service.editReport(tx as never, principal, {
      session: await currentSession(), expectedVersion: 1, content: reportContent(ids), now: NOW,
    }))
    // Someone else replaced the draft this caller was looking at.
    await expect(finalize(1)).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('refuses an edit after finalizing', async () => {
    const ids = await generated()
    await finalize()
    // A finalized report is the record. Editing it would change what a decision was made from, after the
    // fact.
    await expect(tenantTransaction(db, ORG, async (tx) => service.editReport(tx as never, principal, {
      session: await currentSession(), expectedVersion: 1, content: reportContent(ids), now: NOW,
    }))).rejects.toMatchObject({ code: 'already_final' })
  })

  it('refuses a non-owner', async () => {
    await generated()
    await expect(tenantTransaction(db, ORG, async (tx) => service.finalize(tx as never, principal, {
      session: await currentSession({ ownerUserId: OTHER }), expectedVersion: 1,
    }))).rejects.toMatchObject({ code: 'not_owner' })
  })

  it('the repository refuses a second finalize even with the service check bypassed', async () => {
    // The service's `already_final` check runs first, so it hides the repository's `status = 'draft'`
    // predicate — a plant removing that predicate left every other test green. The predicate is the guard
    // for the race the service check cannot see: two clients both read `draft`, both pass, and only one
    // UPDATE may win. Reaching the repository directly is the only way to exercise it.
    await generated()
    await tenantTransaction(db, ORG, (tx) => finalizeReport(tx as never, {
      organizationId: ORG, eventId, version: 1, finalizedAt: NOW,
    }))

    const secondAt = new Date(NOW.getTime() + 60_000)
    await expect(tenantTransaction(db, ORG, (tx) => finalizeReport(tx as never, {
      organizationId: ORG, eventId, version: 1, finalizedAt: secondAt,
    }))).rejects.toMatchObject({ code: 'version_conflict' })

    // And the recorded time is the first one. Without the predicate the second write would silently move
    // when the decision was made.
    const latest = await tenantTransaction(db, ORG, (tx) => findLatestReport(tx as never, { organizationId: ORG, eventId }))
    expect(latest?.finalizedAt).toEqual(NOW)
  })

  it('refuses when there is no report', async () => {
    await expect(finalize()).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('versions', () => {
  it('lists metadata without shipping four assessments of a person', async () => {
    await seedBrief()
    const ids = await seedSegments()
    await generate()
    await tenantTransaction(db, ORG, async (tx) => service.editReport(tx as never, principal, {
      session: await currentSession(), expectedVersion: 1, content: reportContent(ids), now: NOW,
    }))

    const versions = await tenantTransaction(db, ORG, (tx) => listReportVersions(tx as never, {
      organizationId: ORG, eventId,
    }))
    expect(versions.map((row) => row.version)).toEqual([2, 1])
    // No content. A version picker needs to know what exists, not to carry every draft into a browser.
    expect(Object.keys(versions[0])).not.toContain('content')
  })

  it('reads the latest version back', async () => {
    await seedBrief()
    await seedSegments()
    await generate()
    const latest = await tenantTransaction(db, ORG, (tx) => findLatestReport(tx as never, { organizationId: ORG, eventId }))
    expect(latest?.version).toBe(1)
    expect(latest?.status).toBe('draft')
  })
})
