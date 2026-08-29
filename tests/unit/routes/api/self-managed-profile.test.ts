/**
 * The profile route handlers, invoked directly (plan: phase-2/07-perfiles-autogestionados,
 * "Expose strict owner and public profile APIs").
 *
 * The repository is mocked and the handlers are called as functions, because what these prove is
 * the route layer's own contract: who is refused and with which status, that an unknown field is a
 * 400 rather than a value quietly ignored, that a rate-limited call never reaches the repository,
 * and that an absent id and somebody else's id are indistinguishable in the response. The
 * repository's semantics — races, reservations, the thirty-day handle hold — have their own suite
 * against a real database, and the whole stack is crossed by `tests/e2e/self-managed-profile.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  rateLimit: vi.fn(),
  withAccountSubjectContext: vi.fn(),
  emitSecurityAudit: vi.fn(),
  getOwnProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  setVisibility: vi.fn(),
  softDeleteProfile: vi.fn(),
  reserveHandle: vi.fn(),
  isHandleAvailable: vi.fn(),
}))

/**
 * The feature flag is on for this suite, stated rather than inherited.
 *
 * `SELF_MANAGED_PROFILES_ENABLED` defaults to `false` — production inherits no `.env`, so every
 * flag in `env.ts` is off unless somebody turns it on. These tests are about what the feature does
 * when it exists; what it does when it does not is `tests/e2e/self-managed-flag.spec.ts`, and
 * asserting both from one file would mean neither could set the flag at module load.
 */
vi.mock('~/shared/lib/self-managed/feature-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/self-managed/feature-flag')>()
  return { ...actual, isSelfManagedEnabled: () => true, selfManagedDisabledResponse: () => null }
})

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withAccountSubjectContext: mocks.withAccountSubjectContext,
}))

vi.mock('~/shared/lib/rate-limit', () => ({
  rateLimit: mocks.rateLimit,
}))

vi.mock('~/shared/lib/security/audit', () => ({
  emitSecurityAudit: mocks.emitSecurityAudit,
}))

vi.mock('~/shared/lib/security/audit-sink', () => ({
  consoleSecurityAuditSink: { record: async () => undefined },
}))

vi.mock('~/shared/lib/repositories/self-managed-profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/self-managed-profiles')>()
  return {
    ...actual,
    getOwnProfile: mocks.getOwnProfile,
    createProfile: mocks.createProfile,
    updateProfile: mocks.updateProfile,
    setVisibility: mocks.setVisibility,
    softDeleteProfile: mocks.softDeleteProfile,
    reserveHandle: mocks.reserveHandle,
    isHandleAvailable: mocks.isHandleAvailable,
  }
})

const { Route: CollectionRoute } = await import('~/routes/api/self-managed/profile/index')
const { Route: ItemRoute } = await import('~/routes/api/self-managed/profile/$profileId')
const { Route: VisibilityRoute } = await import('~/routes/api/self-managed/visibility')
const { Route: ReserveRoute } = await import('~/routes/api/self-managed/handle/$handle/reserve')
const { Route: LookupRoute } = await import('~/routes/api/self-managed/handle/$handle/index')
const { SelfManagedProfileError } = await import('~/shared/lib/repositories/self-managed-profiles')

type Handler = (args: { request: Request; params: Record<string, string> }) => Promise<Response>

function handlerOf(route: unknown, method: string): Handler {
  const handlers = (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers
  const handler = handlers[method]
  if (!handler) throw new Error(`no ${method} handler`)
  return handler
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request('https://app.test/api/self-managed/anything', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
}

const OWNER = 'user-1'
const PROFILE = {
  id: 'prof-1',
  handle: 'ada',
  ownerUserId: OWNER,
  displayName: 'Ada',
  headline: null,
  bio: 'a bio nobody should find in an audit log',
  locationCity: null,
  locationCountryCode: null,
  languages: [],
  services: [],
  topics: [],
  visibility: 'public' as const,
  promotedToBuilderClaimId: null,
  declaredAt: new Date('2027-01-01T00:00:00Z'),
  updatedAt: new Date('2027-01-02T00:00:00Z'),
}

const VALID_BODY = { handle: 'ada', displayName: 'Ada' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue({ user: { id: OWNER } })
  mocks.rateLimit.mockResolvedValue({ allowed: true, resetMs: 60_000 })
  mocks.withAccountSubjectContext.mockImplementation(
    async (_userId: string, operation: (transaction: never) => Promise<unknown>) => operation({} as never),
  )
  mocks.emitSecurityAudit.mockResolvedValue(undefined)
})

describe('authentication comes first, on every handler', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['GET profile', () => handlerOf(CollectionRoute, 'GET')({ request: jsonRequest('GET'), params: {} })],
    ['POST profile', () => handlerOf(CollectionRoute, 'POST')({ request: jsonRequest('POST', VALID_BODY), params: {} })],
    ['PATCH profile/:id', () => handlerOf(ItemRoute, 'PATCH')({ request: jsonRequest('PATCH', VALID_BODY), params: { profileId: 'prof-1' } })],
    ['DELETE profile/:id', () => handlerOf(ItemRoute, 'DELETE')({ request: jsonRequest('DELETE'), params: { profileId: 'prof-1' } })],
    ['PATCH visibility', () => handlerOf(VisibilityRoute, 'PATCH')({ request: jsonRequest('PATCH', { visibility: 'draft' }), params: {} })],
    ['POST handle reserve', () => handlerOf(ReserveRoute, 'POST')({ request: jsonRequest('POST'), params: { handle: 'ada' } })],
    ['GET handle lookup', () => handlerOf(LookupRoute, 'GET')({ request: jsonRequest('GET'), params: { handle: 'ada' } })],
  ]

  for (const [name, call] of cases) {
    it(`${name} answers 401 with no session`, async () => {
      mocks.getSession.mockResolvedValue(null)
      const response = await call()
      expect(response.status).toBe(401)
    })
  }
})

