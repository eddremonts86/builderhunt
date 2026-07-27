// @vitest-environment node
//
// These are server route tests. The project default is happy-dom, whose `Headers` implementation
// drops `Set-Cookie` when a `Response` is rebuilt from a `Headers` instance -- which is exactly what
// `withPublicHeaders` does, and exactly what these tests assert about. Running them under node uses
// the same undici implementation production does, so a cookie assertion here means something.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Route tests for the public capability flow (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Add public invitation and booking APIs").
 *
 * `capabilityDb` is redirected at a real disposable Postgres instead of stubbing the capability layer,
 * so `scheduling_resolve_capability` (drizzle/0077) and the tenant-setting sequence in
 * `capability-context.ts` actually run. Those two are the security boundary for an unauthenticated
 * flow; a mock of them would test nothing that matters.
 *
 * Rate limiting is left real but generous, so the tests exercise the same gate production does.
 */

const holder: { db: PostgresJsDatabase | null } = { db: null }

vi.mock('~/shared/lib/db/capability-db', () => ({
  get capabilityDb() {
    if (!holder.db) throw new Error('disposable database not ready')
    return holder.db
  },
}))

vi.mock('~/shared/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/env')>()
  return { ...actual, env: { ...actual.env, SCHEDULING_ENABLED: 'true', NODE_ENV: 'test' } }
})

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const { authUsers, organizations } = await import('~/shared/lib/db/schema')
const { insertCalendar } = await import('~/shared/lib/repositories/calendar')
const {
  findInvitationForOwner,
  insertInvitation,
  replaceAvailabilityPolicy,
  updateInvitationStateWithVersion,
  upsertAvailabilityPolicyWithVersion,
} = await import('~/shared/lib/repositories/scheduling')
const { issueCapability } = await import('~/lib/scheduling/capability')
const { capabilitySessionCookieName } = await import('~/lib/scheduling/capability-session')
const { CANDIDATE_NOTICE_VERSION } = await import('~/shared/lib/consent-notice')
const { SITE_URL } = await import('~/shared/lib/site-url')

const { Route: SessionRoute } = await import('./$invitationId/session')
const { Route: InvitationRoute } = await import('./$invitationId/index')
const { Route: SlotsRoute } = await import('./$invitationId/slots')
const { Route: SubmissionRoute } = await import('./$invitationId/submission')
const { Route: BookRoute } = await import('./$invitationId/book')
const { Route: CancelRoute } = await import('./$invitationId/cancel')
const { Route: DeclineRoute } = await import('./$invitationId/decline')
const { Route: WithdrawRoute } = await import('./$invitationId/withdraw')

let drop: () => Promise<void>

const ORG = 'pub-sched-org'
const OWNER = 'pub-sched-owner'
/**
 * The canonical site origin, not a hardcoded localhost. The mutation-origin gate compares against
 * this exact value, so a test that invented its own origin would be testing the gate rejecting the
 * test rather than the handler doing its job.
 */
const ORIGIN = new URL(SITE_URL).origin

/** Far enough out that the whole window is bookable, and clear of DST in Europe/Copenhagen. */
function nextMonday(): Date {
  const base = new Date(Date.UTC(2027, 5, 7, 0, 0, 0))
  return base
}

type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>

function handlerOf(route: unknown, method: string): Handler {
  const options = (route as { options: { server: { handlers: Record<string, Handler> } } }).options
  return options.server.handlers[method]!
}

/**
 * Each request gets its own client IP, so the rate limiter -- which is real here, not mocked -- gives
 * each one its own bucket. Sharing a bucket across the suite would make every test after the
 * twentieth mutation fail with 429 and prove only that the limiter works. One test below deliberately
 * shares an IP to prove exactly that.
 */
let clientCounter = 0

