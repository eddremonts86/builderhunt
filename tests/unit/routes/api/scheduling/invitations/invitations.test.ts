import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

/**
 * Route tests for the authenticated invitation APIs (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Add authenticated invitation APIs").
 *
 * `withTenantContext` is redirected to a real disposable Postgres transaction rather than stubbed
 * out. Mocking the service layer would let a response shape drift from what the database actually
 * returns — and the single most important assertion here is a negative one about the response body
 * (no capability secret, no capability hash, no organization id), which a hand-built stub would
 * happily satisfy while the real route leaked.
 *
 * Authentication is the one thing mocked, because there is no session to forge and the principal is
 * exactly what the route is supposed to trust.
 */

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
}))

vi.mock('~/shared/lib/auth/tenant-principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/tenant-principal')>()
  return { ...actual, requireTenantPrincipal: mocks.requireTenantPrincipal }
})

vi.mock('~/shared/lib/db/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/db/tenant-context')>()
  return { ...actual, withTenantContext: mocks.withTenantContext }
})

/** Mutable, so the presence of an email provider can be flipped between requests. */
const mockEnv = vi.hoisted(() => ({
  SCHEDULING_ENABLED: 'true' as const,
  RESEND_API_KEY: undefined as string | undefined,
  APP_URL: 'https://app.test',
}))

vi.mock('~/shared/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/env')>()
  return {
    ...actual,
    env: new Proxy({} as Record<string, unknown>, {
      // A proxy rather than a spread: the spread is evaluated once at import, so flipping
      // `RESEND_API_KEY` in a test would have had no effect and the security branch could not be tested.
      get: (_target, key: string) => (key in mockEnv ? (mockEnv as Record<string, unknown>)[key] : (actual.env as unknown as Record<string, unknown>)[key]),
      has: (_target, key: string) => key in mockEnv || key in (actual.env as object),
    }),
  }
})

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const { authUsers, organizations } = await import('~/shared/lib/db/schema')
const { insertCalendar } = await import('~/shared/lib/repositories/calendar')
const {
  replaceAvailabilityPolicy,
  upsertAvailabilityPolicyWithVersion,
} = await import('~/shared/lib/repositories/scheduling')
const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')

const { Route: CollectionRoute } = await import('~/routes/api/scheduling/invitations/index')
const { Route: DetailRoute } = await import('~/routes/api/scheduling/invitations/$invitationId')
const { Route: SendRoute } = await import('~/routes/api/scheduling/invitations/$invitationId/send')
const { Route: RevokeRoute } = await import('~/routes/api/scheduling/invitations/$invitationId/revoke')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'inv-route-org-a'
const ORG_B = 'inv-route-org-b'
const OWNER = 'inv-route-owner'
const OTHER_MEMBER = 'inv-route-other'

function principal(overrides: Partial<TenantPrincipal> = {}): TenantPrincipal {
  return {
    userId: OWNER,
    organizationId: ORG_A,
    role: 'member',
    requestId: 'request-1',
    ...overrides,
  }
}

type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>

function handlerOf(route: unknown, method: 'GET' | 'POST'): Handler {
  const options = (route as { options: { server: { handlers: Record<string, Handler> } } }).options
  return options.server.handlers[method]!
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    candidateEmail: 'Casey.Candidate@Test.invalid',
    roleTitle: 'Staff Engineer',
    roleContext: 'Platform team, mostly Postgres and TypeScript.',
    durationMinutes: 45,
    timezone: 'Europe/Copenhagen',
    modality: 'remote_call',
    meetingUrl: 'https://meet.test.invalid/room',
    ...overrides,
  }
}

