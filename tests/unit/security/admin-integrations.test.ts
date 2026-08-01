/**
 * plans/UI/tasks.md Wave 5 "Add a redacted integration and AI health API".
 *
 * Proves: every `SourceName` and every `AI_TASKS` entry gets exactly one row (exhaustiveness is
 * actually enforced at `SOURCE_PRESENTATION`'s own definition site — see source-presentation.ts —
 * this just proves the route doesn't drop or filter any of them); the DTO never carries a secret
 * value, a provider payload, a prompt, or a raw env-var name; and a non-platform-admin never
 * reaches any of it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SOURCE_NAMES } from '~/lib/sources/types'
import { AI_TASKS } from '~/shared/lib/ai/tasks'

const mocks = vi.hoisted(() => ({
  requirePlatformAdminPrincipal: vi.fn(),
  getDiscoveryState: vi.fn(),
}))

vi.mock('~/shared/lib/auth/platform-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/auth/platform-admin')>()
  return { ...actual, requirePlatformAdminPrincipal: mocks.requirePlatformAdminPrincipal }
})

vi.mock('~/shared/lib/repositories/discovery-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/repositories/discovery-state')>()
  return { ...actual, getDiscoveryState: mocks.getDiscoveryState }
})

const { Route } = await import('~/routes/api/admin/integrations/index')
const { PlatformAdminAuthorizationError } = await import('~/shared/lib/auth/platform-admin')

function callRoute(): Promise<Response> {
  const handler = (Route as unknown as {
    options: { server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } } }
  }).options.server.handlers.GET
  return handler({ request: new Request('https://app.test/api/admin/integrations') })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePlatformAdminPrincipal.mockResolvedValue({ userId: 'admin-1', requestId: 'req-1' })
  mocks.getDiscoveryState.mockResolvedValue({ cursor: 3, lastCellKey: 'cell', lastRunAt: new Date('2027-01-01T00:00:00.000Z'), stats: { runs: 1, upserted: 2, errors: 0 } })
})

describe('GET /api/admin/integrations', () => {
  it('rejects a non-platform-admin before building any row', async () => {
    mocks.requirePlatformAdminPrincipal.mockRejectedValue(new PlatformAdminAuthorizationError('Forbidden', 403))
    const response = await callRoute()
    expect(response.status).toBe(403)
    expect(mocks.getDiscoveryState).not.toHaveBeenCalled()
  })

  it('returns exactly one row per SOURCE_NAMES entry — no source is dropped', async () => {
    const response = await callRoute()
    expect(response.status).toBe(200)
    const body = await response.json() as { sources: Array<{ source: string }> }
    expect(body.sources).toHaveLength(SOURCE_NAMES.length)
    expect(body.sources.map((s) => s.source).sort()).toEqual([...SOURCE_NAMES].sort())
  })

  it('returns exactly one row per registered AI task — no task is dropped', async () => {
    const response = await callRoute()
    const body = await response.json() as { aiTasks: Array<{ taskId: string }> }
    expect(body.aiTasks).toHaveLength(Object.keys(AI_TASKS).length)
    expect(body.aiTasks.map((t) => t.taskId).sort()).toEqual(Object.keys(AI_TASKS).sort())
  })

  it('every source row is a plain boolean/null projection — never a credential value or a raw env var name', async () => {
    const response = await callRoute()
    const body = await response.json() as { sources: Array<Record<string, unknown>> }
    for (const row of body.sources) {
      expect(typeof row.credentialPresent).toBe('boolean')
      expect(['boolean', 'object']).toContain(typeof row.killSwitchEnabled) // boolean, or null (typeof null === 'object')
      expect(row.quota).toBeNull()
      expect(row.lastSuccessAt).toBeNull()
      expect(row.lastFailureAt).toBeNull()
      expect(row.indexedCount).toBeNull()
      expect(row.backlogCount).toBeNull()
    }
    const serialized = JSON.stringify(body)
    // No env var name (which would imply the response was built by string-dumping env) ever leaks.
    for (const name of ['GITHUB_TOKEN', 'REDDIT_CLIENT_SECRET', 'MINIMAX_API_KEY', 'PRODUCTHUNT_TOKEN']) {
      expect(serialized).not.toContain(name)
    }
  })

  it('every AI task row carries only tier/version/booleans — never a prompt, schema, or system string', async () => {
    const response = await callRoute()
    const body = await response.json() as { aiTasks: Array<Record<string, unknown>> }
    for (const row of body.aiTasks) {
      expect(['local-first', 'server-only']).toContain(row.tier)
      expect(typeof row.version).toBe('string')
      expect(typeof row.disabled).toBe('boolean')
      expect(typeof row.sensitive).toBe('boolean')
      expect(Object.keys(row).sort()).toEqual(['disabled', 'sensitive', 'taskId', 'tier', 'version'])
    }
  })

  it('surfaces discovery state as one global aggregate, never a per-source fabrication', async () => {
    const response = await callRoute()
    const body = await response.json() as { discovery: { cursor: number; lastRunAt: string | null } }
    expect(body.discovery).toEqual({ cursor: 3, lastRunAt: '2027-01-01T00:00:00.000Z', stats: { runs: 1, upserted: 2, errors: 0 } })
  })

  it('reports null discovery state honestly rather than inventing zeros', async () => {
    mocks.getDiscoveryState.mockResolvedValue(null)
    const response = await callRoute()
    const body = await response.json() as { discovery: unknown }
    expect(body.discovery).toBeNull()
  })
})