describe('POST /api/self-managed/profile', () => {
  const post = (body: unknown) => handlerOf(CollectionRoute, 'POST')({ request: jsonRequest('POST', body), params: {} })

  it('creates and returns the owner projection, dates as strings and no subject id', async () => {
    mocks.createProfile.mockResolvedValue(PROFILE)

    const response = await post(VALID_BODY)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.profile.handle).toBe('ada')
    expect(body.profile.declaredAt).toBe('2027-01-01T00:00:00.000Z')
    expect(body.profile).not.toHaveProperty('ownerUserId')
  })

  it('refuses an unknown field with 400 before touching the repository', async () => {
    const response = await post({ ...VALID_BODY, admin: true })
    expect(response.status).toBe(400)
    expect(mocks.createProfile).not.toHaveBeenCalled()
  })

  it('refuses a malformed handle with 400', async () => {
    expect((await post({ ...VALID_BODY, handle: 'No' })).status).toBe(400)
  })

  it('maps already-exists and handle-taken to 409', async () => {
    mocks.createProfile.mockRejectedValue(new SelfManagedProfileError('already-exists', 'one each'))
    expect((await post(VALID_BODY)).status).toBe(409)

    mocks.createProfile.mockRejectedValue(new SelfManagedProfileError('handle-taken', 'held'))
    expect((await post(VALID_BODY)).status).toBe(409)
  })

  it('rate-limits creation before parsing or writing anything', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, resetMs: 120_000 })

    const response = await post(VALID_BODY)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('120')
    expect(mocks.createProfile).not.toHaveBeenCalled()
  })
})

describe('GET /api/self-managed/profile', () => {
  const get = () => handlerOf(CollectionRoute, 'GET')({ request: jsonRequest('GET'), params: {} })

  it('returns the caller’s own profile', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    const body = await (await get()).json()
    expect(body.profile.id).toBe('prof-1')
  })

  it('is a 404 when there is none', async () => {
    mocks.getOwnProfile.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
  })
})

