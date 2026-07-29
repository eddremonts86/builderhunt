import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

/**
 * Route tests for the live-session, token and segment APIs (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * `withTenantContext` is redirected to a real disposable Postgres transaction rather than stubbed.
 * The assertions that matter most here are negative and about response bodies — no master key, no
 * `ownerUserId`, no audio accepted, a participant offered nothing to break — and a hand-built stub would
 * satisfy every one of them while the real route leaked.
 *
 * Two things are mocked. Authentication, because there is no session to forge and the principal is exactly
 * what a route is meant to trust. And `fetch` for the Deepgram grant, because the whole point of the token
 * route is what it does *not* forward, which needs a provider that can be told to echo the master key back.
 */

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  rateLimit: vi.fn(),
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

vi.mock('~/shared/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/env')>()
  return {
    ...actual,
    env: {
      ...actual.env,
      INTERVIEW_TRANSCRIPTION_ENABLED: 'true',
      INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
      DEEPGRAM_API_KEY: MASTER_KEY,
      APP_URL: 'https://app.test',
    },
  }
})

/** The value that must never appear in a response. Declared here so the mock and the assertions share it. */
const MASTER_KEY = 'dg-master-key-must-not-leak'

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

const { Route: SessionRoute } = await import('~/routes/api/interviews/$interviewId/session')
const { Route: TokenRoute } = await import('~/routes/api/interviews/$interviewId/transcription-token')
const { Route: SegmentsRoute } = await import('~/routes/api/interviews/$interviewId/segments')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ir-org'
const OWNER = 'ir-owner'
const PARTICIPANT = 'ir-participant'
const ADMIN = 'ir-admin'
const NOW = new Date('2027-09-01T10:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let invitationId = ''
/** An event with no invitation behind it: a personal calendar entry, not an interview. */
let personalEventId = ''

function principal(overrides: Partial<TenantPrincipal> = {}): TenantPrincipal {
  return { userId: OWNER, organizationId: ORG, role: 'owner', requestId: 'req-1', ...overrides }
}

type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>

function handlerOf(route: unknown, method: 'GET' | 'POST' | 'PATCH'): Handler {
  const options = (route as { options: { server: { handlers: Record<string, Handler> } } }).options
  return options.server.handlers[method]!
}

/**
 * A request carrying the headers a browser actually sends.
 *
 * `Sec-Fetch-Site` and `Origin` are forbidden header names, and happy-dom's `Request` — the environment
 * these tests run in — silently drops both when you construct one. Node's undici keeps them, and a real
 * server reads them off the wire rather than from a constructed object, so the route is right to require
 * them; it is the *test* that cannot express them. This reinstates exactly what the browser would send,
 * through the only accessor the guard uses.
 *
 * Verified rather than assumed: `new Request(..., {headers: {'sec-fetch-site': 'same-origin'}})` returns
 * `null` for that header under happy-dom and `'same-origin'` under plain Node.
 */
function browserRequest(
  method: string,
  body?: unknown,
  overrides: Record<string, string | null> = {},
): Request {
  const request = new Request('https://app.test/api/interviews/x/session', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
  const forbidden = new Map<string, string | null>(Object.entries({
    'sec-fetch-site': 'same-origin',
    ...overrides,
  }))
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

/** A same-origin request, which is what every normal call in this file is. */
const jsonRequest = (method: string, body?: unknown): Request => browserRequest(method, body)

/**
 * A same-origin request under a non-JSON content type, carrying a body the handler would otherwise accept.
 *
 * The body must be *valid* for the endpoint. An audio-shaped byte string would fail `request.json()` and
 * produce a 400 from schema validation — so the test would pass with the content-type guard deleted, and
 * would be proving "malformed JSON is refused" while claiming to prove "an audio content type is refused".
 * Verified by neutering `assertJsonRequest`: with a valid body these fail, with `RIFF…` they did not.
 */
function audioRequest(contentType: string, body: unknown = { action: 'heartbeat' }): Request {
  const request = new Request('https://app.test/api/interviews/x/session', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': contentType },
  })
  const real = request.headers
  Object.defineProperty(request, 'headers', {
    value: { get: (name: string) => (name.toLowerCase() === 'sec-fetch-site' ? 'same-origin' : real.get(name)) },
  })
  return request
}

const callSession = (body: unknown, actor = principal(), interviewId = eventId) => {
  mocks.requireTenantPrincipal.mockResolvedValue(actor)
  return handlerOf(SessionRoute, 'POST')({ request: jsonRequest('POST', body), params: { interviewId } })
}

const readSession = (actor = principal(), interviewId = eventId) => {
  mocks.requireTenantPrincipal.mockResolvedValue(actor)
  return handlerOf(SessionRoute, 'GET')({ request: jsonRequest('GET'), params: { interviewId } })
}

const callToken = (actor = principal(), interviewId = eventId) => {
  mocks.requireTenantPrincipal.mockResolvedValue(actor)
  return handlerOf(TokenRoute, 'POST')({ request: jsonRequest('POST'), params: { interviewId } })
}

const callSegments = (body: unknown, actor = principal(), interviewId = eventId) => {
  mocks.requireTenantPrincipal.mockResolvedValue(actor)
  return handlerOf(SegmentsRoute, 'POST')({ request: jsonRequest('POST', body), params: { interviewId } })
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_session_routes')
  db = disposable.db
  drop = disposable.drop

  mocks.withTenantContext.mockImplementation(
    (_principal: TenantPrincipal, operation: (tx: unknown) => Promise<unknown>) =>
      db.transaction((tx) => operation(tx)),
  )

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values([
    { id: OWNER, name: 'Owner', email: 'ir-o@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: PARTICIPANT, name: 'P', email: 'ir-p@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
    { id: ADMIN, name: 'A', email: 'ir-a@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW },
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

  const events = await db.insert(schema.calendarEvents).values([
    {
      organizationId: ORG, calendarId: calendar.id, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
      title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 3_600_000),
      timezone: 'UTC', allDay: false, busy: true,
    },
    {
      organizationId: ORG, calendarId: calendar.id, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
      title: 'Lunch', startsAt: NOW, endsAt: new Date(NOW.getTime() + 1_800_000),
      timezone: 'UTC', allDay: false, busy: true,
    },
  ]).returning({ id: schema.calendarEvents.id })
  eventId = events[0].id
  personalEventId = events[1].id

  const [invitation] = await db.insert(schema.schedulingInvitations).values({
    organizationId: ORG, ownerUserId: OWNER, roleTitle: 'Engineer', roleContext: 'Backend',
    durationMinutes: 45, timezone: 'UTC', modality: 'remote_call', policyVersion: 'v1',
    bookedEventId: eventId,
  }).returning({ id: schema.schedulingInvitations.id })
  invitationId = invitation.id

  await db.insert(schema.eventParticipants).values({
    organizationId: ORG, eventId, eventOwnerUserId: OWNER, userId: PARTICIPANT,
    role: 'attendee', accessGranted: true,
  })
}, 180_000)

afterAll(async () => {
  await drop()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.privacyConsents)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await db.transaction((tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 500, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 59, resetMs: 60_000, limit: 60 })
  // A grant that does not contain the master key. Tests that care override it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ access_token: 'scoped-grant-abc', expires_in: 30 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
})

async function acceptConsent() {
  await db.insert(schema.privacyConsents).values({
    organizationId: ORG, invitationId, subjectEmailHash: 'h'.repeat(64),
    purpose: 'live_audio_transcription', noticeVersion: '2027-09-01.1', decision: 'accepted',
    decidedAt: NOW, requestEvidenceHash: 'e'.repeat(64),
  })
}

async function withdrawConsent() {
  await db.update(schema.privacyConsents)
    .set({ withdrawnAt: new Date(NOW.getTime() + 60_000) })
    .where(eq(schema.privacyConsents.invitationId, invitationId))
}

/** Drives the session to `live` through the API, which is also a test of the happy path. */
async function toLive() {
  await acceptConsent()
  const created = await (await callSession({
    action: 'create', captureCapability: 'microphone_and_shared_audio_available', language: 'en',
  })).json()
  const ready = await (await callSession({ action: 'ready', expectedVersion: created.session.version })).json()
  const live = await (await callSession({ action: 'live', expectedVersion: ready.session.version })).json()
  return live
}

describe('authentication and the tenant boundary', () => {
  it('answers 401 without a session', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('Authentication required', 401))
    const response = await handlerOf(SessionRoute, 'GET')({
      request: jsonRequest('GET'), params: { interviewId: eventId },
    })
    expect(response.status).toBe(401)
  })

  it('answers 403 when the active organization is invalid', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('invalid', 403))
    const response = await handlerOf(SessionRoute, 'POST')({
      request: jsonRequest('POST', { action: 'ready', expectedVersion: 1 }), params: { interviewId: eventId },
    })
    expect(response.status).toBe(403)
  })

  it('shows tenant B nothing, rather than telling it the interview exists', async () => {
    await toLive()
    // A different organization on the same event id. The tenant predicate is in every query, so this
    // reads as absent — the same answer an id that never existed gets, which is what stops the status
    // code itself from confirming that someone else's interview is there.
    const response = await readSession(principal({ organizationId: 'ir-other-org' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  it('refuses an organization admin who is not a participant', async () => {
    await toLive()
    // Admin manages seats and billing. That is not the same act as reading what a candidate said.
    //
    // 404, not 403: the route answers a non-owner exactly as it answers an absent interview, so a
    // colleague cannot distinguish "not allowed" from "does not exist". See the comment above the
    // `isOwner` check in `session.ts` — the discrimination itself was the leak.
    const response = await callSession(
      { action: 'pause', expectedVersion: 3 },
      principal({ userId: ADMIN, role: 'admin' }),
    )
    expect(response.status).toBe(404)
    expect((await response.json()).error).toBe('not_found')
  })
})

describe('the origin and content-type guards', () => {
  it('refuses a cross-site POST', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SessionRoute, 'POST')({
      request: browserRequest('POST', { action: 'ready', expectedVersion: 1 }, {
        'sec-fetch-site': 'cross-site',
      }),
      params: { interviewId: eventId },
    })
    expect(response.status).toBe(400)
  })

  it('refuses a request carrying neither sec-fetch-site nor origin', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SessionRoute, 'POST')({
      request: browserRequest('POST', { action: 'ready', expectedVersion: 1 }, {
        'sec-fetch-site': null, origin: null,
      }),
      params: { interviewId: eventId },
    })
    // A browser sends at least one on a cross-origin POST. Neither means this is not the request the
    // endpoint is written for.
    expect(response.status).toBe(400)
  })

  it('accepts a same-origin Origin header when sec-fetch-site is absent', async () => {
    await acceptConsent()
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SessionRoute, 'POST')({
      request: browserRequest('POST', {
        action: 'create', captureCapability: 'microphone_and_shared_audio_available', language: 'en',
      }, { 'sec-fetch-site': null, origin: 'https://app.test' }),
      params: { interviewId: eventId },
    })
    expect(response.status).toBe(200)
  })
})

