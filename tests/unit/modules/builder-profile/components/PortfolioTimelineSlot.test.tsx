/**
 * plans/UI/tasks.md Wave 7 "Add opt-in public timeline to portfolios".
 *
 * Covers the four states the task's own verify line calls out: no events (renders nothing),
 * events present but AI unavailable (list renders, no summarize button), events present with AI
 * available but viewer isn't the owner (list renders, still no button — this is owner-only chrome
 * on an otherwise public page), and the full owner + AI-available case (button renders and calling
 * it surfaces the AI-produced summary).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PortfolioTimelineSlot } from '~/modules/builder-profile/components/PortfolioTimelineSlot'
import type { PortfolioTimelineEvent } from '~/shared/lib/portfolio-integrations'

const mocks = vi.hoisted(() => ({
  useAICapabilities: vi.fn(),
  ai: vi.fn(),
}))

vi.mock('~/shared/lib/ai/useAICapabilities', () => ({
  useAICapabilities: mocks.useAICapabilities,
}))

vi.mock('~/shared/lib/ai/client', () => ({
  ai: mocks.ai,
}))

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
  vi.clearAllMocks()
})

const EVENTS: PortfolioTimelineEvent[] = [
  { id: 'evt_1', occurredAt: '2026-07-01T00:00:00.000Z', kind: 'repo', title: 'Pushed to builderhunt', summary: 'Added new feature' },
]

function capabilities(overrides: Partial<{ ready: boolean; serverAI: boolean; disabled: boolean }> = {}) {
  return { ready: false, serverAI: false, disabled: false, ...overrides }
}

async function render(events: PortfolioTimelineEvent[], isOwner: boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<PortfolioTimelineSlot events={events} isOwner={isOwner} />)
  })
  return container
}

describe('PortfolioTimelineSlot', () => {
  it('renders nothing when there are no events', async () => {
    mocks.useAICapabilities.mockReturnValue(capabilities())
    const el = await render([], true)
    expect(el.querySelector('[data-testid="portfolio-timeline"]')).toBeNull()
  })

  it('renders the event list without a summarize button when AI is unavailable', async () => {
    mocks.useAICapabilities.mockReturnValue(capabilities({ ready: false, serverAI: false }))
    const el = await render(EVENTS, true)
    expect(el.querySelector('[data-testid="portfolio-timeline"]')).not.toBeNull()
    expect(el.textContent).toContain('Pushed to builderhunt')
    expect(el.querySelector('[data-testid="portfolio-timeline-summarize"]')).toBeNull()
  })

  it('hides the summarize button for a non-owner viewer even when AI is available', async () => {
    mocks.useAICapabilities.mockReturnValue(capabilities({ ready: true }))
    const el = await render(EVENTS, false)
    expect(el.querySelector('[data-testid="portfolio-timeline-summarize"]')).toBeNull()
  })

  it('hides the summarize button when the AI kill-switch is disabled, even for the owner', async () => {
    mocks.useAICapabilities.mockReturnValue(capabilities({ ready: true, disabled: true }))
    const el = await render(EVENTS, true)
    expect(el.querySelector('[data-testid="portfolio-timeline-summarize"]')).toBeNull()
  })

  it('shows the summarize button for the owner when AI is available, and surfaces the result', async () => {
    mocks.useAICapabilities.mockReturnValue(capabilities({ ready: true }))
    mocks.ai.mockResolvedValue({ output: { summary: 'Shipped several builderhunt features this month.' } })
    const el = await render(EVENTS, true)
    const button = el.querySelector('[data-testid="portfolio-timeline-summarize"]') as HTMLButtonElement
    expect(button).not.toBeNull()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.ai).toHaveBeenCalledWith('timeline-summary', {
      events: [{ type: 'repo', title: 'Pushed to builderhunt', timestamp: '2026-07-01T00:00:00.000Z' }],
    })
    expect(el.textContent).toContain('Shipped several builderhunt features this month.')
  })
})
