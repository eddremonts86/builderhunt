/**
 * Route tests for the suggestion, report and finalize APIs (plan:
 * calendar-scheduling-interview-intelligence, Phase 10).
 *
 * `withTenantContext` runs against a real disposable Postgres. The assertions that matter are about status
 * codes carrying meaning a client can act on — 402 versus 422 versus 409 are three different things the UI
 * must do — and about what the DTOs refuse to ship. A stubbed service would satisfy every one of them.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { tenantTransaction } from '../../../helpers/tenant-transaction'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  rateLimit: vi.fn(),
  sensitiveCompletion: vi.fn(),
}))

/**
 * Mutable, so a flag can be flipped between requests.
 *
 * A frozen spread of the real env would have made the feature-flag test unable to fail — the first version
 * of it asserted `[200, 503]`.contains(status), which is not a test.
 */
const mockEnv = vi.hoisted(() => ({
  SENSITIVE_AI_ENABLED: 'true' as 'true' | 'false',
  INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED: 'true' as 'true' | 'false',
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
  APP_URL: 'https://app.test',
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})
vi.mock('~/shared/lib/db/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/db/tenant-context')>()
  return { ...actual, withTenantContext: mocks.withTenantContext }
})
vi.mock('~/shared/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit }))
vi.mock('~/shared/lib/ai/sensitive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/ai/sensitive')>()
  return { ...actual, sensitiveCompletion: mocks.sensitiveCompletion }
})
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const { insertBriefVersion } = await import('~/shared/lib/repositories/interviews')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
const { AIProviderError } = await import('~/shared/lib/ai/errors')

const { Route: SuggestionsRoute } = await import('~/routes/api/interviews/$interviewId/suggestions')
const { Route: ReportRoute } = await import('~/routes/api/interviews/$interviewId/report')
const { Route: FinalizeRoute } = await import('~/routes/api/interviews/$interviewId/finalize')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'rr-org'
const OWNER = 'rr-owner'
const PARTICIPANT = 'rr-participant'
const NOW = new Date('2027-12-01T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let sessionId = ''
let segmentIds: string[] = []

function principal(overrides: Partial<TenantPrincipal> = {}): TenantPrincipal {
  return { userId: OWNER, organizationId: ORG, role: 'owner', requestId: 'req-1', ...overrides }
}

type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>
function handlerOf(route: unknown, method: 'GET' | 'POST' | 'PATCH'): Handler {
  const options = (route as { options: { server: { handlers: Record<string, Handler> } } }).options
  return options.server.handlers[method]!
}

/** Reinstates the headers happy-dom strips from a constructed Request — see the session-routes test. */
function browserRequest(url: string, method: string, body?: unknown, overrides: Record<string, string | null> = {}): Request {
  const request = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
  const forbidden = new Map<string, string | null>(Object.entries({ 'sec-fetch-site': 'same-origin', ...overrides }))
  const real = request.headers
  Object.defineProperty(request, 'headers', {
    value: {
      get: (name: string) => {
        const key = name.toLowerCase()
        return forbidden.has(key) ? forbidden.get(key) ?? null : real.get(name)
      },
    },
  })
  return request
}

const call = (route: unknown, method: 'GET' | 'POST' | 'PATCH', body?: unknown, actor = principal(), query = '') => {
  mocks.requireTenantPrincipal.mockResolvedValue(actor)
  return handlerOf(route, method)({
    request: browserRequest(`https://app.test/api/interviews/x/report${query}`, method, body),
    params: { interviewId: eventId },
  })
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_report_routes')
  db = disposable.db
  drop = disposable.drop
  // Mirrors the real `withTenantContext`: it sets `app.organization_id` before the callback, and every
  // RLS policy on a tenant-private table reads it. A bare `db.transaction` here made the mock a
  // weaker thing than the function it stands in for, which surfaced the moment credit writes began
  // elevating to a role RLS applies to.
  mocks.withTenantContext.mockImplementation(
    (_principal: TenantPrincipal, operation: (tx: unknown) => Promise<unknown>) =>
      tenantTransaction(db, ORG, (tx: unknown) => operation(tx)),
  )

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'rr-o@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: PARTICIPANT, name: 'P', email: 'rr-p@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
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

  /*
   * The invitation behind the event, which is what makes it an interview.
   *
   * These routes authorize through `briefContextForEvent`, and that walks back from the event to its
   * invitation — no invitation means a personal calendar entry, not an interview, and the answer is
   * 404. Seeding only the event made every case here a 404 the moment the report routes started
   * authorizing at all, which is the correct answer to the data this file was describing.
   */
  await db.insert(schema.schedulingInvitations).values({
    organizationId: ORG, ownerUserId: OWNER, roleTitle: 'Engineer', roleContext: 'Backend',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
    bookedEventId: eventId,
  })

  // A colleague explicitly handed access, which is what `access_granted` means. Without this row the
  // PARTICIPANT cases below are testing a stranger, not a participant, and every one of them is a 404.
  await db.insert(schema.eventParticipants).values({
    organizationId: ORG, eventId, eventOwnerUserId: OWNER, userId: PARTICIPANT, role: 'attendee', accessGranted: true, materialAccessGranted: true,
  })
}, 180_000)