async function createInvitationViaApi(overrides: Record<string, unknown> = {}) {
  mocks.requireTenantPrincipal.mockResolvedValue(principal())
  const response = await handlerOf(CollectionRoute, 'POST')({
    request: jsonRequest('https://app.test/api/scheduling/invitations', 'POST', createBody(overrides)),
    params: {},
  })
  const body = await response.json()
  return { response, body }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('scheduling_invitation_routes')
  db = disposable.db
  drop = disposable.drop

  // Every route runs its work inside a real transaction against this database.
  mocks.withTenantContext.mockImplementation((_principal: TenantPrincipal, operation: (tx: unknown) => Promise<unknown>) =>
    db.transaction((tx) => operation(tx)))

  await db.insert(organizations).values([
    { id: ORG_A, name: 'A', slug: ORG_A },
    { id: ORG_B, name: 'B', slug: ORG_B },
  ])
  await db.insert(authUsers).values([
    { id: OWNER, name: 'Owner', email: 'inv-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: OTHER_MEMBER, name: 'Other', email: 'inv-other@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.transaction((tx) => insertCalendar(tx, {
    organizationId: ORG_A, ownerUserId: OWNER, name: 'Cal', timezone: 'Europe/Copenhagen', isDefault: true,
  }))
  await db.transaction((tx) => upsertAvailabilityPolicyWithVersion(tx, ORG_A, OWNER, 1, {
    defaultReminderOffsets: [60], defaultReminderChannels: ['email'],
  }))
  await db.transaction((tx) => replaceAvailabilityPolicy(tx, ORG_A, OWNER, {
    rules: [{
      timezone: 'Europe/Copenhagen',
      weekdays: [1, 2, 3, 4, 5],
      localStart: '09:00',
      localEnd: '17:00',
      slotMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 60,
      enabled: true,
    }],
    overrides: [],
  }))
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('POST /api/scheduling/invitations', () => {
  it('creates a draft and returns a real availability preview', async () => {
    const { response, body } = await createInvitationViaApi()
    expect(response.status).toBe(201)
    expect(body.status).toBe('draft')
    expect(body.roleTitle).toBe('Staff Engineer')
    // The preview comes from the same slot generator the candidate will call, so an organizer with
    // nothing free learns it before sending.
    expect(Array.isArray(body.availabilityPreview)).toBe(true)
    expect(body.availabilityPreview.length).toBeGreaterThan(0)
  })

  it('never returns the capability secret or hash', async () => {
    const { body } = await createInvitationViaApi()
    const serialised = JSON.stringify(body)
    // The secret's only job is to go into an email link fragment. A response body passes through
    // logs, devtools, and error reporters on its way to the organizer's screen.
    expect(serialised).not.toMatch(/capabilit/i)
    expect(serialised).not.toMatch(/secret|hash|token/i)
    // Nor anything about the tenant: spec.md forbids leaking organization ids in scheduling responses.
    expect(serialised).not.toContain(ORG_A)
    expect(serialised).not.toContain(OWNER)
  })

  it('normalizes the candidate email it stores', async () => {
    const { body } = await createInvitationViaApi()
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const detail = await handlerOf(DetailRoute, 'GET')({
      request: jsonRequest(`https://app.test/api/scheduling/invitations/${body.invitationId}`, 'GET'),
      params: { invitationId: body.invitationId },
    })
    const invitation = await detail.json()
    expect(invitation.candidateEmail).toBe('casey.candidate@test.invalid')
  })

  it('answers 401 without a principal', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('nope', 401))
    const response = await handlerOf(CollectionRoute, 'POST')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'POST', createBody()),
      params: {},
    })
    expect(response.status).toBe(401)
    expect((await response.json()).error).toBe('authentication_required')
  })

  it('rejects a body the schema does not recognise', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(CollectionRoute, 'POST')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'POST', {
        ...createBody(), unexpectedField: 'surprise',
      }),
      params: {},
    })
    expect(response.status).toBe(400)
  })

  it('rejects a remote interview with no meeting URL', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(CollectionRoute, 'POST')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'POST',
        createBody({ meetingUrl: undefined })),
      params: {},
    })
    // A remote invitation with no way to join it is a support ticket the candidate discovers.
    expect(response.status).toBe(400)
  })

  it('rejects a duration beyond the bound', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(CollectionRoute, 'POST')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'POST',
        createBody({ durationMinutes: 4000 })),
      params: {},
    })
    expect(response.status).toBe(400)
  })
})

