// Plan 38 (work-sample) task 'Limit + degradation curls' —
// security/mocking test that exercises the work-sample analyze
// endpoint's gating logic without real GitHub/MiniMax credentials.
//
// The original task description calls for running the endpoint
// 5 times in an hour and 12 times in a day against real keys.
// That is a manual operator task. This test is the next-best
// regression guard: it verifies that
//   - without AI keys, the kill switch returns 503 'unavailable'
//     BEFORE the rate limit and budget checks fire
//   - with env.AI_DISABLED='true', POST returns 503 'unavailable'
//   - when the budget check trips (any reason), the route returns
//     429 with the right error code
//   - when the rate limit trips, the route returns 429 rate_limited
//   - validation, authentication, and unsupported URL handling are
//     still correct
//
// Real-network runs (5/hour, 12/day) are an operator task that
// requires real GITHUB_TOKEN and MINIMAX_API_KEY. This test does
// not pretend to cover that.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireTenantPrincipal: vi.fn(),
  withTenantContext: vi.fn(),
  rateLimit: vi.fn(),
  checkAndConsumeBudget: vi.fn(),
  findWorkSampleAnalysis: vi.fn(),
  upsertWorkSampleAnalysis: vi.fn(),
  getTask: vi.fn(),
  getOrganizationEntitlement: vi.fn(),
  fetchSampleContent: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  minimaxChat: vi.fn(),
  // The repo's env is module-frozen at import time; we cannot
  // mutate it. The route reads `env.MINIMAX_API_KEY` and
  // `env.GITHUB_TOKEN` at runtime; a missing or falsy value
  // trips the kill switch. We mock the env module instead.
  getEnv: () => ({
    MINIMAX_API_KEY: undefined as string | undefined,
    GITHUB_TOKEN: undefined as string | undefined,
    AI_DISABLED: undefined as string | undefined,
  }),
}))

const envState = mocks.getEnv()

vi.mock('~/shared/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, key: string) {
      if (key === 'MINIMAX_API_KEY') return envState.MINIMAX_API_KEY
      if (key === 'GITHUB_TOKEN') return envState.GITHUB_TOKEN
      if (key === 'AI_DISABLED') return envState.AI_DISABLED
      return undefined
    },
  }),
}))

vi.mock('~/shared/lib/auth/tenant-principal', () => ({
  requireTenantPrincipal: mocks.requireTenantPrincipal,
  TenantAuthorizationError: class extends Error {
    constructor(message: string, readonly status: 401 | 403) {
      super(message)
      this.name = 'TenantAuthorizationError'
    }
  },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}))

vi.mock('~/shared/lib/rate-limit', () => ({
  rateLimit: mocks.rateLimit,
}))

vi.mock('~/shared/lib/ai/budget', () => ({
  checkAndConsumeBudget: mocks.checkAndConsumeBudget,
}))

vi.mock('~/shared/lib/ai/tasks', () => ({
  getTask: mocks.getTask,
}))

vi.mock('~/shared/lib/repositories/entitlements', () => ({
  getOrganizationEntitlement: mocks.getOrganizationEntitlement,
}))

vi.mock('~/shared/lib/ai/cache', () => ({
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}))

vi.mock('~/shared/lib/ai/minimax', () => ({
  minimaxChat: mocks.minimaxChat,
}))

vi.mock('~/shared/lib/repositories/work-samples', () => ({
  findWorkSampleAnalysis: mocks.findWorkSampleAnalysis,
  upsertWorkSampleAnalysis: mocks.upsertWorkSampleAnalysis,
}))

// Mock the github work-sample module at the alias path used in
// the route.
vi.mock('~/lib/github/work-sample', () => ({
  parseSampleUrl: (url: string) => {
    // Return a parsed object if the url looks like a github
    // repo url, otherwise null to trigger unsupported_url.
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/.exec(url)
    if (!m) return null
    return { type: 'repo' as const, owner: m[1], repo: m[2] }
  },
  computeContentHash: () => 'h',
  fetchSampleContent: mocks.fetchSampleContent,
  SampleNotFoundError: class extends Error {
    constructor() {
      super('not found')
      this.name = 'SampleNotFoundError'
    }
  },
  GitHubRateLimitedError: class extends Error {
    constructor() {
      super('rate limited')
      this.name = 'GitHubRateLimitedError'
    }
  },
  GitHubTokenMissingError: class extends Error {
    constructor() {
      super('token missing')
      this.name = 'GitHubTokenMissingError'
    }
  },
}))

const { Route } = await import('~/routes/api/work-samples/analyze')

const principal = {
  userId: 'u-1',
  organizationId: 'org-1',
  role: 'owner' as const,
  requestId: 'r-1',
}