describe('no audio reaches these endpoints', () => {
  const audioTypes = ['audio/webm', 'audio/wav', 'multipart/form-data', 'application/octet-stream']

  it.each(audioTypes)('refuses a %s body on the session route', async (contentType) => {
    // Live, so the heartbeat inside `audioRequest` would be accepted on a JSON content type.
    await toLive()
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SessionRoute, 'POST')({
      request: audioRequest(contentType),
      params: { interviewId: eventId },
    })
    expect(response.status).toBe(400)
  })

  it.each(audioTypes)('refuses a %s body on the segments route', async (contentType) => {
    await toLive()
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SegmentsRoute, 'POST')({
      // A batch this route would otherwise persist, so only the content type can produce the refusal.
      request: audioRequest(contentType, { segments: [segment(1)] }),
      params: { interviewId: eventId },
    })
    expect(response.status).toBe(400)
  })

  it('refuses an audio field smuggled into a JSON segment', async () => {
    await toLive()
    const response = await callSegments({
      segments: [{ ...segment(1), audio: 'data:audio/webm;base64,AAAA' }],
    })
    // `.strict()`, so an unknown key is a rejection rather than a silently ignored field. There is also
    // no column to put it in — but a request that got this far would already be a design failure.
    expect(response.status).toBe(400)
  })

  it('refuses an objectKey field pointing at stored audio', async () => {
    await toLive()
    const response = await callSegments({ segments: [{ ...segment(1), objectKey: 'recordings/x.webm' }] })
    expect(response.status).toBe(400)
  })
})

