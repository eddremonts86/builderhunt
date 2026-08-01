import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SOURCE_NAMES } from '~/lib/sources/types'
import { AI_TASKS } from '~/shared/lib/ai/tasks'
import { IntegrationsPage } from '~/modules/admin/integrations/IntegrationsPage'

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
})

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function buildFixture() {
  const sources = SOURCE_NAMES.map((source) => ({
    source,
    label: source,
    trackable: source !== 'devpost' && source !== 'producthunt' && source !== 'bluesky',
    dormantReason: source === 'producthunt' ? "Tracking Product Hunt builders isn't supported yet" : null,
    credentialRequired: source === 'github',
    credentialPresent: source === 'github' ? false : true,
    killSwitchEnabled: source === 'devpost' ? false : null,
    quota: null, lastSuccessAt: null, lastFailureAt: null, indexedCount: null, backlogCount: null,
  }))
  const aiTasks = Object.keys(AI_TASKS).map((taskId) => ({
    taskId, tier: 'server-only' as const, sensitive: false, version: '1', disabled: false,
  }))
  return {
    sources,
    aiTasks,
    aiGloballyDisabled: false,
    aiProviderAvailable: false,
    aiBudgetDenials: 0,
    enrichmentEnabled: false,
    discovery: null,
    generatedAt: '2027-01-01T00:00:00.000Z',
  }
}

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<IntegrationsPage />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function testId(id: string): Element | null {
  return container!.querySelector(`[data-testid="${id}"]`)
}

describe('IntegrationsPage', () => {
  it('renders exactly one row per SOURCE_NAMES member', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    for (const source of SOURCE_NAMES) {
      expect(testId(`integration-row-${source}`), `row for ${source}`).not.toBeNull()
    }
  })

  it('shows Product Hunt and Devpost as explicitly unavailable, not silently missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    expect(testId('integration-badge-producthunt')?.textContent).toContain('Dormant')
    expect(testId('integration-row-producthunt')?.textContent).toContain("isn't supported yet")
    // Devpost is both dormant (not trackable via /track) and kill-switched (DEVPOST_ENABLED) — the
    // badge shows dormant first, since that's the more specific reason it won't run.
    expect(testId('integration-badge-devpost')?.textContent).toContain('Dormant')
  })

  it('shows the AI provider as unavailable when no key is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    expect(testId('integrations-provider-availability')?.textContent).toContain('Unavailable')
  })

  it('shows a missing-credential source as needing attention', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    expect(testId('integration-badge-github')?.textContent).toContain('No credential')
    expect(testId('integrations-attention-count')).not.toBeNull()
  })

  it('never renders a secret-like string anywhere in the DOM', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    const html = container!.innerHTML
    for (const needle of ['GITHUB_TOKEN', 'MINIMAX_API_KEY', 'ghp_', 'Bearer ']) {
      expect(html).not.toContain(needle)
    }
  })

  it('links each source to a source-filtered Search deep link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    const link = testId('integration-search-link-github') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/search?sources=github')
  })

  it('links to Operations and Metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    expect((testId('integrations-link-operations') as HTMLAnchorElement).getAttribute('href')).toBe('/admin/operations')
    expect((testId('integrations-link-metrics') as HTMLAnchorElement).getAttribute('href')).toBe('/admin/metrics')
  })

  it('renders one row per registered AI task', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    for (const taskId of Object.keys(AI_TASKS)) {
      expect(testId(`integration-ai-task-${taskId}`), `row for ${taskId}`).not.toBeNull()
    }
  })

  it('filters sources needing attention', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(buildFixture())))
    await render()

    await act(async () => {
      testId('integrations-filter-attention')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(testId('integration-row-github')).not.toBeNull()
    expect(testId('integration-row-npm')).toBeNull()
  })
})
