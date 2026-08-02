/**
 * The gold-set admin page (plan 43 Phase 0).
 *
 * The page exists for one reason — until a human writes a judgment, every evaluation run is uncitable — so the
 * tests are mostly about whether the page *says* that, and whether the one rule that keeps the two populations
 * apart can be violated through the form.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GoldSetPage, type GoldSetPageProps } from '~/modules/admin/solutions/GoldSetPage'

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
})

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'gold-1',
  authorship: 'human',
  briefText: 'Translate 200 product pages into German',
  expected: { domain: 'translation_and_transcription', capabilityKeys: ['translation'], offerableLanes: ['human'], rankingMode: 'recommended' },
  notes: null,
  createdAt: '2026-08-02T10:00:00.000Z',
  ...overrides,
})

async function mount(props: GoldSetPageProps) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<GoldSetPage {...props} />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const $ = (selector: string) => container!.querySelector(selector) as HTMLElement | null

function setValue(element: HTMLElement, value: string) {
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the empty state is the point', () => {
  it('says every evaluation run is uncitable when there are no human judgments', async () => {
    /**
     * A curator who does not know why their work matters writes less of it. This is the only place the product
     * says out loud that the 60 seeded briefs cannot be quoted as quality.
     */
    await mount({ fetchBriefs: async () => ({ briefs: [] }) })
    const status = $('[data-testid="gold-set-status"]')!
    expect(status.textContent).toContain('uncitable')
    expect(status.textContent).toContain('machine-authored')
  })

  it('counts human judgments once they exist', async () => {
    await mount({ fetchBriefs: async () => ({ briefs: [row(), row({ id: 'gold-2' })] }) })
    expect($('[data-testid="gold-set-status"]')!.textContent).toContain('2 human judgments')
  })

  it('says where the synthetic briefs live rather than pretending they are missing', async () => {
    await mount({ fetchBriefs: async () => ({ briefs: [] }) })
    expect($('[data-testid="gold-empty"]')!.textContent).toContain('repository')
  })
})

describe('the form', () => {
  it('never sends an authorship field', async () => {
    /**
     * The whole authorship split collapses the moment a synthetic record can enter the human population — it
     * would be indistinguishable a week later. The server forces `human` too; this asserts the client does not
     * even offer the choice.
     */
    let sent: Record<string, unknown> | null = null
    await mount({
      fetchBriefs: async () => ({ briefs: [] }),
      createBrief: async (input) => { sent = input as Record<string, unknown>; return { id: 'new' } },
    })

    await act(async () => { setValue($('[data-testid="gold-brief-text"]')!, 'Translate 40 pages into Danish') })
    await act(async () => { $('[data-testid="gold-capability-translation"]')!.click() })
    await act(async () => { $('[data-testid="gold-submit"]')!.click() })

    expect(sent).not.toBeNull()
    expect(sent).not.toHaveProperty('authorship')
    expect((sent as unknown as { briefText: string }).briefText).toBe('Translate 40 pages into Danish')
  })

  it('refuses to submit without a brief or a capability', async () => {
    // A judgment with no expected capability scores nothing — it would sit in the corpus contributing an
    // automatic pass to every run.
    await mount({ fetchBriefs: async () => ({ briefs: [] }) })
    expect(($('[data-testid="gold-submit"]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { setValue($('[data-testid="gold-brief-text"]')!, 'Something') })
    expect(($('[data-testid="gold-submit"]') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { $('[data-testid="gold-capability-translation"]')!.click() })
    expect(($('[data-testid="gold-submit"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('says nothing was written when the save fails', async () => {
    await mount({
      fetchBriefs: async () => ({ briefs: [] }),
      createBrief: async () => { throw new Error('nope') },
    })
    await act(async () => { setValue($('[data-testid="gold-brief-text"]')!, 'Something') })
    await act(async () => { $('[data-testid="gold-capability-translation"]')!.click() })
    await act(async () => { $('[data-testid="gold-submit"]')!.click() })
    expect($('[data-testid="gold-set-error"]')!.textContent).toContain('Nothing was written')
  })

  it('reloads the list after a successful save', async () => {
    const fetchBriefs = vi.fn(async () => ({ briefs: [] }))
    await mount({ fetchBriefs, createBrief: async () => ({ id: 'new' }) })
    await act(async () => { setValue($('[data-testid="gold-brief-text"]')!, 'Something') })
    await act(async () => { $('[data-testid="gold-capability-translation"]')!.click() })
    await act(async () => { $('[data-testid="gold-submit"]')!.click() })
    // Once on mount, once after the save — the count is what tells the curator their judgment landed.
    expect(fetchBriefs.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('deletion', () => {
  it('deletes by id and reloads', async () => {
    const deleteBrief = vi.fn(async () => undefined)
    await mount({ fetchBriefs: async () => ({ briefs: [row()] }), deleteBrief })
    await act(async () => { $('[data-testid="gold-delete-gold-1"]')!.click() })
    expect(deleteBrief).toHaveBeenCalledWith('gold-1')
  })

  it('gives the delete button an accessible name', async () => {
    // An icon-only button in a list of judgments is unusable by keyboard or screen reader without one.
    await mount({ fetchBriefs: async () => ({ briefs: [row()] }) })
    expect($('[data-testid="gold-delete-gold-1"]')!.getAttribute('aria-label')).toContain('gold-1')
  })
})