describe('the feature flag', () => {
  it('answers 503 for a personal calendar entry rather than inventing an interview', async () => {
    // No invitation behind the event: no candidate, so no consent, so nothing to transcribe.
    const response = await callSession({
      action: 'create', captureCapability: 'microphone_only', language: 'en',
    }, principal(), personalEventId)
    expect(response.status).toBe(404)
  })
})

describe('rate limits', () => {
  it('answers 429 with a retry-after when the write budget is spent', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 30_000, limit: 60 })
    const response = await callSession({ action: 'ready', expectedVersion: 1 })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
  })

  it('bounds the token route separately from the session route', async () => {
    await toLive()
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetMs: 10_000, limit: 20 })
    const response = await callToken()
    expect(response.status).toBe(429)
  })
})

describe('consent and credit at the route boundary', () => {
  it('refuses ready without a consent record', async () => {
    const created = await (await callSession({
      action: 'create', captureCapability: 'microphone_only', language: 'en',
    })).json()
    const response = await callSession({ action: 'ready', expectedVersion: created.session.version })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('consent_missing')
  })

  it('answers 402 when the balance cannot cover the reservation', async () => {
    await db.delete(schema.billingCreditAllocations)
    await db.delete(schema.billingLedgerEntries)
    await db.delete(schema.billingCreditGrants)
    await db.transaction((tx) => grantCredits(tx, {
      grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
      source: 'promotional', units: 5, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
    }))
    await acceptConsent()
    const created = await (await callSession({
      action: 'create', captureCapability: 'microphone_only', language: 'en',
    })).json()
    const ready = await (await callSession({ action: 'ready', expectedVersion: created.session.version })).json()
    const response = await callSession({ action: 'live', expectedVersion: ready.session.version })
    // 402 and not 500: the client routes this to a top-up rather than showing a generic failure.
    expect(response.status).toBe(402)
    expect((await response.json()).error).toBe('insufficient_credits')
  })

  it('reports a withdrawal on a plain read, without writing anything', async () => {
    const live = await toLive()
    await withdrawConsent()
    const before = await db.select().from(schema.interviewSessions)

    const response = await readSession()
    const body = await response.json()
    expect(body.stopNow).toBe(true)
    expect(body.hardStopMs).toBe(10_000)

    const after = await db.select().from(schema.interviewSessions)
    // A GET is reachable cross-site without the origin check. Stamping `heartbeat_at` from it would let
    // any page on the internet keep a dead session out of reclaim.
    expect(after[0].heartbeatAt).toEqual(before[0].heartbeatAt)
    expect(after[0].version).toBe(live.session.version)
  })

  it('answers a heartbeat with stop_now after a withdrawal', async () => {
    await toLive()
    await withdrawConsent()
    const response = await callSession({ action: 'heartbeat' })
    const body = await response.json()
    expect(body.action).toBe('stop_now')
    expect(body.hardStopMs).toBe(10_000)
  })
})