describe('GET /api/scheduling/invitations', () => {
  it('lists only the caller own invitations', async () => {
    const { body } = await createInvitationViaApi()

    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const mine = await handlerOf(CollectionRoute, 'GET')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'GET'),
      params: {},
    })
    const listed = await mine.json()
    expect(listed.invitations.map((row: { invitationId: string }) => row.invitationId)).toContain(body.invitationId)

    // Another member of the same organization sees none of them.
    mocks.requireTenantPrincipal.mockResolvedValue(principal({ userId: OTHER_MEMBER }))
    const theirs = await handlerOf(CollectionRoute, 'GET')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'GET'),
      params: {},
    })
    expect((await theirs.json()).invitations).toHaveLength(0)
  })

  it('shows nothing to another tenant', async () => {
    await createInvitationViaApi()
    mocks.requireTenantPrincipal.mockResolvedValue(principal({ organizationId: ORG_B }))
    const response = await handlerOf(CollectionRoute, 'GET')({
      request: jsonRequest('https://app.test/api/scheduling/invitations', 'GET'),
      params: {},
    })
    expect((await response.json()).invitations).toHaveLength(0)
  })
})

describe('GET /api/scheduling/invitations/:id', () => {
  it('answers 404 rather than 403 for another member invitation', async () => {
    const { body } = await createInvitationViaApi()

    mocks.requireTenantPrincipal.mockResolvedValue(principal({ userId: OTHER_MEMBER }))
    const response = await handlerOf(DetailRoute, 'GET')({
      request: jsonRequest(`https://app.test/api/scheduling/invitations/${body.invitationId}`, 'GET'),
      params: { invitationId: body.invitationId },
    })
    // A 403 would confirm the row exists, turning id enumeration into a way to learn who is
    // interviewing whom inside the organization.
    expect(response.status).toBe(404)
  })

  it('answers 404 for a well-formed id that belongs to nobody', async () => {
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(DetailRoute, 'GET')({
      request: jsonRequest('https://app.test/api/scheduling/invitations/x', 'GET'),
      params: { invitationId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(response.status).toBe(404)
  })

  it('answers 401 without a principal', async () => {
    mocks.requireTenantPrincipal.mockRejectedValue(new TenantAuthorizationError('nope', 401))
    const response = await handlerOf(DetailRoute, 'GET')({
      request: jsonRequest('https://app.test/api/scheduling/invitations/x', 'GET'),
      params: { invitationId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(response.status).toBe(401)
  })
})

describe('POST .../send', () => {
  async function send(invitationId: string, version: number, actor = principal()) {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(SendRoute, 'POST')({
      request: jsonRequest(`https://app.test/api/scheduling/invitations/${invitationId}/send`, 'POST', {
        version, idempotencyKey: `send-${invitationId}-${version}`,
      }),
      params: { invitationId },
    })
  }

  it('moves a draft to sent and returns the new version', async () => {
    const { body } = await createInvitationViaApi()
    const response = await send(body.invitationId, body.version)
    expect(response.status).toBe(200)
    const sent = await response.json()
    expect(sent.status).toBe('sent')
    expect(sent.version).toBeGreaterThan(body.version)
    expect(Object.keys(sent).sort()).toEqual(['devLink', 'invitationId', 'status', 'version'])
  })

  it('returns the candidate link when no email provider is configured', async () => {
    // The invariant this pair replaces was "the response is three fields; nothing about the capability
    // rides along". That was right about production and wrong about everywhere else: the secret is minted
    // at send and never stored, so with no provider the response was the last moment the link existed and
    // it was discarded. Every invitation created locally or in a preview environment was `sent`, had its
    // hash committed, and was unreachable — the only copy printed to a server console — and the candidate
    // page showed the ordinary "no longer open" message with no way to tell that from a real revocation.
    const { body } = await createInvitationViaApi()
    const sent = await (await send(body.invitationId, body.version)).json()
    expect(sent.devLink).toMatch(new RegExp(`/schedule/${body.invitationId}#`))
    // And the fragment is not empty: a link without the secret is exactly the dead URL that was the
    // original symptom.
    expect(String(sent.devLink).split('#')[1] ?? '').not.toBe('')
  })

  it('returns no link once an email provider is configured', async () => {
    // The security half, and the one that matters: with `RESEND_API_KEY` set the sender returns no
    // `devLink` at all, so the capability cannot reach an organizer-facing response in production. This is
    // the branch the original single assertion was protecting.
    //
    // The provider has to *succeed* for this to test anything. A first version let the real Resend fetch
    // fail, which returned a 502 whose body has no `devLink` either way — so the test passed with the
    // route deliberately leaking the link. Verified by planting exactly that.
    mockEnv.RESEND_API_KEY = 're_test_key'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('api.resend.com')) {
        return new Response(JSON.stringify({ id: 'email-1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input)
    }) as typeof fetch

    try {
      const { body } = await createInvitationViaApi()
      const response = await send(body.invitationId, body.version)
      expect(response.status).toBe(200)
      const sent = await response.json()
      expect(sent.status).toBe('sent')
      // The link went to the candidate's inbox and nowhere else.
      expect(sent.devLink ?? null).toBeNull()
      expect(JSON.stringify(sent)).not.toMatch(/#/)
    } finally {
      globalThis.fetch = realFetch
      mockEnv.RESEND_API_KEY = undefined
    }
  })

  it('refuses a resend, because the secret was never kept', async () => {
    const { body } = await createInvitationViaApi()
    const first = await (await send(body.invitationId, body.version)).json()
    expect(first.status).toBe('sent')

    // The capability is minted at send and only its hash is stored, so a second send has no link to
    // deliver. Minting a replacement would silently break the one already in the candidate's inbox,
    // so the organizer is told to revoke and re-invite instead.
    const second = await send(body.invitationId, first.version)
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe('already_sent')
  })

  it('answers 409 when the version is stale', async () => {
    const { body } = await createInvitationViaApi()
    await send(body.invitationId, body.version)
    // Both facts are true here — the caller's version is stale *and* the invitation is already
    // sent — and both are conflicts, so both answer 409. The body distinguishes them; the status
    // deliberately does not, because the caller's next move is the same either way: reload.
    const stale = await send(body.invitationId, body.version)
    expect(stale.status).toBe(409)
  })

  it('answers 404 for another member invitation', async () => {
    const { body } = await createInvitationViaApi()
    const response = await send(body.invitationId, body.version, principal({ userId: OTHER_MEMBER }))
    expect(response.status).toBe(404)
  })

  it('answers 404 for another tenant', async () => {
    const { body } = await createInvitationViaApi()
    const response = await send(body.invitationId, body.version, principal({ organizationId: ORG_B }))
    expect(response.status).toBe(404)
  })

  it('rejects a request with no version', async () => {
    const { body } = await createInvitationViaApi()
    mocks.requireTenantPrincipal.mockResolvedValue(principal())
    const response = await handlerOf(SendRoute, 'POST')({
      request: jsonRequest(`https://app.test/api/scheduling/invitations/${body.invitationId}/send`, 'POST', {
        idempotencyKey: 'no-version',
      }),
      params: { invitationId: body.invitationId },
    })
    expect(response.status).toBe(400)
  })
})

describe('POST .../revoke', () => {
  async function revoke(invitationId: string, version: number, actor = principal()) {
    mocks.requireTenantPrincipal.mockResolvedValue(actor)
    return handlerOf(RevokeRoute, 'POST')({
      request: jsonRequest(`https://app.test/api/scheduling/invitations/${invitationId}/revoke`, 'POST', {
        version, idempotencyKey: `revoke-${invitationId}-${version}`,
      }),
      params: { invitationId },
    })
  }

  it('revokes a draft', async () => {
    const { body } = await createInvitationViaApi()
    const response = await revoke(body.invitationId, body.version)
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe('revoked')
  })

  it('answers 409 on a second revoke rather than pretending it worked', async () => {
    const { body } = await createInvitationViaApi()
    const first = await (await revoke(body.invitationId, body.version)).json()
    // An organizer clicking revoke twice should learn that the second click did nothing.
    const second = await revoke(body.invitationId, first.version)
    expect(second.status).toBe(409)
  })

  it('answers 404 for another tenant', async () => {
    const { body } = await createInvitationViaApi()
    const response = await revoke(body.invitationId, body.version, principal({ organizationId: ORG_B }))
    expect(response.status).toBe(404)
  })
})