afterAll(async () => { await drop() })

const briefContent = {
  candidateSummary: 'Backend engineer.',
  relevantEvidence: [{ claim: 'Rewrote a cache.', sourceIds: ['doc:1'], confidence: 'high' as const }],
  informationGaps: [],
  contradictions: [],
  questionGroups: [
    { category: 'critical' as const, question: 'Explain the rollout.', rationale: 'Dates disagree.', sourceIds: ['doc:1'] },
    { category: 'technical' as const, question: 'How was latency measured?', rationale: 'Claims.', sourceIds: ['doc:1'] },
  ],
}

beforeEach(async () => {
  await db.delete(schema.interviewSuggestions)
  await db.delete(schema.interviewReports)
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await db.transaction((tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 100, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetMs: 60_000, limit: 10 })
  mockEnv.SENSITIVE_AI_ENABLED = 'true'
  mockEnv.INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED = 'true'

  const [session] = await db.insert(schema.interviewSessions).values({
    organizationId: ORG, eventId, ownerUserId: OWNER, state: 'processing',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v1', captureCapability: 'microphone_and_shared_audio_available',
    startedAt: NOW, retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.interviewSessions.id })
  sessionId = session.id

  segmentIds = []
  for (let n = 1; n <= 2; n += 1) {
    const [row] = await db.insert(schema.transcriptSegments).values({
      organizationId: ORG, sessionId, providerSegmentId: `req:0:${n}`, sequence: n,
      speakerEstimate: n % 2 === 0 ? 'speaker_b' : 'speaker_a',
      text: `Turn ${n} about the cache.`, startsMs: n * 60_000, endsMs: n * 60_000 + 3_000,
      retentionExpiresAt: FAR_FUTURE(),
    }).returning({ id: schema.transcriptSegments.id })
    segmentIds.push(row.id)
  }

  await db.transaction((tx) => insertBriefVersion(tx as never, {
    organizationId: ORG, eventId, ownerUserId: OWNER,
    content: briefContent, evidenceManifest: [{ id: 'doc:1', kind: 'document', label: 'cv.pdf' }],
    provider: 'mistral', model: 'mistral-medium-2604', promptVersion: '1',
    status: 'active', retentionExpiresAt: FAR_FUTURE(),
  }))

  mocks.sensitiveCompletion.mockImplementation(async (input: {
    prompt: string
    schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }
  }) => {
    const ids = [...input.prompt.matchAll(/\[([0-9a-f-]{36})\]/g)].map((match) => match[1])
    const value = ids.length > 0 && input.prompt.includes('TOPICS THE INTERVIEW SET OUT TO COVER')
      ? reportContent(ids)
      : { questions: [{ id: 'q1', topicId: 'topic:1', question: 'What changed in latency?', rationale: 'Mentioned.', segmentIds: [ids[0]] }] }
    const result = input.schema.safeParse(value)
    if (!result.success) throw new AIProviderError(0, 'fixture did not satisfy the schema')
    return {
      output: result.data,
      provider: 'mistral',
      model: 'mistral-medium-2604',
      usage: { promptTokens: 100, completionTokens: 50 },
      durationMs: 3,
    }
  })
})