describe('the session DTO', () => {
  it('ships no owner id and answers canControl instead', async () => {
    const live = await toLive()
    // `ownerUserId` in a response is an invitation to compare it client-side and get the answer wrong.
    expect(Object.keys(live.session)).not.toContain('ownerUserId')
    expect(Object.keys(live.session)).not.toContain('retentionExpiresAt')
    expect(live.session.canControl).toBe(true)
  })

  it('tells a participant they cannot control it', async () => {
    await toLive()
    const response = await readSession(principal({ userId: PARTICIPANT, role: 'member' }))
    const body = await response.json()
    // So the workspace never renders a finish button the API would refuse.
    expect(body.session.canControl).toBe(false)
  })

  it('returns the reservation only when the session goes live', async () => {
    const live = await toLive()
    expect(live.reservedUnits).toBe(180)
    const paused = await (await callSession({ action: 'pause', expectedVersion: live.session.version })).json()
    expect(paused.reservedUnits).toBeUndefined()
  })
})

describe('version conflicts', () => {
  it('answers 409 to a stale expected version', async () => {
    const live = await toLive()
    await callSession({ action: 'pause', expectedVersion: live.session.version })
    const response = await callSession({ action: 'pause', expectedVersion: live.session.version })
    expect(response.status).toBe(409)
    // The client must be told to reload — not told it attempted a transition it never requested.
    expect((await response.json()).error).toBe('version_conflict')
  })
})