function request(url: string, method: string, options: { body?: unknown; cookie?: string; origin?: string; clientIp?: string } = {}): Request {
  clientCounter += 1
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.clientIp ?? `10.0.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
  }
  if (options.cookie) headers.cookie = options.cookie
  // Mutations carry an Origin, like a browser does; the mutation-origin gate rejects a
  // cookie-bearing mutation without one.
  if (options.body !== undefined || method !== 'GET') headers.origin = options.origin ?? ORIGIN
  return new Request(url, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

let invitationCounter = 0

/** A `sent` invitation plus its capability secret — what a candidate has when they click the email. */
async function sentInvitation() {
  invitationCounter += 1
  const { secret, hash } = issueCapability()
  const db = holder.db!
  const invitation = await db.transaction((tx) => insertInvitation(tx, {
    organizationId: ORG,
    ownerUserId: OWNER,
    roleTitle: 'Staff Engineer',
    roleContext: 'Platform team.',
    durationMinutes: 30,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call',
    meetingUrl: 'https://meet.test.invalid/room',
    candidateEmailNormalized: `pub-candidate-${invitationCounter}@test.invalid`,
    capabilityHash: hash,
    policyVersion: '2',
  }))
  const sent = await db.transaction((tx) => updateInvitationStateWithVersion(
    tx, ORG, OWNER, invitation.id, invitation.version, { status: 'sent' },
  ))
  return { invitation: sent!, secret, email: `pub-candidate-${invitationCounter}@test.invalid` }
}

function cookieFor(invitationId: string, secret: string): string {
  return `${capabilitySessionCookieName(invitationId)}=${secret}`
}

async function exchange(invitationId: string, secret: string) {
  return handlerOf(SessionRoute, 'POST')({
    request: request(`${ORIGIN}/api/public/scheduling/${invitationId}/session`, 'POST', { body: { secret } }),
    params: { invitationId },
  })
}

async function firstSlot(invitationId: string, secret: string) {
  const monday = nextMonday()
  const response = await handlerOf(SlotsRoute, 'GET')({
    request: request(
      `${ORIGIN}/api/public/scheduling/${invitationId}/slots?from=${monday.toISOString()}&to=${new Date(monday.getTime() + 86_400_000).toISOString()}`,
      'GET',
      { cookie: cookieFor(invitationId, secret) },
    ),
    params: { invitationId },
  })
  const body = await response.json()
  return { response, slots: body.slots as { slotId: string; startsAt: string; endsAt: string }[] }
}

/** Submits candidate details accepting every purpose, and returns the receipt ids. */
async function submitAccepting(invitationId: string, secret: string, email: string, purposes?: string[]) {
  const all = [
    'terms_and_privacy',
    'candidate_document_processing',
    'public_web_import',
    'ai_interview_assistance',
    'live_audio_transcription',
  ]
  const chosen = purposes ?? all
  const response = await handlerOf(SubmissionRoute, 'PUT')({
    request: request(`${ORIGIN}/api/public/scheduling/${invitationId}/submission`, 'PUT', {
      cookie: cookieFor(invitationId, secret),
      body: {
        displayName: 'Casey Candidate',
        email,
        links: [],
        consentDecisions: all.map((purpose) => ({
          purpose,
          decision: chosen.includes(purpose) ? 'accepted' : 'declined',
        })),
      },
    }),
    params: { invitationId },
  })
  const body = await response.json()
  return {
    response,
    receiptIds: (body.consentReceipts ?? [])
      .filter((receipt: { decision: string }) => receipt.decision === 'accepted')
      .map((receipt: { id: string }) => receipt.id) as string[],
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('public_scheduling_routes')
  holder.db = disposable.db
  drop = disposable.drop

  await disposable.db.insert(organizations).values({ id: ORG, name: 'Pub', slug: ORG })
  await disposable.db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'pub-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await disposable.db.transaction((tx) => insertCalendar(tx, {
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'Europe/Copenhagen', isDefault: true,
  }))
  await disposable.db.transaction((tx) => upsertAvailabilityPolicyWithVersion(tx, ORG, OWNER, 1, {
    defaultReminderOffsets: [60], defaultReminderChannels: ['email'],
  }))
  await disposable.db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG, OWNER, {
    rules: [{
      timezone: 'Europe/Copenhagen',
      weekdays: [1, 2, 3, 4, 5],
      localStart: '09:00',
      localEnd: '17:00',
      slotMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 365,
      enabled: true,
    }],
    overrides: [],
  }))
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('POST .../session', () => {
  it('exchanges the secret for an HttpOnly, path-scoped, SameSite=Strict cookie', async () => {
    const { invitation, secret } = await sentInvitation()
    const response = await exchange(invitation.id, secret)
    expect(response.status).toBe(200)

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    // Path-scoped to this one invitation: the browser will not attach this capability to a request
    // about a different one.
    expect(setCookie).toContain(`Path=/api/public/scheduling/${invitation.id}`)
  })

  it('returns the notice version and required purposes from the server, and no organizer identity', async () => {
    const { invitation, secret } = await sentInvitation()
    const body = await (await exchange(invitation.id, secret)).json()
    expect(body.noticeVersion).toBe(CANDIDATE_NOTICE_VERSION)
    expect(body.requiredPurposes).toContain('terms_and_privacy')
    expect(body.requiredPurposes).toContain('live_audio_transcription')

    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain(ORG)
    expect(serialised).not.toContain(OWNER)
    expect(serialised).not.toContain(secret)
  })

  it('marks the invitation opened', async () => {
    const { invitation, secret } = await sentInvitation()
    await exchange(invitation.id, secret)
    const refreshed = await holder.db!.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.status).toBe('opened')
  })

  it('sets no cache or referrer leak on the response', async () => {
    const { invitation, secret } = await sentInvitation()
    const response = await exchange(invitation.id, secret)
    // The URL carries an invitation id; a page linking out must not hand it to the destination.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('answers 404 for an unknown secret, a malformed one, and a revoked invitation alike', async () => {
    const unknown = await exchange('00000000-0000-0000-0000-000000000000', issueCapability().secret)
    expect(unknown.status).toBe(404)

    const { invitation, secret } = await sentInvitation()
    const malformed = await handlerOf(SessionRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/session`, 'POST', {
        body: { secret: 'x'.repeat(40) },
      }),
      params: { invitationId: invitation.id },
    })
    // Too short for the schema, so it never reaches the database.
    expect([400, 404]).toContain(malformed.status)

    await holder.db!.transaction((tx) => updateInvitationStateWithVersion(
      tx, ORG, OWNER, invitation.id, invitation.version, { status: 'revoked', revokedAt: new Date() },
    ))
    const revoked = await exchange(invitation.id, secret)
    // Same answer as unknown: telling the holder of a forwarded email "revoked" leaks the
    // organizer's decision.
    expect(revoked.status).toBe(404)
  })

  it('refuses a capability that belongs to a different invitation', async () => {
    const a = await sentInvitation()
    const b = await sentInvitation()
    const response = await handlerOf(SessionRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${b.invitation.id}/session`, 'POST', {
        body: { secret: a.secret },
      }),
      params: { invitationId: b.invitation.id },
    })
    expect(response.status).toBe(404)
  })

  it('refuses a cookie-bearing mutation with no Origin', async () => {
    const { invitation, secret } = await sentInvitation()
    const noOrigin = new Request(`${ORIGIN}/api/public/scheduling/${invitation.id}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieFor(invitation.id, secret) },
      body: JSON.stringify({ secret }),
    })
    const response = await handlerOf(SessionRoute, 'POST')({ request: noOrigin, params: { invitationId: invitation.id } })
    expect(response.status).toBe(403)
  })

  it('refuses a cookie-bearing mutation from another origin', async () => {
    const { invitation, secret } = await sentInvitation()
    const crossSite = new Request(`${ORIGIN}/api/public/scheduling/${invitation.id}/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieFor(invitation.id, secret),
        origin: 'https://attacker.test',
      },
      body: JSON.stringify({ secret }),
    })
    const response = await handlerOf(SessionRoute, 'POST')({ request: crossSite, params: { invitationId: invitation.id } })
    expect(response.status).toBe(403)
  })
})

describe('GET .../:invitationId', () => {
  it('needs the cookie', async () => {
    const { invitation } = await sentInvitation()
    const response = await handlerOf(InvitationRoute, 'GET')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}`, 'GET'),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(404)
  })

  it('returns the invitation without organizer or tenant identity', async () => {
    const { invitation, secret } = await sentInvitation()
    await exchange(invitation.id, secret)
    const response = await handlerOf(InvitationRoute, 'GET')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}`, 'GET', {
        cookie: cookieFor(invitation.id, secret),
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.roleTitle).toBe('Staff Engineer')
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain(ORG)
    expect(serialised).not.toContain(OWNER)
    expect(serialised).not.toMatch(/capabilit/i)
  })

  it('rejects another invitation cookie', async () => {
    const a = await sentInvitation()
    const b = await sentInvitation()
    await exchange(a.invitation.id, a.secret)
    // A hand-crafted cookie named for B carrying A's secret: the browser would not send this, and the
    // check does not rely on the browser being correct.
    const response = await handlerOf(InvitationRoute, 'GET')({
      request: request(`${ORIGIN}/api/public/scheduling/${b.invitation.id}`, 'GET', {
        cookie: cookieFor(b.invitation.id, a.secret),
      }),
      params: { invitationId: b.invitation.id },
    })
    expect(response.status).toBe(404)
  })
})

describe('GET .../slots', () => {
  it('returns slot id, start, and end only', async () => {
    const { invitation, secret } = await sentInvitation()
    await exchange(invitation.id, secret)
    const { response, slots } = await firstSlot(invitation.id, secret)
    expect(response.status).toBe(200)
    expect(slots.length).toBeGreaterThan(0)
    // spec.md: "Return opaque availability only; never reveal the event causing a conflict."
    for (const slot of slots) {
      expect(Object.keys(slot).sort()).toEqual(['endsAt', 'slotId', 'startsAt'])
    }
  })

  it('clamps an absurd range rather than scanning it', async () => {
    const { invitation, secret } = await sentInvitation()
    await exchange(invitation.id, secret)
    const response = await handlerOf(SlotsRoute, 'GET')({
      request: request(
        `${ORIGIN}/api/public/scheduling/${invitation.id}/slots?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z`,
        'GET',
        { cookie: cookieFor(invitation.id, secret) },
      ),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(200)
    // Bounded window, bounded work — the service's own ceiling, reached through the public route.
    const body = await response.json()
    expect(Array.isArray(body.slots)).toBe(true)
  })
})

describe('PUT .../submission then POST .../book', () => {
  it('books when every required purpose is accepted', async () => {
    const { invitation, secret, email } = await sentInvitation()
    await exchange(invitation.id, secret)
    const { receiptIds } = await submitAccepting(invitation.id, secret, email)
    const { slots } = await firstSlot(invitation.id, secret)

    const response = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: {
          slotId: slots[0]!.slotId,
          slotStartsAt: slots[0]!.startsAt,
          submissionVersion: 1,
          consentReceiptIds: receiptIds,
          idempotencyKey: `book-${invitation.id}`,
        },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.eventId).toBeTruthy()
    expect(body.startsAt).toBe(slots[0]!.startsAt)
  })

  it('answers 422 consent_required when a purpose was declined', async () => {
    const { invitation, secret, email } = await sentInvitation()
    await exchange(invitation.id, secret)
    // Everything except transcription.
    const { receiptIds } = await submitAccepting(invitation.id, secret, email, [
      'terms_and_privacy',
      'candidate_document_processing',
      'public_web_import',
      'ai_interview_assistance',
    ])
    const { slots } = await firstSlot(invitation.id, secret)

    const response = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: {
          slotId: slots[0]!.slotId,
          slotStartsAt: slots[0]!.startsAt,
          submissionVersion: 1,
          consentReceiptIds: receiptIds,
          idempotencyKey: `book-${invitation.id}`,
        },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error).toBe('consent_required')
    expect(body.missingPurposes).toEqual(['live_audio_transcription'])
  })

  it('a client cannot shorten the required purpose list by sending fewer receipts', async () => {
    const { invitation, secret, email } = await sentInvitation()
    await exchange(invitation.id, secret)
    const { receiptIds } = await submitAccepting(invitation.id, secret, email)
    const { slots } = await firstSlot(invitation.id, secret)

    const response = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: {
          slotId: slots[0]!.slotId,
          slotStartsAt: slots[0]!.startsAt,
          submissionVersion: 1,
          // Only the terms receipt. The server decides what is required, not the client.
          consentReceiptIds: [receiptIds[0]!],
          idempotencyKey: `book-${invitation.id}`,
        },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(422)
  })

  it('answers 409 with refreshed alternatives for a stale slot', async () => {
    const { invitation, secret, email } = await sentInvitation()
    await exchange(invitation.id, secret)
    const { receiptIds } = await submitAccepting(invitation.id, secret, email)
    const { slots } = await firstSlot(invitation.id, secret)

    const response = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: {
          slotId: 'a-slot-nobody-issued',
          slotStartsAt: slots[0]!.startsAt,
          submissionVersion: 1,
          consentReceiptIds: receiptIds,
          idempotencyKey: `book-${invitation.id}`,
        },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toBe('slot_unavailable')
    // Losing must not dead-end the candidate.
    expect(body.alternatives.length).toBeGreaterThan(0)
  })

  it('refuses to book with no cookie', async () => {
    const { invitation } = await sentInvitation()
    const response = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        body: {
          slotId: 'x', slotStartsAt: new Date().toISOString(), submissionVersion: 1,
          consentReceiptIds: ['00000000-0000-0000-0000-000000000000'], idempotencyKey: 'k',
        },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(404)
  })
})

describe('rate limiting', () => {
  it('refuses a flood of mutations from one client with 429', async () => {
    const { invitation, secret } = await sentInvitation()
    const responses: number[] = []
    // One shared client ip, unlike every other test in this file.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await handlerOf(WithdrawRoute, 'POST')({
        request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/withdraw`, 'POST', {
          cookie: cookieFor(invitation.id, secret),
          body: { purpose: 'public_web_import', noticeVersion: CANDIDATE_NOTICE_VERSION },
          clientIp: '203.0.113.99',
        }),
        params: { invitationId: invitation.id },
      })
      responses.push(response.status)
    }
    // These endpoints are unauthenticated by design, so the cap is the only thing bounding abuse.
    expect(responses).toContain(429)
  })
})

