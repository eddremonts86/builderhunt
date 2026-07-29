import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestPlanUpgrade: vi.fn(),
  env: { SIGNUP_REQUIRE_VERIFIED_EMAIL: 'false' as 'true' | 'false' },
}))

vi.mock('~/shared/lib/auth/better-auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))

vi.mock('~/shared/lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/billing')>()
  return { ...actual, requestPlanUpgrade: mocks.requestPlanUpgrade }
})

vi.mock('~/shared/lib/env', () => ({ env: mocks.env }))

const { Route } = await import('~/routes/api/plans/request-upgrade')
const { LegacyPlanMutationDisabledError } = await import('~/shared/lib/billing')

function postRequest(body: unknown): Request {
  return new Request('https://app.test/api/plans/request-upgrade', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function callPost(body: unknown = { requestedPlan: 'pro' }): Promise<Response> {
  const handler = (Route as unknown as { options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } } }).options.server.handlers.POST
  return handler({ request: postRequest(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/plans/request-upgrade', () => {
  it('requests an upgrade for a signed-in user', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.requestPlanUpgrade.mockResolvedValue({ id: 'req-1', alreadyPending: false })

    const response = await callPost()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, id: 'req-1', alreadyPending: false })
  })

  it('rejects a signed-out caller before requesting anything', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await callPost()

    expect(response.status).toBe(401)
    expect(mocks.requestPlanUpgrade).not.toHaveBeenCalled()
  })

  it('returns migration guidance (409) once the canonical Stripe system is live, instead of a generic 500', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.requestPlanUpgrade.mockRejectedValue(new LegacyPlanMutationDisabledError())

    const response = await callPost()
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.migrationGuidance).toBe(true)
    expect(body.checkoutUrl).toBe('/settings/billing')
  })

  it('blocks an unverified account from a paid plan upgrade when SIGNUP_REQUIRE_VERIFIED_EMAIL=true', async () => {
    // abuse-and-usage-integrity plan, Phase 3 task "Email verification gate".
    // `env` is a module-level constant in env.ts, computed at import time, so
    // vi.stubEnv on process.env has no effect — the test mocks the env module
    // itself (see the vi.mock at the top) and flips the same key per case.
    mocks.env.SIGNUP_REQUIRE_VERIFIED_EMAIL = 'true'
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1', emailVerified: false } })

    try {
      const response = await callPost()
      const body = await response.json()
      expect(response.status).toBe(403)
      expect(body.error).toBe('email_verification_required')
      expect(mocks.requestPlanUpgrade).not.toHaveBeenCalled()
    } finally {
      mocks.env.SIGNUP_REQUIRE_VERIFIED_EMAIL = 'false'
    }
  })

  it('lets a verified account through when SIGNUP_REQUIRE_VERIFIED_EMAIL=true', async () => {
    mocks.env.SIGNUP_REQUIRE_VERIFIED_EMAIL = 'true'
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1', emailVerified: true } })
    mocks.requestPlanUpgrade.mockResolvedValue({ id: 'req-1', alreadyPending: false })

    try {
      const response = await callPost()
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body).toEqual({ ok: true, id: 'req-1', alreadyPending: false })
    } finally {
      mocks.env.SIGNUP_REQUIRE_VERIFIED_EMAIL = 'false'
    }
  })

  it('does not gate paid actions when SIGNUP_REQUIRE_VERIFIED_EMAIL=false (default)', async () => {
    mocks.env.SIGNUP_REQUIRE_VERIFIED_EMAIL = 'false'
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1', emailVerified: false } })
    mocks.requestPlanUpgrade.mockResolvedValue({ id: 'req-1', alreadyPending: false })

    const response = await callPost()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, id: 'req-1', alreadyPending: false })
  })
})