describe('the transcription token', () => {
  it('mints a scoped grant and never returns the master key', async () => {
    await toLive()
    const response = await callToken()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.accessToken).toBe('scoped-grant-abc')
    expect(JSON.stringify(body)).not.toContain(MASTER_KEY)
    expect(body.url).toBe('wss://api.eu.deepgram.com/v1/listen')
    expect(body.expiresInSeconds).toBe(30)
    // A credential with a 30-second life must not sit in any cache.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a grant that echoed the master key back', async () => {
    await toLive()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: `prefix-${MASTER_KEY}`, expires_in: 30 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const response = await callToken()
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain(MASTER_KEY)
  })

  it('carries the remote configuration for a remote booking', async () => {
    await toLive()
    const body = await (await callToken()).json()
    // Two interleaved channels and no diarization: attribution is deterministic from the channel the
    // mixer assigned, and diarizing would replace a fact with a guess.
    expect(body.parameters.channels).toBe('2')
    expect(body.parameters.multichannel).toBe('true')
    expect(body.parameters.diarize).toBeUndefined()
    expect(body.diarize).toBe(false)
  })

  it('refuses a participant', async () => {
    await toLive()
    const response = await callToken(principal({ userId: PARTICIPANT, role: 'member' }))
    // Two clients streaming into one session would interleave sequences nobody could reconcile.
    expect(response.status).toBe(403)
  })

  it('refuses a paused session', async () => {
    const live = await toLive()
    await callSession({ action: 'pause', expectedVersion: live.session.version })
    const response = await callToken()
    // The organizer has told the candidate capture stopped. A token now is a socket that contradicts it.
    expect(response.status).toBe(409)
  })

  it('refuses a finished session', async () => {
    const live = await toLive()
    await callSession({
      action: 'finish', expectedVersion: live.session.version,
      providerBilledSeconds: 600, providerRequestId: 'r',
    })
    expect((await callToken()).status).toBe(409)
  })

  it('refuses after a withdrawal, which is the real hard stop', async () => {
    await toLive()
    await withdrawConsent()
    const response = await callToken()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('consent_withdrawn')
  })

  it('reports a provider outage as 502, not 500', async () => {
    await toLive()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const response = await callToken()
    expect(response.status).toBe(502)
  })
})

const segment = (n: number) => ({
  providerSegmentId: `req:0:${n}`,
  sequence: n,
  speakerEstimate: 'speaker_a' as const,
  text: `Turn ${n}.`,
  startsMs: n * 1_000,
  endsMs: n * 1_000 + 900,
  confidence: 0.96,
})