const reportContent = (ids: string[], overrides: Record<string, unknown> = {}) => ({
  summary: [{ statement: 'Described a cache rewrite.', segmentIds: [ids[0]] }],
  answersByTopic: [
    { topicId: 'topic:1', answer: 'Two-stage rollout.', segmentIds: [ids[0]], status: 'answered' as const },
    { topicId: 'topic:2', answer: 'Not discussed.', segmentIds: [], status: 'unanswered' as const },
  ],
  openQuestions: ['How was rollback tested?'],
  followUps: [{ action: 'Ask for the dashboard.', segmentIds: [ids[1] ?? ids[0]] }],
  ...overrides,
})

describe('the report route', () => {
  const generate = (body: unknown = { creditConfirmation: true }, actor = principal()) =>
    call(ReportRoute, 'POST', body, actor)

  it('answers 401 without a session', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('auth', 401))
    const response = await handlerOf(ReportRoute, 'GET')({
      request: browserRequest('https://app.test/x', 'GET'), params: { interviewId: eventId },
    })
    expect(response.status).toBe(401)
  })

  it('requires an explicit credit confirmation', async () => {
    // Five credits should not be spent by a retried request nobody intended.
    expect((await generate({})).status).toBe(400)
    expect((await generate({ creditConfirmation: false })).status).toBe(400)
  })

  it('generates version 1 with provenance', async () => {
    const response = await generate()
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.source).toBe('generated')
    expect(body.report.version).toBe(1)
    expect(body.report.provider).toBe('mistral')
  })

  it('ships no owner id and answers canEdit instead', async () => {
    await generate()
    const body = await (await call(ReportRoute, 'GET')).json()
    expect(Object.keys(body.report)).not.toContain('ownerUserId')
    expect(Object.keys(body.report)).not.toContain('retentionExpiresAt')
    expect(body.canEdit).toBe(true)
  })

  it('tells a participant they cannot edit', async () => {
    await generate()
    const body = await (await call(ReportRoute, 'GET', undefined, principal({ userId: PARTICIPANT, role: 'member' }))).json()
    // So the editor never renders a save button the API would refuse.
    expect(body.canEdit).toBe(false)
  })

  it('answers 201 with a template when the provider fails, not an error', async () => {
    mocks.sensitiveCompletion.mockRejectedValue(new AIProviderError(503, 'down'))
    const response = await generate()
    // The interview happened. Refusing to create a report because a model was unavailable would lose the
    // one artifact the feature exists to produce.
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.source).toBe('template')
    expect(body.fallbackReason).toBe('provider_failed')
    // Named plainly, so the client cannot imply a model wrote it.
    expect(body.report.provider).toBeNull()
  })

  it('answers 402 when credits are short, and stores nothing', async () => {
    await db.delete(schema.billingCreditAllocations)
    await db.delete(schema.billingLedgerEntries)
    await db.delete(schema.billingCreditGrants)
    await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
      source: 'promotional', units: 1, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
    }))
    const response = await generate()
    // 402 and not a template: a blank form handed to someone whose balance ran out would hide the reason.
    expect(response.status).toBe(402)
    expect(await db.select().from(schema.interviewReports)).toHaveLength(0)
  })

  it('answers 409 with no transcript', async () => {
    await db.delete(schema.transcriptSegments)
    const response = await generate()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('no_transcript')
  })

  it('refuses a non-owner generating', async () => {
    const response = await generate({ creditConfirmation: true }, principal({ userId: PARTICIPANT, role: 'member' }))
    expect(response.status).toBe(403)
  })

  it('refuses a cross-site POST and an audio content type', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const crossSite = await handlerOf(ReportRoute, 'POST')({
      request: browserRequest('https://app.test/x', 'POST', { creditConfirmation: true }, { 'sec-fetch-site': 'cross-site' }),
      params: { interviewId: eventId },
    })
    expect(crossSite.status).toBe(400)

    const audio = new Request('https://app.test/x', {
      method: 'POST', body: JSON.stringify({ creditConfirmation: true }),
      headers: { 'content-type': 'audio/webm' },
    })
    Object.defineProperty(audio, 'headers', {
      value: { get: (name: string) => (name.toLowerCase() === 'sec-fetch-site' ? 'same-origin' : 'audio/webm') },
    })
    expect((await handlerOf(ReportRoute, 'POST')({ request: audio, params: { interviewId: eventId } })).status).toBe(400)
  })

  it('answers 429 with a retry-after', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 20_000, limit: 10 })
    const response = await generate()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('20')
  })

  it('lists versions without content', async () => {
    await generate()
    const body = await (await call(ReportRoute, 'GET', undefined, principal(), '?version=versions')).json()
    expect(body.versions).toHaveLength(1)
    expect(Object.keys(body.versions[0])).not.toContain('content')
  })

  it('reads a specific version', async () => {
    await generate()
    const body = await (await call(ReportRoute, 'GET', undefined, principal(), '?version=1')).json()
    expect(body.report.version).toBe(1)
  })

  it('answers an empty report for an interview with none', async () => {
    const body = await (await call(ReportRoute, 'GET')).json()
    expect(body).toEqual({ report: null, latestVersion: null })
  })
})