describe('cancel, withdraw, decline', () => {
  async function bookedInvitation() {
    const { invitation, secret, email } = await sentInvitation()
    await exchange(invitation.id, secret)
    const { receiptIds } = await submitAccepting(invitation.id, secret, email)
    const { slots } = await firstSlot(invitation.id, secret)
    const booked = await handlerOf(BookRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/book`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: {
          slotId: slots[0]!.slotId,
          slotStartsAt: slots[0]!.startsAt,
          submissionVersion: 1,
          consentReceiptIds: receiptIds,
          idempotencyKey: `book-${invitation.id}`,
        },
      }),
      params: { invitationId: invitation.id },
    })
    if (booked.status !== 200) throw new Error(`fixture could not book: ${booked.status} ${await booked.text()}`)
    return { invitation, secret, email }
  }

  it('cancels, and cancelling twice still succeeds', async () => {
    const { invitation, secret } = await bookedInvitation()
    const args = {
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/cancel`, 'POST', {
        cookie: cookieFor(invitation.id, secret), body: {},
      }),
      params: { invitationId: invitation.id },
    }
    expect((await handlerOf(CancelRoute, 'POST')(args)).status).toBe(200)
    expect((await handlerOf(CancelRoute, 'POST')({
      ...args,
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/cancel`, 'POST', {
        cookie: cookieFor(invitation.id, secret), body: {},
      }),
    })).status).toBe(200)
  })

  it('withdrawing transcription reports manual_only and does not cancel the interview', async () => {
    const { invitation, secret } = await bookedInvitation()
    const response = await handlerOf(WithdrawRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/withdraw`, 'POST', {
        cookie: cookieFor(invitation.id, secret),
        body: { purpose: 'live_audio_transcription', noticeVersion: CANDIDATE_NOTICE_VERSION },
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.withdrawn).toBe(true)
    // spec.md: withdrawing transcription changes the appointment to manual-only, not cancelled.
    expect(body.affectedState).toBe('manual_only')

    const refreshed = await holder.db!.transaction((tx) => findInvitationForOwner(tx, ORG, OWNER, invitation.id))
    expect(refreshed?.status).toBe('booked')
    expect(refreshed?.bookedEventId).toBeTruthy()
  })

  it('declines an opened invitation and clears the session cookie', async () => {
    const { invitation, secret } = await sentInvitation()
    await exchange(invitation.id, secret)
    const response = await handlerOf(DeclineRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/decline`, 'POST', {
        cookie: cookieFor(invitation.id, secret), body: {},
      }),
      params: { invitationId: invitation.id },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')

    // And the capability stops resolving, so the dead link cannot be reused.
    const after = await handlerOf(InvitationRoute, 'GET')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}`, 'GET', {
        cookie: cookieFor(invitation.id, secret),
      }),
      params: { invitationId: invitation.id },
    })
    expect(after.status).toBe(404)
  })

  it('cannot decline a booked invitation', async () => {
    const { invitation, secret } = await bookedInvitation()
    const response = await handlerOf(DeclineRoute, 'POST')({
      request: request(`${ORIGIN}/api/public/scheduling/${invitation.id}/decline`, 'POST', {
        cookie: cookieFor(invitation.id, secret), body: {},
      }),
      params: { invitationId: invitation.id },
    })
    // Declining would leave a confirmed event beside a declined invitation. Cancel is the way out.
    expect(response.status).toBe(404)
  })
})