describe('segment batches', () => {
  it('persists a batch and reports what was new', async () => {
    await toLive()
    const response = await callSegments({ segments: [segment(1), segment(2)] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: ['req:0:1', 'req:0:2'], inserted: 2 })
  })

  it('acknowledges a resend exactly once', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    const body = await (await callSegments({ segments: [segment(1), segment(2)] })).json()
    // The outbox needs "accepted, already had it" so it can stop resending — and the row count is what
    // makes it exactly-once rather than merely idempotent-looking.
    expect(body.accepted).toEqual(['req:0:1', 'req:0:2'])
    expect(body.inserted).toBe(1)
    expect(await db.select().from(schema.transcriptSegments)).toHaveLength(2)
  })

  it('refuses a batch whose sequences go backwards', async () => {
    await toLive()
    const response = await callSegments({ segments: [segment(5), segment(2)] })
    // Most likely two capture loops writing into one outbox. Accepting it produces a transcript that
    // reads out of order.
    expect(response.status).toBe(400)
    expect(await db.select().from(schema.transcriptSegments)).toHaveLength(0)
  })

  it('refuses a repeated sequence within one batch', async () => {
    await toLive()
    expect((await callSegments({ segments: [segment(3), segment(3)] })).status).toBe(400)
  })

  it('allows a gap, because silent finals are dropped before they get here', async () => {
    await toLive()
    const response = await callSegments({ segments: [segment(1), segment(9)] })
    expect(response.status).toBe(200)
  })

  it('refuses an oversized batch', async () => {
    await toLive()
    const segments = Array.from({ length: 51 }, (_unused, index) => segment(index + 1))
    expect((await callSegments({ segments })).status).toBe(400)
  })

  it('refuses an oversized single segment', async () => {
    await toLive()
    const response = await callSegments({ segments: [{ ...segment(1), text: 'x'.repeat(2_001) }] })
    expect(response.status).toBe(400)
  })

  it('refuses an empty batch', async () => {
    await toLive()
    expect((await callSegments({ segments: [] })).status).toBe(400)
  })

  it('refuses a segment that ends before it starts', async () => {
    await toLive()
    const response = await callSegments({ segments: [{ ...segment(1), startsMs: 5_000, endsMs: 4_000 }] })
    expect(response.status).toBe(400)
  })

  it('refuses a paused session', async () => {
    const live = await toLive()
    await callSession({ action: 'pause', expectedVersion: live.session.version })
    const response = await callSegments({ segments: [segment(1)] })
    expect(response.status).toBe(409)
    expect(await db.select().from(schema.transcriptSegments)).toHaveLength(0)
  })

  it('refuses a finished session', async () => {
    const live = await toLive()
    await callSession({
      action: 'finish', expectedVersion: live.session.version,
      providerBilledSeconds: 600, providerRequestId: 'r',
    })
    expect((await callSegments({ segments: [segment(1)] })).status).toBe(409)
  })

  it('refuses a participant writing segments', async () => {
    await toLive()
    const response = await callSegments(
      { segments: [segment(1)] },
      principal({ userId: PARTICIPANT, role: 'member' }),
    )
    // Segments come from the organizer's capture client. A second writer breaks the sequence contract.
    expect(response.status).toBe(403)
  })

  it('lets a participant read the transcript', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    mocks.requireTenantPrincipal.mockResolvedValue(principal({ userId: PARTICIPANT, role: 'member' }))
    const response = await handlerOf(SegmentsRoute, 'GET')({
      request: jsonRequest('GET'), params: { interviewId: eventId },
    })
    const body = await response.json()
    expect(body.segments).toHaveLength(1)
    // Reading is what their access is for.
    expect(body.segments[0].text).toBe('Turn 1.')
  })

  it('ships no retention schedule in the segment DTO', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    const body = await (await handlerOf(SegmentsRoute, 'GET')({
      request: jsonRequest('GET'), params: { interviewId: eventId },
    })).json()
    expect(Object.keys(body.segments[0])).not.toContain('retentionExpiresAt')
    expect(Object.keys(body.segments[0])).not.toContain('organizationId')
    // Coerced from Postgres `numeric`, which drizzle hands back as a string.
    expect(body.segments[0].confidence).toBe(0.96)
  })
})

describe('speaker correction', () => {
  const patch = (body: unknown, actor = principal()) => {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(SegmentsRoute, 'PATCH')({
      request: jsonRequest('PATCH', body), params: { interviewId: eventId },
    })
  }

  it('records the correction against the caller', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    const [row] = await db.select().from(schema.transcriptSegments)

    const response = await patch({ segmentId: row.id, speakerMapping: 'candidate_or_remote' })
    expect(response.status).toBe(200)
    const [updated] = await db.select().from(schema.transcriptSegments)
    expect(updated.speakerMapping).toBe('candidate_or_remote')
    // Author and time together: an unattributable correction to a transcript is worse than none.
    expect(updated.correctedByUserId).toBe(OWNER)
    expect(updated.correctedAt).not.toBeNull()
  })

  it('refuses a participant relabelling who said what', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    const [row] = await db.select().from(schema.transcriptSegments)
    const response = await patch(
      { segmentId: row.id, speakerMapping: 'organizer' },
      principal({ userId: PARTICIPANT, role: 'member' }),
    )
    expect(response.status).toBe(403)
  })

  it('refuses an unknown mapping value', async () => {
    await toLive()
    await callSegments({ segments: [segment(1)] })
    const [row] = await db.select().from(schema.transcriptSegments)
    expect((await patch({ segmentId: row.id, speakerMapping: 'interviewer' })).status).toBe(400)
  })

  it('answers 404 for a segment in another session', async () => {
    await toLive()
    expect((await patch({
      segmentId: '00000000-0000-4000-8000-000000000000', speakerMapping: 'organizer',
    })).status).toBe(404)
  })
})