describe('editing a report', () => {
  const edit = (body: unknown, actor = principal()) => call(ReportRoute, 'PATCH', body, actor)

  it('appends a version', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await edit({ expectedVersion: 1, content: reportContent(segmentIds) })
    expect(response.status).toBe(200)
    expect((await response.json()).report.version).toBe(2)
  })

  it('answers 409 for a stale version', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    await edit({ expectedVersion: 1, content: reportContent(segmentIds) })
    const response = await edit({ expectedVersion: 1, content: reportContent(segmentIds) })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('version_conflict')
  })

  it('answers 422 for a citation that resolves to nothing', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await edit({
      expectedVersion: 1,
      content: reportContent(segmentIds, {
        summary: [{ statement: 'They led twelve people.', segmentIds: ['00000000-0000-4000-8000-000000000000'] }],
      }),
    })
    // 422 and not 400: the edit was well-formed and the problem is one specific citation, which is a
    // nameable and fixable thing rather than "invalid input".
    expect(response.status).toBe(422)
    expect((await response.json()).error).toBe('dangling_reference')
  })

  it('answers 400 for a score', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await edit({
      expectedVersion: 1,
      content: reportContent(segmentIds, {
        summary: [{ statement: 'My score for them is high.', segmentIds: [segmentIds[0]] }],
      }),
    })
    expect(response.status).toBe(400)
  })

  it('accepts no evidence list from the request', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await edit({
      expectedVersion: 1,
      content: reportContent(segmentIds),
      evidenceSegmentIds: ['00000000-0000-4000-8000-000000000000'],
    })
    // `.strict()`, so an extra key is refused outright rather than silently ignored — an editable evidence
    // list would let a citation point at a segment that was never in the transcript.
    expect(response.status).toBe(400)
  })

  it('refuses a non-owner', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await edit(
      { expectedVersion: 1, content: reportContent(segmentIds) },
      principal({ userId: PARTICIPANT, role: 'member' }),
    )
    expect(response.status).toBe(403)
  })
})

describe('finalizing', () => {
  const finalize = (body: unknown, actor = principal()) => {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(FinalizeRoute, 'POST')({
      request: browserRequest('https://app.test/x/finalize', 'POST', body),
      params: { interviewId: eventId },
    })
  }

  it('requires an explicit confirmation', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    // This cannot be undone, so it needs a field a serialization bug could not set by accident.
    expect((await finalize({ expectedVersion: 1 })).status).toBe(400)
    expect((await finalize({ expectedVersion: 1, confirmFinal: false })).status).toBe(400)
  })

  it('marks the version final', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await finalize({ expectedVersion: 1, confirmFinal: true })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.report.status).toBe('final')
    expect(body.report.finalizedAt).not.toBeNull()
  })

  it('answers 409 to a second finalize', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    await finalize({ expectedVersion: 1, confirmFinal: true })
    const response = await finalize({ expectedVersion: 1, confirmFinal: true })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('already_final')
  })

  it('answers 409 to a stale version', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    await call(ReportRoute, 'PATCH', { expectedVersion: 1, content: reportContent(segmentIds) })
    const response = await finalize({ expectedVersion: 1, confirmFinal: true })
    expect(response.status).toBe(409)
  })

  it('refuses editing after finalizing', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    await finalize({ expectedVersion: 1, confirmFinal: true })
    const response = await call(ReportRoute, 'PATCH', { expectedVersion: 1, content: reportContent(segmentIds) })
    // A finalized report is the record. Editing it would change what a decision was made from.
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('already_final')
  })

  it('answers 404 with no report', async () => {
    expect((await finalize({ expectedVersion: 1, confirmFinal: true })).status).toBe(404)
  })

  it('refuses a non-owner', async () => {
    await call(ReportRoute, 'POST', { creditConfirmation: true })
    const response = await finalize({ expectedVersion: 1, confirmFinal: true }, principal({ userId: PARTICIPANT, role: 'member' }))
    expect(response.status).toBe(403)
  })
})