function call(body: unknown): Promise<Response> {
  const handler = (
    Route as unknown as {
      options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }
    }
  ).options.server.handlers.POST
  return handler({
    request: new Request('https://app.test/api/work-samples/analyze', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  })
}

const TASK = {
  id: 'work-sample-analyze',
  tier: 'server-only' as const,
  system: 's',
  buildPrompt: () => 'p',
  outputSchema: { parse: (v: unknown) => v },
  maxOutputTokens: 1024,
  cacheTtlSeconds: 0,
  allowances: { free: 0, pro: 10, business: 50 },
}

const ENTITLEMENT = { planTier: 'pro' as const, allowances: {} }

beforeEach(() => {
  vi.clearAllMocks()
  // Reset env state to the "no credentials" defaults.
  envState.MINIMAX_API_KEY = undefined
  envState.GITHUB_TOKEN = undefined
  envState.AI_DISABLED = undefined
  mocks.requireTenantPrincipal.mockResolvedValue(principal)
  // Default: a fresh successful budget check + rate limit + task +
  // entitlement, so the test can observe the kill-switch /
  // disabled / 401 / 400 / unsupported_url paths in isolation.
  mocks.checkAndConsumeBudget.mockResolvedValue({
    allowed: true,
    reason: 'budget' as const,
  })
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 100, resetMs: 0 })
  mocks.getTask.mockReturnValue(TASK)
  mocks.getOrganizationEntitlement.mockResolvedValue(ENTITLEMENT)
  mocks.withTenantContext.mockImplementation(async (_p, cb) => cb({} as never))
  mocks.findWorkSampleAnalysis.mockResolvedValue(null)
  mocks.upsertWorkSampleAnalysis.mockResolvedValue({
    id: 'wa-1',
    organizationId: 'org-1',
    userId: 'u-1',
    source: 'github' as const,
    sourceId: 'octocat/Hello-World',
    sampleKind: 'repo' as const,
    contentHash: 'h',
    analysis: { summary: 'x', signals: {}, score: 0.5 },
    budgetConsumed: true,
    createdAt: new Date(),
  })
  mocks.fetchSampleContent.mockResolvedValue('# Hello')
  mocks.getCached.mockResolvedValue(null)
  mocks.minimaxChat.mockResolvedValue({
    summary: 'x',
    signals: {},
    score: 0.5,
  })
})

describe('POST /api/work-samples/analyze — gating (plan 38 task)', () => {
  it('returns 503 unavailable when no AI keys are configured (kill switch runs BEFORE rate limit / budget)', async () => {
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('unavailable')
    // The rate-limit and budget calls MUST NOT have been made —
    // that is the point of the kill switch.
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.checkAndConsumeBudget).not.toHaveBeenCalled()
  })

  it('returns 503 unavailable when env.AI_DISABLED="true"', async () => {
    envState.AI_DISABLED = 'true'
    envState.MINIMAX_API_KEY = 'sk-test'
    envState.GITHUB_TOKEN = 'ghp-test'
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('unavailable')
  })

  it('returns 429 rate_limited when the abuse rate limit trips (5th request in an hour)', async () => {
    envState.MINIMAX_API_KEY = 'sk-test'
    envState.GITHUB_TOKEN = 'ghp-test'
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetMs: 3600_000 })
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('rate_limited')
  })

  it('returns 429 budget when the daily budget is exhausted (12th request in a day)', async () => {
    envState.MINIMAX_API_KEY = 'sk-test'
    envState.GITHUB_TOKEN = 'ghp-test'
    mocks.checkAndConsumeBudget.mockResolvedValueOnce({
      allowed: false,
      reason: 'budget' as const,
    })
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('budget')
  })

  it('returns 429 plan when the organization is on a free tier (allowance is 0)', async () => {
    envState.MINIMAX_API_KEY = 'sk-test'
    envState.GITHUB_TOKEN = 'ghp-test'
    mocks.checkAndConsumeBudget.mockResolvedValueOnce({
      allowed: false,
      reason: 'plan' as const,
    })
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('plan')
  })

  it('returns 400 unsupported_url for a non-GitHub URL (validation runs FIRST, before any kill switch)', async () => {
    const res = await call({ url: 'not-a-url' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('unsupported_url')
  })

  it('returns 401 for an unauthenticated caller (the very first gate)', async () => {
    const { TenantAuthorizationError } = await import('~/shared/lib/auth/tenant-principal')
    mocks.requireTenantPrincipal.mockRejectedValueOnce(
      new TenantAuthorizationError('Authentication required', 401),
    )
    const res = await call({ url: 'https://github.com/octocat/Hello-World' })
    expect(res.status).toBe(401)
  })
})