describe('PATCH and DELETE /api/self-managed/profile/:profileId', () => {
  const patch = (profileId: string, body: unknown = VALID_BODY) =>
    handlerOf(ItemRoute, 'PATCH')({ request: jsonRequest('PATCH', body), params: { profileId } })
  const remove = (profileId: string) =>
    handlerOf(ItemRoute, 'DELETE')({ request: jsonRequest('DELETE'), params: { profileId } })

  it('updates when the id names the caller’s own profile', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    mocks.updateProfile.mockResolvedValue({ ...PROFILE, displayName: 'Ada L.' })

    const response = await patch('prof-1')
    expect(response.status).toBe(200)
    expect((await response.json()).profile.displayName).toBe('Ada L.')
  })

  it('answers the same 404 for an absent id and somebody else’s, and never calls the write', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)

    const foreign = await patch('prof-somebody-elses')
    mocks.getOwnProfile.mockResolvedValue(null)
    const absent = await patch('prof-never-existed')

    expect(foreign.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(await foreign.json()).toEqual(await absent.json())
    expect(mocks.updateProfile).not.toHaveBeenCalled()
  })

  it('refuses an unknown field with 400', async () => {
    expect((await patch('prof-1', { ...VALID_BODY, sneaky: 1 })).status).toBe(400)
  })

  it('maps a lost handle race to 409', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    mocks.updateProfile.mockRejectedValue(new SelfManagedProfileError('handle-taken', 'held'))
    expect((await patch('prof-1')).status).toBe(409)
  })

  it('deletes its own, audits it, and a repeat reads like it never existed', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    mocks.softDeleteProfile.mockResolvedValue(true)

    const first = await remove('prof-1')
    expect(first.status).toBe(200)
    expect(mocks.emitSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'self-managed.profile.delete', targetId: 'prof-1', organizationId: null }),
      expect.anything(),
    )

    mocks.getOwnProfile.mockResolvedValue(null)
    expect((await remove('prof-1')).status).toBe(404)
  })

  it('cannot be aimed at somebody else’s profile id', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    expect((await remove('prof-somebody-elses')).status).toBe(404)
    expect(mocks.softDeleteProfile).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/self-managed/visibility', () => {
  const patch = (body: unknown) =>
    handlerOf(VisibilityRoute, 'PATCH')({ request: jsonRequest('PATCH', body), params: {} })

  it('moves the profile and audits the transition without the content', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    mocks.setVisibility.mockResolvedValue({ ...PROFILE, visibility: 'draft' })

    const response = await patch({ visibility: 'draft' })
    expect(response.status).toBe(200)
    expect((await response.json()).profile.visibility).toBe('draft')

    const [audit] = mocks.emitSecurityAudit.mock.calls[0]!
    expect(audit).toMatchObject({
      action: 'self-managed.profile.visibility',
      details: { from: 'public', to: 'draft' },
    })
    expect(JSON.stringify(audit)).not.toContain(PROFILE.bio)
  })

  it('refuses a value outside the three states with 400', async () => {
    expect((await patch({ visibility: 'hidden' })).status).toBe(400)
    expect(mocks.setVisibility).not.toHaveBeenCalled()
  })

  it('is a 404 with no profile', async () => {
    mocks.getOwnProfile.mockResolvedValue(null)
    expect((await patch({ visibility: 'draft' })).status).toBe(404)
  })

  it('maps a refused transition to 409', async () => {
    mocks.getOwnProfile.mockResolvedValue(PROFILE)
    mocks.setVisibility.mockRejectedValue(new SelfManagedProfileError('invalid-transition', 'no'))
    expect((await patch({ visibility: 'draft' })).status).toBe(409)
  })
})

describe('POST /api/self-managed/handle/:handle/reserve', () => {
  const post = (handle: string) =>
    handlerOf(ReserveRoute, 'POST')({ request: jsonRequest('POST'), params: { handle } })

  it('reserves and says until when', async () => {
    mocks.reserveHandle.mockResolvedValue({ handle: 'ada', expiresAt: new Date('2027-01-08T00:00:00Z') })

    const body = await (await post('ada')).json()
    expect(body).toEqual({ handle: 'ada', expiresAt: '2027-01-08T00:00:00.000Z' })
  })

  it('a retry is just another 200 — the repository refreshes the caller’s own hold', async () => {
    mocks.reserveHandle.mockResolvedValue({ handle: 'ada', expiresAt: new Date('2027-01-08T00:00:00Z') })
    expect((await post('ada')).status).toBe(200)
    expect((await post('ada')).status).toBe(200)
  })

  it('maps a held handle to 409 — including one whose reservation has not expired yet', async () => {
    mocks.reserveHandle.mockRejectedValue(new SelfManagedProfileError('handle-taken', 'held until it expires'))
    expect((await post('ada')).status).toBe(409)
  })

  it('refuses a malformed handle from the path with 400', async () => {
    expect((await post('Not A Handle!')).status).toBe(400)
    expect(mocks.reserveHandle).not.toHaveBeenCalled()
  })

  it('rate-limits to five a day', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, resetMs: 1000 })
    const response = await post('ada')
    expect(response.status).toBe(429)
    expect(mocks.reserveHandle).not.toHaveBeenCalled()
    expect(mocks.rateLimit).toHaveBeenCalledWith('self-managed-handle-reserve', OWNER, 5, 24 * 60 * 60)
  })
})

describe('GET /api/self-managed/handle/:handle', () => {
  const get = (handle: string) =>
    handlerOf(LookupRoute, 'GET')({ request: jsonRequest('GET'), params: { handle } })

  it('answers availability for this caller', async () => {
    mocks.isHandleAvailable.mockResolvedValue(true)
    expect(await (await get('ada')).json()).toEqual({ handle: 'ada', available: true })

    mocks.isHandleAvailable.mockResolvedValue(false)
    expect(await (await get('ada')).json()).toEqual({ handle: 'ada', available: false })
  })

  it('refuses a malformed handle with 400', async () => {
    expect((await get('¡nope!')).status).toBe(400)
    expect(mocks.isHandleAvailable).not.toHaveBeenCalled()
  })

  it('rate-limits the oracle', async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, resetMs: 1000 })
    expect((await get('ada')).status).toBe(429)
    expect(mocks.isHandleAvailable).not.toHaveBeenCalled()
  })
})