describe('the suggestions route', () => {
  const ask = (actor = principal()) => {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(SuggestionsRoute, 'POST')({
      request: browserRequest('https://app.test/x/suggestions', 'POST'),
      params: { interviewId: eventId },
    })
  }
  const act = (body: unknown, actor = principal()) => {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(SuggestionsRoute, 'PATCH')({
      request: browserRequest('https://app.test/x/suggestions', 'PATCH', body),
      params: { interviewId: eventId },
    })
  }

  beforeEach(async () => {
    await db.update(schema.interviewSessions).set({ state: 'live' })
      .where(eq(schema.interviewSessions.id, sessionId))
  })

  it('answers 200 with prepared questions for a paused session, not an error', async () => {
    await db.update(schema.interviewSessions).set({ state: 'paused' })
      .where(eq(schema.interviewSessions.id, sessionId))
    const response = await ask()
    // An error status during a live interview would surface as a failure banner on a screen the candidate
    // may be able to see.
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.source).toBe('prepared')
    expect(body.reason).toBe('not_live')
    expect(body.suggestions.length).toBeGreaterThan(0)
  })

  it('suggests from the transcript on a live session', async () => {
    const response = await ask()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.source).toBe('suggested')
    expect(body.provider).toBe('mistral')
    expect(body.suggestions[0].segmentIds).toContain(segmentIds[0])
  })

  it('writes nothing when it only proposes', async () => {
    await ask()
    expect(await db.select().from(schema.interviewSuggestions)).toHaveLength(0)
  })

  it('records an action and lists it back', async () => {
    const body = await (await ask()).json()
    const recorded = await act({ action: 'used', suggestion: body.suggestions[0] })
    expect(recorded.status).toBe(200)
    expect((await recorded.json()).state).toBe('used')

    const listed = await (await handlerOf(SuggestionsRoute, 'GET')({
      request: browserRequest('https://app.test/x/suggestions', 'GET'), params: { interviewId: eventId },
    })).json()
    expect(listed.suggestions).toHaveLength(1)
    expect(listed.suggestions[0].promptVersion).toBe('1')
  })

  it('refuses a body naming both a proposal and a stored id', async () => {
    const body = await (await ask()).json()
    const response = await act({
      action: 'saved', suggestion: body.suggestions[0],
      suggestionId: '00000000-0000-4000-8000-000000000000',
    })
    expect(response.status).toBe(400)
  })

  it('answers 404 for a stored id that does not exist', async () => {
    const response = await act({ action: 'dismissed', suggestionId: '00000000-0000-4000-8000-000000000000' })
    expect(response.status).toBe(404)
  })

  it('refuses a participant asking, because it spends the organizer\'s provider call', async () => {
    const response = await ask(principal({ userId: PARTICIPANT, role: 'member' }))
    expect(response.status).toBe(403)
  })

  it('answers 503 when contextual questions are switched off', async () => {
    mockEnv.INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED = 'false'
    const response = await ask()
    // 503, and before authentication: an undeployed feature must not leak that a session exists behind an
    // auth wall.
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('contextual_questions_disabled')
  })

  it('falls back to prepared questions when sensitive AI is off', async () => {
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const body = await (await ask()).json()
    expect(body.source).toBe('prepared')
    expect(body.reason).toBe('ai_disabled')
  })

  it('answers 429 when the budget is spent', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 15_000, limit: 30 })
    const response = await ask()
    expect(response.status).toBe(429)
  })
})
