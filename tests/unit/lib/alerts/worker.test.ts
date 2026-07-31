// Plan: smart-alerts, Phase 1 task "Worker integration (best-effort)".
//
// Regression coverage for the AI-digest-summary wiring in `runAlertsWorker`. This exists because
// the task id used to call `ai()` (`alert_digest_summary`, underscore) silently didn't match the
// registered task id (`alert-digest-summary`, hyphen) in `src/shared/lib/ai/tasks.ts` — an exact
// string lookup that always threw, was always caught, and always fell back to the plain digest.
// No test exercised the real call path, so it shipped and stayed broken.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listWorkerOrganizationIds = vi.fn()
const withWorkerOrganization = vi.fn()
const listEnabledWorkerAlerts = vi.fn()
const findWorkerBuilder = vi.fn()
const findWorkerUserEmail = vi.fn()
const markWorkerAlertEvaluated = vi.fn()
const recordWorkerTrigger = vi.fn()
const listWorkerSeenSourceIds = vi.fn()

vi.mock('~/shared/lib/repositories/alerts-worker', () => ({
  listWorkerOrganizationIds: (...args: unknown[]) => listWorkerOrganizationIds(...args),
  withWorkerOrganization: (...args: unknown[]) => withWorkerOrganization(...args),
  listEnabledWorkerAlerts: (...args: unknown[]) => listEnabledWorkerAlerts(...args),
  findWorkerBuilder: (...args: unknown[]) => findWorkerBuilder(...args),
  findWorkerUserEmail: (...args: unknown[]) => findWorkerUserEmail(...args),
  markWorkerAlertEvaluated: (...args: unknown[]) => markWorkerAlertEvaluated(...args),
  recordWorkerTrigger: (...args: unknown[]) => recordWorkerTrigger(...args),
  listWorkerSeenSourceIds: (...args: unknown[]) => listWorkerSeenSourceIds(...args),
}))

const searchBuilders = vi.fn()
vi.mock('~/lib/search', () => ({ searchBuilders: (...args: unknown[]) => searchBuilders(...args) }))

const sendAlertDigestEmail = vi.fn()
vi.mock('~/shared/lib/email', () => ({
  sendAlertDigestEmail: (...args: unknown[]) => sendAlertDigestEmail(...args),
}))

const ai = vi.fn()
vi.mock('~/shared/lib/ai/client', () => ({ ai: (...args: unknown[]) => ai(...args) }))

let aiDisabled = 'false'
let aiDisabledTasks = ''
vi.mock('~/shared/lib/env', () => ({
  get env() {
    return { AI_DISABLED: aiDisabled, AI_DISABLED_TASKS: aiDisabledTasks }
  },
}))

const BASE_ALERT = {
  id: 'alert-1',
  organizationId: 'org-1',
  userId: 'user-1',
  name: 'New activity from tosh',
  enabled: true,
  deliveryChannel: 'email' as const,
  frequency: 'daily' as const,
  lastCheckedAt: null,
  nextEvaluationAt: null,
  lastTriggeredAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  consecutiveFailures: 0,
  triggerConditions: { eventType: 'any_activity', builderId: 'builder-1' },
  keywords: [],
}

const BASE_BUILDER = {
  id: 'builder-1',
  sourceId: 'src-1',
  source: 'hackernews',
  username: 'tosh',
  displayName: 'Tosh',
  profileUrl: 'https://news.ycombinator.com/user?id=tosh',
  avatarUrl: null,
  bio: 'Builder',
  followersCount: 10,
  language: null,
  country: null,
  topics: [],
  metadata: {},
  lastSeen: new Date('2026-06-01T00:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  aiDisabled = 'false'
  aiDisabledTasks = ''
  listWorkerOrganizationIds.mockResolvedValue([{ id: 'org-1' }])
  withWorkerOrganization.mockImplementation((_organizationId: string, operation: (tx: unknown) => unknown) =>
    operation({}))
  listEnabledWorkerAlerts.mockResolvedValue([BASE_ALERT])
  findWorkerBuilder.mockResolvedValue(BASE_BUILDER)
  findWorkerUserEmail.mockResolvedValue('user@example.com')
  markWorkerAlertEvaluated.mockResolvedValue(null)
  recordWorkerTrigger.mockResolvedValue(undefined)
  listWorkerSeenSourceIds.mockResolvedValue(new Set())
})

describe('runAlertsWorker — AI digest summary', () => {
  it('calls ai() with the registered task id and forwards the summary to the digest email', async () => {
    ai.mockResolvedValue({ output: { summary: 'Tosh shipped a new HN comment about balcony solar.' } })

    const { runAlertsWorker } = await import('~/lib/alerts/worker')
    const result = await runAlertsWorker()

    expect(ai).toHaveBeenCalledTimes(1)
    expect(ai.mock.calls[0][0]).toBe('alert-digest-summary')
    expect(sendAlertDigestEmail).toHaveBeenCalledTimes(1)
    expect(sendAlertDigestEmail.mock.calls[0][2]).toBe('Tosh shipped a new HN comment about balcony solar.')
    expect(result.usersEmailed).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it('falls back to the plain digest — never drops the email — when the AI call throws', async () => {
    ai.mockRejectedValue(new Error('provider unavailable'))

    const { runAlertsWorker } = await import('~/lib/alerts/worker')
    const result = await runAlertsWorker()

    expect(ai).toHaveBeenCalledTimes(1)
    expect(sendAlertDigestEmail).toHaveBeenCalledTimes(1)
    expect(sendAlertDigestEmail.mock.calls[0][2]).toBeUndefined()
    expect(result.usersEmailed).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it('skips the ai() call entirely when the task id is in AI_DISABLED_TASKS, and still sends the plain digest', async () => {
    aiDisabledTasks = 'alert-digest-summary'

    const { runAlertsWorker } = await import('~/lib/alerts/worker')
    const result = await runAlertsWorker()

    expect(ai).not.toHaveBeenCalled()
    expect(sendAlertDigestEmail).toHaveBeenCalledTimes(1)
    expect(sendAlertDigestEmail.mock.calls[0][2]).toBeUndefined()
    expect(result.usersEmailed).toBe(1)
  })
})
