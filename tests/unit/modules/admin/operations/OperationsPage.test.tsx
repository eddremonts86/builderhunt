import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OperationsPage } from '~/modules/admin/operations/OperationsPage'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const JOB = {
  jobKey: 'alerts.evaluate',
  label: 'Alert evaluation',
  scope: 'organization' as const,
  cronExpression: '*/15 * * * *',
  timezone: 'UTC',
  enabled: true,
  version: 1,
  nextRunAt: '2027-01-01T00:15:00.000Z',
  overdue: false,
  stale: false,
  lastRun: {
    state: 'succeeded',
    scheduledFor: '2027-01-01T00:00:00.000Z',
    startedAt: '2027-01-01T00:00:00.000Z',
    finishedAt: '2027-01-01T00:00:01.000Z',
    durationMs: 1000,
    processedCount: 5,
    failedCount: 0,
    errorCode: null,
  },
}

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<OperationsPage />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

describe('OperationsPage', () => {
  it('renders a job row with its status, cadence, and counters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' })))
    await render()

    expect(testId('operations-row-alerts.evaluate')?.textContent).toContain('Alert evaluation')
    expect(testId('job-status-alerts.evaluate')?.textContent).toContain('Healthy')
    // Rendered in both the desktop table and the mobile card list.
    expect(testId('operations-card-alerts.evaluate')).not.toBeNull()
  })

  it('pauses a job via PATCH with the current expectedVersion, then reloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ jobKey: 'alerts.evaluate', enabled: false, version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ ...JOB, enabled: false, version: 2 }], generatedAt: '2027-01-01T00:01:00.000Z' }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => {
      testId('operations-toggle-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const patchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/admin/operations/alerts.evaluate') && !String(url).includes('/run'))
    expect(patchCall).toBeTruthy()
    expect(patchCall![1]).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(patchCall![1].body)).toEqual({ enabled: false, expectedVersion: 1 })
    expect(testId('job-status-alerts.evaluate')?.textContent).toContain('Paused')
  })

  it('shows a conflict message and reloads when the version has moved (another admin changed it first)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'version_conflict', currentVersion: 3 }, 409))
      .mockResolvedValueOnce(jsonResponse({ jobs: [{ ...JOB, version: 3 }], generatedAt: '2027-01-01T00:01:00.000Z' }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => {
      testId('operations-toggle-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('operations-message-alerts.evaluate')?.textContent).toMatch(/refreshed/i)
  })

  it('requires an explicit confirm before running a job manually', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    expect(testId('operations-run-confirm-alerts.evaluate')).toBeNull()

    await act(async () => {
      testId('operations-run-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(testId('operations-run-confirm-alerts.evaluate')).not.toBeNull()
    // Confirming triggers exactly one more fetch (the run POST); clicking "Run now" alone must not.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('POSTs the manual-run endpoint only after the confirm click', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, jobKey: 'alerts.evaluate', alertsEvaluated: 3 }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:01:00.000Z' }))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => {
      testId('operations-run-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      testId('operations-run-confirm-yes-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const runCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/run'))
    expect(runCall).toBeTruthy()
    expect(runCall![1]).toMatchObject({ method: 'POST' })
    expect(testId('operations-message-alerts.evaluate')?.textContent).toMatch(/started/i)
  })

  it('surfaces an already-running conflict without pretending a new run started', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'already_running', startedAt: '2027-01-01T00:00:00.000Z' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    await render()

    await act(async () => {
      testId('operations-run-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      testId('operations-run-confirm-yes-alerts.evaluate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(testId('operations-message-alerts.evaluate')?.textContent).toMatch(/already running/i)
  })

  it('disables pause/resume until the job has a real version from the registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobs: [{ ...JOB, version: null }], generatedAt: '2027-01-01T00:00:05.000Z' })))
    await render()

    expect((testId('operations-toggle-alerts.evaluate') as HTMLButtonElement).disabled).toBe(true)
  })

  it('links to the runbook document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ jobs: [JOB], generatedAt: '2027-01-01T00:00:05.000Z' })))
    await render()

    expect(testId('operations-runbook')?.textContent).toContain('docs/operations/deploy-runbook.md')
  })
})
